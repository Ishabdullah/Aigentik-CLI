// contacts.js — Aigentik contact memory system
// Builds and maintains a growing directory of contacts
// Gets smarter the more Aigentik is used

import fs from 'fs';
import path from 'path';
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const CONTACTS_FILE = path.join(config.paths.data_dir, 'contacts.json');

// Load contacts from disk
function loadContacts() {
  try {
    if (fs.existsSync(CONTACTS_FILE)) {
      return JSON.parse(fs.readFileSync(CONTACTS_FILE, 'utf8'));
    }
  } catch (e) {
    log.warn('contacts', 'Could not load contacts file', { error: e.message });
  }
  return [];
}

// Save contacts to disk
function saveContacts(contacts) {
  try {
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
  } catch (e) {
    log.error('contacts', 'Failed to save contacts', { error: e.message });
  }
}

// Normalize phone number to last 10 digits for comparison
function normalizePhone(phone) {
  if (!phone) return null;
  return phone.replace(/[^0-9]/g, '').slice(-10);
}

// Normalize email to lowercase
function normalizeEmail(email) {
  if (!email) return null;
  return email.toLowerCase().trim();
}

// Generate a unique contact ID
function generateId(contacts) {
  const maxId = contacts.reduce((max, c) => {
    const num = parseInt(c.id.replace('contact_', ''));
    return num > max ? num : max;
  }, 0);
  return `contact_${String(maxId + 1).padStart(4, '0')}`;
}

// Find a contact by phone, email, or name
function findContact(identifier) {
  const contacts = loadContacts();
  if (!identifier) return null;

  const normPhone = normalizePhone(identifier);
  const normEmail = normalizeEmail(identifier);
  const nameLower = identifier.toLowerCase().trim();

  return contacts.find(c => {
    if (normPhone && c.phones?.some(p => normalizePhone(p) === normPhone)) return true;
    if (normEmail && c.emails?.some(e => normalizeEmail(e) === normEmail)) return true;
    if (c.name?.toLowerCase() === nameLower) return true;
    if (c.name?.toLowerCase().includes(nameLower)) return true;
    if (c.aliases?.some(a => a.toLowerCase() === nameLower)) return true;
    if (c.aliases?.some(a => a.toLowerCase().includes(nameLower))) return true;
    return false;
  }) || null;
}

// Find contact by relationship label (e.g. "boss", "wife")
function findByRelationship(relationship) {
  const contacts = loadContacts();
  const rel = relationship.toLowerCase().trim();
  return contacts.find(c => c.relationship?.toLowerCase() === rel) || null;
}

// Create a new contact
function createContact({ name, phones, emails, relationship, type, notes, source }) {
  const contacts = loadContacts();
  const id = generateId(contacts);

  const contact = {
    id,
    name: name || null,
    aliases: [],
    phones: phones ? [phones].flat().filter(Boolean) : [],
    emails: emails ? [emails].flat().filter(Boolean) : [],
    relationship: relationship || null,
    type: type || 'unknown',
    notes: notes || null,
    instructions: null,
    reply_behavior: 'auto',
    source: source || 'auto',
    first_seen: new Date().toISOString(),
    last_contact: new Date().toISOString(),
    contact_count: 1,
    history: []
  };
  contacts.push(contact);
  saveContacts(contacts);

  log.info('contacts', `New contact created: ${name || phones || emails}`, { id });
  return contact;
}

// Update an existing contact with new info
function updateContact(id, updates) {
  const contacts = loadContacts();
  const idx = contacts.findIndex(c => c.id === id);
  if (idx === -1) {
    log.warn('contacts', `Contact not found for update: ${id}`);
    return null;
  }

  const contact = contacts[idx];

  if (updates.phones) {
    const newPhones = [updates.phones].flat().filter(Boolean);
    newPhones.forEach(p => {
      if (!contact.phones.some(ep => normalizePhone(ep) === normalizePhone(p))) {
        contact.phones.push(p);
      }
    });
  }

  if (updates.emails) {
    const newEmails = [updates.emails].flat().filter(Boolean);
    newEmails.forEach(e => {
      if (!contact.emails.some(ee => normalizeEmail(ee) === normalizeEmail(e))) {
        contact.emails.push(e);
      }
    });
  }

  if (updates.aliases) {
    const newAliases = [updates.aliases].flat().filter(Boolean);
    newAliases.forEach(a => {
      if (!contact.aliases.includes(a)) contact.aliases.push(a);
    });
  }

  if (updates.name && !contact.name) contact.name = updates.name;
  if (updates.relationship) contact.relationship = updates.relationship;
  if (updates.type && contact.type === 'unknown') contact.type = updates.type;
  if (updates.notes) contact.notes = updates.notes;

  contact.last_contact = new Date().toISOString();
  contact.contact_count = (contact.contact_count || 0) + 1;

  contacts[idx] = contact;
  saveContacts(contacts);

  log.debug('contacts', `Contact updated: ${id}`, { updates: Object.keys(updates) });
  return contact;
}

// Add a history entry to a contact
function addHistory(identifier, historyEntry) {
  const contact = findContact(identifier);
  if (!contact) return;

  const contacts = loadContacts();
  const idx = contacts.findIndex(c => c.id === contact.id);
  if (idx === -1) return;

  if (!contacts[idx].history) contacts[idx].history = [];
  contacts[idx].history.push({
    ...historyEntry,
    timestamp: new Date().toISOString()
  });
  if (contacts[idx].history.length > 50) {
    contacts[idx].history = contacts[idx].history.slice(-50);
  }
  contacts[idx].last_contact = new Date().toISOString();
  contacts[idx].contact_count = (contacts[idx].contact_count || 0) + 1;

  saveContacts(contacts);
}

// Process extracted entities and update/create contacts automatically
function processEntities(entities, source) {
  if (!entities) return;

  const { names, phones, emails, businesses, relationships } = entities;

  phones.forEach((phone, i) => {
    let contact = findContact(phone);
    if (!contact) {
      contact = createContact({
        name: names[i] || null,
        phones: phone,
        relationship: relationships[i] || null,
        type: 'unknown',
        source
      });
    } else {
      updateContact(contact.id, {
        phones: phone,
        ...(names[i] ? { aliases: names[i] } : {}),
        ...(relationships[i] ? { relationship: relationships[i] } : {})
      });
    }
  });

  emails.forEach((email, i) => {
    let contact = findContact(email);
    if (!contact) {
      contact = createContact({
        name: names[i] || null,
        emails: email,
        relationship: relationships[i] || null,
        type: 'person',
        source
      });
    } else {
      updateContact(contact.id, {
        emails: email,
        ...(names[i] ? { aliases: names[i] } : {}),
        ...(relationships[i] ? { relationship: relationships[i] } : {})
      });
    }
  });

  businesses.forEach(biz => {
    let contact = findContact(biz);
    if (!contact) {
      createContact({
        name: biz,
        type: 'business',
        source
      });
    }
  });
}

// Get a formatted contact summary for display
function formatContact(contact) {
  if (!contact) return 'Unknown contact';
  const parts = [];
  if (contact.name) parts.push(contact.name);
  if (contact.relationship) parts.push(`(${contact.relationship})`);
  if (contact.phones?.length) parts.push(`📱 ${contact.phones[0]}`);
  if (contact.emails?.length) parts.push(`✉️ ${contact.emails[0]}`);
  if (contact.type !== 'unknown') parts.push(`[${contact.type}]`);
  return parts.join(' ') || contact.id;
}

// List all contacts as a summary
function listContacts() {
  const contacts = loadContacts();
  if (contacts.length === 0) return 'No contacts saved yet.';
  return contacts.map(c => formatContact(c)).join('\n');
}

// Find or create contact by phone (used on every SMS)
function findOrCreateByPhone(phone, additionalInfo = {}) {
  let contact = findContact(phone);
  if (!contact) {
    contact = createContact({
      phones: phone,
      type: additionalInfo.type || 'unknown',
      name: additionalInfo.name || null,
      relationship: additionalInfo.relationship || null,
      source: 'sms'
    });
  }
  return contact;
}

// Find or create contact by email (used on every email)
function findOrCreateByEmail(email, name, additionalInfo = {}) {
  let contact = findContact(email);
  if (!contact) {
    contact = createContact({
      emails: email,
      name: name || null,
      type: 'person',
      relationship: additionalInfo.relationship || null,
      source: 'email'
    });
  } else if (name && !contact.name) {
    updateContact(contact.id, { name });
  }
  return contact;
}

// Set instructions for how to handle a specific contact
function setContactInstructions(identifier, instructions, behavior) {
  const contact = findContact(identifier) || findByRelationship(identifier);
  if (!contact) return null;
  const contacts = loadContacts();
  const idx = contacts.findIndex(c => c.id === contact.id);
  if (idx === -1) return null;
  if (instructions) contacts[idx].instructions = instructions;
  if (behavior) contacts[idx].reply_behavior = behavior;
  saveContacts(contacts);
  log.info('contacts', 'Contact instructions updated', { id: contact.id, instructions, behavior });
  return contacts[idx];
}

// Find ALL contacts matching a name — for disambiguation
function findAllByName(name) {
  const contacts = loadContacts();
  const nameLower = name.toLowerCase().trim();
  return contacts.filter(c =>
    c.name?.toLowerCase().includes(nameLower) ||
    c.aliases?.some(a => a.toLowerCase().includes(nameLower))
  );
}

// Format contact info for SMS display
function formatContactInfo(contact) {
  const lines = [];
  if (contact.name) lines.push('👤 ' + contact.name);
  if (contact.relationship) lines.push('🔗 ' + contact.relationship);
  if (contact.phones?.length) lines.push('📱 ' + contact.phones.join(', '));
  if (contact.emails?.length) lines.push('✉️ ' + contact.emails.join(', '));
  if (contact.notes) lines.push('📝 ' + contact.notes);
  return lines.join('\n');
}

export {
  findContact,
  findByRelationship,
  findAllByName,
  createContact,
  updateContact,
  addHistory,
  processEntities,
  formatContact,
  formatContactInfo,
  listContacts,
  findOrCreateByPhone,
  findOrCreateByEmail,
  loadContacts,
  setContactInstructions
};