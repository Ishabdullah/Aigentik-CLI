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
  } catch (e) {
    config.aigentik_name = 'Aigentik';
    config.owner_name = 'Ish';
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

// A fresh "book an appointment" request. Aigentik never books unilaterally:
// if they gave a specific time and it's free, book it now; if it's taken,
// recommend the nearest alternative and wait for them to agree; if they
// gave no time at all, offer a few options and wait for them to pick.
async function handleAppointmentRequest({ classified, contact, channel, target, reply, adminEmail, senderLabel }) {
  const attendeeEmail = channel === 'email' ? target : (contact?.emails?.[0] || null);
  if (!attendeeEmail) {
    await reply("I'd love to get this on the calendar — what's a good email address to send the invite to?");
    return true;
  }

  const preferredDate = calendarModule.parseDatetimePhrase(classified.raw_datetime_phrase);
  const duration = classified.duration_hint_minutes || calendarModule.getDurationForRelationship(contact?.relationship);
  // Never book same-day on Aigentik's own initiative — only when explicitly asked for today/tonight
  const afterDate = calendarModule.mentionsToday(classified.raw_datetime_phrase) ? undefined : calendarModule.startOfTomorrow();

  if (preferredDate) {
    const slot = calendarModule.findNextAvailableSlot({ afterDate, durationMinutes: duration, preferredDate });
    if (!slot) {
      await reply("I'm not able to find any open slot near that time — I'll have my owner reach out to schedule directly.");
      await gmail.sendOwnerNotification(`⚠️ Could not find any available slot for a scheduling request from ${senderLabel}.`);
      return true;
    }

    if (slot.start.getTime() === preferredDate.getTime()) {
      const appt = calendarModule.createAppointment({
        title: `Appointment with ${contact?.name || senderLabel}`,
        start: slot.start,
        end: slot.end,
        contactId: contact?.id,
        attendeeName: contact?.name || senderLabel,
        attendeeEmail,
        createdVia: channel
      });
      await gmail.sendCalendarInvite(appt, attendeeEmail);
      await gmail.sendCalendarInvite(appt, adminEmail);
      await reply(`You're booked! ${appt.title} on ${new Date(appt.start).toLocaleString()}. I've sent a calendar invite to ${attendeeEmail}.`);
      await gmail.sendOwnerNotification(`📅 New appointment booked with ${contact?.name || senderLabel}: ${new Date(appt.start).toLocaleString()}`);
      return true;
    }

    // Their requested time isn't free — recommend the nearest alternative
    // and wait for them to agree, rather than booking it for them.
    calendarModule.proposeAppointment({
      title: `Appointment with ${contact?.name || senderLabel}`,
      contactId: contact?.id,
      attendeeName: contact?.name || senderLabel,
      attendeeEmail,
      createdVia: channel,
      offeredSlots: [slot]
    });
    await reply(`That time isn't available. The soonest opening after that is ${new Date(slot.start).toLocaleString()} — does that work, or would you like to suggest another time?`);
    return true;
  }

  // No specific time mentioned — offer a few options and wait for them to choose
  const offers = calendarModule.generateOfferSlots({ durationMinutes: duration, afterDate, count: 3 });
  if (offers.length === 0) {
    await reply("I'm not able to find any open slots right now — I'll have my owner reach out to schedule directly.");
    await gmail.sendOwnerNotification(`⚠️ Could not find any available slots for a scheduling request from ${senderLabel}.`);
    return true;
  }

  calendarModule.proposeAppointment({
    title: `Appointment with ${contact?.name || senderLabel}`,
    contactId: contact?.id,
    attendeeName: contact?.name || senderLabel,
    attendeeEmail,
    createdVia: channel,
    offeredSlots: offers
  });
  await reply(`Happy to set that up — here's what I have open:\n${calendarModule.formatOfferList(offers)}\n\nWhich works for you, or suggest another time?`);
  return true;
}

// A reply to an in-progress negotiation for a brand-new appointment
// (contact has a 'negotiating' record — either they were offered options,
// or their earlier requested time wasn't available and got a counter-offer).
async function handleNegotiationReply({ negotiation, text, reply, adminEmail, senderLabel }) {
  const requestedDate = calendarModule.parseDatetimePhrase(text);
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
    const appt = calendarModule.confirmNegotiation(negotiation.id, slot.start, slot.end);
    if (appt.attendee_email) await gmail.sendCalendarInvite(appt, appt.attendee_email);
    await gmail.sendCalendarInvite(appt, adminEmail);
    await reply(`You're all set! ${appt.title} on ${new Date(appt.start).toLocaleString()}. I've sent a calendar invite.`);
    await gmail.sendOwnerNotification(`📅 Appointment confirmed with ${appt.attendee_name || senderLabel}: ${new Date(appt.start).toLocaleString()}`);
  } else {
    calendarModule.updateNegotiationOffers(negotiation.id, [slot]);
    await reply(`That time isn't available either — the soonest opening after that is ${new Date(slot.start).toLocaleString()}. Does that work, or would you like another time?`);
  }
  return true;
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
    await reply(`Got it — moved to ${new Date(updated.start).toLocaleString()}. Updated invite sent.`);
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
  const requestedDate = calendarModule.parseDatetimePhrase(text);
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
    await reply(`Got it — moved to ${new Date(updated.start).toLocaleString()}. Updated invite sent.`);
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
  await reply(`Done — your appointment on ${new Date(appt.start).toLocaleString()} has been cancelled.`);
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

  // Only treat a message as continuing a negotiation if it plausibly is one —
  // otherwise an unrelated message from a contact with a stale, unanswered
  // offer would get wrongly forced through the negotiation-reply path.
  const looksSchedulingRelevant = llama.mightBeSchedulingRelated(text) || !!calendarModule.parseDatetimePhrase(text);

  const activeNegotiation = contact?.id ? calendarModule.findNegotiationsByContact(contact.id)[0] : null;
  if (activeNegotiation && looksSchedulingRelevant) {
    return await handleNegotiationReply({ negotiation: activeNegotiation, text, reply, adminEmail, senderLabel });
  }

  const confirmedAppts = contact?.id ? calendarModule.findAppointmentsByContact(contact.id) : [];
  const pendingReschedule = confirmedAppts.find(a => a.pending_reschedule);
  if (pendingReschedule && looksSchedulingRelevant) {
    return await handleRescheduleReply({ appt: pendingReschedule, text, reply, adminEmail, senderLabel });
  }

  if (!llama.mightBeSchedulingRelated(text)) return false;

  let classified;
  try {
    classified = await llama.classifySchedulingIntent(text, { current_time: new Date().toISOString() });
  } catch (e) {
    log.error('index', 'Failed to classify scheduling intent', { error: e.message });
    return false;
  }
  if (!classified || classified.intent === 'none') return false;

  if (classified.intent === 'request_appointment') {
    return await handleAppointmentRequest({ classified, contact, channel, target, reply, adminEmail, senderLabel });
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
    text: voiceMsg.body,
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
      agentName
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

  if (action === 'spam') {
    await gmail.markAsSpam({ from: email.from_email });
    log.action('index', 'Email marked spam from ' + email.from_email);
    return;
  }

  // Scheduling requests are handled separately from the normal auto-reply flow
  const schedulingHandled = await handleSchedulingMessage({
    text: email.body,
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
      ownerName, agentName
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