// queue.js — Aigentik pending review queue
// Holds emails and SMS waiting for owner approval

import fs from 'fs';
import path from 'path';
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const QUEUE_FILE = path.join(config.paths.data_dir, 'pending.json');

function loadQueue() {
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    }
  } catch (e) {
    log.warn('queue', 'Could not load queue file');
  }
  return [];
}

function saveQueue(queue) {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
  } catch (e) {
    log.error('queue', 'Failed to save queue', { error: e.message });
  }
}

function generateItemId(queue) {
  const max = queue.reduce((m, i) => Math.max(m, i.display_id || 0), 0);
  return max + 1;
}

// Add item to queue — returns the queue item with display_id
function addToQueue({ type, sender, senderName, subject, body, draftReply, contactId, replyToEmail, originalSubject, uid }) {
  const queue = loadQueue();
  const displayId = generateItemId(queue);

  const item = {
    display_id: displayId,
    type,
    sender,
    sender_name: senderName || null,
    subject: subject || null,
    body: body?.substring(0, 500) || '',
    draft_reply: draftReply || null,
    contact_id: contactId || null,
    // For type 'sms' items sourced from a Google Voice forwarded email: the
    // email address/subject needed to reply via gmail.replyToGoogleVoiceText
    // instead of sending SMS directly.
    reply_to_email: replyToEmail || null,
    original_subject: originalSubject || null,
    // The source email's IMAP UID, so a later "spam this item" can target
    // the exact message instead of falling back to "all mail from sender".
    uid: uid || null,
    queued_at: new Date().toISOString(),
    status: 'pending'
  };

  queue.push(item);
  saveQueue(queue);

  log.action('queue', `Added item #${displayId} to queue`, { type, sender });
  return item;
}

// Get item by display_id
function getItem(displayId) {
  const queue = loadQueue();
  return queue.find(i => i.display_id === parseInt(displayId)) || null;
}

// Remove item from queue
function removeItem(displayId) {
  const queue = loadQueue();
  const idx = queue.findIndex(i => i.display_id === parseInt(displayId));
  if (idx === -1) return false;
  queue.splice(idx, 1);
  saveQueue(queue);
  log.info('queue', `Removed item #${displayId} from queue`);
  return true;
}

// Update draft reply for an item
function updateDraft(displayId, newDraft) {
  const queue = loadQueue();
  const idx = queue.findIndex(i => i.display_id === parseInt(displayId));
  if (idx === -1) return false;
  queue[idx].draft_reply = newDraft;
  queue[idx].draft_edited = true;
  saveQueue(queue);
  return true;
}

// Get all pending items
function listQueue() {
  return loadQueue().filter(i => i.status === 'pending');
}

// Format queue for SMS display
function formatQueueForSms() {
  const pending = listQueue();
  if (pending.length === 0) return '📭 No pending items.';

  const lines = [`📬 ${pending.length} pending item(s):\n`];
  pending.forEach(item => {
    const icon = item.type === 'email' ? '✉️' : '💬';
    const from = item.sender_name || item.sender;
    const preview = item.subject || item.body?.substring(0, 40) + '...';
    lines.push(`#${item.display_id} ${icon} From: ${from}\n   ${preview}`);
  });
  lines.push(`\nReply: "reply [#]" to send, "edit [#] [text]" to change, "skip [#]" to dismiss`);
  return lines.join('\n');
}

// Format single item detail for SMS
function formatItemForSms(item) {
  if (!item) return 'Item not found.';
  const icon = item.type === 'email' ? '✉️' : '💬';
  return [
    `${icon} Item #${item.display_id}`,
    `From: ${item.sender_name || item.sender}`,
    item.subject ? `Subject: ${item.subject}` : '',
    `Message: ${item.body?.substring(0, 150)}`,
    `---`,
    `Draft reply: ${item.draft_reply || '(none)'}`,
    `\nReply "reply ${item.display_id}" to send or "edit ${item.display_id} [new text]" to change`
  ].filter(Boolean).join('\n');
}

export {
  addToQueue,
  getItem,
  removeItem,
  updateDraft,
  listQueue,
  formatQueueForSms,
  formatItemForSms
};