// gmail.js — Aigentik Gmail integration v2.0
// Compatibility wrapper for EmailProvider
// Preserves all existing public APIs while using modern imapflow backend

import { getEmailProvider } from './email-provider.js';
import config from './config.json' with { type: 'json' };
import log from './logger.js';

let emailProvider = null;
let onNewEmailCallback = null;
const STARTUP_TIME = new Date();

log.info && console.log(`[gmail] Startup time: ${STARTUP_TIME.toISOString()} — older emails will be skipped`);

// Initialize email provider lazily
function getProvider() {
  if (!emailProvider) {
    emailProvider = getEmailProvider({
      config,
      logger: log
    });
  }
  return emailProvider;
}

// ─── PUBLIC API (Backward Compatible) ─────────────────────────────────────────

/**
 * Connect to Gmail IMAP and start monitoring for new emails
 * @param {Function} onNewEmail - Callback function for new emails
 */
function connect(onNewEmail) {
  onNewEmailCallback = onNewEmail;
  if (!config.gmail.email || !config.gmail.app_password) {
    log.error('gmail', 'Gmail credentials not configured');
    return;
  }
  log.info('gmail', `Connecting to Gmail as ${config.gmail.email}...`);

  const provider = getProvider();

  // Wrap callback to handle async errors
  const wrappedCallback = async (email) => {
    try {
      await onNewEmail(email);
    } catch (e) {
      log.error('gmail', 'Error in onNewEmail callback', { error: e.message });
    }
  };

  // Start connection in background (non-blocking)
  provider.connect(wrappedCallback).catch((err) => {
    log.error('gmail', 'Connection failed', { error: err.message });
  });
}

/**
 * Disconnect from Gmail IMAP
 */
async function disconnect() {
  if (emailProvider) {
    await emailProvider.disconnect();
    emailProvider = null;
  }
  log.info('gmail', 'IMAP disconnected');
}

// ─── EMAIL SENDING ────────────────────────────────────────────────────────────

/**
 * Send email reply
 */
async function sendReply(toEmail, originalSubject, body) {
  const provider = getProvider();
  return provider.sendReply(toEmail, originalSubject, body);
}

/**
 * Send new email
 */
async function sendEmail(toEmail, subject, body) {
  const provider = getProvider();
  return provider.sendEmail(toEmail, subject, body);
}

/**
 * Send notification to owner via email
 */
async function sendOwnerNotification(message) {
  const provider = getProvider();
  return provider.sendOwnerNotification(message);
}

// ─── EMAIL MANAGEMENT ─────────────────────────────────────────────────────────

/**
 * Search emails by criteria
 */
async function searchEmails(criteria) {
  const provider = getProvider();
  return provider.searchEmails(criteria);
}

/**
 * Delete emails permanently (move to Trash)
 */
async function deleteEmails(criteria) {
  const provider = getProvider();
  return provider.deleteEmails(criteria);
}

/**
 * Archive emails (move to All Mail)
 */
async function archiveEmails(criteria) {
  const provider = getProvider();
  return provider.archiveEmails(criteria);
}

/**
 * Mark emails as spam
 */
async function markAsSpam(criteria) {
  const provider = getProvider();
  return provider.markAsSpam(criteria);
}

/**
 * Scan the inbox and move to spam only messages matching predicate({from, subject, body})
 */
async function spamMatchingEmails(predicate) {
  const provider = getProvider();
  return provider.spamMatchingEmails(predicate);
}

/**
 * Mark emails as read
 */
async function markAsRead(criteria) {
  const provider = getProvider();
  return provider.markAsRead(criteria);
}

/**
 * Mark emails as unread
 */
async function markAsUnread(criteria) {
  const provider = getProvider();
  return provider.markAsUnread(criteria);
}

/**
 * Add a label to emails
 */
async function labelEmails(criteria, labelName) {
  const provider = getProvider();
  return provider.labelEmails(criteria, labelName);
}

/**
 * Mark all current inbox emails as seen
 */
async function markAllAsSeen() {
  const provider = getProvider();
  return provider.markAllAsSeen();
}

// ─── GOOGLE VOICE EMAIL PARSING ───────────────────────────────────────────────

/**
 * Check if an email is a Google Voice forwarded text message
 */
function isGoogleVoiceText(email) {
  const provider = getProvider();
  return provider.isGoogleVoiceText(email);
}

/**
 * Parse a Google Voice forwarded email into an SMS-like object
 */
function parseGoogleVoiceEmail(email) {
  const provider = getProvider();
  return provider.parseGoogleVoiceEmail(email);
}

/**
 * Reply to a Google Voice forwarded text by replying to the email
 */
async function replyToGoogleVoiceText(voiceMessage, replyText) {
  const provider = getProvider();
  return provider.replyToGoogleVoiceText(voiceMessage, replyText);
}

// Export all public APIs
export {
  connect,
  disconnect,
  sendReply,
  sendEmail,
  sendOwnerNotification,
  deleteEmails,
  archiveEmails,
  markAsSpam,
  spamMatchingEmails,
  markAsRead,
  markAsUnread,
  labelEmails,
  markAllAsSeen,
  isGoogleVoiceText,
  parseGoogleVoiceEmail,
  replyToGoogleVoiceText
};

// Default export for backward compatibility
export default {
  connect,
  disconnect,
  sendReply,
  sendEmail,
  sendOwnerNotification,
  deleteEmails,
  archiveEmails,
  markAsSpam,
  spamMatchingEmails,
  markAsRead,
  markAsUnread,
  labelEmails,
  markAllAsSeen,
  isGoogleVoiceText,
  parseGoogleVoiceEmail,
  replyToGoogleVoiceText
};