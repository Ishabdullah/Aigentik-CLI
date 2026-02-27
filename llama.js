// llama.js — Aigentik AI communication layer
const config = require('./config.json');
const log = require('./logger');

const LLAMA_URL = `${config.llama.host}/v1/chat/completions`;
const MODEL = config.llama.model;
const MAX_TOKENS = config.llama.max_tokens;
const TEMPERATURE = config.llama.temperature;

let fetch;
try {
  fetch = require('node-fetch');
} catch (e) {
  console.error('node-fetch not installed. Run: npm install node-fetch@2');
  process.exit(1);
}

async function chat(messages, maxTokens = MAX_TOKENS) {
  try {
    const response = await fetch(LLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: TEMPERATURE }),
      timeout: 180000
    });
    if (!response.ok) throw new Error(`llama-server returned ${response.status}`);
    const data = await response.json();
    const text = data.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('Empty response from llama-server');
    return text;
  } catch (e) {
    log.error('llama', 'AI call failed', { error: e.message });
    throw e;
  }
}

async function generateEmailReply(senderName, senderEmail, subject, body, relationship, contactInstructions, ownerName, agentName) {
  const agent = agentName || config.aigentik_name || 'Axon';
  const owner = ownerName || 'my owner';
  const signature = '\n\n---\n' + agent + ' | Personal Agent of ' + owner + '\nIf you need to reach ' + owner + ' urgently, include "' + owner + '" in your subject line.';

  let instructionText = '';
  if (contactInstructions) {
    instructionText = 'IMPORTANT: Special instructions for this contact: ' + contactInstructions;
  }

  const systemMsg = 'You are ' + agent + ', an AI personal assistant managing email on behalf of ' + owner + '. ' +
    'You are replying to an email sent TO ' + owner + ' from ' + (senderName || senderEmail) + '. ' +
    'Write a professional, natural email reply as ' + agent + ' on behalf of ' + owner + '. ' +
    'Relationship to owner: ' + (relationship || 'unknown') + '. ' +
    (instructionText ? instructionText + '. ' : '') +
    'Do NOT add a signature — it will be added automatically. ' +
    'Reply with email body text only.';

  const userMsg = 'Reply to this email received by ' + owner + ':\nFrom: ' + senderName + ' <' + senderEmail + '>\nSubject: ' + subject + '\nBody: ' + body;

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ];

  log.info('llama', 'Generating email reply', { from: senderEmail });
  const reply = await chat(messages);
  return reply + signature;
}

async function generateSmsReply(senderNumber, senderName, message, tone, relationship, contactInstructions, ownerName, agentName) {
  const agent = agentName || config.aigentik_name || 'Axon';
  const owner = ownerName || 'my owner';
  const signature = '\n\n— ' + agent + ', personal agent of ' + owner + '. If you need to reach ' + owner + ' urgently, reply with "' + owner + '" in your message.';

  let instructionText = '';
  if (contactInstructions) {
    instructionText = 'IMPORTANT: Special instructions for this contact: ' + contactInstructions;
  }

  const systemMsg = 'You are ' + agent + ', an AI personal assistant managing communications on behalf of ' + owner + '. ' +
    'You are replying to a message sent TO ' + owner + ' from ' + (senderName || senderNumber) + '. ' +
    'Write a natural, helpful reply as ' + agent + ' on behalf of ' + owner + '. ' +
    'Match the tone: ' + (tone || 'neutral') + '. ' +
    'Relationship to owner: ' + (relationship || 'unknown') + '. ' +
    (instructionText ? instructionText + '. ' : '') +
    'Keep it concise — this is a text message. ' +
    'Do NOT add the signature — it will be added automatically. ' +
    'Reply with message text only, nothing else.';

  const userMsg = 'Reply to this text message received by ' + owner + ':\nFrom: ' + (senderName || senderNumber) + '\nMessage: "' + message + '"';

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ];

  log.info('llama', 'Generating SMS reply', { from: senderNumber, tone });
  const reply = await chat(messages);
  return reply + signature;
}

async function interpretCommand(commandText, context) {
  const actions = 'send_email, send_sms, list_pending, approve_reply, edit_reply, skip_item, spam_item, add_rule, remove_rule, list_rules, list_contacts, find_contact, set_contact_instructions, never_reply_to, always_reply_to, pause_all, pause_email, pause_sms, resume_all, resume_email, resume_sms, status, generate_content, delete_all_emails, archive_all_emails, spam_all_promotional, clean_inbox, sync_contacts, unknown';
  const schema = '{"action":"string","target":"string|null","content":"string|null","item_id":"number|null","rule_type":"string|null","rule_description":"string|null","confirm_required":false}';
  const systemMsg = 'You interpret natural language commands for an AI assistant. Return ONLY valid JSON: ' + schema + ' Actions: ' + actions + ' Examples: "text mom I love her"={"action":"send_sms","target":"mom","content":"I love her"} "email boss about the meeting"={"action":"send_email","target":"boss","content":"the meeting"} "find Mike"={"action":"find_contact","target":"Mike"} "delete all emails"={"action":"delete_all_emails"} "pause"={"action":"pause_all"}';
  const userMsg = 'Command: "' + commandText + '"\nContext: ' + JSON.stringify(context || {});
  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ];
  log.info('llama', 'Interpreting command', { command: commandText });
  const raw = await chat(messages, 256);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    log.warn('llama', 'Failed to parse command JSON', { raw });
    return { action: 'unknown', target: null, content: commandText, confirm_required: false };
  }
}

async function extractEntities(text) {
  const messages = [
    { role: 'system', content: `Extract contact info from text. Return ONLY valid JSON:
{"names":[],"phones":[],"emails":[],"businesses":[],"relationships":[],"topics":[]}` },
    { role: 'user', content: `Extract from: "${text}"` }
  ];
  const raw = await chat(messages, 256);
  try {
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    return { names: [], phones: [], emails: [], businesses: [], relationships: [], topics: [] };
  }
}

async function detectTone(text) {
  const messages = [
    { role: 'system', content: 'Detect tone. Reply with ONE word only: formal, casual, urgent, friendly, aggressive, neutral, or professional' },
    { role: 'user', content: `Detect tone of: "${text}"` }
  ];
  const result = await chat(messages, 10);
  const valid = ['formal','casual','urgent','friendly','aggressive','neutral','professional'];
  const tone = result.toLowerCase().trim().split(/\s/)[0];
  return valid.includes(tone) ? tone : 'neutral';
}

async function generateContent(topic, type, context) {
  const messages = [
    { role: 'system', content: `You are ${config.aigentik_name || 'an AI assistant'} generating ${type || 'content'} for your owner. Return only the content itself.` },
    { role: 'user', content: `Generate a ${type || 'message'} about: ${topic}\nContext: ${context || 'none'}` }
  ];
  log.info('llama', 'Generating content', { topic, type });
  return await chat(messages, 512);
}

async function warmUp() {
  log.info('llama', 'Warming up llama-server...');
  try {
    const result = await chat([{ role: 'user', content: 'Say "ready" and nothing else.' }], 10);
    log.info('llama', 'Warm-up complete', { response: result });
    return true;
  } catch (e) {
    log.error('llama', 'Warm-up failed', { error: e.message });
    return false;
  }
}

module.exports = { warmUp, generateEmailReply, generateSmsReply, interpretCommand, extractEntities, detectTone, generateContent, chat };
