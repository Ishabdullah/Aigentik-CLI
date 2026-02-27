// contacts-sync.js — Aigentik Android contacts sync
// Pulls real phone contacts via termux-contact-list
// Merges into Aigentik contacts.json without overwriting existing data

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const log = require('./logger');

const CONTACTS_FILE = path.join(config.paths.data_dir, 'contacts.json');

function normalizePhone(phone) {
  if (!phone) return null;
  return phone.replace(/[^0-9]/g, '').slice(-10);
}

function loadContacts() {
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    }
  } catch (e) {}
  return [];
}

function saveContacts(contacts) {
  fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
}

function generateId(contacts) {
  let max = 0;
  for (const c of contacts) {
    const num = parseInt((c.id || '').replace('contact_', '') || '0');
    if (num > max) max = num;
  }
  return 'contact_' + String(max + 1).padStart(4, '0');
}

// Fetch all Android contacts via termux-api
function fetchAndroidContacts() {
  try {
    const raw = execSync('termux-contact-list', {
      timeout: 15000,
      encoding: 'utf8'
    });
    const parsed = JSON.parse(raw);
    // Filter out entries with no valid phone number
    return parsed.filter(c => c.name && c.number);
  } catch (e) {
    log.error('contacts-sync', 'Failed to fetch Android contacts', { error: e.message });
    return [];
  }
}

// Main sync function
function syncContacts() {
  log.info('contacts-sync', 'Syncing Android contacts...');

  const androidContacts = fetchAndroidContacts();
  if (androidContacts.length === 0) {
    log.warn('contacts-sync', 'No Android contacts found');
    return;
  }

  const aigentikContacts = loadContacts();
  let added = 0;
  let updated = 0;

  for (const ac of androidContacts) {
    const normPhone = normalizePhone(ac.number);
    if (!normPhone) continue;

    // Check if contact already exists by phone number
    const existingIdx = aigentikContacts.findIndex(c =>
      c.phones?.some(p => normalizePhone(p) === normPhone)
    );

    if (existingIdx === -1) {
      // New contact — add it
      aigentikContacts.push({
        id: generateId(aigentikContacts),
        name: ac.name,
        aliases: [ac.name.toLowerCase()],
        phones: [ac.number],
        emails: [],
        relationship: null,
        type: 'person',
        notes: null,
        instructions: null,
        reply_behavior: 'auto',
        source: 'android_contacts',
        first_seen: new Date().toISOString(),
        last_contact: null,
        contact_count: 0,
        history: []
      });
      added++;
    } else {
      // Existing contact — update name if missing, add phone if new
      const existing = aigentikContacts[existingIdx];

      // Only update name if contact has no name yet
      if (!existing.name) {
        aigentikContacts[existingIdx].name = ac.name;
        updated++;
      }

      // Add alias for name matching if not already there
      const nameLower = ac.name.toLowerCase();
      if (!existing.aliases?.includes(nameLower)) {
        if (!aigentikContacts[existingIdx].aliases) {
          aigentikContacts[existingIdx].aliases = [];
        }
        aigentikContacts[existingIdx].aliases.push(nameLower);
        updated++;
      }

      // Mark source as android_contacts if it was auto-created
      if (existing.source === 'auto' || existing.source === 'sms') {
        aigentikContacts[existingIdx].source = 'android_contacts';
      }
    }
  }

  saveContacts(aigentikContacts);
  log.info('contacts-sync', 'Sync complete', {
    android: androidContacts.length,
    added,
    updated,
    total: aigentikContacts.length
  });

  return { android: androidContacts.length, added, updated, total: aigentikContacts.length };
}

// Run once on startup only — no auto-interval
// Owner can trigger manual sync by texting "sync contacts"
function startAutoSync() {
  const result = syncContacts();
  if (result) {
    log.info('contacts-sync', 'Initial sync: ' + result.added + ' new, ' + result.updated + ' updated, ' + result.total + ' total contacts');
  }
  return result;
}

module.exports = { syncContacts, startAutoSync };
