// first-run.js — Aigentik first launch setup wizard
// Checks if configured, if not sends SMS to owner asking for a name

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const PROFILE_FILE = path.join(config.paths.data_dir, 'profile.json');
const ADMIN_NUMBER = config.owner.admin_number_formatted;

function loadProfile() {
  try {
    return JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
  } catch (e) {
    return { configured: false, aigentik_name: null };
  }
}

function saveProfile(profile) {
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
}

function sendSms(number, message) {
  try {
    const safeMessage = message.replace(/'/g, "'\\''");
    execSync(`termux-sms-send -n "${number}" '${safeMessage}'`, { timeout: 15000 });
    return true;
  } catch (e) {
    log.error('first-run', 'Failed to send setup SMS', { error: e.message });
    return false;
  }
}

function fetchLatestSmsFromOwner(timeoutMs = 120000) {
  const start = Date.now();
  log.info('first-run', 'Waiting for owner to reply with Aigentik name...');

  let lastKnownId = null;
  try {
    const initial = JSON.parse(
      execSync('termux-sms-list -l 1 -t inbox', { encoding: 'utf8', timeout: 10000 })
    );
    if (initial.length > 0) lastKnownId = initial[0]._id;
  } catch (e) {}

  while (Date.now() - start < timeoutMs) {
    execSync('sleep 5');
    try {
      const messages = JSON.parse(
        execSync('termux-sms-list -l 5 -t inbox', { encoding: 'utf8', timeout: 10000 })
      );

      for (const sms of messages) {
        if (lastKnownId && sms._id <= lastKnownId) continue;

        const senderNorm = sms.address.replace(/[^0-9]/g, '').slice(-10);
        const adminNorm = config.owner.admin_number.replace(/[^0-9]/g, '').slice(-10);

        if (senderNorm === adminNorm) {
          log.info('first-run', 'Owner replied with name', { name: sms.body });
          return sms.body.trim();
        }
      }
    } catch (e) {
      log.warn('first-run', 'Poll error during setup', { error: e.message });
    }
  }

  return null;
}

// Run first-time setup if not configured
// Returns the aigentik name (either existing or newly set)
async function runIfNeeded() {
  const profile = loadProfile();

  if (profile.configured && profile.aigentik_name) {
    log.info('first-run', `Aigentik already configured as "${profile.aigentik_name}"`);
    config.aigentik_name = profile.aigentik_name;
    return profile.aigentik_name;
  }

  log.info('first-run', 'First run detected — starting setup wizard');

  const sent = sendSms(
    ADMIN_NUMBER,
    'Welcome to Aigentik! I\'m your new AI assistant. What would you like to call me? Reply with a name.'
  );

  if (!sent) {
    log.error('first-run', 'Could not send setup SMS. Check Termux:API permissions.');
    const defaultName = 'Aigentik';
    profile.configured = true;
    profile.aigentik_name = defaultName;
    profile.setup_date = new Date().toISOString();
    saveProfile(profile);
    config.aigentik_name = defaultName;
    return defaultName;
  }

  const chosenName = fetchLatestSmsFromOwner(120000);

  if (!chosenName) {
    log.warn('first-run', 'No name received in time — using default "Aigentik"');
    const defaultName = 'Aigentik';
    profile.configured = true;
    profile.aigentik_name = defaultName;
    profile.setup_date = new Date().toISOString();
    saveProfile(profile);
    config.aigentik_name = defaultName;
    sendSms(ADMIN_NUMBER, `No name received — I'll go by "Aigentik" for now. You can rename me anytime by texting: rename [new name]`);
    return defaultName;
  }

  const name = chosenName.charAt(0).toUpperCase() + chosenName.slice(1).toLowerCase();

  profile.configured = true;
  profile.aigentik_name = name;
  profile.setup_date = new Date().toISOString();
  saveProfile(profile);
  config.aigentik_name = name;

  log.info('first-run', `Aigentik named "${name}" — setup complete`);

  sendSms(
    ADMIN_NUMBER,
    `Perfect! I'm ${name}, your personal AI assistant. I'm now monitoring your email and messages. Text me anytime to give instructions!`
  );

  return name;
}

export { runIfNeeded };