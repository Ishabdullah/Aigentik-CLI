// index.js — Aigentik v2.0
// Communication: Gmail + Google Voice ONLY
// No SMS sending or receiving via Termux
// Admin: texts FROM 5551234567 TO 5559876543 (Google Voice)
// Public: anyone texts 5559876543 (Google Voice)
// All routing via Gmail IMAP IDLE

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import log from './logger.js';
import config from './config.json' with { type: 'json' };
import { runIfNeeded as firstRun } from './first-run.js';
import * as llama from './llama.js';
import * as gmail from './gmail.js';
import * as ownerCommand from './owner-command.js';
import * as contacts from './contacts.js';
import * as contactsSync from './contacts-sync.js';
import * as queue from './queue.js';
import * as tone from './tone.js';
import * as smsRules from './sms-rules.js';
import * as emailRules from './email-rules.js';

const PROFILE_FILE = path.join(config.paths.data_dir, 'profile.json');

function loadProfile() {
  try {
    const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    config.aigentik_name = profile.aigentik_name || 'Aigentik';
    config.owner_name = profile.owner_name || 'Ish';
  } catch (e) {
    config.aigentik_name = 'Aigentik';
    config.owner_name = 'Ish';
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

async function startLlamaServer() {
  if (isLlamaRunning()) {
    log.info('index', 'llama-server already running');
    return true;
  }
  log.info('index', 'Starting llama-server...');
  try {
    // Expand tilde in model path
    const modelPath = config.llama.model_path.replace(/^~/, process.env.HOME || '/data/data/com.termux/files/home');
    const cmd = config.llama.llama_server_path +
      ' -m "' + modelPath + '"' +
      ' -t ' + config.llama.threads +
      ' -c ' + config.llama.context_size +
      ' --host 0.0.0.0 --port 8080 -np 1 --log-disable';
    execSync(cmd + ' &', { stdio: 'ignore' });
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (isLlamaRunning()) {
        log.info('index', 'llama-server started');
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

// Handle Google Voice forwarded text messages
async function handleGoogleVoiceText(email) {
  const voiceMsg = gmail.parseGoogleVoiceEmail(email);

  if (!voiceMsg.body || !voiceMsg.sender_phone) {
    log.warn('index', 'Could not parse Google Voice message', { subject: email.subject });
    return;
  }

  log.info('index', 'Google Voice text from ' + (voiceMsg.sender_name || voiceMsg.sender_phone),
    { body: voiceMsg.body.substring(0, 50) });

  const ownerName = config.owner_name || 'Ish';
  const agentName = config.aigentik_name || 'Aigentik';
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

  // Check for urgent keyword
  if (voiceMsg.body.toLowerCase().includes(ownerName.toLowerCase())) {
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

  const shouldAutoReply = contact?.reply_behavior === 'always' ||
                          contact?.reply_behavior === 'auto' ||
                          action === 'auto-reply';

  try {
    const detectedTone = await tone.detectTone(voiceMsg.body);
    const reply = await llama.generateSmsReply(
      voiceMsg.sender_phone,
      voiceMsg.sender_name,
      voiceMsg.body,
      detectedTone,
      contact?.relationship,
      contact?.instructions,
      ownerName,
      agentName
    );

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
        originalSubject: voiceMsg.original_subject
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

  // Route Google Voice texts separately
  if (gmail.isGoogleVoiceText(email)) {
    await handleGoogleVoiceText(email);
    return;
  }

  log.info('index', 'Regular email from ' + email.from_email, { subject: email.subject });

  const contact = contacts.findOrCreateByEmail(email.from_email, email.from_name);
  contacts.addHistory(email.from_email, {
    type: 'email_received',
    subject: email.subject,
    preview: email.body?.substring(0, 100)
  });

  const { action } = emailRules.checkRules({
    from: email.from_email,
    subject: email.subject,
    body: email.body
  });

  const ownerName = config.owner_name || 'Ish';
  const agentName = config.aigentik_name || 'Aigentik';

  if (action === 'spam') {
    await gmail.markAsSpam({ from: email.from_email });
    log.action('index', 'Email marked spam from ' + email.from_email);
    return;
  }

  try {
    const reply = await llama.generateEmailReply(
      email.from_name, email.from_email, email.subject,
      email.body?.substring(0, 1000),
      contact?.relationship, contact?.instructions,
      ownerName, agentName
    );

    if (action === 'auto-reply') {
      await gmail.sendReply(email.from_email, email.subject, reply);
      contacts.addHistory(email.from_email, { type: 'email_auto_replied' });
      await gmail.sendOwnerNotification(
        '✉️ Auto-replied to ' + (email.from_name || email.from_email) + ':\n' +
        'Subject: ' + email.subject?.substring(0, 50) + '\n' +
        'Sent: "' + reply.substring(0, 80) + '"'
      );
    } else {
      const item = queue.addToQueue({
        type: 'email',
        sender: email.from_email,
        senderName: email.from_name,
        subject: email.subject,
        body: email.body?.substring(0, 300),
        draftReply: reply,
        contactId: contact?.id
      });
      await gmail.sendOwnerNotification(
        '✉️ Email #' + item.display_id + ' from ' +
        (email.from_name || email.from_email) + ':\n' +
        'Subject: ' + email.subject?.substring(0, 50) + '\n' +
        'Draft: "' + reply.substring(0, 80) + '"\n\n' +
        'Reply "reply ' + item.display_id + '" to send'
      );
    }
  } catch (e) {
    log.error('index', 'Failed to process email', { error: e.message });
  }
}

// Graceful shutdown
async function shutdown(signal) {
  log.info('index', signal + ' received — shutting down Aigentik');
  await gmail.disconnect();
  process.exit(0);
}

async function main() {
  console.log('\n🤖 Aigentik v2.0 — Starting up...\n');

  loadProfile();

  // Start llama-server
  const llamaOk = await startLlamaServer();
  if (!llamaOk) {
    log.error('index', 'Cannot start without llama-server');
    process.exit(1);
  }

  // Warm up AI
  const warmedUp = await llama.warmUp();
  if (!warmedUp) {
    log.error('index', 'llama-server not responding');
    process.exit(1);
  }

  // First run check
  const aigentikName = await firstRun();
  config.aigentik_name = aigentikName;
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
  const pending = queue.listQueue();
  await gmail.sendOwnerNotification(
    '✅ ' + aigentikName + ' v2.0 is online!\n' +
    '📬 Pending: ' + pending.length + '\n' +
    '📧 Gmail: monitoring\n' +
    '💬 Google Voice: monitoring\n' +
    '📵 SMS: disabled\n\n' +
    'Text me at 5559876543 from your 9332 number to give commands!'
  );

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  log.info('index', aigentikName + ' v2.0 fully started — Gmail/Google Voice only');
  console.log('\n✅ ' + aigentikName + ' v2.0 running. Press Ctrl+C to stop.\n');
}

main().catch(e => {
  console.error('Fatal startup error:', e);
  process.exit(1);
});