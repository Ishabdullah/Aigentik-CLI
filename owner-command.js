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
import { normalizeTrade } from './trades.js';
import * as doNotContact from './do-not-contact.js';
import * as recruiter from './subcontractor-recruiter.js';
import * as customerModule from './customer-module.js';

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
async function handleRename(newName, customReply, silent = false) {
  const replyFn = customReply || reply;
  try {
    const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    const oldName = profile.aigentik_name || 'Aigentik';
    const trimmed = (newName || '').trim();
    if (!trimmed) {
      if (!silent) await replyFn('Please provide a valid name.');
      return;
    }
    const name = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
    profile.aigentik_name = name;
    profile.agent_name_set = true;
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
    config.aigentik_name = name;
    if (!silent) {
      await replyFn(`Done! I'll now go by "${name}" instead of "${oldName}". 😊`);
    }
    log.action('owner-command', `Renamed from ${oldName} to ${name}`);
  } catch (e) {
    if (!silent) await replyFn('Sorry, I had trouble saving the new name. Try again.');
  }
}

// A do-not-contact target can be a raw email/phone, or a saved contact's
// name — resolve a name down to the identifier(s) Aigentik would actually
// use to reach them, since the do-not-contact list is keyed on identifiers,
// not names.
function resolveIdentifiers(target) {
  if (!target) return [];
  if (target.includes('@') || /\d{7,}/.test(target)) return [target];
  const contact = contacts.findContact(target) || contacts.findByRelationship(target);
  if (!contact) return [];
  return [...(contact.emails || []), ...(contact.phones || [])];
}

async function handleBlockContact(target, reason, customReply) {
  const replyFn = customReply || reply;
  if (!target) { await replyFn('Who should I block? Give me a name, email, or phone number.'); return; }
  const identifiers = resolveIdentifiers(target);
  if (identifiers.length === 0) {
    await replyFn(`I couldn't find an email or phone for "${target}". Try the exact email or phone number.`);
    return;
  }
  identifiers.forEach(id => doNotContact.addToDoNotContact({
    identifier: id,
    name: target.includes('@') || /\d{7,}/.test(target) ? null : target,
    reason: reason || 'blocked by owner',
    source: 'owner'
  }));
  await replyFn(`🚫 Blocked ${target} — ${identifiers.join(', ')}. I will never contact them again.`);
  log.action('owner-command', `Owner blocked: ${target}`, { identifiers });
}

async function handleUnblockContact(target, customReply) {
  const replyFn = customReply || reply;
  if (!target) { await replyFn('Who should I unblock?'); return; }
  const identifiers = resolveIdentifiers(target);
  const candidates = identifiers.length ? identifiers : [target];
  const removed = candidates.filter(id => doNotContact.removeFromDoNotContact(id));
  if (removed.length === 0) {
    await replyFn(`"${target}" isn't on the do-not-contact list.`);
    return;
  }
  await replyFn(`✅ Unblocked ${target}.`);
  log.action('owner-command', `Owner unblocked: ${target}`, { identifiers: removed });
}

// Marks setup complete once both identity fields Aigentik asks for on
// first run (see index.js's sendOnboardingEmail()) are known — informational
// only, nothing currently branches on it, but keeps profile.json honest.
function markConfiguredIfComplete(profile) {
  if (profile.owner_name && profile.business_name) profile.configured = true;
}

// Set who the agent works for (business name) and what that business does,
// so replies and Q&A take on that business's persona instead of a generic
// personal-assistant one. Description is optional — the name alone is
// enough to start using it in prompts. ownerName is optional too — set
// together with the business when the same message introduces both (the
// common case for the first-run onboarding reply — see index.js).
async function handleSetBusinessInfo(businessName, businessDescription, ownerName, customReply) {
  const replyFn = customReply || reply;
  try {
    const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    const parts = [];

    if (ownerName && !profile.owner_name) {
      profile.owner_name = ownerName;
      config.owner_name = ownerName;
      parts.push(`I'll call you ${ownerName}`);
    }

    // A description only carries over when re-stating the same business
    // name — naming a different business without a description shouldn't
    // silently inherit the old one's.
    if (businessName !== profile.business_name) profile.business_description = null;
    profile.business_name = businessName;
    if (businessDescription) profile.business_description = businessDescription;
    config.business_name = profile.business_name;
    config.business_description = profile.business_description;
    parts.push(`I now work as the secretary for ${businessName}` +
      (profile.business_description ? `, ${profile.business_description}` : ''));

    markConfiguredIfComplete(profile);
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
    await replyFn(`Got it — ${parts.join('. ')}. 😊`);
    log.action('owner-command', `Business info set: ${businessName} — ${profile.business_description || 'no description'}` +
      (ownerName ? `, owner: ${ownerName}` : ''));
  } catch (e) {
    await replyFn('Sorry, I had trouble saving that. Try again.');
  }
}

// Set only the owner's own name — used when the admin introduces themselves
// without mentioning a business (e.g. a personal-assistant-only install).
// Overwrites deliberately (this is also how an already-configured owner
// corrects their name later), but always says what it replaced so an
// unintended overwrite — e.g. the model misfiring on an unrelated message —
// is obvious immediately rather than silent.
async function handleSetOwnerName(ownerName, customReply) {
  const replyFn = customReply || reply;
  try {
    const profile = JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8'));
    const oldName = profile.owner_name;
    profile.owner_name = ownerName;
    markConfiguredIfComplete(profile);
    fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
    config.owner_name = ownerName;
    await replyFn(oldName && oldName !== ownerName
      ? `Got it — I'll call you ${ownerName} instead of ${oldName}. 😊`
      : `Got it — I'll call you ${ownerName}. 😊`);
    log.action('owner-command', `Owner name set: ${ownerName}` + (oldName ? ` (was ${oldName})` : ''));
  } catch (e) {
    await replyFn('Sorry, I had trouble saving that. Try again.');
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

  // Show the do-not-contact list
  if (lower === 'blocked' || lower === 'do not contact list' || lower === 'dnc list' || lower === 'dnc') {
    reply(doNotContact.listDoNotContact());
    return;
  }

  // Show subcontractor recruitment pipeline
  if (lower === 'pipeline' || lower === 'subcontractor pipeline' || lower === 'subcontractor leads' || lower === 'subcontractors') {
    reply(recruiter.formatPipelineReport());
    return;
  }

  // Show pending subcontractor follow-ups
  if (lower === 'subcontractor followups' || lower === 'sub followups' || lower === 'pending followups') {
    reply(recruiter.formatFollowupList());
    return;
  }

  // Show customer CRM pipeline report
  if (lower === 'customers' || lower === 'customer pipeline' || lower === 'customer leads') {
    reply(customerModule.formatCustomerPipelineReport());
    return;
  }

  // Show pending customer follow-ups
  if (lower === 'customer followups' || lower === 'customer follow-ups' || lower === 'client followups') {
    reply(customerModule.formatCustomerFollowupList());
    return;
  }

  // Show hot leads
  if (lower === 'hot leads' || lower === 'hot customers') {
    const custs = customerModule.loadCustomers().filter(c => c.lead_score === 'HOT');
    if (custs.length === 0) {
      reply('No HOT leads currently in pipeline.');
    } else {
      const list = custs.map(c => `🔥 ${c.customer_name} [${c.customer_id}] — ${c.project_type || c.project_category || 'General'} | Status: ${c.lead_status} | Phone: ${c.phone || 'N/A'}`).join('\n');
      reply(`🔥 Hot Leads (${custs.length}):\n${list}`);
    }
    return;
  }

  // Customer profile shorthand — "customer [name/id/phone]"
  if (lower.startsWith('customer ') && !lower.startsWith('customer pipeline') && !lower.startsWith('customer followups') && !lower.startsWith('customer follow-ups') && !lower.startsWith('customer leads')) {
    const target = text.substring(9).trim();
    const cust = customerModule.findCustomer(target);
    if (!cust) {
      reply(`No customer found matching "${target}".`);
    } else {
      reply(customerModule.formatCustomerSummary(cust));
    }
    return;
  }

  // Block shorthand — "block [name/email/phone]"
  if (lower.startsWith('block ')) {
    await handleBlockContact(text.substring(6).trim());
    return;
  }

  // Unblock shorthand — "unblock [name/email/phone]"
  if (lower.startsWith('unblock ')) {
    await handleUnblockContact(text.substring(8).trim());
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
      await reply('I need an email address for "' + target + '". Say "add contact ' + target + ' email [address]"');
      return;
    }

    if (doNotContact.isBlocked(exactMatch.emails[0])) {
      await reply('🚫 ' + (exactMatch.name || target) + ' (' + exactMatch.emails[0] + ') is on your do-not-contact list — I won\'t send this.');
      return;
    }

    try {
      await reply('✍️ Generating email to ' + (exactMatch.name || target) + ' about "' + topic + '"...');
      const content = await llama.generateContent(topic, 'email', 'To: ' + (exactMatch.name || target));
      const subject = topic.charAt(0).toUpperCase() + topic.slice(1);
      const { sendEmail } = await import('./gmail.js');
      await sendEmail(exactMatch.emails[0], subject, content);
      await reply('✅ Email sent to ' + (exactMatch.name || target) + ' (' + exactMatch.emails[0] + ')\nSubject: ' + subject);
    } catch (e) {
      await reply('❌ Failed to send email: ' + e.message);
    }
    return;
  }

  // Rename command
  if (lower.startsWith('rename ')) {
    const newName = text.substring(7).trim();
    if (newName) { await handleRename(newName); return; }
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
    await reply(`Sorry, I had trouble understanding that command. Could you rephrase it?`);
  }
}

// Execute an interpreted command object
async function executeInterpretedCommand(cmd, originalText, name) {
  let gmail;
  try { gmail = await import('./gmail.js'); } catch (e) {}

  // agent_name can ride alongside any action (e.g. the same onboarding reply
  // that also sets the owner's name and the business) — handled once here.
  // When set_business_info also has an agent_name, rename silently so the
  // business info confirmation sends a single unified reply.
  if (cmd.agent_name && cmd.action !== 'set_agent_name') {
    await handleRename(cmd.agent_name, reply, cmd.action === 'set_business_info');
  }

  switch (cmd.action) {
    case 'set_agent_name': {
      const newName = cmd.target || cmd.agent_name;
      if (!newName) { await reply('What would you like me to go by?'); break; }
      await handleRename(newName);
      break;
    }
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

      if (doNotContact.isBlocked(item.sender)) {
        reply(`🚫 ${item.sender_name || item.sender} is on your do-not-contact list — I won't send this. Say "skip ${id}" to dismiss it, or "unblock ${item.sender_name || item.sender}" if that's wrong.`);
        break;
      }

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

      if (doNotContact.isBlocked(toEmail)) {
        reply(`🚫 ${toName} (${toEmail}) is on your do-not-contact list — I won't send this. Say "unblock ${toName}" if that's wrong.`);
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

    case 'add_subcontractor': {
      const targetName = cmd.target;
      if (!targetName) { reply("What's the subcontractor's name or business name?"); break; }

      let extracted = {};
      try {
        extracted = await llama.extractSubcontractorDetails(cmd.content || originalText);
      } catch (e) {
        log.error('owner-command', 'Failed to extract subcontractor details', { error: e.message });
      }

      let contact = contacts.findContact(targetName);
      if (!contact) {
        contact = contacts.createContact({
          name: targetName,
          phones: extracted.phone,
          emails: extracted.email,
          type: 'subcontractor',
          source: 'owner'
        });
      }

      contacts.applySubcontractorDetails(contact.id, {
        business_name: extracted.business_name || (contact.business_name ? null : targetName),
        trade: normalizeTrade(extracted.trade),
        trade_raw: extracted.trade,
        phone: extracted.phone,
        email: extracted.email,
        licensed: extracted.licensed,
        license_number: extracted.license_number,
        gl_insurance: extracted.gl_insurance,
        wc_insurance: extracted.wc_insurance,
        has_tools: extracted.has_tools,
        crew_size: extracted.crew_size,
        weekly_capacity: extracted.weekly_capacity
      });

      // Also record in the recruiter pipeline
      const sub = recruiter.createOrUpdateSubcontractorLead({
        contact_id: contact.id,
        company_name: extracted.business_name || targetName,
        contact_name: targetName,
        phone: extracted.phone || (contact.phones?.[0]),
        email: extracted.email || (contact.emails?.[0]),
        primary_trade: extracted.trade,
        license_number: extracted.license_number,
        license_status: extracted.licensed ? 'LICENSE_VERIFIED' : (extracted.license_number ? 'LICENSE_PENDING_VERIFICATION' : null),
        general_liability: extracted.gl_insurance,
        workers_comp: extracted.wc_insurance,
        crew_size: extracted.crew_size,
        availability: extracted.weekly_capacity,
        lead_source: 'owner_command'
      });

      const trade = normalizeTrade(extracted.trade);
      reply(`✅ Added ${contact.name || targetName} as a subcontractor${trade ? ` (${extracted.trade})` : ''} [${sub.subcontractor_id}].`);
      log.action('owner-command', `add_subcontractor: ${targetName}`);
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
        await reply('What\'s the business name? Example: "the business name is Acme Restoration and we do home improvement, specializing in water damage restoration"');
        break;
      }
      await handleSetBusinessInfo(businessName, cmd.content, cmd.owner_name);
      break;
    }

    case 'set_owner_name': {
      const ownerName = cmd.target;
      if (!ownerName) {
        await reply('What\'s your name?');
        break;
      }
      await handleSetOwnerName(ownerName);
      break;
    }

    case 'find_contact': {
      const searchTerm = cmd.target;
      if (!searchTerm) { await reply('Who are you looking for?'); break; }

      const exactMatch = contacts.findContact(searchTerm) ||
                         contacts.findByRelationship(searchTerm);

      if (exactMatch) {
        await reply('📒 Found:\n' + contacts.formatContactInfo(exactMatch));
        break;
      }

      const allMatches = contacts.findAllByName(searchTerm);

      if (allMatches.length === 0) {
        await reply('No contact found for "' + searchTerm + '".\n\nTry "sync contacts" to refresh from your phone.');
        break;
      }

      if (allMatches.length === 1) {
        await reply('📒 Found:\n' + contacts.formatContactInfo(allMatches[0]));
        break;
      }

      const names = allMatches.map((c, i) => (i + 1) + '. ' + (c.name || c.phones?.[0] || c.id)).join('\n');
      await reply('Found ' + allMatches.length + ' contacts named "' + searchTerm + '":\n\n' + names + '\n\nWhich one? Reply with the full name.');
      break;
    }

    case 'sync_contacts': {
      await reply('🔄 Syncing contacts from your phone...');
      const result = contactsSync.syncContacts();
      await reply('✅ Done!\n📱 ' + result.added + ' new\n🔄 ' + result.updated + ' updated\n👥 ' + result.total + ' total');
      break;
    }

    case 'list_contacts':
      await reply(`📒 Contacts:\n${contacts.listContacts()}`);
      break;

    case 'list_subcontractors_by_trade': {
      const tradeQuery = cmd.target;
      if (!tradeQuery) { await reply('Which trade?'); break; }
      const matches = contacts.findSubcontractorsByTrade(tradeQuery);
      if (matches.length === 0) {
        await reply(`I don't have any subcontractors on file for "${tradeQuery}".`);
        break;
      }
      const list = matches.map(c => contacts.formatContact(c)).join('\n');
      await reply(`🛠️ ${matches.length} subcontractor(s) for "${tradeQuery}":\n${list}`);
      break;
    }

    case 'list_subcontractor_pipeline': {
      await reply(recruiter.formatPipelineReport());
      break;
    }

    case 'show_subcontractor_profile': {
      const target = cmd.target;
      if (!target) { await reply("Which subcontractor? Give a name, trade, or ID."); break; }
      const sub = recruiter.findSubcontractor(target);
      if (!sub) {
        await reply(`No subcontractor found matching "${target}".`);
      } else {
        await reply(recruiter.formatSubcontractorSummary(sub));
      }
      break;
    }

    case 'qualify_subcontractor': {
      const target = cmd.target;
      if (!target) { await reply("Which subcontractor do you want to qualify?"); break; }
      const sub = recruiter.findSubcontractor(target);
      if (!sub) {
        await reply(`Subcontractor "${target}" not found.`);
        break;
      }
      const updated = recruiter.updateSubcontractor(sub.subcontractor_id, {
        qualification_status: recruiter.QUALIFICATION_STATUSES.QUALIFICATION_IN_PROGRESS
      });
      await reply(`🛠️ Qualification in progress for ${sub.company_name || sub.contact_name} [${sub.subcontractor_id}]. Next step: ${recruiter.determineNextRecruitmentStep(updated)}`);
      break;
    }

    case 'approve_subcontractor': {
      const target = cmd.target;
      if (!target) { await reply("Which subcontractor do you want to approve?"); break; }
      const sub = recruiter.findSubcontractor(target);
      if (!sub) {
        await reply(`Subcontractor "${target}" not found.`);
        break;
      }
      recruiter.updateSubcontractor(sub.subcontractor_id, {
        qualification_status: recruiter.QUALIFICATION_STATUSES.APPROVED_ONBOARDING
      });
      await reply(`✅ Approved onboarding for ${sub.company_name || sub.contact_name} [${sub.subcontractor_id}]. Status set to APPROVED_ONBOARDING.`);
      log.action('owner-command', `approve_subcontractor: ${sub.subcontractor_id}`);
      break;
    }

    case 'decline_subcontractor': {
      const target = cmd.target;
      if (!target) { await reply("Which subcontractor do you want to decline?"); break; }
      const sub = recruiter.findSubcontractor(target);
      if (!sub) {
        await reply(`Subcontractor "${target}" not found.`);
        break;
      }
      recruiter.updateSubcontractor(sub.subcontractor_id, {
        qualification_status: recruiter.QUALIFICATION_STATUSES.DECLINED
      });
      await reply(`🛑 Marked ${sub.company_name || sub.contact_name} [${sub.subcontractor_id}] as DECLINED.`);
      log.action('owner-command', `decline_subcontractor: ${sub.subcontractor_id}`);
      break;
    }

    case 'request_subcontractor_docs': {
      const target = cmd.target;
      if (!target) { await reply("Which subcontractor needs document requests?"); break; }
      const sub = recruiter.findSubcontractor(target);
      if (!sub) {
        await reply(`Subcontractor "${target}" not found.`);
        break;
      }
      const missing = recruiter.getMissingDocuments(sub);
      recruiter.updateSubcontractor(sub.subcontractor_id, {
        qualification_status: recruiter.QUALIFICATION_STATUSES.DOCUMENTS_REQUESTED
      });
      await reply(`📄 Document request flagged for ${sub.company_name || sub.contact_name} [${sub.subcontractor_id}].\nMissing: ${missing.join(', ')}`);
      break;
    }

    case 'list_subcontractor_missing_docs': {
      const target = cmd.target;
      if (!target) { await reply("Which subcontractor?"); break; }
      const sub = recruiter.findSubcontractor(target);
      if (!sub) {
        await reply(`Subcontractor "${target}" not found.`);
        break;
      }
      const missing = recruiter.getMissingDocuments(sub);
      if (!missing.length) {
        await reply(`✅ All documents received for ${sub.company_name || sub.contact_name} [${sub.subcontractor_id}].`);
      } else {
        await reply(`⚠️ Missing documents for ${sub.company_name || sub.contact_name} [${sub.subcontractor_id}]:\n• ${missing.join('\n• ')}`);
      }
      break;
    }

    case 'list_subcontractor_followups': {
      await reply(recruiter.formatFollowupList());
      break;
    }

    case 'list_customers': {
      await reply(customerModule.formatCustomerPipelineReport());
      break;
    }

    case 'show_customer_profile': {
      const target = cmd.target;
      if (!target) { await reply("Which customer? Say 'customer [name/id/phone]'"); break; }
      const cust = customerModule.findCustomer(target);
      if (!cust) {
        await reply(`Customer "${target}" not found.`);
      } else {
        await reply(customerModule.formatCustomerSummary(cust));
      }
      break;
    }

    case 'list_customer_followups': {
      await reply(customerModule.formatCustomerFollowupList());
      break;
    }

    case 'list_hot_leads': {
      const custs = customerModule.loadCustomers().filter(c => c.lead_score === 'HOT');
      if (custs.length === 0) {
        await reply('No HOT leads currently in pipeline.');
      } else {
        const list = custs.map(c => `🔥 ${c.customer_name} [${c.customer_id}] — ${c.project_type || c.project_category || 'General'} | Status: ${c.lead_status} | Phone: ${c.phone || 'N/A'}`).join('\n');
        await reply(`🔥 Hot Leads (${custs.length}):\n${list}`);
      }
      break;
    }

    case 'update_customer_status': {
      const target = cmd.target;
      const newStatus = (cmd.content || '').toUpperCase().trim();
      if (!target || !newStatus) {
        await reply("Please specify customer and status, e.g. 'update customer John status QUALIFIED'");
        break;
      }
      const cust = customerModule.findCustomer(target);
      if (!cust) {
        await reply(`Customer "${target}" not found.`);
        break;
      }
      const updated = customerModule.updateCustomer(cust.customer_id, { lead_status: newStatus });
      await reply(`✅ Updated ${updated.customer_name} [${updated.customer_id}] status to ${newStatus}.`);
      log.action('owner-command', `update_customer_status: ${updated.customer_id} -> ${newStatus}`);
      break;
    }

    case 'escalate_customer': {
      const target = cmd.target;
      if (!target) { await reply("Which customer?"); break; }
      const cust = customerModule.findCustomer(target);
      if (!cust) {
        await reply(`Customer "${target}" not found.`);
        break;
      }
      const updated = customerModule.updateCustomer(cust.customer_id, {
        escalation_status: 'HUMAN_REVIEW_REQUIRED'
      });
      const handoff = customerModule.formatHandoffSummary({
        customer: updated,
        issue: cmd.content || 'Owner-requested human escalation',
        urgency: 'High'
      });
      await reply(handoff);
      log.action('owner-command', `escalate_customer: ${updated.customer_id}`);
      break;
    }

    case 'block_contact': {
      await handleBlockContact(cmd.target, cmd.content);
      break;
    }

    case 'unblock_contact': {
      await handleUnblockContact(cmd.target);
      break;
    }

    case 'list_do_not_contact':
      reply(doNotContact.listDoNotContact());
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