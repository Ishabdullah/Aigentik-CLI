// contacts-sync.js — Aigentik Android contacts sync
// Pulls real phone contacts via termux-contact-list
// Merges into Aigentik contacts.json without overwriting existing data

import { execSync } from 'child_process';
import log from './logger.js';
import { loadContacts, saveContacts, normalizePhone } from './contacts.js';

function generateId(contacts) {
  let max = 0;
  for (const c of contacts) {
    const num = parseInt((c.id || '').replace('contact_', '') || '0', 10);
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
    return parsed.filter(c => c.name && c.number);
  } catch (e) {
    log.error('contacts-sync', 'Failed to fetch Android contacts', { error: e.message });
    return [];
  }
}

// Main sync function
function syncContacts() {
  log.info('contacts-sync', 'Syncing Android contacts...');

  const aigentikContacts = loadContacts();
  const androidContacts = fetchAndroidContacts();
  if (androidContacts.length === 0) {
    log.warn('contacts-sync', 'No Android contacts found');
    return { android: 0, added: 0, updated: 0, total: aigentikContacts.length };
  }

  let added = 0;
  let updated = 0;

  for (const ac of androidContacts) {
    const normPhone = normalizePhone(ac.number);
    if (!normPhone) continue;

    const existingIdx = aigentikContacts.findIndex(c =>
      c.phones?.some(p => normalizePhone(p) === normPhone)
    );

    if (existingIdx === -1) {
      aigentikContacts.push({
        id: generateId(aigentikContacts),
        name: ac.name,
        aliases: [ac.name.toLowerCase()],
        phones: [ac.number],
        emails: [],
        address: null,
        relationship: null,
        type: 'person',
        notes: null,
        instructions: null,
        reply_behavior: 'auto',
        business_name: null,
        trade: null,
        trade_raw: null,
        licensed: null,
        license_number: null,
        gl_insurance: null,
        wc_insurance: null,
        has_tools: null,
        crew_size: null,
        weekly_capacity: null,
        references: [],
        source: 'android_contacts',
        first_seen: new Date().toISOString(),
        last_contact: null,
        contact_count: 0,
        history: []
      });
      added++;
    } else {
      const existing = aigentikContacts[existingIdx];

      if (!existing.name) {
        aigentikContacts[existingIdx].name = ac.name;
        updated++;
      }

      const nameLower = ac.name.toLowerCase();
      if (!existing.aliases?.includes(nameLower)) {
        if (!aigentikContacts[existingIdx].aliases) {
          aigentikContacts[existingIdx].aliases = [];
        }
        aigentikContacts[existingIdx].aliases.push(nameLower);
        updated++;
      }

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

export { syncContacts, startAutoSync };