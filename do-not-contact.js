// do-not-contact.js — permanent contact suppression list
// Anyone added here is never auto-replied to, queued, or messaged again by
// Aigentik, on either channel (email or Google Voice/SMS). Stored under
// data/ like every other runtime file, so it's gitignored and stays local
// to this install — never pushed to GitHub.

import fs from 'fs';
import path from 'path';
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const DNC_FILE = path.join(config.paths.data_dir, 'do-not-contact.json');

// Deterministic phrase match for "stop contacting me" style requests — kept
// out of the LLM (same reasoning as calendar.js's date parsing) so a block
// this consequential never depends on a model guess.
// First-person phrasing only, deliberately — 'unsubscribe'/'opt out' alone
// are already treated as generic marketing-footer boilerplate elsewhere
// (see email-rules.js's PROMO_KEYWORDS), so they're excluded here. A false
// positive on this list is a permanent, silent block, unlike a promotional
// misclassification which is easily reversed — so this list stays narrow.
const OPT_OUT_PHRASES = [
  'remove me from your list', 'remove me from this list', 'take me off your list',
  'take me off this list', 'stop contacting me', 'stop texting me', 'stop emailing me',
  'stop messaging me', 'do not contact me', "don't contact me", 'do not text me',
  "don't text me", 'do not email me', "don't email me", 'do not message me',
  "don't message me", 'never contact me again', "never contact me", 'please stop contacting',
  'unsubscribe me', 'opt me out', 'lose my number', 'lose my contact',
  'remove my number', 'remove my email', 'stop reaching out'
];

function loadEntries() {
  try {
    if (fs.existsSync(DNC_FILE)) {
      return JSON.parse(fs.readFileSync(DNC_FILE, 'utf8'));
    }
  } catch (e) {
    log.warn('do-not-contact', 'Could not load do-not-contact file', { error: e.message });
  }
  return [];
}

function saveEntries(entries) {
  try {
    fs.writeFileSync(DNC_FILE, JSON.stringify(entries, null, 2));
  } catch (e) {
    log.error('do-not-contact', 'Failed to save do-not-contact file', { error: e.message });
  }
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/[^0-9]/g, '');
  return digits ? digits.slice(-10) : null;
}

function normalizeEmail(email) {
  if (!email) return null;
  return email.toLowerCase().trim();
}

// Identify what kind of identifier was given so it's stored/matched
// consistently regardless of which channel it came in on.
function classifyIdentifier(identifier) {
  if (!identifier) return null;
  const trimmed = identifier.trim();
  if (trimmed.includes('@')) return { type: 'email', value: normalizeEmail(trimmed) };
  const phone = normalizePhone(trimmed);
  if (phone && phone.length === 10) return { type: 'phone', value: phone };
  return null;
}

// True if this email address or phone number is on the do-not-contact list
function isBlocked(identifier) {
  if (!identifier) return false;
  const classified = classifyIdentifier(identifier);
  if (!classified) return false;
  const entries = loadEntries();
  return entries.some(e => e.type === classified.type && e.value === classified.value);
}

// Add an identifier (email or phone) to the permanent block list. Idempotent
// — re-adding an existing entry just refreshes the reason/timestamp.
function addToDoNotContact({ identifier, name, reason, source }) {
  const classified = classifyIdentifier(identifier);
  if (!classified) return null;

  const entries = loadEntries();
  const idx = entries.findIndex(e => e.type === classified.type && e.value === classified.value);

  const entry = {
    type: classified.type,
    value: classified.value,
    original: identifier,
    name: name || (idx !== -1 ? entries[idx].name : null) || null,
    reason: reason || 'requested removal',
    source: source || 'auto',
    added_at: new Date().toISOString()
  };

  if (idx !== -1) entries[idx] = entry;
  else entries.push(entry);

  saveEntries(entries);
  log.action('do-not-contact', `Added to do-not-contact: ${classified.value}`, { reason: entry.reason, source: entry.source });
  return entry;
}

function removeFromDoNotContact(identifier) {
  const classified = classifyIdentifier(identifier);
  if (!classified) return false;
  const entries = loadEntries();
  const idx = entries.findIndex(e => e.type === classified.type && e.value === classified.value);
  if (idx === -1) return false;
  entries.splice(idx, 1);
  saveEntries(entries);
  log.action('do-not-contact', `Removed from do-not-contact: ${classified.value}`);
  return true;
}

function listDoNotContact() {
  const entries = loadEntries();
  if (entries.length === 0) return '🚫 Do-not-contact list is empty.';
  const lines = entries.map((e, i) =>
    `${i + 1}. ${e.name ? e.name + ' — ' : ''}${e.original} (${e.reason})`
  );
  return `🚫 Do-Not-Contact list (${entries.length}):\n` + lines.join('\n');
}

// Deterministic keyword check for opt-out language in an inbound message
function detectOptOutRequest(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return OPT_OUT_PHRASES.some(phrase => lower.includes(phrase));
}

export {
  isBlocked,
  addToDoNotContact,
  removeFromDoNotContact,
  listDoNotContact,
  detectOptOutRequest,
  loadEntries
};
