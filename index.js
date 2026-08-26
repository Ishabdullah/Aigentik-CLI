// index.js — Aigentik
// Communication: Gmail + Google Voice ONLY
// No SMS sending or receiving via Termux
// Admin: texts FROM owner.admin_number TO owner.aigentik_number (Google Voice),
// OR emails from owner.admin_email directly — both are routed to the same
// command handler.
// Public: anyone texts owner.aigentik_number (Google Voice)
// All routing via Gmail IMAP IDLE

import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import log from './logger.js';
import config from './config.json' with { type: 'json' };
import pkg from './package.json' with { type: 'json' };
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
import * as subcontractorForm from './subcontractor-form.js';
import * as doNotContact from './do-not-contact.js';
import * as recruiter from './subcontractor-recruiter.js';
import * as customerModule from './customer-module.js';
import * as roleRouter from './role-router.js';

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

// Shared do-not-contact gate for both channels — called before any auto-reply
// or drafting happens. Two cases:
//  1. The identifier is already on the list: silently drop (no reply, no
//     draft) and report it to the admin so they know Aigentik is honoring
//     the block rather than just going quiet.
//  2. The message itself contains opt-out language ("stop texting me",
//     "remove me from your list", etc): add them to the list right now,
//     before any reply goes out, and report what happened.
// Returns true if the caller should stop processing this message.
async function checkDoNotContact({ identifier, name, text, channel }) {
  if (!identifier) return false;

  if (doNotContact.isBlocked(identifier)) {
    log.action('index', `Blocked contact reached out again: ${identifier}`, { channel });
    await gmail.sendOwnerNotification(
      `🚫 Do-Not-Contact: ${name ? name + ' (' + identifier + ')' : identifier} messaged you again via ${channel}, ` +
      `but they're on your do-not-contact list — no reply was sent.\n\nTheir message: "${(text || '').substring(0, 200)}"`
    );
    return true;
  }

  if (doNotContact.detectOptOutRequest(text)) {
    const entry = doNotContact.addToDoNotContact({
      identifier,
      name,
      reason: 'asked to be removed/stopped contacting',
      source: 'auto-detected'
    });
    log.action('index', `Added to do-not-contact from opt-out request: ${identifier}`, { channel });
    await gmail.sendOwnerNotification(
      `🚫 Do-Not-Contact added: ${name ? name + ' (' + identifier + ')' : identifier} asked to be removed via ${channel}.\n` +
      `Aigentik will never contact them again.\n\n` +
      `Their message: "${(text || '').substring(0, 200)}"\n` +
      (entry ? `Stored as: ${entry.value}` : '')
    );
    return true;
  }

  return false;
}

// On a brand-new install there is no profile.json yet (data/ is gitignored,
// so a fresh clone starts with nothing) — create one with owner/business
// fields left unset rather than defaulting them to this deployment's own
// values, so a new install's onboarding email (see sendOnboardingEmail())
// actually triggers instead of silently inheriting a stranger's name.
function loadProfile() {
  try {
    if (!fs.existsSync(PROFILE_FILE)) {
      const fresh = {
        configured: false,
        aigentik_name: 'Aigentik',
        agent_name_set: false,
        setup_date: new Date().toISOString(),
        owner_name: null,
        business_name: null,
        business_description: null,
        onboarding_sent: false
      };
      fs.writeFileSync(PROFILE_FILE, JSON.stringify(fresh, null, 2));
    }
    const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    config.aigentik_name = profile.aigentik_name || 'Aigentik';
    config.owner_name = profile.owner_name || null;
    config.business_name = profile.business_name || null;
    config.business_description = profile.business_description || null;
  } catch (e) {
    config.aigentik_name = 'Aigentik';
    config.owner_name = null;
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

// Calendar invite emails routinely land in spam for a first-time sender, so
// every message that claims to have sent one tells the customer where to
// look if it doesn't show up in their inbox.
function inviteSentNote() {
  return " I've sent a calendar invite to your email — if you don't see it in a few minutes, check your spam folder.";
}

// Name/phone/address live on the linked contact record (collected during
// intake via applyExtractedDetails), not on the appointment itself — this
// pulls them together so the admin gets full customer info on every booking
// notification and invite, not just the name. Used for fresh bookings and
// reschedules alike, since the admin needs the same details either way.
function customerDetailBlock(appt, fallbackLabel, attendeeEmail) {
  const bookedContact = appt.contact_id ? contacts.getContactById(appt.contact_id) : null;
  const name = appt.attendee_name || bookedContact?.name || fallbackLabel;
  const phone = bookedContact?.phones?.[0] || 'not on file';
  const email = attendeeEmail || bookedContact?.emails?.[0] || appt.attendee_email || 'not on file';
  const address = bookedContact?.address || 'not on file';
  let block = `👤 Name: ${name}\n📞 Phone: ${phone}\n📧 Email: ${email}\n🏠 Address: ${address}`;
  // If this appointment is with a subcontractor (e.g. an onboarding call),
  // the admin needs their license/insurance/crew standing right alongside
  // the booking, not just the name.
  const subDetails = contacts.formatSubcontractorDetails(bookedContact);
  if (subDetails) block += '\n' + subDetails;
  return block;
}

// Confirm a negotiation into a real booking, send invites, and reply with
// the confirmation + closing reassurance — the single place this happens so
// every path (fresh intake, time negotiation, reschedule) sounds the same.
async function confirmAndClose({ negotiation, slot, attendeeEmail, adminEmail, senderLabel, reply }) {
  const typeLabel = negotiation.appointment_type === 'in_person' ? 'in-person appointment' : 'phone call';
  const appt = calendarModule.confirmNegotiation(negotiation.id, slot.start, slot.end, attendeeEmail);
  const details = customerDetailBlock(appt, senderLabel, attendeeEmail);
  if (attendeeEmail) await gmail.sendCalendarInvite(appt, attendeeEmail);
  await gmail.sendCalendarInvite(appt, adminEmail,
    `📅 New appointment booked: ${appt.title} at ${new Date(appt.start).toLocaleString()}.\n\n${details}`);
  await reply(
    `You're all set! ${typeLabel} on ${new Date(appt.start).toLocaleString()}.` +
    (attendeeEmail ? inviteSentNote() : '') +
    closingReassurance()
  );
  await gmail.sendOwnerNotification(
    `📅 Appointment confirmed with ${appt.attendee_name || senderLabel} (${typeLabel}): ${new Date(appt.start).toLocaleString()}\n\n${details}`
  );
}

// Stage 1 of a fresh request — a live secretary doesn't hand a caller a
// checklist, they ask a couple of natural follow-up questions based on
// what's already been said. Their opening message (or an existing contact
// record) may already contain name/address/phone AND a stated call-vs-
// in-person preference — all of that is extracted/applied up front and
// dropped from the ask instead of being requested again. Address is only
// ever asked for when it's actually needed (an in-person visit), never
// asked for as a blanket default the way a checklist would.
async function sendIntakeForm({ negotiation, text, contact, reply, senderLabel }) {
  let acknowledgment = '';
  try {
    acknowledgment = await llama.generateAcknowledgment(text, config.aigentik_name, config.business_name, config.business_description);
  } catch (e) {
    log.error('index', 'Failed to generate acknowledgment', { error: e.message });
  }

  // A caller who opens with "we'd rather just discuss it over the phone"
  // has already answered the call-vs-in-person question — asking it again
  // in the same breath as acknowledging what they said would be exactly
  // the kind of not-listening a real secretary never does.
  const detectedType = calendarModule.detectAppointmentTypeFromText(text);
  if (detectedType) negotiation = calendarModule.setAppointmentType(negotiation.id, detectedType);

  let extracted = {};
  try {
    extracted = await llama.extractContactDetails(text, ['name', 'email', 'phone', 'address']);
  } catch (e) {
    log.error('index', 'Failed to extract contact details from initial message', { error: e.message });
  }
  if (contact?.id) contacts.applyExtractedDetails(contact.id, extracted);
  const freshContact = contact?.id ? contacts.getContactById(contact.id) : contact;
  // requiredFieldsForType only pulls in 'address' for an in-person visit —
  // if the type isn't known yet, ask for it conditionally alongside the
  // call-vs-visit question below rather than demanding it up front.
  const requiredNow = detectedType ? requiredFieldsForType(detectedType) : ['name', 'email', 'phone'];
  const missing = contacts.getMissingFields(freshContact, requiredNow);

  const sentences = [];
  const basics = [];
  if (missing.includes('name')) basics.push('your name');
  if (missing.includes('phone')) basics.push('a good phone number');
  if (missing.includes('address')) basics.push('the property address');
  if (basics.length) {
    const basicsText = basics.length > 1
      ? basics.slice(0, -1).join(', ') + (basics.length > 2 ? ',' : '') + ' and ' + basics[basics.length - 1]
      : basics[0];
    sentences.push(`Could you send over ${basicsText}?`);
  }

  if (!detectedType) {
    sentences.push("Also, would a phone call work to go over the details, or would you rather someone come take a look in person? (If in-person, I'll just need the address too.)");
  }

  sentences.push("And what's the best date/time for you, or best time to reach you if a call works better?");

  const form = sentences.join(' ');

  await reply(acknowledgment ? `${acknowledgment} ${form}` : form);
  calendarModule.markFormSent(negotiation.id);
  await gmail.sendOwnerNotification(
    `📋 New scheduling inquiry from ${contact?.name || senderLabel}:\n` +
    `They said: "${text.substring(0, 200)}"\n` +
    (detectedType ? `Detected preference: ${detectedType === 'in_person' ? 'in-person visit' : 'phone call'}\n` : '') +
    `Asked for: ${[...basics, !detectedType ? 'call vs. in-person preference' : null, 'preferred date/time'].filter(Boolean).join(', ')}`
  );
  return true;
}

// Stage 2: their reply to the intake form (or any message before a time has
// been offered). Pulls name/phone/address/concerns and the appointment type
// out of the same message in one pass — someone who answers everything at
// once skips straight to booking; anyone missing something just gets asked
// for what's still missing, not the whole form again.
async function processIntakeReply({ negotiation, text, contact, channel, target, subject, voiceMsg, reply, adminEmail, senderLabel }) {
  const detectedType = negotiation.appointment_type ? null : calendarModule.detectAppointmentTypeFromText(text);
  if (detectedType) negotiation = calendarModule.setAppointmentType(negotiation.id, detectedType);

  let extracted = {};
  try {
    extracted = await llama.extractContactDetails(text, ['name', 'email', 'phone', 'address', 'concerns']);
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
    const ask = `Before I can get this scheduled, could you also share ${asks.join(' and ')}?`;

    // If the message didn't actually contribute anything toward the intake
    // (no field extracted, no type detected, no date/time parsed), it's
    // likely an unrelated question rather than a partial answer to the
    // form — answer it for real instead of silently ignoring it and just
    // repeating the outstanding ask.
    const contributedNothing = !detectedType &&
      !Object.values(extracted || {}).some(v => v) &&
      !calendarModule.parseDatetimePhrase(text);

    if (contributedNothing) {
      let answer = '';
      try {
        const ownerName = config.owner_name || null;
        const agentName = config.aigentik_name || 'Aigentik';
        const businessName = config.business_name || null;
        const businessDescription = config.business_description || null;
        if (channel === 'email') {
          const generated = await llama.generateEmailReply(
            senderLabel, target, subject, text,
            freshContact?.relationship, freshContact?.instructions,
            ownerName, agentName, businessName, businessDescription
          );
          answer = generated.text;
        } else {
          const detectedTone = await tone.detectTone(text);
          answer = await llama.generateSmsReply(
            voiceMsg?.sender_phone, voiceMsg?.sender_name, text, detectedTone,
            freshContact?.relationship, freshContact?.instructions,
            ownerName, agentName, businessName, businessDescription
          );
        }
      } catch (e) {
        log.error('index', 'Failed to generate answer for off-topic intake reply', { error: e.message });
      }
      await reply(answer ? `${answer}\n\n${ask}` : `Thanks! ${ask}`);
      return true;
    }

    await reply(`Thanks! ${ask}`);
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
async function advanceScheduling({ negotiation, text, contact, channel, target, subject, voiceMsg, reply, adminEmail, senderLabel }) {
  if (!negotiation.form_sent) {
    return await sendIntakeForm({ negotiation, text, contact, reply, senderLabel });
  }
  if (negotiation.offered_slots.length === 0) {
    return await processIntakeReply({ negotiation, text, contact, channel, target, subject, voiceMsg, reply, adminEmail, senderLabel });
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
    const details = customerDetailBlock(updated, contact?.name || senderLabel, updated.attendee_email);
    if (updated.attendee_email) await gmail.sendCalendarInvite(updated, updated.attendee_email);
    await gmail.sendCalendarInvite(updated, adminEmail,
      `🔁 Appointment rescheduled: ${updated.title} now at ${new Date(updated.start).toLocaleString()}.\n\n${details}`);
    await reply(
      `Got it — moved to ${new Date(updated.start).toLocaleString()}.` +
      (updated.attendee_email ? inviteSentNote() : ' Updated invite sent.') +
      closingReassurance()
    );
    await gmail.sendOwnerNotification(
      `🔁 Appointment rescheduled for ${contact?.name || senderLabel}: now ${new Date(updated.start).toLocaleString()}\n\n${details}`
    );
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
    const details = customerDetailBlock(updated, senderLabel, updated.attendee_email);
    if (updated.attendee_email) await gmail.sendCalendarInvite(updated, updated.attendee_email);
    await gmail.sendCalendarInvite(updated, adminEmail,
      `🔁 Appointment rescheduled: ${updated.title} now at ${new Date(updated.start).toLocaleString()}.\n\n${details}`);
    await reply(
      `Got it — moved to ${new Date(updated.start).toLocaleString()}.` +
      (updated.attendee_email ? inviteSentNote() : ' Updated invite sent.') +
      closingReassurance()
    );
    await gmail.sendOwnerNotification(
      `🔁 Appointment rescheduled for ${senderLabel}: now ${new Date(updated.start).toLocaleString()}\n\n${details}`
    );
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
    return await advanceScheduling({ negotiation: activeNegotiation, text, contact, channel, target, subject, voiceMsg, reply, adminEmail, senderLabel });
  }

  const confirmedAppts = contact?.id ? calendarModule.findAppointmentsByContact(contact.id) : [];
  const pendingReschedule = confirmedAppts.find(a => a.pending_reschedule);
  if (pendingReschedule) {
    return await handleRescheduleReply({ appt: pendingReschedule, text, reply, adminEmail, senderLabel });
  }

  // A known subcontractor with no negotiation/reschedule already in flight
  // (both handled above, unconditionally) isn't a homeowner requesting an
  // appointment — let role-router route them into the subcontractor flow
  // instead of the customer-appointment classifier below.
  const isKnownSubcontractor = contact?.active_role === 'SUBCONTRACTOR' || contact?.type === 'subcontractor';
  if (isKnownSubcontractor) return false;

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
    // A price/estimate question ("how much are bathroom remodels usually?")
    // reads as wanting an appointment even from someone who already has one
    // confirmed — classifySchedulingIntent has no way to know that. Rather
    // than propose a redundant second appointment, let this fall through to
    // the normal reply flow, which can just answer the question (and, once
    // it has appointment context — see generateCustomerReply/generateSmsReply/
    // generateEmailReply — can reference the existing booking naturally).
    const existingAppt = contact?.id ? calendarModule.findUpcomingAppointmentForContact(contact.id) : null;
    if (existingAppt) {
      log.info('index', `Skipping duplicate appointment proposal for ${senderLabel} — already has ${existingAppt.id} confirmed`);
      return false;
    }
    const negotiation = calendarModule.proposeAppointment({
      title: `Appointment with ${contact?.name || senderLabel}`,
      contactId: contact?.id,
      attendeeName: contact?.name || senderLabel,
      attendeeEmail: channel === 'email' ? target : (contact?.emails?.[0] || null),
      createdVia: channel
    });
    return await advanceScheduling({ negotiation, text, contact, channel, target, subject, voiceMsg, reply, adminEmail, senderLabel });
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
// A subcontractor application arrived as a structured lead-form
// submission — parse it deterministically, save the applicant as a
// 'subcontractor' contact (distinct from a regular customer contact) with
// their trade/license/insurance/crew standing, acknowledge receipt with a
// subcontractor-specific reply (never the customer auto-reply prompt), and
// give the admin the full application in one notification.
async function handleSubcontractorApplication(email) {
  if (doNotContact.isBlocked(email.from_email)) {
    log.action('index', `Blocked contact sent a subcontractor application: ${email.from_email}`);
    await gmail.sendOwnerNotification(
      `🚫 Do-Not-Contact: ${email.from_email} submitted a subcontractor application, but they're on your do-not-contact list — no acknowledgment was sent.`
    );
    return;
  }

  const parsed = subcontractorForm.parseApplication(email.body || '');
  const contact = contacts.findOrCreateByEmail(email.from_email, parsed.principal_name || email.from_name);
  contacts.applySubcontractorDetails(contact.id, parsed);
  contacts.addHistory(email.from_email, {
    type: 'subcontractor_application',
    trade: parsed.trade_raw || parsed.trade,
    business_name: parsed.business_name
  });

  // Record in Restoricon recruitment pipeline
  const subLead = recruiter.createOrUpdateSubcontractorLead({
    contact_id: contact.id,
    company_name: parsed.business_name,
    legal_name: parsed.business_name,
    contact_name: parsed.principal_name || email.from_name,
    phone: parsed.phone,
    email: email.from_email,
    primary_trade: parsed.trade,
    license_number: parsed.license_number,
    license_status: parsed.licensed ? 'LICENSE_VERIFIED' : (parsed.license_number ? 'LICENSE_PENDING_VERIFICATION' : null),
    general_liability: parsed.gl_insurance,
    workers_comp: parsed.wc_insurance,
    crew_size: parsed.crew_size,
    availability: parsed.weekly_capacity,
    references: parsed.references,
    lead_source: 'application_form'
  });

  log.action('index', 'Subcontractor application received from ' + email.from_email, {
    business: parsed.business_name,
    trade: parsed.trade_raw,
    subcontractorId: subLead?.subcontractor_id
  });

  try {
    const agentName = config.aigentik_name || 'Aigentik';
    const ownerName = config.owner_name || null;
    const businessName = config.business_name || null;
    const businessDescription = config.business_description || null;

    const ack = await llama.generateSubcontractorAck(
      parsed.principal_name || email.from_name,
      parsed.business_name,
      parsed.trade_raw || parsed.trade,
      agentName, businessName, businessDescription
    );
    const signature = llama.buildEmailSignature(agentName, businessName, ownerName, null);
    await gmail.sendReply(
      email.from_email,
      email.subject,
      ack + signature.text,
      llama.textToHtml(ack) + signature.html
    );
  } catch (e) {
    log.error('index', 'Failed to send subcontractor application ack', { error: e.message });
  }

  await gmail.sendOwnerNotification(subcontractorForm.formatApplicationSummary(parsed));
}

async function handleGoogleVoiceText(email) {
  const voiceMsg = gmail.parseGoogleVoiceEmail(email);

  if (!voiceMsg.body || !voiceMsg.sender_phone) {
    log.warn('index', 'Could not parse Google Voice message', { subject: email.subject });
    return;
  }

  log.info('index', 'Google Voice text from ' + (voiceMsg.sender_name || voiceMsg.sender_phone),
    { body: voiceMsg.body.substring(0, 50) });

  const ownerName = config.owner_name || null;
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

  // Do-not-contact check must happen before any reply/draft is generated
  const dncHandled = await checkDoNotContact({
    identifier: voiceMsg.sender_phone,
    name: voiceMsg.sender_name || contact?.name,
    text: stripQuotedReply(voiceMsg.body) || voiceMsg.body,
    channel: 'sms'
  });
  if (dncHandled) return;

  // Check for urgent keyword
  if (ownerName && voiceMsg.body.toLowerCase().includes(ownerName.toLowerCase())) {
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
                          (contact?.reply_behavior !== 'review' && action === 'auto-reply');

  try {
    // Computed once and threaded into whichever reply generator ends up
    // running below, so an already-confirmed appointment can be mentioned
    // naturally when relevant instead of being invisible to the reply (or,
    // via the duplicate-booking guard in handleSchedulingMessage above,
    // getting silently re-proposed).
    const upcomingAppt = contact?.id ? calendarModule.findUpcomingAppointmentForContact(contact.id) : null;
    const appointmentContext = upcomingAppt ? calendarModule.formatAppointment(upcomingAppt) : null;

    const person = roleRouter.resolvePersonAndRoles({
      phone: voiceMsg.sender_phone,
      name: voiceMsg.sender_name
    });

    const classification = await roleRouter.detectRoleAndIntent({
      message: voiceMsg.body,
      person,
      channel: 'sms'
    });

    log.info('index', `Role classification for ${voiceMsg.sender_phone}: Role=${classification.detected_role}, Intent=${classification.detected_intent}, Workflow=${classification.workflow}`);

    let reply = '';

    if (classification.workflow === roleRouter.WORKFLOWS.AMBIGUOUS_CLARIFICATION) {
      reply = (classification.clarification_needed ||
        "Thank you for reaching out to Restoricon! Are you looking to get work done on your own property, or are you inquiring about trade subcontractor opportunities with us?") +
        "\n\n— " + agentName + ", Restoricon";
    } else if (
      classification.workflow === roleRouter.WORKFLOWS.SUBCONTRACTOR_RECRUITMENT ||
      classification.workflow === roleRouter.WORKFLOWS.SUBCONTRACTOR_ACTIVE ||
      classification.detected_role === roleRouter.ROLES.SUBCONTRACTOR
    ) {
      let extracted = {};
      try {
        extracted = await llama.extractRecruiterQualification(voiceMsg.body, person.subcontractor_record || {});
      } catch (err) {
        log.warn('index', 'Failed to extract recruiter qualification details', { error: err.message });
      }

      let currentSub = person.subcontractor_record;
      if (!currentSub) {
        currentSub = recruiter.createOrUpdateSubcontractorLead({
          contact_id: contact?.id,
          contact_name: voiceMsg.sender_name,
          phone: voiceMsg.sender_phone,
          company_name: extracted.company_name || person.organization?.company_name || voiceMsg.sender_name,
          primary_trade: extracted.primary_trade || person.organization?.trade || contact?.trade,
          lead_source: 'incoming_sms',
          ...extracted
        });
      } else if (Object.keys(extracted).length > 0) {
        currentSub = recruiter.updateSubcontractor(currentSub.subcontractor_id, extracted);
      }

      reply = await llama.generateRecruiterReply({
        channel: 'sms',
        senderPhone: voiceMsg.sender_phone,
        senderName: voiceMsg.sender_name,
        message: voiceMsg.body,
        subcontractor: currentSub,
        agentName,
        ownerName,
        businessName,
        businessDescription
      });
    } else if (
      classification.workflow === roleRouter.WORKFLOWS.CUSTOMER_INTAKE_SALES ||
      classification.workflow === roleRouter.WORKFLOWS.CUSTOMER_SUPPORT ||
      classification.detected_role === roleRouter.ROLES.CUSTOMER
    ) {
      const isEmergency = customerModule.checkEmergencyKeywords(voiceMsg.body);
      const isEscalation = customerModule.checkEscalationKeywords(voiceMsg.body);

      let extracted = {};
      try {
        extracted = await llama.extractCustomerIntake(voiceMsg.body, person.customer_record || {});
      } catch (err) {
        log.warn('index', 'Failed to extract customer intake details', { error: err.message });
      }

      let currentCust = person.customer_record;
      if (!currentCust) {
        currentCust = customerModule.createOrUpdateCustomer({
          customer_name: voiceMsg.sender_name || extracted.customer_name || 'Homeowner',
          phone: voiceMsg.sender_phone,
          escalation_status: isEmergency ? 'EMERGENCY_REVIEW' : (isEscalation ? 'HUMAN_REVIEW_REQUIRED' : null),
          ...extracted
        });
      } else {
        currentCust = customerModule.updateCustomer(currentCust.customer_id, {
          escalation_status: isEmergency ? 'EMERGENCY_REVIEW' : (isEscalation ? 'HUMAN_REVIEW_REQUIRED' : currentCust.escalation_status),
          ...extracted
        });
      }

      if (isEmergency) {
        const handoff = customerModule.formatHandoffSummary({
          customer: currentCust,
          issue: '🚨 ACTIVE EMERGENCY DETECTED (Water/Fire/Safety/Structural)',
          urgency: 'Immediate',
          whatCustomerWants: 'Immediate emergency response / stabilization',
          nextAction: 'Call customer immediately and dispatch emergency mitigation team'
        });
        await gmail.sendOwnerNotification(handoff);
      } else if (isEscalation) {
        const handoff = customerModule.formatHandoffSummary({
          customer: currentCust,
          issue: '⚠️ HUMAN REVIEW / ESCALATION REQUESTED',
          urgency: 'High',
          whatCustomerWants: extracted.escalation_reason || 'Speak with Restoricon manager/owner'
        });
        await gmail.sendOwnerNotification(handoff);
      }

      reply = await llama.generateCustomerReply({
        channel: 'sms',
        senderPhone: voiceMsg.sender_phone,
        senderName: voiceMsg.sender_name,
        message: voiceMsg.body,
        customer: currentCust,
        agentName,
        ownerName,
        businessName,
        businessDescription,
        appointmentContext
      });
    } else {
      const shouldDetectTone = config.behavior?.tone_matching !== false;
      const detectedTone = shouldDetectTone ? await tone.detectTone(voiceMsg.body) : 'neutral';
      const contactRole = contact?.relationship || 'acquaintance';
      reply = await llama.generateSmsReply(
        voiceMsg.sender_phone,
        voiceMsg.sender_name,
        voiceMsg.body,
        detectedTone,
        contactRole,
        contact?.instructions,
        ownerName,
        agentName,
        businessName,
        businessDescription,
        appointmentContext
      );
    }

    // Update multi-roles and active role in contacts memory
    roleRouter.updatePersonRolesAndState({
      person,
      classification,
      contactId: contact?.id
    });

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

  // Subcontractor applications get their own distinct handling — parsed
  // deterministically (like scheduling's date math) rather than through the
  // general auto-reply flow, saved as a 'subcontractor' contact rather than
  // a regular customer, and acknowledged with a subcontractor-specific
  // reply instead of the customer reply prompt.
  if (subcontractorForm.isSubcontractorApplication(email)) {
    await handleSubcontractorApplication(email);
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

  // Do-not-contact check must happen before any reply/draft is generated
  const dncHandled = await checkDoNotContact({
    identifier: email.from_email,
    name: email.from_name || contact?.name,
    text: stripQuotedReply(email.body) || email.body,
    channel: 'email'
  });
  if (dncHandled) return;

  // Check contact behavior
  if (contact?.reply_behavior === 'never') {
    log.info('index', 'Contact set to never reply — skipping');
    return;
  }

  const { action } = emailRules.checkRules({
    from: email.from_email,
    subject: email.subject,
    body: email.body
  });

  const ownerName = config.owner_name || null;
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

  const shouldAutoReply = contact?.reply_behavior === 'always' ||
                          (contact?.reply_behavior !== 'review' && action === 'auto-reply');

  try {
    const fullEmailContent = `${email.subject || ''}\n\n${email.body || ''}`;
    // See the matching comment in handleGoogleVoiceText — same reasoning.
    const upcomingApptEmail = contact?.id ? calendarModule.findUpcomingAppointmentForContact(contact.id) : null;
    const appointmentContext = upcomingApptEmail ? calendarModule.formatAppointment(upcomingApptEmail) : null;

    const person = roleRouter.resolvePersonAndRoles({
      email: email.from_email,
      name: email.from_name
    });

    const classification = await roleRouter.detectRoleAndIntent({
      message: fullEmailContent,
      person,
      channel: 'email'
    });

    log.info('index', `Email role classification for ${email.from_email}: Role=${classification.detected_role}, Intent=${classification.detected_intent}, Workflow=${classification.workflow}`);

    let reply;

    if (classification.workflow === roleRouter.WORKFLOWS.AMBIGUOUS_CLARIFICATION) {
      const clarifyText = (classification.clarification_needed ||
        "Thank you for contacting Restoricon! Are you inquiring about a remodeling or restoration project for your home, or are you looking to partner with us as a trade subcontractor?") +
        "\n\n— " + agentName + ", Restoricon, LLC";
      reply = {
        text: clarifyText,
        html: `<p>${clarifyText.replace(/\n\n/g, '</p><p>')}</p>`
      };
    } else if (
      classification.workflow === roleRouter.WORKFLOWS.SUBCONTRACTOR_RECRUITMENT ||
      classification.workflow === roleRouter.WORKFLOWS.SUBCONTRACTOR_ACTIVE ||
      classification.detected_role === roleRouter.ROLES.SUBCONTRACTOR
    ) {
      let extracted = {};
      try {
        extracted = await llama.extractRecruiterQualification(email.body || '', person.subcontractor_record || {});
      } catch (err) {
        log.warn('index', 'Failed to extract recruiter qualification from email', { error: err.message });
      }

      let currentSub = person.subcontractor_record;
      if (!currentSub) {
        currentSub = recruiter.createOrUpdateSubcontractorLead({
          contact_id: contact?.id,
          contact_name: email.from_name,
          email: email.from_email,
          company_name: extracted.company_name || person.organization?.company_name || email.from_name,
          primary_trade: extracted.primary_trade || person.organization?.trade || contact?.trade,
          lead_source: 'incoming_email',
          ...extracted
        });
      } else if (Object.keys(extracted).length > 0) {
        currentSub = recruiter.updateSubcontractor(currentSub.subcontractor_id, extracted);
      }

      reply = await llama.generateRecruiterReply({
        channel: 'email',
        senderEmail: email.from_email,
        senderName: email.from_name,
        message: email.body,
        subcontractor: currentSub,
        agentName,
        ownerName,
        businessName,
        businessDescription
      });
    } else if (
      classification.workflow === roleRouter.WORKFLOWS.CUSTOMER_INTAKE_SALES ||
      classification.workflow === roleRouter.WORKFLOWS.CUSTOMER_SUPPORT ||
      classification.detected_role === roleRouter.ROLES.CUSTOMER
    ) {
      const isEmergency = customerModule.checkEmergencyKeywords(fullEmailContent);
      const isEscalation = customerModule.checkEscalationKeywords(fullEmailContent);

      let extracted = {};
      try {
        extracted = await llama.extractCustomerIntake(fullEmailContent, person.customer_record || {});
      } catch (err) {
        log.warn('index', 'Failed to extract customer intake from email', { error: err.message });
      }

      let currentCust = person.customer_record;
      if (!currentCust) {
        currentCust = customerModule.createOrUpdateCustomer({
          customer_name: email.from_name || extracted.customer_name || 'Homeowner',
          email: email.from_email,
          lead_source: 'incoming_email',
          escalation_status: isEmergency ? 'EMERGENCY_REVIEW' : (isEscalation ? 'HUMAN_REVIEW_REQUIRED' : null),
          ...extracted
        });
      } else {
        currentCust = customerModule.updateCustomer(currentCust.customer_id, {
          escalation_status: isEmergency ? 'EMERGENCY_REVIEW' : (isEscalation ? 'HUMAN_REVIEW_REQUIRED' : currentCust.escalation_status),
          ...extracted
        });
      }

      if (isEmergency) {
        const handoff = customerModule.formatHandoffSummary({
          customer: currentCust,
          issue: '🚨 ACTIVE EMERGENCY DETECTED VIA EMAIL',
          urgency: 'Immediate',
          whatCustomerWants: 'Emergency restoration / stabilization assessment',
          nextAction: 'Contact customer immediately by phone/email and dispatch emergency team'
        });
        await gmail.sendOwnerNotification(handoff);
      } else if (isEscalation) {
        const handoff = customerModule.formatHandoffSummary({
          customer: currentCust,
          issue: '⚠️ HUMAN REVIEW / ESCALATION REQUESTED VIA EMAIL',
          urgency: 'High',
          whatCustomerWants: extracted.escalation_reason || 'Direct communication with owner/manager'
        });
        await gmail.sendOwnerNotification(handoff);
      }

      reply = await llama.generateCustomerReply({
        channel: 'email',
        senderEmail: email.from_email,
        senderName: email.from_name,
        message: fullEmailContent,
        customer: currentCust,
        agentName,
        ownerName,
        businessName,
        businessDescription,
        appointmentContext
      });
    } else {
      const contactRole = contact?.relationship || 'acquaintance';
      reply = await llama.generateEmailReply(
        email.from_name, email.from_email, email.subject,
        email.body?.substring(0, 1000),
        contactRole, contact?.instructions,
        ownerName, agentName,
        businessName, businessDescription,
        appointmentContext
      );
    }

    // Update multi-roles and active role in contacts memory
    roleRouter.updatePersonRolesAndState({
      person,
      classification,
      contactId: contact?.id
    });

    if (shouldAutoReply) {
      await gmail.sendReply(email.from_email, email.subject, reply.text, reply.html);
      contacts.addHistory(email.from_email, { type: 'email_auto_replied' });
      await gmail.sendOwnerNotification(
        '✉️ Auto-replied to ' + (email.from_name || email.from_email) + ':\n' +
        'Subject: ' + email.subject?.substring(0, 50) + '\n' +
        'Sent: "' + reply.text.substring(0, 80) + '"'
      );
    } else {
      const item = queue.addToQueue({
        type: 'email',
        sender: email.from_email,
        senderName: email.from_name,
        subject: email.subject,
        body: email.body?.substring(0, 300),
        draftReply: reply.text,
        contactId: contact?.id,
        uid: email.uid
      });
      await gmail.sendOwnerNotification(
        '✉️ Email #' + item.display_id + ' from ' +
        (email.from_name || email.from_email) + ':\n' +
        'Subject: ' + email.subject?.substring(0, 50) + '\n' +
        'Draft: "' + reply.text.substring(0, 80) + '"\n\n' +
        'Reply "reply ' + item.display_id + '" to send'
      );
    }
  } catch (e) {
    log.error('index', 'Failed to process email', { error: e.message });
  }
}

// Ask the admin for whatever identity info is still missing (owner's name
// and/or business name + description) — sent once per install via the flag
// in profile.json, not on every restart, since the admin may take a while
// to reply and a crash-loop shouldn't spam them. The reply is picked up by
// ownerCommand's onboarding check (owner-command.js) the next time an email
// arrives from the admin address.
async function sendOnboardingEmail() {
  let profile;
  try {
    profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
  } catch (e) {
    return;
  }

  const needsOwnerName = !config.owner_name;
  const needsBusiness = !config.business_name;
  const needsAgentName = !profile.agent_name_set;
  if (!needsOwnerName && !needsBusiness && !needsAgentName) return;
  if (profile.onboarding_sent) return;

  const asks = [];
  if (needsOwnerName) asks.push('- Your name, so I know what to call you');
  if (needsAgentName) asks.push('- What you\'d like to call me — I\'ll keep going by "Aigentik" if you skip this');
  if (needsBusiness) asks.push('- Your business name');
  if (needsBusiness) asks.push('- What your business does, and anything else about it I should know so I can answer questions from customers or subcontractors (services offered, service area, specialties, etc.)');

  await gmail.sendOwnerNotification(
    `👋 Hi! I'm ${config.aigentik_name}, your new AI assistant.\n\n` +
    `Before I start replying to emails and texts on your behalf, I need a couple things:\n\n` +
    asks.join('\n') + '\n\n' +
    `Just reply to this email in your own words, filling in the blanks — for example:\n` +
    `"My name is [your name]. Call yourself [name you want me to go by]. The business is [business name], [what the business does and anything else customers or subcontractors might ask about]."`
  );

  profile.onboarding_sent = true;
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
  log.action('index', 'Sent onboarding request email to admin');
}

// Graceful shutdown
async function shutdown(signal) {
  log.info('index', signal + ' received — shutting down Aigentik');
  await gmail.disconnect();
  stopLlamaServer();
  process.exit(0);
}

async function main() {
  console.log('\n🤖 Aigentik v' + pkg.version + ' — Starting up...\n');

  loadProfile();

  // Only spin up the local llama-server when it's actually the configured
  // provider — a Gemini-only setup has no local model to launch or wait on.
  if (llama.getLlmProvider() === 'local') {
    const llamaOk = await startLlamaServer();
    if (!llamaOk) {
      log.error('index', 'Cannot start without llama-server');
      process.exit(1);
    }
  }

  // Warm up AI (whichever provider is configured)
  const warmedUp = await llama.warmUp();
  if (!warmedUp) {
    log.error('index', `AI provider (${llama.getLlmProvider()}) not responding`);
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
  if (!config.owner_name || !config.business_name) {
    await sendOnboardingEmail();
  } else {
    const pending = queue.listQueue();
    await gmail.sendOwnerNotification(
      '✅ ' + aigentikName + ' v' + pkg.version + ' is online!\n' +
      '📬 Pending: ' + pending.length + '\n' +
      '📧 Email: ' + (config.behavior.pause_email ? 'paused' : 'monitoring') + '\n' +
      '💬 Google Voice (texting): ' + (config.behavior.pause_sms ? 'paused' : 'monitoring') + '\n\n' +
      'Text me at ' + config.owner.aigentik_number_formatted + ' from your ' + config.owner.admin_number_formatted + ' number to give commands!'
    );
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log.info('index', aigentikName + ' v' + pkg.version + ' fully started — Gmail/Google Voice only');
  console.log('\n✅ ' + aigentikName + ' v' + pkg.version + ' running. Press Ctrl+C to stop.\n');
}

main().catch(e => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});