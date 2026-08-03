// owner-command.js — Aigentik natural language owner command processor
// Interprets messages from Google Voice number as natural language commands
// Executes actions and replies back to owner via SMS

import config from './config.json' with { type: 'json' };
import log from './logger.js';
import * as llama from './llama.js';
import * as queue from './queue.js';
import * as emailRules from './email-rules.js';
import * as contacts from './contacts.js';
import * as calendarModule from './calendar.js';
import fs from 'fs';
import path from 'path';
import * as contactsSync from './contacts-sync.js';

const PROFILE_FILE = path.join(config.paths.data_dir, 'profile.json');

// Pending confirmations for destructive actions
const pendingConfirmations = new Map();

// Where the current command's replies should go. Set at the top of every
// handleOwnerCommand() call (including the later "yes"/"no" confirmation
// call, which comes from the same channel as the original command), and
// read by reply(). Google Voice commands (address is a phone number) have
// no email to reply to directly, so they keep going to the self-notification
// address as before.
let currentReplyTarget = null;
let currentReplySubject = 'Aigentik';

function getAigentikName() {
  try {
    const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    return profile.aigentik_name || 'Aigentik';
  } catch (e) { return 'Aigentik'; }
}

async function reply(message) {
  try {
    const gmail = await import('./gmail.js');
    if (currentReplyTarget) {
      await gmail.sendReply(currentReplyTarget, currentReplySubject, message);
    } else {
      await gmail.sendOwnerNotification(message);
    }
  } catch (e) {
    log.error('owner-command', 'Failed to reply to owner', { error: e.message });
  }
}

// Handle a rename command
function handleRename(newName) {
  try {
    const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    const oldName = profile.aigentik_name;
    const name = newName.charAt(0).toUpperCase() + newName.slice(1).toLowerCase();
    profile.aigentik_name = name;
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
    config.aigentik_name = name;
    reply(`Done! I'll now go by "${name}" instead of "${oldName}". 😊`);
    log.action('owner-command', `Renamed from ${oldName} to ${name}`);
  } catch (e) {
    reply('Sorry, I had trouble saving the new name. Try again.');
  }
}

// Set who the agent works for (business name) and what that business does,
// so replies and Q&A take on that business's persona instead of a generic
// personal-assistant one. Description is optional — the name alone is
// enough to start using it in prompts.
function handleSetBusinessInfo(businessName, businessDescription) {
  try {
    const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    // A description only carries over when re-stating the same business
    // name — naming a different business without a description shouldn't
    // silently inherit the old one's.
    if (businessName !== profile.business_name) profile.business_description = null;
    profile.business_name = businessName;
    if (businessDescription) profile.business_description = businessDescription;
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
    config.business_name = profile.business_name;
    config.business_description = profile.business_description;
    reply(`Got it — I now work as the secretary for ${businessName}` +
      (profile.business_description ? `, ${profile.business_description}` : '') + `. 😊`);
    log.action('owner-command', `Business info set: ${businessName} — ${profile.business_description || 'no description'}`);
  } catch (e) {
    reply('Sorry, I had trouble saving that. Try again.');
  }
}

// Main command handler — called for every SMS from Google Voice
async function handleOwnerCommand(sms) {
  const text = sms.body?.trim();
  if (!text) return;

  currentReplyTarget = sms.address?.includes('@') ? sms.address : null;
  currentReplySubject = sms.subject || 'Aigentik';

  const name = getAigentikName();
  log.info('owner-command', `Owner command received: "${text}" (from ${sms.address}, subject "${currentReplySubject}")`);

  // --- Handle pending confirmations first ---
  if (pendingConfirmations.has('pending')) {
    const pending = pendingConfirmations.get('pending');
    if (text.toLowerCase() === 'yes' || text.toLowerCase() === 'confirm') {
      pendingConfirmations.delete('pending');
      await pending.execute();
      return;
    } else if (text.toLowerCase() === 'no' || text.toLowerCase() === 'cancel') {
      pendingConfirmations.delete('pending');
      reply('❌ Action cancelled.');
      return;
    }
    pendingConfirmations.delete('pending');
  }

  // --- Quick shorthand commands (no AI needed) ---
  const lower = text.toLowerCase().trim();

  // Sync contacts
  if (lower === 'sync contacts' || lower === 'refresh contacts' || lower === 'sync') {
    reply('🔄 Syncing contacts from your phone...');
    const result = contactsSync.syncContacts();
    reply('✅ Contacts synced!\n📱 ' + result.added + ' new contacts added\n🔄 ' + result.updated + ' updated\n👥 ' + result.total + ' total contacts');
    return;
  }

  // List pending queue
  if (lower === 'list' || lower === 'pending' || lower === 'queue') {
    reply(queue.formatQueueForSms());
    return;
  }

  // Status check
  if (lower === 'status' || lower === 'ping') {
    const pending = queue.listQueue();
    reply(`✅ ${name} is running.\n📬 ${pending.length} item(s) pending.\n⏱ ${new Date().toLocaleString()}`);
    return;
  }

  // List email rules
  if (lower === 'email rules' || lower === 'list email rules') {
    reply(emailRules.listRulesForSms());
    return;
  }

  // List SMS rules
  if (lower === 'sms rules' || lower === 'list sms rules') {
    const smsRules = await import('./sms-rules.js');
    reply(smsRules.listRulesForSms());
    return;
  }

  // List contacts
  if (lower === 'contacts' || lower === 'list contacts') {
    const list = contacts.listContacts();
    reply(`📒 Contacts:\n${list}`);
    return;
  }

  // Show current business identity
  if (lower === 'business info' || lower === 'company info' || lower === 'who do you work for') {
    if (config.business_name) {
      reply(`🏢 I work for ${config.business_name}` +
        (config.business_description ? `, ${config.business_description}` : ' (no description set)') + `.`);
    } else {
      reply('No business set yet. Tell me who I work for, e.g. "the business name is Acme Restoration and we do home improvement, specializing in water damage restoration"');
    }
    return;
  }

  // Direct email shorthand — "email [name] about/re [topic]"
  if (lower.startsWith('email ') && (lower.includes(' about ') || lower.includes(' re '))) {
    const words = text.split(' ');
    const target = words[1];
    const topicIdx = Math.max(lower.indexOf(' about '), lower.indexOf(' re '));
    const topic = text.substring(topicIdx + 6).trim();

    const exactMatch = contacts.findContact(target) ||
                       contacts.findByRelationship(target);

    if (!exactMatch || !exactMatch.emails?.length) {
      reply('I need an email address for "' + target + '". Say "add contact ' + target + ' email [address]"');
      return;
    }

    try {
      reply('✍️ Generating email to ' + (exactMatch.name || target) + ' about "' + topic + '"...');
      const content = await llama.generateContent(topic, 'email', 'To: ' + (exactMatch.name || target));
      const subject = topic.charAt(0).toUpperCase() + topic.slice(1);
      const { sendEmail } = await import('./gmail.js');
      await sendEmail(exactMatch.emails[0], subject, content);
      reply('✅ Email sent to ' + (exactMatch.name || target) + ' (' + exactMatch.emails[0] + ')\nSubject: ' + subject);
    } catch (e) {
      reply('❌ Failed to send email: ' + e.message);
    }
    return;
  }

  // Rename command
  if (lower.startsWith('rename ')) {
    const newName = text.substring(7).trim();
    if (newName) { handleRename(newName); return; }
  }

  // --- Use AI to interpret everything else ---
  try {
    const pendingCount = queue.listQueue().length;
    const context = {
      aigentik_name: name,
      pending_count: pendingCount,
      current_time: new Date().toISOString()
    };

    const interpreted = await llama.interpretCommand(text, context);
    log.info('owner-command', 'Command interpreted', interpreted);

    await executeInterpretedCommand(interpreted, text, name);

  } catch (e) {
    log.error('owner-command', 'Failed to interpret command', { error: e.message });
    reply(`Sorry, I had trouble understanding that command. Could you rephrase it?`);
  }
}

// Execute an interpreted command object
async function executeInterpretedCommand(cmd, originalText, name) {
  let gmail;
  try { gmail = await import('./gmail.js'); } catch (e) {}

  switch (cmd.action) {
    case 'delete_all_emails': {
      pendingConfirmations.set('pending', {
        execute: async () => {
          try {
            const result = await gmail.deleteEmails({ all: true });
            reply(`🗑 Done! Deleted ${result.deleted} email(s) from inbox.`);
          } catch (e) {
            reply(`❌ Failed to delete emails: ${e.message}`);
          }
        }
      });
      reply(`⚠️ You want to permanently delete ALL inbox emails.\n\nThis cannot be undone.\n\nReply "yes" to confirm or "no" to cancel.`);
      break;
    }

    case 'archive_all_emails': {
      pendingConfirmations.set('pending', {
        execute: async () => {
          try {
            const result = await gmail.archiveEmails({ all: true });
            reply(`📦 Done! Archived ${result.archived} email(s).`);
          } catch (e) {
            reply(`❌ Failed to archive: ${e.message}`);
          }
        }
      });
      reply(`⚠️ Archive ALL inbox emails?\n\nReply "yes" to confirm or "no" to cancel.`);
      break;
    }

    case 'spam_all_promotional': {
      pendingConfirmations.set('pending', {
        execute: async () => {
          try {
            const result = await gmail.spamMatchingEmails(emailRules.isPromotional);
            reply(`🚫 Done! Scanned ${result.scanned} email(s), moved ${result.spam} promotional one(s) to spam.`);
          } catch (e) {
            reply(`❌ Failed: ${e.message}`);
          }
        }
      });
      reply(`⚠️ Scan the inbox and move promotional emails to spam?\n\nReply "yes" to confirm or "no" to cancel.`);
      break;
    }

    case 'clean_inbox': {
      pendingConfirmations.set('pending', {
        execute: async () => {
          try {
            const result = await gmail.archiveEmails({ all: true });
            reply(`✅ Inbox cleaned! Archived ${result.archived} email(s). Your inbox is now empty.`);
          } catch (e) {
            reply(`❌ Failed to clean inbox: ${e.message}`);
          }
        }
      });
      reply(`⚠️ Clean inbox by archiving ALL emails?\n\nReply "yes" to confirm or "no" to cancel.`);
      break;
    }
    case 'list_pending':
      reply(queue.formatQueueForSms());
      break;

    case 'approve_reply': {
      const id = cmd.item_id;
      if (!id) { reply('Which item? Say "reply [number]"'); break; }
      const item = queue.getItem(id);
      if (!item) { reply(`Item #${id} not found.`); break; }

      if (item.type === 'email' && gmail) {
        await gmail.sendReply(item.sender, item.subject, item.draft_reply);
      } else if (item.type === 'sms' && gmail) {
        if (!item.reply_to_email) {
          reply(`❌ Item #${id} predates the current version and is missing the info needed to reply. Say "skip ${id}" to dismiss it.`);
          break;
        }
        // Google Voice texts arrive as a forwarded email; reply via that same
        // email (Google Voice delivers it as a text) rather than sending SMS
        // directly, so this stays consistent with the auto-reply path.
        await gmail.replyToGoogleVoiceText(
          { reply_to_email: item.reply_to_email, original_subject: item.original_subject },
          item.draft_reply
        );
      }
      queue.removeItem(id);
      reply(`✅ Reply sent for item #${id}.\nTo: ${item.sender_name || item.sender}`);
      log.action('owner-command', `Approved reply for item #${id}`);
      break;
    }

    case 'edit_reply': {
      const id = cmd.item_id;
      const newText = cmd.content;
      if (!id || !newText) { reply('Say: "edit [#] [new reply text]"'); break; }
      if (queue.updateDraft(id, newText)) {
        reply(`✏️ Draft updated for item #${id}.\nNew draft: "${newText}"\n\nSay "reply ${id}" to send it.`);
      } else {
        reply(`Item #${id} not found.`);
      }
      break;
    }

    case 'skip_item': {
      const id = cmd.item_id;
      if (!id) { reply('Which item? Say "skip [number]"'); break; }
      if (queue.removeItem(id)) {
        reply(`⏭ Item #${id} skipped and removed.`);
      } else {
        reply(`Item #${id} not found.`);
      }
      break;
    }

    case 'spam_item': {
      const id = cmd.item_id;
      if (!id) { reply('Which item? Say "spam [number]"'); break; }
      const item = queue.getItem(id);
      if (!item) { reply(`Item #${id} not found.`); break; }
      if (gmail && item.uid) {
        await gmail.spamByUid(item.uid);
      } else if (item.type === 'email' && gmail) {
        // Older queued items (from before UIDs were stored) have no way to
        // target the exact message, so this falls back to the whole sender.
        await gmail.markAsSpam({ from: item.sender });
      }
      queue.removeItem(id);
      reply(`🚫 Item #${id} marked as spam.`);
      log.action('owner-command', `Marked item #${id} as spam`);
      break;
    }

    case 'add_rule': {
      const ruleType = cmd.rule_type || 'email';
      const desc = cmd.rule_description || cmd.content;
      if (!desc) { reply('Describe the rule. e.g. "add email rule: auto-reply to anything from FedEx"'); break; }

      const rulePrompt = `Parse this rule description into JSON:
"${desc}"
Return: {"condition_type": "from|subject_contains|body_contains|domain|message_contains|any", "condition_value": "value to match", "action": "auto-reply|review|spam"}
Return ONLY JSON.`;

      const parsed = await llama.chat([{ role: 'user', content: rulePrompt }], 100);
      try {
        const ruleData = JSON.parse(parsed.replace(/```json|```/g, '').trim());
        if (ruleType === 'sms') {
          const smsRules = await import('./sms-rules.js');
          smsRules.addRule({ description: desc, ...ruleData, added_by: 'owner' });
        } else {
          emailRules.addRule({ description: desc, ...ruleData, added_by: 'owner' });
        }
        reply(`✅ ${ruleType.toUpperCase()} rule added:\n"${desc}"\nAction: ${ruleData.action}`);
      } catch (e) {
        reply(`Sorry, I couldn't parse that rule. Try: "add email rule: spam anything from [domain]"`);
      }
      break;
    }

    case 'remove_rule': {
      const ruleType = cmd.rule_type || 'email';
      const identifier = cmd.rule_description || cmd.content || cmd.target;
      if (!identifier) { reply('Which rule? Say "remove rule [description]" or check "email rules" / "sms rules" for the exact wording.'); break; }

      let removed;
      if (ruleType === 'sms') {
        const smsRules = await import('./sms-rules.js');
        removed = smsRules.removeRule(identifier);
      } else {
        removed = emailRules.removeRule(identifier);
      }

      if (removed) {
        reply(`✅ Removed the ${ruleType} rule matching "${identifier}".`);
        log.action('owner-command', `Removed ${ruleType} rule: ${identifier}`);
      } else {
        reply(`Couldn't find a ${ruleType} rule matching "${identifier}". Say "${ruleType} rules" to see the list.`);
      }
      break;
    }

    case 'list_rules': {
      const type = cmd.rule_type || 'both';
      let msg = '';
      if (type === 'email' || type === 'both') msg += emailRules.listRulesForSms() + '\n\n';
      if (type === 'sms' || type === 'both') {
        const smsRules = await import('./sms-rules.js');
        msg += smsRules.listRulesForSms();
      }
      reply(msg.trim());
      break;
    }

    case 'send_email': {
      if (!gmail) { reply('Email module not available.'); break; }
      let toEmail = null;
      let toName = cmd.target;

      if (cmd.target) {
        const contact = contacts.findContact(cmd.target) ||
                        contacts.findByRelationship(cmd.target);
        if (contact && contact.emails?.length) {
          toEmail = contact.emails[0];
          toName = contact.name || cmd.target;
        } else if (cmd.target.includes('@')) {
          // A raw email address, not (yet) a saved contact
          toEmail = cmd.target;
          toName = cmd.target;
        }
      }

      if (!toEmail) {
        reply(`I need an email address for "${cmd.target}". Do you have one saved for them?\nIf so, say: "add contact [name] email [address]"`);
        break;
      }

      const content = await llama.generateContent(cmd.content, 'email', `To: ${toName}`);
      const subject = `Re: ${cmd.content?.substring(0, 50) || 'Message from your assistant'}`;

      if (cmd.confirm_required) {
        pendingConfirmations.set('pending', {
          execute: async () => {
            await gmail.sendEmail(toEmail, subject, content);
            reply(`✅ Email sent to ${toName} (${toEmail})`);
          }
        });
        reply(`📧 Ready to send email to ${toName} (${toEmail}):\nSubject: ${subject}\nPreview: ${content.substring(0, 100)}...\n\nReply "yes" to send or "no" to cancel.`);
      } else {
        await gmail.sendEmail(toEmail, subject, content);
        reply(`✅ Email sent to ${toName} (${toEmail})`);
      }
      break;
    }

    case 'send_sms':
      reply(`I can't start a new text out of the blue — Aigentik only replies to Google Voice texts you've already received (via email), it can't send unprompted SMS. Reply to a pending item instead, or use "email [name] about ..." to reach them by email.`);
      break;

    case 'pause_all':
      config.behavior.paused = true;
      reply(`⏸ ${name} paused. I won't process any emails or SMS until you say "resume".`);
      log.action('owner-command', 'System paused by owner');
      break;

    case 'pause_email':
      config.behavior.pause_email = true;
      reply(`⏸ Email processing paused. SMS still active.`);
      break;

    case 'pause_sms':
      config.behavior.pause_sms = true;
      reply(`⏸ SMS auto-reply paused. Email still active.`);
      break;

    case 'resume_all':
      config.behavior.paused = false;
      config.behavior.pause_email = false;
      config.behavior.pause_sms = false;
      reply(`▶️ ${name} resumed. Monitoring all channels.`);
      log.action('owner-command', 'System resumed by owner');
      break;

    case 'resume_email':
      config.behavior.pause_email = false;
      reply(`▶️ Email processing resumed.`);
      break;

    case 'resume_sms':
      config.behavior.pause_sms = false;
      reply(`▶️ SMS auto-reply resumed.`);
      break;

    case 'status': {
      const pending = queue.listQueue();
      const paused = config.behavior.paused ? '⏸ PAUSED' : '✅ ACTIVE';
      reply(`${name} Status: ${paused}\n📬 Pending: ${pending.length}\n📧 Email: ${config.behavior.pause_email ? 'paused' : 'active'}\n💬 SMS: ${config.behavior.pause_sms ? 'paused' : 'active'}\n⏱ ${new Date().toLocaleString()}`);
      break;
    }

    case 'set_contact_instructions': {
      const target = cmd.target;
      const instructions = cmd.content;
      if (!target || !instructions) {
        reply('Tell me who and what. Example: "always reply to Mom with I am busy call you later"');
        break;
      }
      const contact = contacts.findContact(target) || contacts.findByRelationship(target);
      if (!contact) {
        reply('I don\'t have ' + target + ' in contacts yet. Have them text you first or say "add contact ' + target + ' number [phone]"');
        break;
      }
      const behavior = cmd.rule_type || 'auto';
      contacts.setContactInstructions(contact.id, instructions, behavior);
      reply('✅ Got it! For ' + (contact.name || target) + ' I will now: ' + instructions);
      log.action('owner-command', 'Contact instructions set for ' + target);
      break;
    }

    case 'never_reply_to': {
      const target = cmd.target;
      const contact = contacts.findContact(target) || contacts.findByRelationship(target);
      if (!contact) { reply('Contact "' + target + '" not found.'); break; }
      contacts.setContactInstructions(contact.id, 'never reply', 'never');
      reply('✅ Got it — I will never reply to ' + (contact.name || target) + '.');
      break;
    }

    case 'always_reply_to': {
      const target = cmd.target;
      const contact = contacts.findContact(target) || contacts.findByRelationship(target);
      if (!contact) { reply('Contact "' + target + '" not found.'); break; }
      contacts.setContactInstructions(contact.id, null, 'always');
      reply('✅ Got it — I will always auto-reply to ' + (contact.name || target) + '.');
      break;
    }

    case 'add_contact': {
      const targetName = cmd.target;
      if (!targetName) { reply('What\'s the contact\'s name?'); break; }

      const existing = contacts.findContact(targetName);
      const field = cmd.contact_field;
      const value = cmd.contact_value;

      if (existing) {
        if (field === 'phone') contacts.updateContact(existing.id, { phones: value });
        else if (field === 'email') contacts.updateContact(existing.id, { emails: value });
        else if (field === 'address') contacts.updateContact(existing.id, { address: value });
        else if (field === 'relationship') contacts.updateContact(existing.id, { relationship: value });
        reply(`✅ Updated ${existing.name || targetName}.`);
      } else {
        const c = contacts.createContact({
          name: targetName,
          phones: field === 'phone' ? value : null,
          emails: field === 'email' ? value : null,
          relationship: field === 'relationship' ? value : null,
          type: 'person',
          source: 'owner'
        });
        if (field === 'address') contacts.updateContact(c.id, { address: value });
        reply(`✅ Added ${c.name} to contacts.`);
      }
      log.action('owner-command', `add_contact: ${targetName}`);
      break;
    }

    case 'update_contact': {
      const targetName = cmd.target;
      if (!targetName) { reply('Which contact?'); break; }

      const contact = contacts.findContact(targetName) || contacts.findByRelationship(targetName);
      if (!contact) {
        reply(`Contact "${targetName}" not found. Say "add contact ${targetName}" first.`);
        break;
      }

      const field = cmd.contact_field;
      const value = cmd.contact_value;
      if (!field || !value) {
        reply('What should I change? Example: "save email john@x.com to Mike" or "change Mike\'s name to Michael"');
        break;
      }

      if (field === 'name') {
        contacts.renameContact(contact.id, value);
        reply(`✅ Renamed ${contact.name || targetName} to ${value}.`);
      } else if (field === 'phone') {
        contacts.updateContact(contact.id, { phones: value });
        reply(`✅ Added phone ${value} to ${contact.name || targetName}.`);
      } else if (field === 'email') {
        contacts.updateContact(contact.id, { emails: value });
        reply(`✅ Added email ${value} to ${contact.name || targetName}.`);
      } else if (field === 'address') {
        contacts.updateContact(contact.id, { address: value });
        reply(`✅ Set ${contact.name || targetName}'s address to ${value}.`);
      } else if (field === 'relationship') {
        contacts.updateContact(contact.id, { relationship: value });
        reply(`✅ Set ${contact.name || targetName}'s relationship to ${value}.`);
      } else if (field === 'notes') {
        contacts.updateContact(contact.id, { notes: value });
        reply(`✅ Updated notes for ${contact.name || targetName}.`);
      } else {
        reply(`I don't know how to update "${field}".`);
        break;
      }
      log.action('owner-command', `update_contact: ${targetName} (${field})`);
      break;
    }

    case 'delete_contact': {
      const targetName = cmd.target;
      if (!targetName) { reply('Which contact should I delete?'); break; }

      const contact = contacts.findContact(targetName) || contacts.findByRelationship(targetName);
      if (!contact) { reply(`Contact "${targetName}" not found.`); break; }

      pendingConfirmations.set('pending', {
        execute: async () => {
          contacts.deleteContact(contact.id);
          reply(`🗑️ Deleted ${contact.name || targetName} from contacts.`);
          log.action('owner-command', `Deleted contact: ${targetName}`);
        }
      });
      reply(`⚠️ Delete contact "${contact.name || targetName}"? This cannot be undone.\n\nReply "yes" to confirm or "no" to cancel.`);
      break;
    }

    case 'schedule_appointment': {
      const targetName = cmd.target;
      if (!targetName) { reply('Who\'s this appointment for?'); break; }

      let contact = contacts.findContact(targetName) || contacts.findByRelationship(targetName);
      if (!contact && targetName.includes('@')) {
        // A raw email address, not (yet) a saved contact — track it anyway
        contact = contacts.findOrCreateByEmail(targetName, null);
      }
      if (!contact) {
        reply(`Contact "${targetName}" not found. Add them first with "add contact ${targetName}", or give me an email address directly.`);
        break;
      }
      if (!contact.emails?.length) {
        reply(`I don't have an email on file for ${contact.name || targetName} to send the invite to. Say "save email x@y.com to ${targetName}" first.`);
        break;
      }

      const preferredDate = calendarModule.parseDatetimePhrase(cmd.content);
      const duration = calendarModule.getDurationForRelationship(contact.relationship);
      // Never book same-day unless explicitly asked for today/tonight
      const afterDate = calendarModule.mentionsToday(cmd.content) ? undefined : calendarModule.startOfTomorrow();
      const slot = calendarModule.findNextAvailableSlot({ afterDate, durationMinutes: duration, preferredDate });
      if (!slot) { reply('I couldn\'t find an open slot for that.'); break; }

      const appt = calendarModule.createAppointment({
        title: `Appointment with ${contact.name || targetName}`,
        start: slot.start,
        end: slot.end,
        contactId: contact.id,
        attendeeName: contact.name || targetName,
        attendeeEmail: contact.emails[0],
        createdVia: 'owner'
      });

      if (gmail) {
        await gmail.sendCalendarInvite(appt, contact.emails[0]);
        await gmail.sendCalendarInvite(appt, config.owner?.admin_email || config.gmail.email);
      }
      reply(`✅ Booked ${appt.title} for ${new Date(appt.start).toLocaleString()}. Invite sent to ${contact.emails[0]}.`);
      log.action('owner-command', `schedule_appointment: ${targetName} @ ${appt.start}`);
      break;
    }

    case 'reschedule_appointment': {
      const targetName = cmd.target;
      if (!targetName) { reply('Whose appointment?'); break; }

      const contact = contacts.findContact(targetName) || contacts.findByRelationship(targetName);
      if (!contact) { reply(`Contact "${targetName}" not found.`); break; }

      const appts = calendarModule.findAppointmentsByContact(contact.id);
      if (appts.length === 0) { reply(`No appointment on file for ${contact.name || targetName}.`); break; }
      const appt = appts.sort((a, b) => new Date(a.start) - new Date(b.start))[0];

      const preferredDate = calendarModule.parseDatetimePhrase(cmd.content);
      if (!preferredDate) { reply('What time should I move it to?'); break; }

      const duration = (new Date(appt.end) - new Date(appt.start)) / 60000;
      const afterDate = calendarModule.mentionsToday(cmd.content) ? undefined : calendarModule.startOfTomorrow();
      const slot = calendarModule.findNextAvailableSlot({ afterDate, durationMinutes: duration, preferredDate, excludeId: appt.id });
      if (!slot) { reply('That time isn\'t available and I couldn\'t find a nearby opening.'); break; }

      const updated = calendarModule.rescheduleAppointment(appt.id, slot.start, slot.end);
      if (gmail && updated.attendee_email) {
        await gmail.sendCalendarInvite(updated, updated.attendee_email);
        await gmail.sendCalendarInvite(updated, config.owner?.admin_email || config.gmail.email);
      }
      reply(`✅ Moved ${updated.title} to ${new Date(updated.start).toLocaleString()}.`);
      log.action('owner-command', `reschedule_appointment: ${targetName} -> ${updated.start}`);
      break;
    }

    case 'cancel_appointment': {
      const targetName = cmd.target;
      if (!targetName) { reply('Whose appointment should I cancel?'); break; }

      const contact = contacts.findContact(targetName) || contacts.findByRelationship(targetName);
      if (!contact) { reply(`Contact "${targetName}" not found.`); break; }

      const appts = calendarModule.findAppointmentsByContact(contact.id);
      if (appts.length === 0) { reply(`No appointment on file for ${contact.name || targetName}.`); break; }
      const appt = appts.sort((a, b) => new Date(a.start) - new Date(b.start))[0];

      pendingConfirmations.set('pending', {
        execute: async () => {
          calendarModule.cancelAppointment(appt.id);
          if (gmail) {
            if (appt.attendee_email) await gmail.sendCalendarCancellation(appt, appt.attendee_email);
            await gmail.sendCalendarCancellation(appt, config.owner?.admin_email || config.gmail.email);
          }
          reply(`🚫 Cancelled ${appt.title} (was ${new Date(appt.start).toLocaleString()}).`);
          log.action('owner-command', `Cancelled appointment for ${targetName}`);
        }
      });
      reply(`⚠️ Cancel ${appt.title} on ${new Date(appt.start).toLocaleString()}?\n\nReply "yes" to confirm or "no" to cancel.`);
      break;
    }

    case 'list_appointments': {
      const content = (cmd.content || '').toLowerCase().trim();
      if (!content) {
        reply(calendarModule.listUpcomingForSms());
      } else if (content.includes('today')) {
        reply(calendarModule.listForDateForSms(new Date()));
      } else if (content.includes('this week')) {
        reply(calendarModule.listUpcomingForSms(7));
      } else if (content.includes('next week')) {
        reply(calendarModule.listUpcomingForSms(14));
      } else if (content.includes('month')) {
        reply(calendarModule.listUpcomingForSms(30));
      } else {
        // A specific date, e.g. "tomorrow", "next tuesday", "august 5th"
        const date = calendarModule.parseDatetimePhrase(content);
        reply(date ? calendarModule.listForDateForSms(date) : calendarModule.listUpcomingForSms());
      }
      break;
    }

    case 'set_working_hours': {
      const parsed = calendarModule.parseWorkingHoursPhrase(cmd.content);
      if (parsed) {
        calendarModule.setWorkingHours(parsed.days, parsed.start, parsed.end);
        reply(`✅ Working hours updated:\n${calendarModule.formatWorkingHours()}`);
        log.action('owner-command', `Working hours set: ${JSON.stringify(parsed)}`);
        break;
      }

      const offDays = calendarModule.parseDayOffPhrase(cmd.content);
      if (offDays) {
        calendarModule.setDayOff(offDays);
        reply(`✅ Marked off: ${offDays.join(', ')}.\n${calendarModule.formatWorkingHours()}`);
        log.action('owner-command', `Days off set: ${offDays.join(',')}`);
        break;
      }

      reply('I couldn\'t parse that. Try: "set working hours 9am to 5pm monday through friday" or "I don\'t work on Sundays"');
      break;
    }

    case 'set_appointment_duration': {
      const relationship = cmd.rule_type;
      const minutes = parseInt(cmd.content, 10);
      if (!relationship || !minutes) {
        reply('Tell me the role and the duration. Example: "lawyers get 60 minute appointments"');
        break;
      }
      calendarModule.setDurationForRelationship(relationship, minutes);
      reply(`✅ ${relationship} appointments are now ${minutes} minutes by default.`);
      log.action('owner-command', `Duration set for ${relationship}: ${minutes}min`);
      break;
    }

    case 'set_business_info': {
      const businessName = cmd.target;
      if (!businessName) {
        reply('What\'s the business name? Example: "the business name is Acme Restoration and we do home improvement, specializing in water damage restoration"');
        break;
      }
      handleSetBusinessInfo(businessName, cmd.content);
      break;
    }

    case 'find_contact': {
      const searchTerm = cmd.target;
      if (!searchTerm) { reply('Who are you looking for?'); break; }

      const exactMatch = contacts.findContact(searchTerm) ||
                         contacts.findByRelationship(searchTerm);

      if (exactMatch) {
        reply('📒 Found:\n' + contacts.formatContactInfo(exactMatch));
        break;
      }

      const allMatches = contacts.findAllByName(searchTerm);

      if (allMatches.length === 0) {
        reply('No contact found for "' + searchTerm + '".\n\nTry "sync contacts" to refresh from your phone.');
        break;
      }

      if (allMatches.length === 1) {
        reply('📒 Found:\n' + contacts.formatContactInfo(allMatches[0]));
        break;
      }

      const names = allMatches.map((c, i) => (i + 1) + '. ' + (c.name || c.phones?.[0] || c.id)).join('\n');
      reply('Found ' + allMatches.length + ' contacts named "' + searchTerm + '":\n\n' + names + '\n\nWhich one? Reply with the full name.');
      break;
    }

    case 'sync_contacts': {
      reply('🔄 Syncing contacts from your phone...');
      const result = contactsSync.syncContacts();
      reply('✅ Done!\n📱 ' + result.added + ' new\n🔄 ' + result.updated + ' updated\n👥 ' + result.total + ' total');
      break;
    }

    case 'list_contacts':
      reply(`📒 Contacts:\n${contacts.listContacts()}`);
      break;

    case 'generate_content': {
      const content = await llama.generateContent(cmd.content, cmd.target || 'message', '');
      reply(`Here's what I generated:\n\n${content}`);
      break;
    }

    case 'unknown':
    default:
      try {
        const response = await llama.chat([
          {
            role: 'system',
            content: `You are ${name}, an AI assistant. Your owner sent you a message you couldn't interpret as a command. Respond helpfully and ask them to clarify if needed. Be brief.`
          },
          { role: 'user', content: originalText }
        ], 150);
        reply(response);
      } catch (e) {
        reply(`I'm not sure what you mean. Try: "status", "list", "email rules", "sms rules", or describe what you want me to do.`);
      }
      break;
  }
}

export { handleOwnerCommand };