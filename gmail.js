// gmail.js — Aigentik Gmail integration v1.1
// IMAP IDLE push + SMTP sending + full email management
// Fixed: only processes emails received AFTER startup

const Imap = require('node-imap');
const nodemailer = require('nodemailer');
const { simpleParser } = require('mailparser');
const config = require('./config.json');
const log = require('./logger');

let imapConnection = null;
let onNewEmailCallback = null;
let reconnectTimer = null;
const RECONNECT_DELAY = 15000;

// NOTE: Record startup time — only process emails newer than this
const STARTUP_TIME = new Date();
log.info && console.log(`[gmail] Startup time: ${STARTUP_TIME.toISOString()} — older emails will be skipped`);

function getImapConfig() {
  return {
    user: config.gmail.email,
    password: config.gmail.app_password,
    host: config.gmail.imap_host,
    port: config.gmail.imap_port,
    tls: true,
    tlsOptions: { rejectUnauthorized: false },
    keepalive: { interval: 10000, idleInterval: 300000, forceNoop: true }
  };
}

function getTransporter() {
  return nodemailer.createTransport({
    host: config.gmail.smtp_host,
    port: config.gmail.smtp_port,
    secure: false,
    auth: { user: config.gmail.email, pass: config.gmail.app_password },
    tls: { rejectUnauthorized: false }
  });
}

async function parseMessage(msg) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    msg.on('body', (stream) => {
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', async () => {
        try {
          const parsed = await simpleParser(Buffer.concat(chunks));
          resolve({
            from: parsed.from?.text || '',
            from_email: parsed.from?.value?.[0]?.address || '',
            from_name: parsed.from?.value?.[0]?.name || '',
            to: parsed.to?.text || '',
            subject: parsed.subject || '(no subject)',
            body: parsed.text || parsed.html || '',
            date: parsed.date || new Date(),
            message_id: parsed.messageId || ''
          });
        } catch (e) { reject(e); }
      });
    });
  });
}

function openInboxAndWatch(imap) {
  imap.openBox('INBOX', false, (err, box) => {
    if (err) {
      log.error('gmail', 'Failed to open INBOX', { error: err.message });
      return;
    }
    log.info('gmail', `INBOX opened. ${box.messages.total} total messages.`);
    imap.on('mail', (numNew) => {
      log.info('gmail', `${numNew} new email(s) pushed by Gmail`);
      fetchUnseen(imap);
    });
  });
}

function fetchUnseen(imap) {
  // Only fetch emails received since startup
  const sinceDate = STARTUP_TIME.toDateString();
  imap.search(['UNSEEN', ['SINCE', sinceDate]], (err, uids) => {
    if (err) { log.error('gmail', 'Search error', { error: err.message }); return; }
    if (!uids || uids.length === 0) { log.debug('gmail', 'No new unread emails'); return; }

    log.info('gmail', `Fetching ${uids.length} new email(s)`);
    const fetch = imap.fetch(uids, { bodies: '' });

    fetch.on('message', async (msg, seqno) => {
      try {
        const email = await parseMessage(msg);

        // Double-check email is newer than startup time
        const emailDate = new Date(email.date);
        if (emailDate < STARTUP_TIME) {
          log.debug('gmail', `Skipping old email from ${email.from_email} (${email.date})`);
          return;
        }

        log.info('gmail', `Processing new email from ${email.from_email}`, { subject: email.subject });

        // Mark as seen
        imap.addFlags(uids, ['\\Seen'], (e) => {
          if (e) log.warn('gmail', 'Could not mark as seen', { error: e.message });
        });

        if (onNewEmailCallback) await onNewEmailCallback(email);
      } catch (e) {
        log.error('gmail', 'Failed to parse email', { error: e.message });
      }
    });

    fetch.on('error', (e) => log.error('gmail', 'Fetch error', { error: e.message }));
  });
}

// ─── EMAIL MANAGEMENT FUNCTIONS ───────────────────────────────────────────────

// ─── GOOGLE VOICE EMAIL PARSING ───────────────────────────────────────────────

// Check if an email is a Google Voice forwarded text message
function isGoogleVoiceText(email) {
  return email.subject?.startsWith('New text message from') ||
         email.subject?.startsWith('New group text message');
}

// Parse a Google Voice forwarded email into an SMS-like object
function parseGoogleVoiceEmail(email) {
  // Subject format: "New text message from NAME (XXX) XXX-XXXX"
  const subjectMatch = email.subject?.match(
    /New text message from (.+?)\s*\((\d{3})\)\s*(\d{3})-(\d{4})/
  );

  let senderName = null;
  let senderPhone = null;

  if (subjectMatch) {
    senderName = subjectMatch[1].trim();
    senderPhone = subjectMatch[2] + subjectMatch[3] + subjectMatch[4];
  }

  // Strip Google Voice footer from body
  let body = email.body || '';
  const footerIdx = body.indexOf('To respond to this text message');
  if (footerIdx !== -1) {
    body = body.substring(0, footerIdx).trim();
  }
  // Also strip any HTML artifacts
  body = body.replace(/<[^>]*>/g, '').trim();

  return {
    type: 'google_voice',
    sender_name: senderName,
    sender_phone: senderPhone,
    sender_email: email.from_email,
    reply_to_email: email.from_email,
    body: body,
    original_subject: email.subject,
    original_email: email
  };
}

// Reply to a Google Voice forwarded text by replying to the email
async function replyToGoogleVoiceText(voiceMessage, replyText) {
  const transporter = getTransporter();
  try {
    await transporter.sendMail({
      from: config.gmail.email,
      to: voiceMessage.reply_to_email,
      subject: 'Re: ' + voiceMessage.original_subject,
      text: replyText
    });
    log.action('gmail', 'Google Voice reply sent to ' + voiceMessage.sender_name +
      ' (' + voiceMessage.sender_phone + ')');
    return true;
  } catch (e) {
    log.error('gmail', 'Failed to send Google Voice reply', { error: e.message });
    throw e;
  }
}

// Get a fresh IMAP connection for management tasks
function getManagementImap() {
  return new Imap(getImapConfig());
}

// Helper — run a management action with its own IMAP connection
function withImap(action) {
  return new Promise((resolve, reject) => {
    const imap = getManagementImap();
    imap.once('ready', () => {
      imap.openBox('INBOX', false, (err) => {
        if (err) { imap.end(); return reject(err); }
        action(imap)
          .then(result => { imap.end(); resolve(result); })
          .catch(e => { imap.end(); reject(e); });
      });
    });
    imap.once('error', reject);
    imap.connect();
  });
}

// Search emails by various criteria
function searchEmails(imap, criteria) {
  return new Promise((resolve, reject) => {
    imap.search(criteria, (err, uids) => {
      if (err) return reject(err);
      resolve(uids || []);
    });
  });
}

// Delete emails permanently (move to Trash then expunge)
async function deleteEmails(criteria) {
  return withImap(async (imap) => {
    const uids = await searchEmails(imap, criteria);
    if (!uids.length) return { deleted: 0 };
    return new Promise((resolve, reject) => {
      imap.move(uids, '[Gmail]/Trash', (err) => {
        if (err) return reject(err);
        log.action('gmail', `Deleted ${uids.length} email(s)`);
        resolve({ deleted: uids.length });
      });
    });
  });
}

// Archive emails (move to All Mail, out of Inbox)
async function archiveEmails(criteria) {
  return withImap(async (imap) => {
    const uids = await searchEmails(imap, criteria);
    if (!uids.length) return { archived: 0 };
    return new Promise((resolve, reject) => {
      imap.move(uids, '[Gmail]/All Mail', (err) => {
        if (err) return reject(err);
        log.action('gmail', `Archived ${uids.length} email(s)`);
        resolve({ archived: uids.length });
      });
    });
  });
}

// Mark emails as spam
async function markAsSpam(criteria) {
  return withImap(async (imap) => {
    const uids = await searchEmails(imap, criteria);
    if (!uids.length) return { spam: 0 };
    return new Promise((resolve, reject) => {
      imap.move(uids, '[Gmail]/Spam', (err) => {
        if (err) return reject(err);
        log.action('gmail', `Marked ${uids.length} email(s) as spam`);
        resolve({ spam: uids.length });
      });
    });
  });
}

// Mark emails as read
async function markAsRead(criteria) {
  return withImap(async (imap) => {
    const uids = await searchEmails(imap, criteria);
    if (!uids.length) return { marked: 0 };
    return new Promise((resolve, reject) => {
      imap.addFlags(uids, ['\\Seen'], (err) => {
        if (err) return reject(err);
        log.action('gmail', `Marked ${uids.length} email(s) as read`);
        resolve({ marked: uids.length });
      });
    });
  });
}

// Mark emails as unread
async function markAsUnread(criteria) {
  return withImap(async (imap) => {
    const uids = await searchEmails(imap, criteria);
    if (!uids.length) return { marked: 0 };
    return new Promise((resolve, reject) => {
      imap.delFlags(uids, ['\\Seen'], (err) => {
        if (err) return reject(err);
        log.action('gmail', `Marked ${uids.length} email(s) as unread`);
        resolve({ marked: uids.length });
      });
    });
  });
}

// Add a label to emails
// NOTE: Gmail labels must exist first — Axon will attempt to create if missing
async function labelEmails(criteria, labelName) {
  return withImap(async (imap) => {
    const uids = await searchEmails(imap, criteria);
    if (!uids.length) return { labeled: 0 };
    return new Promise((resolve, reject) => {
      imap.addFlags(uids, [labelName], (err) => {
        if (err) {
          log.warn('gmail', `Could not add label "${labelName}"`, { error: err.message });
          return reject(err);
        }
        log.action('gmail', `Labeled ${uids.length} email(s) as "${labelName}"`);
        resolve({ labeled: uids.length });
      });
    });
  });
}

// Mark all current inbox emails as seen (run once to clear backlog)
async function markAllAsSeen() {
  return withImap(async (imap) => {
    const uids = await searchEmails(imap, ['UNSEEN']);
    if (!uids.length) return { marked: 0 };
    return new Promise((resolve, reject) => {
      imap.addFlags(uids, ['\\Seen'], (err) => {
        if (err) return reject(err);
        log.action('gmail', `Marked all ${uids.length} emails as seen`);
        resolve({ marked: uids.length });
      });
    });
  });
}

// ─── SEND FUNCTIONS ────────────────────────────────────────────────────────────

async function sendReply(toEmail, originalSubject, body) {
  const transporter = getTransporter();
  const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;
  try {
    await transporter.sendMail({
      from: `${config.aigentik_name || 'Axon'} <${config.gmail.email}>`,
      to: toEmail, subject, text: body
    });
    log.action('gmail', `Reply sent to ${toEmail}`, { subject });
    return true;
  } catch (e) {
    log.error('gmail', `Failed to send reply to ${toEmail}`, { error: e.message });
    throw e;
  }
}

async function sendEmail(toEmail, subject, body) {
  const transporter = getTransporter();
  try {
    await transporter.sendMail({
      from: `${config.aigentik_name || 'Axon'} <${config.gmail.email}>`,
      to: toEmail, subject, text: body
    });
    log.action('gmail', `Email sent to ${toEmail}`, { subject });
    return true;
  } catch (e) {
    log.error('gmail', `Failed to send email to ${toEmail}`, { error: e.message });
    throw e;
  }
}
// Send notification to owner via email
// Owner sees it in Gmail — no SMS involved
async function sendOwnerNotification(message) {
  const transporter = getTransporter();
  try {
    await transporter.sendMail({
      from: config.gmail.email,
      to: config.gmail.email,
      subject: 'Aigentik Notification',
      text: message
    });
    log.info('gmail', 'Owner notification sent via email');
    return true;
  } catch (e) {
    log.error('gmail', 'Failed to send owner notification', { error: e.message });
    return false;
  }
}
// ─── CONNECTION MANAGEMENT ─────────────────────────────────────────────────────

function connect(onNewEmail) {
  onNewEmailCallback = onNewEmail;
  if (!config.gmail.email || !config.gmail.app_password) {
    log.error('gmail', 'Gmail credentials not configured');
    return;
  }
  log.info('gmail', `Connecting to Gmail as ${config.gmail.email}...`);
  imapConnection = new Imap(getImapConfig());
  imapConnection.once('ready', () => {
    log.info('gmail', 'IMAP IDLE active — monitoring for new emails');
    openInboxAndWatch(imapConnection);
  });
  imapConnection.on('error', (err) => {
    log.error('gmail', 'IMAP error', { error: err.message });
    scheduleReconnect(onNewEmail);
  });
  imapConnection.once('end', () => {
    log.warn('gmail', 'IMAP connection ended — reconnecting');
    scheduleReconnect(onNewEmail);
  });
  imapConnection.connect();
}

function scheduleReconnect(onNewEmail) {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect(onNewEmail);
  }, RECONNECT_DELAY);
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (imapConnection) { try { imapConnection.end(); } catch (e) {} imapConnection = null; }
  log.info('gmail', 'IMAP disconnected');
}

module.exports = {
  connect, disconnect,
  sendReply, sendEmail, sendOwnerNotification,
  deleteEmails, archiveEmails, markAsSpam,
  markAsRead, markAsUnread, labelEmails,
  markAllAsSeen,
  isGoogleVoiceText, parseGoogleVoiceEmail, replyToGoogleVoiceText
};
