// contacts.js — Aigentik contact memory system
// Builds and maintains a growing directory of contacts
// Gets smarter the more Aigentik is used

import fs from 'fs';
import path from 'path';
import config from './config.json' with { type: 'json' };
import log from './logger.js';
import { normalizeTrade } from './trades.js';

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
    const num = parseInt((c.id || '').replace('contact_', ''), 10) || 0;
    return num > max ? num : max;
  }, 0);
  return `contact_${String(maxId + 1).padStart(4, '0')}`;
}

// Find a contact by ID, phone, email, or name
function findContact(identifier) {
  const contacts = loadContacts();
  if (!identifier) return null;

  const directMatch = contacts.find(c => c.id === identifier);
  if (directMatch) return directMatch;

  const normPhone = normalizePhone(identifier);
  const normEmail = normalizeEmail(identifier);
  const nameLower = identifier.toLowerCase().trim();

  return contacts.find(c => {
    if (c.id === identifier) return true;
    if (normPhone && c.phones?.some(p => normalizePhone(p) === normPhone)) return true;
    if (normEmail && c.emails?.some(e => normalizeEmail(e) === normEmail)) return true;
    if (c.name?.toLowerCase() === nameLower) return true;
    if (c.name?.toLowerCase().includes(nameLower)) return true;
    if (c.aliases?.some(a => a.toLowerCase() === nameLower)) return true;
    if (c.aliases?.some(a => a.toLowerCase().includes(nameLower))) return true;
    return false;
  }) || null;
}

// Find a contact by its exact id
function getContactById(id) {
  if (!id) return null;
  return loadContacts().find(c => c.id === id) || null;
}

// Which of `required` (any of 'name','email','phone','address') this
// contact doesn't have yet
function getMissingFields(contact, required) {
  if (!contact) return [...required];
  return required.filter(f => {
    if (f === 'name') return !contact.name;
    if (f === 'email') return !(contact.emails?.length);
    if (f === 'phone') return !(contact.phones?.length);
    if (f === 'address') return !contact.address;
    return false;
  });
}

// Apply LLM-extracted { name, email, phone, address } onto a contact,
// filling in only what's actually present — used while collecting missing
// info before booking an appointment
function applyExtractedDetails(id, extracted) {
  const updates = {};
  if (extracted?.name) updates.name = extracted.name;
  if (extracted?.email) updates.emails = extracted.email;
  if (extracted?.phone) updates.phones = extracted.phone;
  if (extracted?.address) updates.address = extracted.address;
  if (Object.keys(updates).length === 0) return null;
  return updateContact(id, updates);
}

// Apply a parsed subcontractor application (subcontractor-form.js) onto a
// contact — always forces type to 'subcontractor' (a submitted application
// is an unambiguous signal, unlike the incremental scheduling-intake
// extraction applyExtractedDetails does) and overwrites trade/license/
// insurance/crew fields with the latest submission rather than merging,
// since a resubmission should reflect current standing, not accumulate.
function applySubcontractorDetails(id, parsed) {
  if (!parsed) return null;
  const updates = { type: 'subcontractor' };
  if (parsed.business_name) updates.business_name = parsed.business_name;
  if (parsed.trade) updates.trade = parsed.trade;
  if (parsed.trade_raw) updates.trade_raw = parsed.trade_raw;
  if (parsed.principal_name) updates.name = parsed.principal_name;
  if (parsed.phone) updates.phones = parsed.phone;
  if (parsed.email) updates.emails = parsed.email;
  if (parsed.licensed !== null && parsed.licensed !== undefined) updates.licensed = parsed.licensed;
  if (parsed.license_number) updates.license_number = parsed.license_number;
  if (parsed.gl_insurance !== null && parsed.gl_insurance !== undefined) updates.gl_insurance = parsed.gl_insurance;
  if (parsed.wc_insurance !== null && parsed.wc_insurance !== undefined) updates.wc_insurance = parsed.wc_insurance;
  if (parsed.has_tools !== null && parsed.has_tools !== undefined) updates.has_tools = parsed.has_tools;
  if (parsed.crew_size != null) updates.crew_size = parsed.crew_size;
  if (parsed.weekly_capacity) updates.weekly_capacity = parsed.weekly_capacity;
  if (parsed.references?.length) updates.references = parsed.references;
  return updateContact(id, updates);
}

// Subcontractors on file whose trade matches a freeform query (e.g. "list
// my plumbers" -> tradeQuery "plumbers") — normalizes the query the same
// way trade_raw was normalized on intake so "plumber"/"plumbing"/"Plumbing
// Contractor" all resolve to the same slug; falls back to a raw substring
// match against trade_raw for a trade that didn't map to a known slug.
function findSubcontractorsByTrade(tradeQuery) {
  if (!tradeQuery) return [];
  const norm = normalizeTrade(tradeQuery);
  const q = tradeQuery.toLowerCase().trim();
  return loadContacts().filter(c => {
    if (c.type !== 'subcontractor') return false;
    if (norm && c.trade === norm) return true;
    if (c.trade_raw && c.trade_raw.toLowerCase().includes(q)) return true;
    return false;
  });
}

// Trade/license/insurance/crew block appended to a subcontractor's contact
// info — shared by formatContactInfo (owner "find [name]") and anywhere
// else (e.g. index.js's appointment detail block) that needs to hand the
// admin a subcontractor's standing alongside their booking/contact info.
function formatSubcontractorDetails(contact) {
  if (!contact || contact.type !== 'subcontractor') return '';
  const lines = [];
  if (contact.business_name) lines.push('🏢 Business: ' + contact.business_name);
  if (contact.trade_raw || contact.trade) lines.push('🛠️ Trade: ' + (contact.trade_raw || contact.trade));
  if (contact.licensed !== null && contact.licensed !== undefined) {
    lines.push('📄 Licensed: ' + (contact.licensed ? 'Yes' + (contact.license_number ? ' (#' + contact.license_number + ')' : '') : 'No'));
  }
  if (contact.gl_insurance !== null && contact.gl_insurance !== undefined) lines.push('🛡️ GL Insurance: ' + (contact.gl_insurance ? 'Yes' : 'No'));
  if (contact.wc_insurance !== null && contact.wc_insurance !== undefined) lines.push('🛡️ WC Insurance: ' + (contact.wc_insurance ? 'Yes' : 'No'));
  if (contact.has_tools !== null && contact.has_tools !== undefined) lines.push('🧰 Own tools/crew: ' + (contact.has_tools ? 'Yes' : 'No'));
  if (contact.crew_size != null) lines.push('👷 Crew size: ' + contact.crew_size);
  if (contact.weekly_capacity) lines.push('🗓️ Capacity: ' + contact.weekly_capacity);
  if (contact.references?.length) lines.push('📇 References: ' + contact.references.map(r => r.raw).join('; '));
  return lines.join('\n');
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
    address: null,
    relationship: relationship || null,
    type: type || 'unknown',
    notes: notes || null,
    instructions: null,
    reply_behavior: 'auto',
    // Subcontractor-specific fields — stay null/empty for every other
    // contact type, populated from a parsed application (see
    // applySubcontractorDetails / subcontractor-form.js).
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
  if (updates.type) contact.type = updates.type;
  if (updates.notes) contact.notes = updates.notes;
  if (updates.address) contact.address = updates.address;
  if (updates.business_name) contact.business_name = updates.business_name;
  if (updates.trade) contact.trade = updates.trade;
  if (updates.trade_raw) contact.trade_raw = updates.trade_raw;
  if (updates.licensed !== undefined) contact.licensed = updates.licensed;
  if (updates.license_number) contact.license_number = updates.license_number;
  if (updates.gl_insurance !== undefined) contact.gl_insurance = updates.gl_insurance;
  if (updates.wc_insurance !== undefined) contact.wc_insurance = updates.wc_insurance;
  if (updates.has_tools !== undefined) contact.has_tools = updates.has_tools;
  if (updates.crew_size != null) contact.crew_size = updates.crew_size;
  if (updates.weekly_capacity) contact.weekly_capacity = updates.weekly_capacity;
  if (updates.references) contact.references = updates.references;

  contact.last_contact = new Date().toISOString();
  contact.contact_count = (contact.contact_count || 0) + 1;

  contacts[idx] = contact;
  saveContacts(contacts);

  log.debug('contacts', `Contact updated: ${id}`, { updates: Object.keys(updates) });
  return contact;
}

// Delete a contact entirely
function deleteContact(identifier) {
  const contacts = loadContacts();
  const contact = getContactById(identifier) || findContact(identifier) || findByRelationship(identifier);
  if (!contact) return false;
  saveContacts(contacts.filter(c => c.id !== contact.id));
  log.info('contacts', `Contact deleted: ${contact.name || contact.id}`, { id: contact.id });
  return true;
}

// Explicitly overwrite a contact's name (updateContact only fills in a missing name)
function renameContact(identifier, newName) {
  const contacts = loadContacts();
  const contact = getContactById(identifier) || findContact(identifier) || findByRelationship(identifier);
  if (!contact) return null;
  const idx = contacts.findIndex(c => c.id === contact.id);
  contacts[idx].name = newName;
  saveContacts(contacts);
  log.info('contacts', `Contact renamed to ${newName}`, { id: contact.id });
  return contacts[idx];
}

// Add a history entry to a contact
function addHistory(identifier, historyEntry) {
  const contact = getContactById(identifier) || findContact(identifier);
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

  const names = entities.names || [];
  const phones = entities.phones || [];
  const emails = entities.emails || [];
  const businesses = entities.businesses || [];
  const relationships = entities.relationships || [];

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
  if (contact.type !== 'unknown') {
    const tradeSuffix = contact.type === 'subcontractor' && (contact.trade_raw || contact.trade)
      ? `: ${contact.trade_raw || contact.trade}` : '';
    parts.push(`[${contact.type}${tradeSuffix}]`);
  }
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
  const contact = getContactById(identifier) || findContact(identifier) || findByRelationship(identifier);
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
  if (contact.address) lines.push('🏠 ' + contact.address);
  if (contact.notes) lines.push('📝 ' + contact.notes);
  const subDetails = formatSubcontractorDetails(contact);
  if (subDetails) lines.push(subDetails);
  return lines.join('\n');
}

export {
  findContact,
  getContactById,
  getMissingFields,
  applyExtractedDetails,
  applySubcontractorDetails,
  findSubcontractorsByTrade,
  formatSubcontractorDetails,
  findByRelationship,
  findAllByName,
  createContact,
  updateContact,
  deleteContact,
  renameContact,
  addHistory,
  processEntities,
  formatContact,
  formatContactInfo,
  listContacts,
  findOrCreateByPhone,
  findOrCreateByEmail,
  loadContacts,
  saveContacts,
  normalizePhone,
  setContactInstructions
};