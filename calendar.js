// calendar.js — Aigentik self-hosted appointment calendar
// No external calendar API/OAuth — Aigentik is the source of truth for
// appointments, pushed to real calendars via .ics invite emails
// (see email-provider.js). Same load/save-flat-file pattern as contacts.js.

import fs from 'fs';
import path from 'path';
import * as chrono from 'chrono-node';
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const CALENDAR_FILE = path.join(config.paths.data_dir, 'calendar.json');
const SCHEDULE_CONFIG_FILE = path.join(config.paths.data_dir, 'schedule-config.json');

// Fully open by default (all 7 days, 00:00-23:59) — Aigentik doesn't know your
// real availability until you tell it, so it shouldn't invent a 9-5 Mon-Fri
// assumption on your behalf. Narrow it down with "set working hours ...".
const OPEN_DAY = { start: '00:00', end: '23:59' };
const DEFAULT_SCHEDULE_CONFIG = {
  working_hours: {
    sun: { ...OPEN_DAY }, mon: { ...OPEN_DAY }, tue: { ...OPEN_DAY }, wed: { ...OPEN_DAY },
    thu: { ...OPEN_DAY }, fri: { ...OPEN_DAY }, sat: { ...OPEN_DAY }
  },
  default_duration_minutes: 30,
  buffer_minutes: 15,
  booking_window_days: 365,
  duration_by_relationship: {}
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// ─── Storage ────────────────────────────────────────────────────────────────

function loadCalendar() {
  try {
    if (fs.existsSync(CALENDAR_FILE)) {
      return JSON.parse(fs.readFileSync(CALENDAR_FILE, 'utf8'));
    }
  } catch (e) {
    log.warn('calendar', 'Could not load calendar file', { error: e.message });
  }
  return [];
}

function saveCalendar(appointments) {
  try {
    fs.writeFileSync(CALENDAR_FILE, JSON.stringify(appointments, null, 2));
  } catch (e) {
    log.error('calendar', 'Failed to save calendar', { error: e.message });
  }
}

function loadScheduleConfig() {
  try {
    if (fs.existsSync(SCHEDULE_CONFIG_FILE)) {
      return { ...DEFAULT_SCHEDULE_CONFIG, ...JSON.parse(fs.readFileSync(SCHEDULE_CONFIG_FILE, 'utf8')) };
    }
  } catch (e) {
    log.warn('calendar', 'Could not load schedule config, using defaults', { error: e.message });
  }
  return { ...DEFAULT_SCHEDULE_CONFIG };
}

function saveScheduleConfig(scheduleConfig) {
  try {
    fs.writeFileSync(SCHEDULE_CONFIG_FILE, JSON.stringify(scheduleConfig, null, 2));
  } catch (e) {
    log.error('calendar', 'Failed to save schedule config', { error: e.message });
  }
}

function generateAppointmentId(appointments) {
  const maxId = appointments.reduce((max, a) => {
    const num = parseInt(a.id.replace('appt_', ''));
    return num > max ? num : max;
  }, 0);
  return `appt_${String(maxId + 1).padStart(4, '0')}`;
}

// ─── Working hours / duration rules ────────────────────────────────────────

function getDurationForRelationship(relationship) {
  const scheduleConfig = loadScheduleConfig();
  if (relationship) {
    const rel = relationship.toLowerCase().trim();
    if (scheduleConfig.duration_by_relationship?.[rel]) {
      return scheduleConfig.duration_by_relationship[rel];
    }
  }
  return scheduleConfig.default_duration_minutes;
}

function setWorkingHours(days, start, end) {
  const scheduleConfig = loadScheduleConfig();
  days.forEach(day => {
    const key = day.toLowerCase().slice(0, 3);
    if (DAY_KEYS.includes(key)) {
      scheduleConfig.working_hours[key] = { start, end };
    }
  });
  saveScheduleConfig(scheduleConfig);
  log.info('calendar', 'Working hours updated', { days, start, end });
  return scheduleConfig.working_hours;
}

function setDayOff(days) {
  const scheduleConfig = loadScheduleConfig();
  days.forEach(day => {
    const key = day.toLowerCase().slice(0, 3);
    if (DAY_KEYS.includes(key)) {
      scheduleConfig.working_hours[key] = null;
    }
  });
  saveScheduleConfig(scheduleConfig);
  return scheduleConfig.working_hours;
}

function setDurationForRelationship(relationship, minutes) {
  const scheduleConfig = loadScheduleConfig();
  scheduleConfig.duration_by_relationship[relationship.toLowerCase().trim()] = minutes;
  saveScheduleConfig(scheduleConfig);
  log.info('calendar', `Appointment duration set for ${relationship}: ${minutes}min`);
  return scheduleConfig;
}

function formatWorkingHours() {
  const scheduleConfig = loadScheduleConfig();
  const lines = DAY_KEYS.filter(k => k !== 'sun' || true).map(key => {
    const label = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' }[key];
    const hours = scheduleConfig.working_hours[key];
    return `${label}: ${hours ? `${hours.start}-${hours.end}` : 'off'}`;
  });
  return lines.join(', ');
}

// ─── Natural-language phrase parsing (deterministic, no LLM date math) ────

// Turn a raw phrase like "next tuesday at 2pm" into a concrete Date, anchored
// to now. Returns null if chrono can't find a date in it. forwardDate:true
// so an ambiguous month/day that's already passed this year ("July 3rd" said
// in August) resolves to next year, not a date in the past — appointments
// are never booked in the past, so rolling forward is always correct here.
function parseDatetimePhrase(phrase, anchorDate) {
  if (!phrase) return null;
  const result = chrono.parseDate(phrase, anchorDate ? new Date(anchorDate) : new Date(), { forwardDate: true });
  return result || null;
}

// Like parseDatetimePhrase, but also reports whether an explicit date (day/
// weekday/month) was actually stated, vs. only a time with the date
// defaulted by chrono from the anchor. Callers use this to tell "Tuesday at
// 2pm" (explicit) apart from a bare "how about 11am instead" (not explicit —
// should be anchored to whatever date is already under discussion, not to
// "now"). Returns null if chrono finds nothing at all.
function parseDatetimeDetailed(phrase, anchorDate) {
  if (!phrase) return null;
  const results = chrono.parse(phrase, anchorDate ? new Date(anchorDate) : new Date(), { forwardDate: true });
  if (results.length === 0) return null;
  const start = results[0].start;
  const hasExplicitDate = start.isCertain('day') || start.isCertain('weekday') || start.isCertain('month');
  return { date: start.date(), hasExplicitDate };
}

// Combine a bare time-of-day (from a chrono result with no explicit date)
// with a separate anchor date — used when someone replies with just a time
// during an active negotiation, so "11am" means "11am on the date we were
// just discussing," not "11am today."
function combineTimeWithDate(timeOnlyDate, anchorDate) {
  const combined = new Date(anchorDate);
  combined.setHours(timeOnlyDate.getHours(), timeOnlyDate.getMinutes(), 0, 0);
  return combined;
}

const DAY_NAME_TO_KEY = {
  sunday: 'sun', sun: 'sun', monday: 'mon', mon: 'mon', tuesday: 'tue', tue: 'tue', tues: 'tue',
  wednesday: 'wed', wed: 'wed', thursday: 'thu', thu: 'thu', thurs: 'thu',
  friday: 'fri', fri: 'fri', saturday: 'sat', sat: 'sat'
};
const DAY_ORDER = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Shared by parseWorkingHoursPhrase and parseDayOffPhrase: pull day names
// out of a lowercased phrase, expanding "weekday(s)"/"weekend(s)" and
// "X through/to Y" ranges, falling back to a plain substring scan.
function extractDaysFromPhrase(lower) {
  if (/weekday/.test(lower)) return ['mon', 'tue', 'wed', 'thu', 'fri'];
  if (/weekend/.test(lower)) return ['sat', 'sun'];

  const dayNamesPattern = Object.keys(DAY_NAME_TO_KEY).sort((a, b) => b.length - a.length).join('|');
  const dayRangeRegex = new RegExp(`\\b(${dayNamesPattern})\\b\\s*(?:through|to|-)\\s*\\b(${dayNamesPattern})\\b`);
  const rangeMatch = lower.match(dayRangeRegex);
  if (rangeMatch && DAY_NAME_TO_KEY[rangeMatch[1]] && DAY_NAME_TO_KEY[rangeMatch[2]]) {
    const days = [];
    const startIdx = DAY_ORDER.indexOf(DAY_NAME_TO_KEY[rangeMatch[1]]);
    const endIdx = DAY_ORDER.indexOf(DAY_NAME_TO_KEY[rangeMatch[2]]);
    for (let i = startIdx; ; i = (i + 1) % 7) {
      days.push(DAY_ORDER[i]);
      if (i === endIdx) break;
    }
    return days;
  }

  const days = Object.keys(DAY_NAME_TO_KEY)
    .filter(name => lower.includes(name))
    .map(name => DAY_NAME_TO_KEY[name]);
  return [...new Set(days)];
}

// Turn a phrase like "9am to 5pm monday through friday" into
// { days: ['mon','tue',...], start: 'HH:MM', end: 'HH:MM' }, or null if it
// can't be parsed. Handled deterministically (not by the LLM) since it's a
// well-bounded extraction task and the failure mode of a wrong config is bad.
function parseWorkingHoursPhrase(phrase) {
  if (!phrase) return null;
  const lower = phrase.toLowerCase();

  const timeRangeMatch = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:to|-|through|until)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (!timeRangeMatch) return null;

  const to24h = (h, m, meridiem, fallbackMeridiem) => {
    let hour = parseInt(h, 10);
    const min = m ? parseInt(m, 10) : 0;
    const mer = meridiem || fallbackMeridiem;
    if (mer === 'pm' && hour < 12) hour += 12;
    if (mer === 'am' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };

  // If only one side specifies am/pm, assume the same for the other unless
  // the times suggest otherwise (e.g. "9 to 5" -> 9am to 5pm, business hours)
  const [, sh, sm, sMer, eh, em, eMer] = timeRangeMatch;
  const startMeridiem = sMer || (parseInt(sh, 10) < 12 ? 'am' : 'pm');
  const endMeridiem = eMer || sMer || 'pm';

  const start = to24h(sh, sm, sMer, startMeridiem);
  const end = to24h(eh, em, eMer, endMeridiem);

  const days = extractDaysFromPhrase(lower);
  if (days.length === 0) return null;
  return { days, start, end };
}

// Turn a phrase like "I don't work on Sundays" / "closed on weekends" /
// "no appointments on Saturday" into a list of day keys to mark off, or
// null if no such phrase is recognized. Only tried after
// parseWorkingHoursPhrase fails to find a time range, so it's specifically
// for "day off" statements, not hours statements.
const DAY_OFF_KEYWORDS = /\b(don'?t work|do not work|not working|off|closed|no appointments|no work|unavailable|not available)\b/i;
function parseDayOffPhrase(phrase) {
  if (!phrase) return null;
  const lower = phrase.toLowerCase();
  if (!DAY_OFF_KEYWORDS.test(lower)) return null;

  const days = extractDaysFromPhrase(lower);
  return days.length > 0 ? days : null;
}

// Does a raw scheduling phrase explicitly ask for today? Used to gate
// same-day booking — Aigentik should never book today on its own initiative,
// only when the person actually said "today"/"tonight".
function mentionsToday(phrase) {
  return /\btoday\b|\btonight\b/i.test(phrase || '');
}

// Start of the next calendar day after `from` (or now)
function startOfTomorrow(from) {
  const d = from ? new Date(from) : new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0);
  return d;
}

// ─── Slot finding ───────────────────────────────────────────────────────────

// Check whether [start, end) fits inside that day's working hours
function fitsWorkingHours(start, end, dayHours) {
  if (!dayHours) return false;
  const dayStart = new Date(start);
  const [sh, sm] = dayHours.start.split(':').map(Number);
  dayStart.setHours(sh, sm, 0, 0);
  const dayEnd = new Date(start);
  const [eh, em] = dayHours.end.split(':').map(Number);
  dayEnd.setHours(eh, em, 0, 0);
  return start >= dayStart && end <= dayEnd;
}

// Check whether [start, end) conflicts with any existing confirmed appointment,
// honoring the buffer on both sides
function hasConflict(start, end, appointments, bufferMinutes, excludeId) {
  const bufferMs = bufferMinutes * 60 * 1000;
  return appointments.some(a => {
    if (a.status !== 'confirmed') return false;
    if (excludeId && a.id === excludeId) return false;
    const aStart = new Date(a.start).getTime() - bufferMs;
    const aEnd = new Date(a.end).getTime() + bufferMs;
    return start.getTime() < aEnd && end.getTime() > aStart;
  });
}

// Is [start, end) a valid, open slot right now?
function isSlotAvailable(start, end, scheduleConfig, appointments, excludeId) {
  const dayKey = DAY_KEYS[start.getDay()];
  const dayHours = scheduleConfig.working_hours[dayKey];
  if (!fitsWorkingHours(start, end, dayHours)) return false;
  if (hasConflict(start, end, appointments, scheduleConfig.buffer_minutes, excludeId)) return false;
  return true;
}

// Find the next available slot, honoring working hours + existing bookings.
// If preferredDate is given and free, it's used as-is; otherwise this walks
// forward from afterDate (or preferredDate, if later) day by day, checking
// every slot_duration-aligned start time within working hours, up to
// booking_window_days out.
function findNextAvailableSlot({ afterDate, durationMinutes, preferredDate, excludeId } = {}) {
  const scheduleConfig = loadScheduleConfig();
  const appointments = loadCalendar();
  const duration = durationMinutes || scheduleConfig.default_duration_minutes;
  const now = afterDate ? new Date(afterDate) : new Date();

  if (preferredDate) {
    const start = new Date(preferredDate);
    const end = new Date(start.getTime() + duration * 60 * 1000);
    if (start > now && isSlotAvailable(start, end, scheduleConfig, appointments, excludeId)) {
      return { start, end };
    }
  }

  // Walk forward from the later of now/preferredDate, in 15-minute increments,
  // within each day's working hours, until we find an open slot.
  const searchStart = preferredDate && new Date(preferredDate) > now ? new Date(preferredDate) : now;
  const windowEnd = new Date(now.getTime() + scheduleConfig.booking_window_days * 24 * 60 * 60 * 1000);

  for (let dayOffset = 0; dayOffset < scheduleConfig.booking_window_days; dayOffset++) {
    const day = new Date(searchStart);
    day.setDate(day.getDate() + dayOffset);
    const dayKey = DAY_KEYS[day.getDay()];
    const dayHours = scheduleConfig.working_hours[dayKey];
    if (!dayHours) continue;

    const [sh, sm] = dayHours.start.split(':').map(Number);
    const [eh, em] = dayHours.end.split(':').map(Number);
    const dayStart = new Date(day);
    dayStart.setHours(sh, sm, 0, 0);
    const dayEnd = new Date(day);
    dayEnd.setHours(eh, em, 0, 0);

    let slotStart = new Date(dayOffset === 0 && searchStart > dayStart ? searchStart : dayStart);
    // Round up to the next 15-minute mark
    slotStart.setMinutes(Math.ceil(slotStart.getMinutes() / 15) * 15, 0, 0);

    while (slotStart.getTime() + duration * 60 * 1000 <= dayEnd.getTime()) {
      const slotEnd = new Date(slotStart.getTime() + duration * 60 * 1000);
      if (slotStart > windowEnd) return null;
      if (isSlotAvailable(slotStart, slotEnd, scheduleConfig, appointments, excludeId)) {
        return { start: slotStart, end: slotEnd };
      }
      slotStart = new Date(slotStart.getTime() + 15 * 60 * 1000);
    }
  }

  return null; // fully booked for the entire window — extremely unlikely
}

// Generate up to `count` non-overlapping open slots — used to offer a
// customer a few options rather than picking one for them. Each subsequent
// search starts right after the previous offer ends, so they never collide
// with each other even though none of them are booked yet.
function generateOfferSlots({ durationMinutes, preferredDate, afterDate, count = 3 } = {}) {
  const offers = [];
  let cursor = afterDate;
  let firstPreferred = preferredDate;
  for (let i = 0; i < count; i++) {
    const slot = findNextAvailableSlot({ afterDate: cursor, durationMinutes, preferredDate: firstPreferred });
    if (!slot) break;
    offers.push(slot);
    cursor = new Date(slot.end.getTime() + 15 * 60 * 1000);
    firstPreferred = null; // only honor the original preference for the first offer
  }
  return offers;
}

function formatOfferList(offers) {
  return offers.map((s, i) => `${i + 1}. ${new Date(s.start).toLocaleString()}`).join('\n');
}

// ─── Appointments ───────────────────────────────────────────────────────────

function createAppointment({ title, start, end, contactId, attendeeName, attendeeEmail, createdVia, notes, appointmentType }) {
  const appointments = loadCalendar();
  const id = generateAppointmentId(appointments);

  const appointment = {
    id,
    uid: `${id}@aigentik.local`,
    ics_sequence: 0,
    title: title || `Appointment with ${attendeeName || attendeeEmail || 'contact'}`,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    contact_id: contactId || null,
    attendee_name: attendeeName || null,
    attendee_email: attendeeEmail || null,
    appointment_type: appointmentType || null, // 'call' | 'in_person' | null
    status: 'confirmed',
    rsvp_status: 'pending', // updated when the attendee accepts/declines via their calendar app
    pending_reschedule: null, // set when a reschedule request is awaiting the other party's confirmation
    created_via: createdVia || 'owner',
    notes: notes || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    history: [{ event: 'created', at: new Date().toISOString() }]
  };

  appointments.push(appointment);
  saveCalendar(appointments);
  log.action('calendar', `Appointment created: ${appointment.title}`, { id, start: appointment.start });
  return appointment;
}

// ─── Negotiation (offer/counter-offer before a booking is confirmed) ──────
// Used for inbound requests from customers/contacts: Aigentik never books
// unilaterally when the exact requested/offered time isn't free — it
// proposes and waits for the other party to agree, rather than silently
// substituting a different time.

function proposeAppointment({ title, contactId, attendeeName, attendeeEmail, createdVia, offeredSlots = [], appointmentType = null }) {
  const appointments = loadCalendar();
  const id = generateAppointmentId(appointments);
  const primary = offeredSlots[0] || null;

  const appointment = {
    id,
    uid: `${id}@aigentik.local`,
    ics_sequence: 0,
    title: title || `Appointment with ${attendeeName || attendeeEmail || 'contact'}`,
    start: primary ? new Date(primary.start).toISOString() : null,
    end: primary ? new Date(primary.end).toISOString() : null,
    contact_id: contactId || null,
    attendee_name: attendeeName || null,
    attendee_email: attendeeEmail || null,
    appointment_type: appointmentType,
    status: 'negotiating',
    form_sent: false, // whether the intake template has already been sent to this contact
    rsvp_status: 'pending',
    pending_reschedule: null,
    offered_slots: offeredSlots.map(s => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() })),
    created_via: createdVia || 'owner',
    notes: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    history: [{ event: 'proposed', at: new Date().toISOString() }]
  };

  appointments.push(appointment);
  saveCalendar(appointments);
  log.action('calendar', `Appointment proposed: ${appointment.title}`, { id });
  return appointment;
}

function setAppointmentType(id, type) {
  const appointments = loadCalendar();
  const idx = appointments.findIndex(a => a.id === id);
  if (idx === -1) return null;

  appointments[idx].appointment_type = type;
  appointments[idx].updated_at = new Date().toISOString();
  appointments[idx].history.push({ event: 'type_set', at: appointments[idx].updated_at, type });

  saveCalendar(appointments);
  return appointments[idx];
}

function markFormSent(id) {
  const appointments = loadCalendar();
  const idx = appointments.findIndex(a => a.id === id);
  if (idx === -1) return null;

  appointments[idx].form_sent = true;
  appointments[idx].updated_at = new Date().toISOString();
  appointments[idx].history.push({ event: 'form_sent', at: appointments[idx].updated_at });

  saveCalendar(appointments);
  return appointments[idx];
}

function setAppointmentNotes(id, notes) {
  const appointments = loadCalendar();
  const idx = appointments.findIndex(a => a.id === id);
  if (idx === -1) return null;

  appointments[idx].notes = notes;
  appointments[idx].updated_at = new Date().toISOString();

  saveCalendar(appointments);
  return appointments[idx];
}

// Deterministic (not LLM) — keyword-based, since this only needs to
// distinguish two categories and a wrong guess here would misroute the
// whole intake flow.
function detectAppointmentTypeFromText(text) {
  const lower = (text || '').toLowerCase();
  if (/\b(in[\s-]?person|come (over|by)|at (my|your|the) (home|house|office|place)|visit|on[\s-]?site|drop by)\b/.test(lower)) return 'in_person';
  if (/\b(call|phone call|video call|zoom|virtual|over the phone|on the phone)\b/.test(lower)) return 'call';
  return null;
}

function updateNegotiationOffers(id, offeredSlots) {
  const appointments = loadCalendar();
  const idx = appointments.findIndex(a => a.id === id);
  if (idx === -1) return null;

  const iso = offeredSlots.map(s => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }));
  appointments[idx].offered_slots = iso;
  appointments[idx].start = iso[0].start;
  appointments[idx].end = iso[0].end;
  appointments[idx].updated_at = new Date().toISOString();
  appointments[idx].history.push({ event: 'counter_offered', at: appointments[idx].updated_at });

  saveCalendar(appointments);
  return appointments[idx];
}

function confirmNegotiation(id, start, end) {
  const appointments = loadCalendar();
  const idx = appointments.findIndex(a => a.id === id);
  if (idx === -1) return null;

  appointments[idx].status = 'confirmed';
  appointments[idx].start = new Date(start).toISOString();
  appointments[idx].end = new Date(end).toISOString();
  appointments[idx].offered_slots = [];
  appointments[idx].updated_at = new Date().toISOString();
  appointments[idx].history.push({ event: 'confirmed', at: appointments[idx].updated_at });

  saveCalendar(appointments);
  log.action('calendar', `Negotiation confirmed as appointment: ${appointments[idx].title}`, { id });
  return appointments[idx];
}

function findNegotiationsByContact(contactId) {
  if (!contactId) return [];
  return loadCalendar().filter(a => a.contact_id === contactId && a.status === 'negotiating');
}

// Reschedule negotiation: a lighter-weight version for an already-confirmed
// appointment. The old time stays booked (still shows as busy) until the
// other party confirms the new one, rather than moving it unilaterally.
function setPendingReschedule(id, slot) {
  const appointments = loadCalendar();
  const idx = appointments.findIndex(a => a.id === id);
  if (idx === -1) return null;

  appointments[idx].pending_reschedule = { start: new Date(slot.start).toISOString(), end: new Date(slot.end).toISOString() };
  appointments[idx].updated_at = new Date().toISOString();
  saveCalendar(appointments);
  return appointments[idx];
}

function clearPendingReschedule(id) {
  const appointments = loadCalendar();
  const idx = appointments.findIndex(a => a.id === id);
  if (idx === -1) return null;

  appointments[idx].pending_reschedule = null;
  saveCalendar(appointments);
  return appointments[idx];
}

function rescheduleAppointment(id, newStart, newEnd) {
  const appointments = loadCalendar();
  const idx = appointments.findIndex(a => a.id === id);
  if (idx === -1) return null;

  const appt = appointments[idx];
  const fromStart = appt.start;
  appt.start = new Date(newStart).toISOString();
  appt.end = new Date(newEnd).toISOString();
  appt.ics_sequence = (appt.ics_sequence || 0) + 1;
  appt.updated_at = new Date().toISOString();
  appt.history.push({ event: 'rescheduled', at: appt.updated_at, from: fromStart, to: appt.start });

  appointments[idx] = appt;
  saveCalendar(appointments);
  log.action('calendar', `Appointment rescheduled: ${appt.title}`, { id, from: fromStart, to: appt.start });
  return appt;
}

function cancelAppointment(id) {
  const appointments = loadCalendar();
  const idx = appointments.findIndex(a => a.id === id);
  if (idx === -1) return null;

  appointments[idx].status = 'cancelled';
  appointments[idx].updated_at = new Date().toISOString();
  appointments[idx].history.push({ event: 'cancelled', at: appointments[idx].updated_at });

  saveCalendar(appointments);
  log.action('calendar', `Appointment cancelled: ${appointments[idx].title}`, { id });
  return appointments[idx];
}

function getAppointment(id) {
  return loadCalendar().find(a => a.id === id) || null;
}

function findAppointmentsByContact(contactId) {
  if (!contactId) return [];
  return loadCalendar().filter(a => a.contact_id === contactId && a.status === 'confirmed');
}

// Most relevant appointment for a given attendee email — used to match an
// incoming calendar-response email (accept/decline) back to the booking it's
// about. Prefers the soonest upcoming one still awaiting a response.
function findAppointmentByAttendeeEmail(email) {
  if (!email) return null;
  const norm = email.toLowerCase().trim();
  const matches = loadCalendar()
    .filter(a => a.status === 'confirmed' && a.attendee_email?.toLowerCase().trim() === norm)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
  if (matches.length === 0) return null;
  return matches.find(a => a.rsvp_status === 'pending') || matches[0];
}

function setRsvpStatus(id, status) {
  const appointments = loadCalendar();
  const idx = appointments.findIndex(a => a.id === id);
  if (idx === -1) return null;
  appointments[idx].rsvp_status = status;
  appointments[idx].updated_at = new Date().toISOString();
  appointments[idx].history.push({ event: 'rsvp', at: appointments[idx].updated_at, status });
  saveCalendar(appointments);
  log.info('calendar', `RSVP recorded for ${appointments[idx].title}: ${status}`, { id });
  return appointments[idx];
}

function findUpcoming(days = 30) {
  const now = new Date();
  const until = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return loadCalendar()
    .filter(a => a.status === 'confirmed' && new Date(a.start) >= now && new Date(a.start) <= until)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

// All confirmed appointments falling on the same calendar day as `date`
function findForDate(date) {
  const target = new Date(date);
  const dayStart = new Date(target);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(target);
  dayEnd.setHours(23, 59, 59, 999);
  return loadCalendar()
    .filter(a => a.status === 'confirmed' && new Date(a.start) >= dayStart && new Date(a.start) <= dayEnd)
    .sort((a, b) => new Date(a.start) - new Date(b.start));
}

function formatAppointment(appt) {
  if (!appt) return 'Unknown appointment';
  const start = new Date(appt.start);
  const typeLabel = appt.appointment_type === 'in_person' ? ' [🏠 in-person]' : appt.appointment_type === 'call' ? ' [📞 call]' : '';
  return `${appt.title} — ${start.toLocaleString()} (${appt.attendee_name || appt.attendee_email || 'no contact'})${typeLabel}`;
}

function listUpcomingForSms(days = 14) {
  const upcoming = findUpcoming(days);
  if (upcoming.length === 0) return `📅 No appointments in the next ${days} days.`;
  const lines = [`📅 Upcoming appointments:\n`];
  upcoming.forEach(a => lines.push(`#${a.id.replace('appt_', '')} ${formatAppointment(a)}`));
  return lines.join('\n');
}

function listForDateForSms(date) {
  const appts = findForDate(date);
  const label = new Date(date).toLocaleDateString();
  if (appts.length === 0) return `📅 No appointments on ${label}.`;
  const lines = [`📅 Appointments on ${label}:\n`];
  appts.forEach(a => lines.push(`#${a.id.replace('appt_', '')} ${formatAppointment(a)}`));
  return lines.join('\n');
}

export {
  loadCalendar,
  loadScheduleConfig,
  parseDatetimePhrase,
  parseDatetimeDetailed,
  combineTimeWithDate,
  parseWorkingHoursPhrase,
  parseDayOffPhrase,
  mentionsToday,
  startOfTomorrow,
  getDurationForRelationship,
  setWorkingHours,
  setDayOff,
  setDurationForRelationship,
  formatWorkingHours,
  findNextAvailableSlot,
  generateOfferSlots,
  formatOfferList,
  detectAppointmentTypeFromText,
  createAppointment,
  proposeAppointment,
  setAppointmentType,
  markFormSent,
  setAppointmentNotes,
  updateNegotiationOffers,
  confirmNegotiation,
  findNegotiationsByContact,
  setPendingReschedule,
  clearPendingReschedule,
  rescheduleAppointment,
  cancelAppointment,
  getAppointment,
  findAppointmentsByContact,
  findAppointmentByAttendeeEmail,
  setRsvpStatus,
  findUpcoming,
  findForDate,
  formatAppointment,
  listUpcomingForSms,
  listForDateForSms
};
