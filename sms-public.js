// sms-public.js — Aigentik public SMS handler v1.1
// Handles incoming SMS from non-owner numbers
// Respects per-contact instructions, applies rules, adds agent signature

const config = require('./config.json');
const log = require('./logger');
const llama = require('./llama');
const smsSend = require('./sms-send');
const smsRules = require('./sms-rules');
const contacts = require('./contacts');
const queue = require('./queue');
const tone = require('./tone');
const fs = require('fs');
const path = require('path');

function getOwnerName() {
  try {
    const profile = JSON.parse(fs.readFileSync(
      path.join(config.paths.data_dir, 'profile.json'), 'utf8'
    ));
    return profile.owner_name || 'the owner';
  } catch (e) { return 'the owner'; }
}

async function handlePublicSms(sms) {
  if (config.behavior.paused || config.behavior.pause_sms) {
    log.info('sms-public', 'SMS processing paused, skipping');
    return;
  }

  const { address, body } = sms;
  log.info('sms-public', 'Public SMS from ' + address, { preview: body?.substring(0, 50) });

  // Find or create contact
  const contact = contacts.findOrCreateByPhone(address);
  contacts.addHistory(address, { type: 'sms_received', preview: body?.substring(0, 100) });

  // Extract entities to build contact intelligence
  try {
    const entities = await llama.extractEntities(body);
    contacts.processEntities(entities, 'sms');
  } catch (e) {
    log.warn('sms-public', 'Entity extraction failed', { error: e.message });
  }

  const ownerName = getOwnerName();
  const agentName = config.aigentik_name || 'Axon';

  // Check for urgent keyword — notify owner immediately
  if (body && ownerName && body.toLowerCase().includes(ownerName.toLowerCase())) {
    smsSend.notifyOwner(
      '🚨 URGENT: ' + (contact?.name || address) + ' is trying to reach you directly!\nMessage: "' + body.substring(0, 100) + '"'
    );
    log.action('sms-public', 'Urgent message detected — owner notified');
  }

  // Check per-contact reply behavior first
  if (contact?.reply_behavior === 'never') {
    log.info('sms-public', 'Contact set to never reply — skipping', { contact: contact.name });
    smsSend.notifyOwner('📵 Ignored SMS from ' + (contact.name || address) + ' (set to never reply)');
    return;
  }

  if (contact?.reply_behavior === 'review') {
    // Force to review queue regardless of rules
    try {
      const detectedTone = await tone.detectTone(body);
      const draftReply = await llama.generateSmsReply(
        address, contact?.name, body, detectedTone,
        contact?.relationship, contact?.instructions, ownerName, agentName
      );
      const item = queue.addToQueue({
        type: 'sms', sender: address,
        senderName: contact?.name, body, draftReply, contactId: contact?.id
      });
      smsSend.notifyOwner(
        '💬 SMS #' + item.display_id + ' from ' + (contact?.name || address) + ' (review required):\n"' + body.substring(0, 60) + '"\n\nDraft: "' + draftReply.substring(0, 80) + '"\n\nText "reply ' + item.display_id + '" to send'
      );
    } catch (e) {
      smsSend.notifyOwner('📬 SMS from ' + (contact?.name || address) + ' needs review:\n"' + body.substring(0, 100) + '"');
    }
    return;
  }

  // Check SMS rules
  const { action, rule } = smsRules.checkRules(sms);

  // If contact has 'always' behavior or rule says auto-reply
  const shouldAutoReply = contact?.reply_behavior === 'always' || action === 'auto-reply';

  if (action === 'spam') {
    log.action('sms-public', 'SMS from ' + address + ' marked as spam');
    smsSend.notifyOwner('🚫 Spam SMS blocked from ' + (contact?.name || address) + ':\n"' + body.substring(0, 60) + '"');
    return;
  }

  if (shouldAutoReply) {
    try {
      const detectedTone = await tone.detectTone(body);
      const reply = await llama.generateSmsReply(
        address, contact?.name, body, detectedTone,
        contact?.relationship, contact?.instructions, ownerName, agentName
      );

      smsSend.sendSms(address, reply);
      contacts.addHistory(address, { type: 'sms_auto_replied', preview: reply.substring(0, 100) });

      smsSend.notifyOwner(
        '💬 Auto-replied to ' + (contact?.name || address) + ':\nTheir msg: "' + body.substring(0, 50) + '"\nSent: "' + reply.substring(0, 80) + '"'
      );
      log.action('sms-public', 'Auto-replied to ' + address);
    } catch (e) {
      log.error('sms-public', 'Failed to generate auto-reply', { error: e.message });
      smsSend.notifyOwner('⚠️ Failed to auto-reply to ' + (contact?.name || address) + '. Message: "' + body.substring(0, 80) + '"');
    }
    return;
  }

  // Default — queue for review
  try {
    const detectedTone = await tone.detectTone(body);
    const draftReply = await llama.generateSmsReply(
      address, contact?.name, body, detectedTone,
      contact?.relationship, contact?.instructions, ownerName, agentName
    );
    const item = queue.addToQueue({
      type: 'sms', sender: address,
      senderName: contact?.name, body, draftReply, contactId: contact?.id
    });
    smsSend.notifyOwner(
      '💬 New SMS #' + item.display_id + ' from ' + (contact?.name || address) + ':\n"' + body.substring(0, 80) + '"\n\nDraft: "' + draftReply.substring(0, 60) + '"\n\nText "reply ' + item.display_id + '" to send'
    );
  } catch (e) {
    smsSend.notifyOwner('📬 New SMS from ' + (contact?.name || address) + ':\n"' + body.substring(0, 100) + '"');
  }
}

module.exports = { handlePublicSms };
