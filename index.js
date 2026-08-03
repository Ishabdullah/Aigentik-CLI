// index.js — Aigentik v2.0
// Communication: Gmail + Google Voice ONLY
// No SMS sending or receiving via Termux
// Admin: texts FROM 5551234567 TO 5559876543 (Google Voice), OR emails from
// owner.admin_email directly — both are routed to the same command handler.
// Public: anyone texts 5559876543 (Google Voice)
// All routing via Gmail IMAP IDLE

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import log from './logger.js';
import config from './config.json' with { type: 'json' };
import * as llama from './llama.js';
import * as gmail from './gmail.js';
import * as ownerCommand from './owner-command.js';
import * as contacts from './contacts.js';
import * as contactsSync from './contacts-sync.js';
import * as queue from './queue.js';
import * as tone from './tone.js';
import * as smsRules from './sms-rules.js';
import * as emailRules from './email-rules.js';
import * as calendarModule from './calendar.js';

const PROFILE_FILE = path.join(config.paths.data_dir, 'profile.json');

// Strip a quoted-reply block off an admin command email, so replying to one
// of Aigentik's own notifications (which Gmail threads with "On ... wrote:"
// plus the quoted original below the new text) doesn't feed the old message
// back into the command interpreter along with the real instruction.
function stripQuotedReply(text) {
  if (!text) return text;
  const markers = [
    /\n[ \t]*On .{0,120} wrote:[\s\S]*$/i,
    /\n[ \t]*-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i,
    /\n[ \t]*>.*$/s
  ];
  let result = text;
  for (const marker of markers) {
    result = result.replace(marker, '');
  }
  return result.trim();
}

function loadProfile() {
  try {
    const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    config.aigentik_name = profile.aigentik_name || 'Aigentik';
    config.owner_name = profile.owner_name || 'Ish';
    config.business_name = profile.business_name || null;
    config.business_description = profile.business_description || null;
  } catch (e) {
    config.aigentik_name = 'Aigentik';
    config.owner_name = 'Ish';
    config.business_name = null;
    config.business_description = null;
  }
}

function isLlamaRunning() {
  try {
    const result = execSync('curl -s http://127.0.0.1:8080/health', {
      timeout: 5000, encoding: 'utf8'
    });
    return result.includes('ok');
  } catch (e) { return false; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Set only if THIS process actually launched llama-server — if one was
// already running (isLlamaRunning() below), we leave it alone and won't
// kill it on shutdown either, since we didn't start it.
let llamaProcess = null;

async function startLlamaServer() {
  if (isLlamaRunning()) {
    log.info('index', 'llama-server already running');
    return true;
  }
  log.info('index', 'Starting llama-server...');
  try {
    // Expand tilde in model path
    const modelPath = config.llama.model_path.replace(/^~/, process.env.HOME || '/data/data/com.termux/files/home');
    llamaProcess = spawn(config.llama.llama_server_path, [
      '-m', modelPath,
      '-t', String(config.llama.threads),
      '-c', String(config.llama.context_size),
      '--host', '0.0.0.0',
      '--port', '8080',
      '-np', '1',
      '--log-disable'
    ], { stdio: 'ignore', detached: true });
    llamaProcess.unref();
    llamaProcess.on('error', (e) => {
      log.error('index', 'llama-server process error', { error: e.message });
    });
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (isLlamaRunning()) {
        log.info('index', 'llama-server started', { pid: llamaProcess.pid });
        return true;
      }
    }
    log.error('index', 'llama-server failed to start');
    return false;
  } catch (e) {
    log.error('index', 'Failed to start llama-server', { error: e.message });
    return false;
  }
}

// Stop the llama-server process this Aigentik instance started, if any.
function stopLlamaServer() {
  if (!llamaProcess || llamaProcess.killed || llamaProcess.pid == null) return;
  log.info('index', 'Stopping llama-server', { pid: llamaProcess.pid });
  try {
    process.kill(llamaProcess.pid, 'SIGTERM');
  } catch (e) {
    log.warn('index', 'Failed to stop llama-server', { error: e.message });
  }
}

// Pick the right appointment out of several when a contact has more than
// one on file and mentions a date — falls back to null (ambiguous) if no
// date was given or none is closer than the others.
function pickAppointmentFromMany(appts, rawPhrase) {
  if (appts.length === 1) return appts[0];
  const phraseDate = calendarModule.parseDatetimePhrase(rawPhrase);
  if (!phraseDate) return null;
  return appts.reduce((closest, a) =>
    (!closest || Math.abs(new Date(a.start) - phraseDate) < Math.abs(new Date(closest.start) - phraseDate)) ? a : closest, null);
}

// Required contact fields before Aigentik will book an appointment. Address
// is only needed for an in-person visit — a phone call doesn't need one.
function requiredFieldsForType(appointmentType) {
  return appointmentType === 'in_person' ? ['name', 'email', 'phone', 'address'] : ['name', 'email', 'phone'];
}

// Appended to every booking/reschedule confirmation — invites follow-up
// questions/changes and sets the expectation of a confirmation call before
// the appointment, per the intake script.
function closingReassurance() {
  return "\n\nIf anything changes or you have any questions or concerns in the meantime, feel free to reach back out — we're happy to help or get you rebooked. We'll also give you a call before your appointment to confirm the time and make sure you get a chance to speak with one of our qualified technicians beforehand.";
}

// Confirm a negotiation into a real booking, send invites, and reply with
// the confirmation + closing reassurance — the single place this happens so
// every path (fresh intake, time negotiation, reschedule) sounds the same.
async function confirmAndClose({ negotiation, slot, attendeeEmail, adminEmail, senderLabel, reply }) {
  const typeLabel = negotiation.appointment_type === 'in_person' ? 'in-person appointment' : 'phone call';
  const appt = calendarModule.confirmNegotiation(negotiation.id, slot.start, slot.end);
  if (attendeeEmail) await gmail.sendCalendarInvite(appt, attendeeEmail);
  await gmail.sendCalendarInvite(appt, adminEmail);
  await reply(
    `You're all set! ${typeLabel} on ${new Date(appt.start).toLocaleString()}.` +
    (attendeeEmail ? " I've sent a calendar invite." : '') +
    closingReassurance()
  );
  await gmail.sendOwnerNotification(`📅 Appointment confirmed with ${appt.attendee_name || senderLabel} (${typeLabel}): ${new Date(appt.start).toLocaleString()}`);
}

// Stage 1 of a fresh request: reply with one sentence naturally
// acknowledging what they actually said, followed by a single combined
// template asking for everything Aigentik needs (name, address, phone,
// call-vs-in-person, best available time, and any specific concerns) —
// rather than asking one question per turn.
async function sendIntakeForm({ negotiation, text, reply }) {
  let acknowledgment = '';
  try {
    acknowledgment = await llama.generateAcknowledgment(text, config.aigentik_name, config.business_name, config.business_description);
  } catch (e) {
    log.error('index', 'Failed to generate acknowledgment', { error: e.message });
  }

  const form = [
    'To get this scheduled, could you send over:',
    '• Your full name',
    '• Your address',
    '• A phone number',
    "• Whether you'd prefer a phone call or an in-person visit",
    '• Your best available date/time (or best time to call, if a call works better)',
    "• Any specific issues or concerns you'd like addressed",
    '',
    "Once I have that, I'll check the calendar and get back to you with a confirmed time."
  ].join('\n');

  await reply(acknowledgment ? `${acknowledgment}\n\n${form}` : form);
  calendarModule.markFormSent(negotiation.id);
  return true;
}

// Stage 2: their reply to the intake form (or any message before a time has
// been offered). Pulls name/phone/address/concerns and the appointment type
// out of the same message in one pass — someone who answers everything at
// once skips straight to booking; anyone missing something just gets asked
// for what's still missing, not the whole form again.
async function processIntakeReply({ negotiation, text, contact, channel, target, reply, adminEmail, senderLabel }) {
  if (!negotiation.appointment_type) {
    const detectedType = calendarModule.detectAppointmentTypeFromText(text);
    if (detectedType) negotiation = calendarModule.setAppointmentType(negotiation.id, detectedType);
  }

  let extracted = {};
  try {
    extracted = await llama.extractContactDetails(text, ['name', 'phone', 'address', 'concerns']);
  } catch (e) {
    log.error('index', 'Failed to extract intake reply', { error: e.message });
  }
  if (contact?.id) contacts.applyExtractedDetails(contact.id, extracted);
  if (extracted?.concerns) calendarModule.setAppointmentNotes(negotiation.id, extracted.concerns);

  const freshContact = contact?.id ? contacts.getContactById(contact.id) : contact;
  const required = requiredFieldsForType(negotiation.appointment_type);
  const missing = contacts.getMissingFields(freshContact, required);
  const stillNeedsType = !negotiation.appointment_type;

  if (stillNeedsType || missing.length > 0) {
    const asks = [];
    if (stillNeedsType) asks.push("whether you'd like a phone call or an in-person visit");
    if (missing.length > 0) asks.push(`your ${missing.join(', ')}`);
    await reply(`Thanks! Before I can get this scheduled, could you also share ${asks.join(' and ')}?`);
    return true;
  }

  const attendeeEmail = channel === 'email' ? target : (freshContact?.emails?.[0] || null);
  const duration = calendarModule.getDurationForRelationship(freshContact?.relationship);
  const afterDate = calendarModule.mentionsToday(text) ? undefined : calendarModule.startOfTomorrow();
  const requestedDate = calendarModule.parseDatetimePhrase(text);
  const typeLabel = negotiation.appointment_type === 'in_person' ? 'in-person appointment' : 'phone call';

  if (!requestedDate) {
    const offers = calendarModule.generateOfferSlots({ durationMinutes: duration, afterDate, count: 3 });
    if (offers.length === 0) {
      await reply("I'm not able to find any open slots right now — I'll have my owner reach out to schedule directly.");
      await gmail.sendOwnerNotification(`⚠️ Could not find any available slots for a scheduling request from ${senderLabel}.`);
      return true;
    }
    calendarModule.updateNegotiationOffers(negotiation.id, offers);
    await reply(`Great, thanks for the details! Here's what I have open for a ${typeLabel}:\n${calendarModule.formatOfferList(offers)}\n\nWhich works for you, or suggest another time?`);
    return true;
  }

  const slot = calendarModule.findNextAvailableSlot({ afterDate, durationMinutes: duration, preferredDate: requestedDate });
  if (!slot) {
    await reply("I'm not able to find any open slot near that time — I'll have my owner reach out directly.");
    await gmail.sendOwnerNotification(`⚠️ Could not find an available slot while scheduling with ${senderLabel}.`);
    return true;
  }

  if (slot.start.getTime() === requestedDate.getTime()) {
    await confirmAndClose({ negotiation, slot, attendeeEmail, adminEmail, senderLabel, reply });
  } else {
    calendarModule.updateNegotiationOffers(negotiation.id, [slot]);
    await reply(`Thanks for the details! That time isn't available, though — the soonest opening after that is ${new Date(slot.start).toLocaleString()}. Does that work, or would you like another time?`);
  }
  return true;
}

// Stage 3: a time has already been offered, so this reply is purely about
// picking/proposing a time — everything else (type, contact info) was
// already settled in stage 2.
async function negotiateTime({ negotiation, text, adminEmail, senderLabel, reply }) {
  // A bare time with no date ("could we do 11am instead?") means "that time
  // on the date we're already discussing," not "11am relative to right
  // now" — anchor it to the first currently-offered slot's date instead of
  // letting chrono default it to today/tomorrow.
  const parsed = calendarModule.parseDatetimeDetailed(text);
  const requestedDate = parsed
    ? (parsed.hasExplicitDate ? parsed.date : calendarModule.combineTimeWithDate(parsed.date, negotiation.offered_slots[0].start))
    : null;
  if (!requestedDate) {
    await reply(`I didn't catch a specific time in that. Here's what I have open:\n${calendarModule.formatOfferList(negotiation.offered_slots)}\n\nWhich works, or suggest another time?`);
    return true;
  }

  const duration = (new Date(negotiation.offered_slots[0].end) - new Date(negotiation.offered_slots[0].start)) / 60000;
  const afterDate = calendarModule.mentionsToday(text) ? undefined : calendarModule.startOfTomorrow();
  const slot = calendarModule.findNextAvailableSlot({ afterDate, durationMinutes: duration, preferredDate: requestedDate });

  if (!slot) {
    await reply("I'm not able to find any open slot near that time — I'll have my owner reach out directly.");
    await gmail.sendOwnerNotification(`⚠️ Could not find an available slot while scheduling with ${senderLabel}.`);
    return true;
  }

  if (slot.start.getTime() === requestedDate.getTime()) {
    await confirmAndClose({ negotiation, slot, attendeeEmail: negotiation.attendee_email, adminEmail, senderLabel, reply });
  } else {
    calendarModule.updateNegotiationOffers(negotiation.id, [slot]);
    await reply(`That time isn't available either — the soonest opening after that is ${new Date(slot.start).toLocaleString()}. Does that work, or would you like another time?`);
  }
  return true;
}

// Advance a scheduling negotiation by one turn, whether it's a brand-new
// request or a reply to one already in progress. Three stages:
//   1. Send the intake form (once) — natural acknowledgment + one combined ask.
//   2. Process their reply to it — extract everything at once, ask only for
//      whatever's still missing, then offer times or check a time they gave.
//   3. Once a time's been offered, pure back-and-forth on picking one.
async function advanceScheduling({ negotiation, text, contact, channel, target, reply, adminEmail, senderLabel }) {
  if (!negotiation.form_sent) {
    return await sendIntakeForm({ negotiation, text, reply });
  }
  if (negotiation.offered_slots.length === 0) {
    return await processIntakeReply({ negotiation, text, contact, channel, target, reply, adminEmail, senderLabel });
  }
  return await negotiateTime({ negotiation, text, adminEmail, senderLabel, reply });
}

// A fresh "move my appointment" request against an already-confirmed booking.
async function handleRescheduleRequest({ classified, contact, reply, adminEmail, senderLabel }) {
  const appts = calendarModule.findAppointmentsByContact(contact?.id);
  if (appts.length === 0) {
    await reply("I don't see any upcoming appointment on file for you.");
    return true;
  }

  const appt = pickAppointmentFromMany(appts, classified.raw_datetime_phrase);
  if (!appt) {
    const list = appts.map(a => `- ${new Date(a.start).toLocaleString()}`).join('\n');
    await reply(`You have a few appointments on file:\n${list}\n\nWhich one do you mean?`);
    return true;
  }

  const preferredDate = calendarModule.parseDatetimePhrase(classified.raw_datetime_phrase);
  if (!preferredDate) {
    await reply('What time would you like to move it to?');
    return true;
  }

  const duration = (new Date(appt.end) - new Date(appt.start)) / 60000;
  const afterDate = calendarModule.mentionsToday(classified.raw_datetime_phrase) ? undefined : calendarModule.startOfTomorrow();
  const slot = calendarModule.findNextAvailableSlot({ afterDate, durationMinutes: duration, preferredDate, excludeId: appt.id });
  if (!slot) {
    await reply("I couldn't find another open slot near that time — I'll have my owner follow up.");
    return true;
  }

  if (slot.start.getTime() === preferredDate.getTime()) {
    const updated = calendarModule.rescheduleAppointment(appt.id, slot.start, slot.end);
    if (updated.attendee_email) await gmail.sendCalendarInvite(updated, updated.attendee_email);
    await gmail.sendCalendarInvite(updated, adminEmail);
    await reply(`Got it — moved to ${new Date(updated.start).toLocaleString()}. Updated invite sent.${closingReassurance()}`);
    await gmail.sendOwnerNotification(`🔁 Appointment rescheduled for ${contact?.name || senderLabel}: now ${new Date(updated.start).toLocaleString()}`);
  } else {
    // Their requested new time isn't free either — recommend the nearest
    // alternative but leave the current booking intact until they agree.
    calendarModule.setPendingReschedule(appt.id, slot);
    await reply(`That time isn't available. The soonest opening after that is ${new Date(slot.start).toLocaleString()} — does that work, or would you like to suggest another time?`);
  }
  return true;
}

// A reply to an in-progress reschedule negotiation on an existing booking.
async function handleRescheduleReply({ appt, text, reply, adminEmail, senderLabel }) {
  const parsed = calendarModule.parseDatetimeDetailed(text);
  const requestedDate = parsed
    ? (parsed.hasExplicitDate ? parsed.date : calendarModule.combineTimeWithDate(parsed.date, appt.pending_reschedule.start))
    : null;
  if (!requestedDate) {
    await reply(`I didn't catch a specific time. The soonest opening I found was ${new Date(appt.pending_reschedule.start).toLocaleString()} — does that work, or would you like another time?`);
    return true;
  }

  const duration = (new Date(appt.end) - new Date(appt.start)) / 60000;
  const afterDate = calendarModule.mentionsToday(text) ? undefined : calendarModule.startOfTomorrow();
  const slot = calendarModule.findNextAvailableSlot({ afterDate, durationMinutes: duration, preferredDate: requestedDate, excludeId: appt.id });

  if (!slot) {
    await reply("I'm not able to find any open slot near that time — I'll have my owner follow up.");
    return true;
  }

  if (slot.start.getTime() === requestedDate.getTime()) {
    const updated = calendarModule.rescheduleAppointment(appt.id, slot.start, slot.end);
    calendarModule.clearPendingReschedule(updated.id);
    if (updated.attendee_email) await gmail.sendCalendarInvite(updated, updated.attendee_email);
    await gmail.sendCalendarInvite(updated, adminEmail);
    await reply(`Got it — moved to ${new Date(updated.start).toLocaleString()}. Updated invite sent.${closingReassurance()}`);
    await gmail.sendOwnerNotification(`🔁 Appointment rescheduled for ${senderLabel}: now ${new Date(updated.start).toLocaleString()}`);
  } else {
    calendarModule.setPendingReschedule(appt.id, slot);
    await reply(`That time isn't available either — the soonest opening after that is ${new Date(slot.start).toLocaleString()}. Does that work?`);
  }
  return true;
}

async function handleCancelRequest({ classified, contact, reply, adminEmail, senderLabel }) {
  const appts = calendarModule.findAppointmentsByContact(contact?.id);
  if (appts.length === 0) {
    await reply("I don't see any upcoming appointment on file for you.");
    return true;
  }

  const appt = pickAppointmentFromMany(appts, classified.raw_datetime_phrase);
  if (!appt) {
    const list = appts.map(a => `- ${new Date(a.start).toLocaleString()}`).join('\n');
    await reply(`You have a few appointments on file:\n${list}\n\nWhich one do you mean?`);
    return true;
  }

  calendarModule.cancelAppointment(appt.id);
  if (appt.attendee_email) await gmail.sendCalendarCancellation(appt, appt.attendee_email);
  await gmail.sendCalendarCancellation(appt, adminEmail);
  await reply(`Done — your appointment on ${new Date(appt.start).toLocaleString()} has been cancelled. Let us know whenever you're ready to rebook.`);
  await gmail.sendOwnerNotification(`🚫 Appointment cancelled by ${contact?.name || senderLabel}: was ${new Date(appt.start).toLocaleString()}`);
  return true;
}

// Check whether an inbound message (email or Google Voice text) from a
// non-admin contact is a scheduling request, and if so, negotiate/book/
// reschedule/cancel an appointment and reply — entirely via the .ics-over-
// email mechanism, no calendar API/OAuth involved. Returns true if handled
// (caller should skip its normal auto-reply/queue flow), false otherwise.
async function handleSchedulingMessage({ text, contact, channel, target, subject, voiceMsg, senderLabel }) {
  const reply = async (msg) => {
    if (channel === 'email') await gmail.sendReply(target, subject, msg);
    else await gmail.replyToGoogleVoiceText(voiceMsg, msg);
  };
  const adminEmail = config.owner.admin_email || config.gmail.email;

  // A contact with an active negotiation almost certainly means this message
  // is part of it — including replies with no date/scheduling keyword at all
  // (e.g. answering "what's your address?" with just an address). Route
  // there unconditionally rather than gating on a keyword match.
  const activeNegotiation = contact?.id ? calendarModule.findNegotiationsByContact(contact.id)[0] : null;
  if (activeNegotiation) {
    return await advanceScheduling({ negotiation: activeNegotiation, text, contact, channel, target, reply, adminEmail, senderLabel });
  }

  const confirmedAppts = contact?.id ? calendarModule.findAppointmentsByContact(contact.id) : [];
  const pendingReschedule = confirmedAppts.find(a => a.pending_reschedule);
  if (pendingReschedule) {
    return await handleRescheduleReply({ appt: pendingReschedule, text, reply, adminEmail, senderLabel });
  }

  // No keyword pre-filter here on purpose: a service/estimate inquiry
  // ("can you paint my house, what's the cost?") is exactly the kind of
  // message that needs to turn into an appointment, and it often won't
  // contain any obviously "scheduling" word at all. The classifier itself
  // (not a keyword list) decides whether this implies wanting an appointment.
  let classified;
  try {
    classified = await llama.classifySchedulingIntent(text, { current_time: new Date().toISOString() });
  } catch (e) {
    log.error('index', 'Failed to classify scheduling intent', { error: e.message });
    return false;
  }
  if (!classified || classified.intent === 'none') return false;

  if (classified.intent === 'request_appointment') {
    const negotiation = calendarModule.proposeAppointment({
      title: `Appointment with ${contact?.name || senderLabel}`,
      contactId: contact?.id,
      attendeeName: contact?.name || senderLabel,
      attendeeEmail: channel === 'email' ? target : (contact?.emails?.[0] || null),
      createdVia: channel
    });
    return await advanceScheduling({ negotiation, text, contact, channel, target, reply, adminEmail, senderLabel });
  }
  if (classified.intent === 'cancel_appointment') {
    return await handleCancelRequest({ classified, contact, reply, adminEmail, senderLabel });
  }
  if (classified.intent === 'reschedule_appointment') {
    return await handleRescheduleRequest({ classified, contact, reply, adminEmail, senderLabel });
  }

  return false;
}

// Handle Google Voice forwarded text messages
async function handleGoogleVoiceText(email) {
  const voiceMsg = gmail.parseGoogleVoiceEmail(email);

  if (!voiceMsg.body || !voiceMsg.sender_phone) {
    log.warn('index', 'Could not parse Google Voice message', { subject: email.subject });
    return;
  }

  log.info('index', 'Google Voice text from ' + (voiceMsg.sender_name || voiceMsg.sender_phone),
    { body: voiceMsg.body.substring(0, 50) });

  const ownerName = config.owner_name || 'Ish';
  const agentName = config.aigentik_name || 'Aigentik';
  const businessName = config.business_name || null;
  const businessDescription = config.business_description || null;
  const adminPhone = config.owner.admin_number.replace(/[^0-9]/g, '').slice(-10);
  const senderNorm = voiceMsg.sender_phone.replace(/[^0-9]/g, '').slice(-10);

  // Route to admin handler if from owner's number
  if (senderNorm === adminPhone) {
    log.info('index', 'Admin command via Google Voice from ' + ownerName);
    const fakeSms = {
      address: voiceMsg.sender_phone,
      body: voiceMsg.body,
      _id: 'gv_' + Date.now()
    };
    await ownerCommand.handleOwnerCommand(fakeSms);
    return;
  }

  // Public message handling
  const contact = contacts.findOrCreateByPhone(voiceMsg.sender_phone);
  if (voiceMsg.sender_name && contact && !contact.name) {
    contacts.updateContact(contact.id, { name: voiceMsg.sender_name });
  }
  contacts.addHistory(voiceMsg.sender_phone, {
    type: 'gvoice_text_received',
    preview: voiceMsg.body.substring(0, 100)
  });

  // Check for urgent keyword
  if (voiceMsg.body.toLowerCase().includes(ownerName.toLowerCase())) {
    await gmail.sendOwnerNotification(
      '🚨 URGENT: ' + (voiceMsg.sender_name || voiceMsg.sender_phone) +
      ' is trying to reach you!\nMessage: "' + voiceMsg.body.substring(0, 100) + '"'
    );
  }

  // Check contact behavior
  if (contact?.reply_behavior === 'never') {
    log.info('index', 'Contact set to never reply — skipping');
    return;
  }

  // Check rules
  const { action } = smsRules.checkRules({
    address: voiceMsg.sender_phone,
    body: voiceMsg.body
  });

  if (action === 'spam') {
    log.action('index', 'Google Voice text marked spam from ' + voiceMsg.sender_phone);
    return;
  }

  // Scheduling requests are handled separately from the normal auto-reply flow
  const schedulingHandled = await handleSchedulingMessage({
    text: stripQuotedReply(voiceMsg.body) || voiceMsg.body,
    contact,
    channel: 'sms',
    voiceMsg,
    senderLabel: voiceMsg.sender_name || voiceMsg.sender_phone
  });
  if (schedulingHandled) return;

  const shouldAutoReply = contact?.reply_behavior === 'always' ||
                          contact?.reply_behavior === 'auto' ||
                          action === 'auto-reply';

  try {
    const detectedTone = await tone.detectTone(voiceMsg.body);
    const reply = await llama.generateSmsReply(
      voiceMsg.sender_phone,
      voiceMsg.sender_name,
      voiceMsg.body,
      detectedTone,
      contact?.relationship,
      contact?.instructions,
      ownerName,
      agentName,
      businessName,
      businessDescription
    );

    if (shouldAutoReply) {
      await gmail.replyToGoogleVoiceText(voiceMsg, reply);
      contacts.addHistory(voiceMsg.sender_phone, { type: 'gvoice_auto_replied' });
      await gmail.sendOwnerNotification(
        '💬 Replied to ' + (voiceMsg.sender_name || voiceMsg.sender_phone) + ':\n' +
        'They said: "' + voiceMsg.body.substring(0, 60) + '"\n' +
        'Sent: "' + reply.substring(0, 80) + '"'
      );
      log.action('index', 'Google Voice auto-reply sent to ' + voiceMsg.sender_phone);
    } else {
      const item = queue.addToQueue({
        type: 'sms',
        sender: voiceMsg.sender_phone,
        senderName: voiceMsg.sender_name,
        body: voiceMsg.body,
        draftReply: reply,
        contactId: contact?.id,
        replyToEmail: voiceMsg.reply_to_email,
        originalSubject: voiceMsg.original_subject,
        uid: voiceMsg.original_email?.uid
      });
      await gmail.sendOwnerNotification(
        '💬 New text #' + item.display_id + ' from ' +
        (voiceMsg.sender_name || voiceMsg.sender_phone) + ':\n"' +
        voiceMsg.body.substring(0, 80) + '"\n\nDraft: "' +
        reply.substring(0, 60) + '"\n\nText "reply ' + item.display_id + '" to approve'
      );
    }
  } catch (e) {
    log.error('index', 'Failed to handle Google Voice text', { error: e.message });
  }
}

// Handle regular emails (not Google Voice)
async function handleNewEmail(email) {
  if (config.behavior?.paused || config.behavior?.pause_email) {
    log.info('index', 'Email processing paused');
    return;
  }

  // Ignore emails from self
  if (email.from_email?.toLowerCase() === config.gmail.email?.toLowerCase()) {
    log.debug('index', 'Ignoring email from self');
    return;
  }

  // Calendar invite accept/decline/tentative responses — these come from the
  // attendee's own address (via their mail client's RSVP), not a real
  // message, so they're handled here rather than falling through to the
  // normal auto-reply flow (which would otherwise try to draft a reply to
  // "Accepted: Appointment with...").
  if (gmail.isCalendarResponse(email)) {
    const rsvp = gmail.parseCalendarResponse(email);
    const appt = rsvp.status && calendarModule.findAppointmentByAttendeeEmail(rsvp.attendeeEmail);
    if (appt) {
      calendarModule.setRsvpStatus(appt.id, rsvp.status);
      const icon = rsvp.status === 'accepted' ? '✅' : rsvp.status === 'declined' ? '❌' : '❔';
      await gmail.sendOwnerNotification(
        `${icon} ${appt.attendee_name || rsvp.attendeeEmail} ${rsvp.status} the appointment: ` +
        `${appt.title} on ${new Date(appt.start).toLocaleString()}`
      );
      log.action('index', `Calendar RSVP recorded: ${rsvp.attendeeEmail} ${rsvp.status}`, { appointmentId: appt.id });
    } else {
      log.debug('index', 'Calendar response email did not match any known appointment', { from: email.from_email, subject: email.subject });
    }
    return;
  }

  // Route Google Voice texts separately
  if (gmail.isGoogleVoiceText(email)) {
    await handleGoogleVoiceText(email);
    return;
  }

  // Owner's own email address is treated the same as the admin phone number:
  // its content is interpreted as a command, not auto-replied to as a
  // regular email.
  const adminEmail = config.owner.admin_email?.toLowerCase();
  if (adminEmail && email.from_email?.toLowerCase() === adminEmail) {
    log.info('index', 'Admin command via email from ' + email.from_email);
    const fakeSms = {
      address: email.from_email,
      body: stripQuotedReply(email.body) || (email.subject || '').trim(),
      subject: email.subject,
      _id: 'email_' + Date.now()
    };
    await ownerCommand.handleOwnerCommand(fakeSms);
    return;
  }

  log.info('index', 'Regular email from ' + email.from_email, { subject: email.subject });

  const contact = contacts.findOrCreateByEmail(email.from_email, email.from_name);
  contacts.addHistory(email.from_email, {
    type: 'email_received',
    subject: email.subject,
    preview: email.body?.substring(0, 100)
  });

  const { action } = emailRules.checkRules({
    from: email.from_email,
    subject: email.subject,
    body: email.body
  });

  const ownerName = config.owner_name || 'Ish';
  const agentName = config.aigentik_name || 'Aigentik';
  const businessName = config.business_name || null;
  const businessDescription = config.business_description || null;

  if (action === 'spam') {
    await gmail.markAsSpam({ from: email.from_email });
    log.action('index', 'Email marked spam from ' + email.from_email);
    return;
  }

  // Scheduling requests are handled separately from the normal auto-reply flow.
  // Quoted-reply content must be stripped first — Gmail's own "On [date] at
  // [time], X wrote:" quote header reads as a real date to chrono-node
  // otherwise, and gets mistaken for a time the customer proposed.
  const schedulingHandled = await handleSchedulingMessage({
    text: stripQuotedReply(email.body) || '',
    contact,
    channel: 'email',
    target: email.from_email,
    subject: email.subject,
    senderLabel: email.from_name || email.from_email
  });
  if (schedulingHandled) return;

  try {
    const reply = await llama.generateEmailReply(
      email.from_name, email.from_email, email.subject,
      email.body?.substring(0, 1000),
      contact?.relationship, contact?.instructions,
      ownerName, agentName,
      businessName, businessDescription
    );

    if (action === 'auto-reply') {
      await gmail.sendReply(email.from_email, email.subject, reply);
      contacts.addHistory(email.from_email, { type: 'email_auto_replied' });
      await gmail.sendOwnerNotification(
        '✉️ Auto-replied to ' + (email.from_name || email.from_email) + ':\n' +
        'Subject: ' + email.subject?.substring(0, 50) + '\n' +
        'Sent: "' + reply.substring(0, 80) + '"'
      );
    } else {
      const item = queue.addToQueue({
        type: 'email',
        sender: email.from_email,
        senderName: email.from_name,
        subject: email.subject,
        body: email.body?.substring(0, 300),
        draftReply: reply,
        contactId: contact?.id,
        uid: email.uid
      });
      await gmail.sendOwnerNotification(
        '✉️ Email #' + item.display_id + ' from ' +
        (email.from_name || email.from_email) + ':\n' +
        'Subject: ' + email.subject?.substring(0, 50) + '\n' +
        'Draft: "' + reply.substring(0, 80) + '"\n\n' +
        'Reply "reply ' + item.display_id + '" to send'
      );
    }
  } catch (e) {
    log.error('index', 'Failed to process email', { error: e.message });
  }
}

// Graceful shutdown
async function shutdown(signal) {
  log.info('index', signal + ' received — shutting down Aigentik');
  await gmail.disconnect();
  stopLlamaServer();
  process.exit(0);
}

async function main() {
  console.log('\n🤖 Aigentik v2.0 — Starting up...\n');

  loadProfile();

  // Start llama-server
  const llamaOk = await startLlamaServer();
  if (!llamaOk) {
    log.error('index', 'Cannot start without llama-server');
    process.exit(1);
  }

  // Warm up AI
  const warmedUp = await llama.warmUp();
  if (!warmedUp) {
    log.error('index', 'llama-server not responding');
    process.exit(1);
  }

  const aigentikName = config.aigentik_name;
  log.info('index', 'Running as: ' + aigentikName);

  // Sync Android contacts
  log.info('index', 'Syncing Android contacts...');
  contactsSync.startAutoSync();
  log.info('index', 'Contact sync complete');

  // Connect to Gmail — this is the ONLY channel now
  if (config.gmail.email && config.gmail.app_password) {
    gmail.connect(handleNewEmail);
    log.info('index', 'Gmail IMAP IDLE started — sole communication channel');
  } else {
    log.error('index', 'Gmail not configured — Aigentik cannot function without it');
    process.exit(1);
  }

  // Notify owner via email only
  const pending = queue.listQueue();
  await gmail.sendOwnerNotification(
    '✅ ' + aigentikName + ' v2.0 is online!\n' +
    '📬 Pending: ' + pending.length + '\n' +
    '📧 Gmail: monitoring\n' +
    '💬 Google Voice: monitoring\n' +
    '📵 SMS: disabled\n\n' +
    'Text me at 5559876543 from your 9332 number to give commands!'
  );

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log.info('index', aigentikName + ' v2.0 fully started — Gmail/Google Voice only');
  console.log('\n✅ ' + aigentikName + ' v2.0 running. Press Ctrl+C to stop.\n');
}

main().catch(e => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});