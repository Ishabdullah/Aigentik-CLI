// email-rules.js — Aigentik email rule engine v1.1
// Supports: from, domain, subject_contains, body_contains, promotional, any
// Default action when no rule matches: auto-reply

const fs = require('fs');
const path = require('path');
const config = require('./config.json');
const log = require('./logger');

const RULES_FILE = path.join(config.paths.data_dir, 'email-rules.json');

// Common promotional/marketing keywords for auto-detection
const PROMO_KEYWORDS = [
  'unsubscribe', 'opt-out', 'opt out', 'marketing', 'newsletter',
  'promotion', 'offer', 'deal', 'discount', 'sale', 'click here',
  'no-reply', 'noreply', 'donotreply', 'do-not-reply',
  'notifications@', 'updates@', 'news@', 'info@', 'hello@',
  'mailing list', 'email preferences', 'manage your'
];

function loadRules() {
  try {
    if (fs.existsSync(RULES_FILE)) {
      return JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
    }
  } catch (e) {
    log.warn('email-rules', 'Could not load rules file');
  }
  return [];
}

function saveRules(rules) {
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
  } catch (e) {
    log.error('email-rules', 'Failed to save rules', { error: e.message });
  }
}

function addRule({ description, condition_type, condition_value, action, added_by }) {
  const rules = loadRules();
  const rule = {
    id: `er_${Date.now()}`,
    description,
    condition_type,
    condition_value: condition_value || '',
    action,
    added_by: added_by || 'owner',
    created_at: new Date().toISOString(),
    match_count: 0
  };
  rules.unshift(rule); // Add to top so newer rules take priority
  saveRules(rules);
  log.info('email-rules', `Rule added: ${description}`, { action });
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
  log.info('email-rules', `Rule removed: ${removed.description}`);
  return true;
}

// Detect if email looks promotional
function isPromotional(email) {
  const combined = [
    email.from || '',
    email.subject || '',
    email.body?.substring(0, 500) || ''
  ].join(' ').toLowerCase();
  return PROMO_KEYWORDS.some(kw => combined.includes(kw));
}

// Check email against all rules
// Returns { action, rule, reason }
function checkRules(email) {
  const rules = loadRules();
  const from = (email.from || '').toLowerCase();
  const subject = (email.subject || '').toLowerCase();
  const body = (email.body || '').toLowerCase();

  for (const rule of rules) {
    const val = (rule.condition_value || '').toLowerCase();
    let matched = false;

    switch (rule.condition_type) {
      case 'from':
        matched = from.includes(val);
        break;
      case 'domain':
        // Match @domain.com anywhere in from address
        matched = from.includes(`@${val}`) || from.includes(val);
        break;
      case 'subject_contains':
        matched = subject.includes(val);
        break;
      case 'body_contains':
        matched = body.includes(val);
        break;
      case 'promotional':
        matched = isPromotional(email);
        break;
      case 'any':
        matched = from.includes(val) || subject.includes(val) || body.includes(val);
        break;
    }

    if (matched) {
      // Update match stats
      const allRules = loadRules();
      const rIdx = allRules.findIndex(r => r.id === rule.id);
      if (rIdx !== -1) {
        allRules[rIdx].match_count = (allRules[rIdx].match_count || 0) + 1;
        allRules[rIdx].last_matched = new Date().toISOString();
        saveRules(allRules);
      }
      log.info('email-rules', `Rule matched: "${rule.description}" → ${rule.action}`);
      return { action: rule.action, rule, reason: rule.description };
    }
  }

  // No rule matched — use default from config
  const defaultAction = config.behavior?.default_unmatched_action || 'auto-reply';
  log.debug('email-rules', `No rule matched for email from ${email.from} — default: ${defaultAction}`);
  return { action: defaultAction, rule: null, reason: 'default' };
}

function listRulesForSms() {
  const rules = loadRules();
  if (rules.length === 0) {
    return '📋 No email rules set.\n\nExamples:\n"spam all emails from amazon.com"\n"auto-reply to emails from boss@company.com"\n"delete emails with subject containing newsletter"';
  }
  const lines = [`📋 Email Rules (${rules.length}):\n`];
  rules.forEach((r, i) => {
    const icon = r.action === 'auto-reply' ? '↩️' : r.action === 'spam' ? '🚫' : r.action === 'delete' ? '🗑' : r.action === 'archive' ? '📦' : '👁';
    lines.push(`${i + 1}. ${icon} [${r.action.toUpperCase()}] ${r.description}`);
  });
  lines.push(`\nDefault for unmatched: ${config.behavior?.default_unmatched_action || 'auto-reply'}`);
  return lines.join('\n');
}

module.exports = { addRule, removeRule, checkRules, listRulesForSms, loadRules, isPromotional };
