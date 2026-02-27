// sms-inbox.js — Aigentik SMS inbox monitor v1.2
// Polls termux-sms-list every 30 seconds
// Routes: owner (Google Voice) → commands, all others → public handler
// Fixed: properly catches ALL incoming numbers

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const log = require('./logger');

const POLL_INTERVAL = config.sms.poll_interval_ms || 30000;
const ADMIN_NUMBER = config.owner.admin_number;
const SEEN_IDS_FILE = path.join(config.paths.data_dir, 'seen-sms-ids.json');

function loadSeenIds() {
  try {
    if (fs.existsSync(SEEN_IDS_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(SEEN_IDS_FILE, 'utf8')));
    }
  } catch (e) {
    log.warn('sms-inbox', 'Could not load seen IDs, starting fresh');
  }
  return new Set();
}

function saveSeenIds(seenIds) {
  try {
    const arr = Array.from(seenIds).slice(-1000);
    fs.writeFileSync(SEEN_IDS_FILE, JSON.stringify(arr));
  } catch (e) {
    log.warn('sms-inbox', 'Could not save seen IDs', { error: e.message });
  }
}

function normalizeNumber(num) {
  if (!num) return '';
  return num.replace(/[^0-9]/g, '').slice(-10);
}

function fetchRecentSms() {
  try {
    // Fetch last 25 messages from inbox to make sure we catch everything
    const raw = execSync(
      'termux-sms-list -l 25 -t inbox',
      { timeout: 15000, encoding: 'utf8' }
    );
    return JSON.parse(raw);
  } catch (e) {
    log.error('sms-inbox', 'Failed to fetch SMS', { error: e.message });
    return [];
  }
}

function startInbox({ onOwnerMessage, onPublicMessage }) {
  const seenIds = loadSeenIds();

  log.info('sms-inbox', 'SMS inbox started. Polling every ' + (POLL_INTERVAL / 1000) + 's');
  log.info('sms-inbox', 'Admin number: ' + ADMIN_NUMBER);

  // On startup mark all current messages as seen so we don't
  // reprocess old messages — but only if seenIds is empty
  // This way after restart we don't lose the seen list
  if (seenIds.size === 0) {
    const initial = fetchRecentSms();
    initial.forEach(sms => seenIds.add(sms._id));
    saveSeenIds(seenIds);
    log.info('sms-inbox', 'First run — marked ' + initial.length + ' existing SMS as seen');
  } else {
    log.info('sms-inbox', 'Resuming with ' + seenIds.size + ' previously seen IDs');
  }

  const loop = setInterval(async () => {
    if (config.behavior.paused) {
      log.debug('sms-inbox', 'System paused, skipping SMS poll');
      return;
    }

    const messages = fetchRecentSms();
    const newMessages = messages.filter(sms => !seenIds.has(sms._id));

    if (newMessages.length === 0) return;

    log.info('sms-inbox', newMessages.length + ' new SMS detected');

    for (const sms of newMessages) {
      // Mark seen immediately to prevent double processing
      seenIds.add(sms._id);

      const senderNorm = normalizeNumber(sms.address);
      const adminNorm = normalizeNumber(ADMIN_NUMBER);
      const isOwner = senderNorm === adminNorm;

      log.info('sms-inbox', 'New SMS from ' + sms.address + ' isOwner=' + isOwner, {
        id: sms._id,
        preview: sms.body?.substring(0, 50)
      });

      try {
        if (isOwner) {
          log.info('sms-inbox', 'Routing to owner command handler');
          if (onOwnerMessage) await onOwnerMessage(sms);
        } else {
          log.info('sms-inbox', 'Routing to public message handler');
          if (onPublicMessage) await onPublicMessage(sms);
        }
      } catch (e) {
        log.error('sms-inbox', 'Error handling SMS from ' + sms.address, {
          id: sms._id,
          error: e.message
        });
      }
    }

    saveSeenIds(seenIds);
  }, POLL_INTERVAL);

  return () => {
    clearInterval(loop);
    log.info('sms-inbox', 'SMS inbox stopped');
  };
}

module.exports = { startInbox };
