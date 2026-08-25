// sms-rules.js — Aigentik SMS rule engine
// Checks incoming SMS against saved rules
// Returns: auto-reply, review, spam, or no-match

import fs from 'fs';
import path from 'path';
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const RULES_FILE = path.join(config.paths.data_dir, 'sms-rules.json');

function loadRules() {
  try {
    if (fs.existsSync(RULES_FILE)) {
      return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    }
  } catch (e) {
    log.warn('sms-rules', 'Could not load rules file');
  }
  return [];
}

function saveRules(rules) {
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
  } catch (e) {
    log.error('sms-rules', 'Failed to save rules', { error: e.message });
  }
}

function addRule({ description, condition_type, condition_value, action, added_by }) {
  const rules = loadRules();
  const rule = {
    id: `sr_${Date.now()}`,
    description,
    condition_type,
    condition_value: condition_value || '',
    action,
    added_by: added_by || 'owner',
    created_at: new Date().toISOString(),
    match_count: 0
  };
  rules.unshift(rule);
  saveRules(rules);
  log.info('sms-rules', `Rule added: ${description}`, { action });
  return rule;
}

function removeRule(identifier) {
  const rules = loadRules();
  const idx = rules.findIndex(r =>
    r.id === identifier ||
    r.description.toLowerCase().includes(identifier.toLowerCase())
  );
  if (idx === -1) return false;
  const removed = rules.splice(idx, 1)[0];
  saveRules(rules);
  log.info('sms-rules', `Rule removed: ${removed.description}`);
  return true;
}

function checkRules(sms) {
  const rules = loadRules();
  const { address, body } = sms;
  const addressNorm = (address || '').replace(/[^0-9]/g, '').slice(-10);
  const bodyLower = (body || '').toLowerCase();

  for (const rule of rules) {
    const val = (rule.condition_value || '').toLowerCase();
    const valNorm = val.replace(/[^0-9]/g, '').slice(-10);
    let matched = false;

    switch (rule.condition_type) {
      case 'from_number':
        matched = addressNorm === valNorm || addressNorm.includes(valNorm);
        break;
      case 'message_contains':
        matched = bodyLower.includes(val);
        break;
      case 'any':
        matched = bodyLower.includes(val) || addressNorm.includes(valNorm);
        break;
    }

    if (matched) {
      const allRules = loadRules();
      const rIdx = allRules.findIndex(r => r.id === rule.id);
      if (rIdx !== -1) {
        allRules[rIdx].match_count = (allRules[rIdx].match_count || 0) + 1;
        allRules[rIdx].last_matched = new Date().toISOString();
        saveRules(allRules);
      }

      log.info('sms-rules', `Rule matched: "${rule.description}" → ${rule.action}`, {
        from: address
      });
      return { action: rule.action, rule };
    }
  }

  const defaultAction = config.behavior?.default_unmatched_sms_action || 'auto-reply';
  log.debug('sms-rules', `No rule matched for SMS from ${address} — defaulting to ${defaultAction}`);
  return { action: defaultAction, rule: null };
}

function listRulesForSms() {
  const rules = loadRules();
  if (rules.length === 0) return '📋 No SMS rules set yet.\n\nText: "add sms rule [description]" to add one.';
  const lines = [`📋 SMS Rules (${rules.length}):\n`];
  rules.forEach((r, i) => {
    lines.push(`${i + 1}. [${r.action.toUpperCase()}] ${r.description}`);
  });
  return lines.join('\n');
}

export { addRule, removeRule, checkRules, listRulesForSms, loadRules };