// sms-send.js — Aigentik SMS sender
// Uses termux-api to send SMS messages from the phone

const { execSync } = require('child_process');
const config = require('./config.json');
const log = require('./logger');

// Send an SMS to any number
function sendSms(toNumber, message) {
  try {
    // Clean the number — remove spaces, dashes, etc
    const cleanNumber = toNumber.replace(/[^0-9+]/g, '');

    // Escape single quotes in message for shell safety
    const safeMessage = message.replace(/'/g, "'\\''");

    const cmd = `termux-sms-send -n "${cleanNumber}" '${safeMessage}'`;
    log.action('sms-send', `Sending SMS to ${cleanNumber}`, {
      to: cleanNumber,
      preview: message.substring(0, 50)
    });

    execSync(cmd, { timeout: 15000 });
    log.info('sms-send', `SMS sent successfully to ${cleanNumber}`);
    return true;

  } catch (e) {
    log.error('sms-send', `Failed to send SMS to ${toNumber}`, { error: e.message });
    return false;
  }
}

// Send a notification to the owner (Google Voice number)
function notifyOwner(message) {
  const ownerNumber = config.owner.admin_number_formatted;
  return sendSms(ownerNumber, message);
}

// Send a long message — splits if over 160 chars
function sendLongSms(toNumber, message) {
  // SMS can handle up to ~1600 chars in practice on Android
  // but we split at 1500 to be safe
  if (message.length <= 1500) {
    return sendSms(toNumber, message);
  }

  const chunks = [];
  let remaining = message;
  while (remaining.length > 0) {
    chunks.push(remaining.substring(0, 1500));
    remaining = remaining.substring(1500);
  }

  log.info('sms-send', `Splitting long message into ${chunks.length} parts`);
  let allSent = true;
  chunks.forEach((chunk, i) => {
    const part = chunks.length > 1 ? `[${i + 1}/${chunks.length}] ${chunk}` : chunk;
    if (!sendSms(toNumber, part)) allSent = false;
    // Small delay between parts
    if (i < chunks.length - 1) {
      execSync('sleep 1');
    }
  });
  return allSent;
}

module.exports = {
  sendSms,
  notifyOwner,
  sendLongSms
};

