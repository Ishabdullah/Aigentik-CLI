// llama.js — Aigentik AI communication layer
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.json' with { type: 'json' };
import log from './logger.js';
import { buildRecruiterSystemPrompt } from './subcontractor-recruiter.js';
import { buildCustomerSystemPrompt } from './customer-module.js';

const LLAMA_URL = `${config.llama.host}/v1/chat/completions`;
const MODEL = config.llama.model;
const MAX_TOKENS = config.llama.max_tokens;
const TEMPERATURE = config.llama.temperature;

// The RESTORICON helmet-icon thumbnail embedded in every AI-sent email
// signature (as a cid inline attachment — see email-provider.js) — this is
// what visually distinguishes the AI's sign-off from the owner's own.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIGNATURE_ICON_PATH = path.join(__dirname, 'assets', 'restoricon-icon-thumb.png');
const SIGNATURE_ICON_CID = 'restoricon-icon';

// Builds the AI's email sign-off in both plain-text and HTML form. Kept
// distinct from the owner's own signature by always identifying as the
// agent (never the owner's personal name) once a business is configured.
function buildEmailSignature(agentName, businessName, ownerName, taglineText) {
  const identity = businessName
    ? `${agentName} | ${businessName}`
    : `${agentName} | Personal Agent of ${ownerName}`;

  const text = `\n\n---\n${identity}` + (taglineText ? `\n${taglineText}` : '');

  const html = '<br><br>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" style="border-top:1px solid #ccc;padding-top:10px;">' +
    '<tr>' +
    `<td style="padding-right:10px;vertical-align:middle;"><img src="cid:${SIGNATURE_ICON_CID}" width="36" height="36" alt="${agentName}" style="display:block;border-radius:50%;"></td>` +
    '<td style="font-family:Arial,sans-serif;font-size:13px;color:#333;vertical-align:middle;">' +
    `<strong>${identity}</strong>` +
    (taglineText ? `<br><span style="color:#666;">${taglineText}</span>` : '') +
    '</td>' +
    '</tr>' +
    '</table>';

  return { text, html };
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Turns the model's plain-text reply into minimal HTML paragraphs so it can
// sit above the signature's HTML table in the same message body.
function textToHtml(text) {
  return text.split(/\n{2,}/)
    .map(para => '<p style="margin:0 0 12px;font-family:Arial,sans-serif;font-size:14px;color:#222;">' +
      escapeHtml(para).replace(/\n/g, '<br>') + '</p>')
    .join('');
}

async function chat(messages, maxTokens = MAX_TOKENS) {
  try {
    const response = await fetch(LLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages,
        max_tokens: maxTokens,
        temperature: TEMPERATURE,
        // Qwen3.5 is a reasoning model: left enabled, it streams its
        // chain-of-thought into `reasoning_content` and leaves `content`
        // empty until it's done thinking, which reads as an empty/failed
        // response to every caller here that only looks at `content`.
        chat_template_kwargs: { enable_thinking: false }
      }),
      signal: AbortSignal.timeout(180000)
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

// Builds the "who this agent works for and what that business does" clause
// shared by every persona-facing prompt, so the model stays in character as
// the business's secretary/assistant instead of a generic personal AI once
// the owner has told it who it works for.
function businessContext(businessName, businessDescription) {
  if (!businessName) return '';
  return ' You work as the secretary and personal assistant for ' + businessName +
    (businessDescription ? ', ' + businessDescription : '') + '.';
}

// Safely extracts a JSON object from model output even with conversational text
function extractJson(raw) {
  if (!raw) return null;
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  return JSON.parse(match[0]);
}

async function generateEmailReply(senderName, senderEmail, subject, body, relationship, contactInstructions, ownerName, agentName, businessName, businessDescription) {
  const agent = agentName || config.aigentik_name || 'Aigentik';
  const owner = ownerName || 'my owner';
  // Once a business is set, the signature identifies the agent as that
  // business's secretary rather than surfacing the owner's personal name to
  // customers — the owner's name stays internal (used only in the system
  // prompt) once there's a business persona to front instead.
  const tagline = businessName
    ? 'For anything urgent, reply back with the word "urgent" and we\'ll get back to you as soon as possible.'
    : 'If you need to reach ' + owner + ' urgently, include "' + owner + '" in your subject line.';
  const signature = buildEmailSignature(agent, businessName, owner, tagline);

  let instructionText = '';
  if (contactInstructions) {
    instructionText = 'IMPORTANT: Special instructions for this contact: ' + contactInstructions;
  }

  const senderDisplay = senderName ? `${senderName} <${senderEmail}>` : (senderEmail || 'unknown');

  const systemMsg = 'You are ' + agent + ', an AI personal assistant managing email on behalf of ' + owner + '.' +
    businessContext(businessName, businessDescription) + ' ' +
    'You are replying to an email sent TO ' + owner + ' from ' + senderDisplay + '. ' +
    'Write a professional, natural email reply as ' + agent + ', ' + owner + '\'s assistant — NEVER claim to be ' + owner + ' or write as if you are them (no "this is ' + owner + '", no signing as ' + owner + '); if you introduce yourself, use your own name, ' + agent + '. ' +
    'Relationship to owner / role: ' + (relationship || 'homeowner/customer') + '. ' +
    'If the sender is a homeowner or customer, be helpful and attentive to their remodeling, renovation, or home service needs. ' +
    'If the sender is a subcontractor or tradesperson, communicate professionally regarding trade work, services, or scheduling while avoiding unauthorized commitments. ' +
    (instructionText ? instructionText + '. ' : '') +
    'Do NOT add a signature — it will be added automatically. ' +
    'Reply with email body text only.';

  const userMsg = 'Reply to this email received by ' + owner + ':\nFrom: ' + senderDisplay + '\nSubject: ' + (subject || '(no subject)') + '\nBody:\n"""\n' + (body || '') + '\n"""';

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ];

  log.info('llama', 'Generating email reply', { from: senderEmail });
  const reply = await chat(messages);
  return {
    text: reply + signature.text,
    html: textToHtml(reply) + signature.html
  };
}

async function generateSmsReply(senderNumber, senderName, message, tone, relationship, contactInstructions, ownerName, agentName, businessName, businessDescription) {
  const agent = agentName || config.aigentik_name || 'Aigentik';
  const owner = ownerName || 'my owner';
  const signature = businessName
    ? '\n\n— ' + agent + ', ' + businessName + '. For anything urgent, reply back with the word "urgent" and we\'ll get back to you ASAP.'
    : '\n\n— ' + agent + ', personal agent of ' + owner + '. If you need to reach ' + owner + ' urgently, reply with "' + owner + '" in your message.';

  let instructionText = '';
  if (contactInstructions) {
    instructionText = 'IMPORTANT: Special instructions for this contact: ' + contactInstructions;
  }

  const senderDisplay = senderName || senderNumber || 'unknown';

  const systemMsg = 'You are ' + agent + ', an AI personal assistant managing communications on behalf of ' + owner + '.' +
    businessContext(businessName, businessDescription) + ' ' +
    'You are replying to a message sent TO ' + owner + ' from ' + senderDisplay + '. ' +
    'Write a natural, helpful reply as ' + agent + ', ' + owner + '\'s assistant — NEVER claim to be ' + owner + ' or write as if you are them (no "this is ' + owner + '", no signing as ' + owner + '); if you introduce yourself, use your own name, ' + agent + '. ' +
    'Match the tone: ' + (tone || 'neutral') + '. ' +
    'Relationship to owner / role: ' + (relationship || 'homeowner/customer') + '. ' +
    'If the sender is a homeowner or customer, be helpful and attentive to their remodeling, renovation, or home service needs. ' +
    'If the sender is a subcontractor or tradesperson, communicate professionally regarding trade work, services, or scheduling while avoiding unauthorized commitments. ' +
    (instructionText ? instructionText + '. ' : '') +
    'Keep it concise — this is a text message. ' +
    'Do NOT add the signature — it will be added automatically. ' +
    'Reply with message text only, nothing else.';

  const userMsg = 'Reply to this text message received by ' + owner + ':\nFrom: ' + senderDisplay + '\nMessage:\n"""\n' + (message || '') + '\n"""';

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ];

  log.info('llama', 'Generating SMS reply', { from: senderNumber, tone });
  const reply = await chat(messages);
  return reply + signature;
}

async function interpretCommand(commandText, context) {
  const actions = 'send_email, send_sms, list_pending, approve_reply, edit_reply, skip_item, spam_item, add_rule, remove_rule, list_rules, list_contacts, find_contact, add_contact, update_contact, delete_contact, set_contact_instructions, never_reply_to, always_reply_to, pause_all, pause_email, pause_sms, resume_all, resume_email, resume_sms, status, generate_content, delete_all_emails, archive_all_emails, spam_all_promotional, clean_inbox, sync_contacts, schedule_appointment, reschedule_appointment, cancel_appointment, list_appointments, set_working_hours, set_appointment_duration, set_business_info, set_owner_name, set_agent_name, list_subcontractors_by_trade, add_subcontractor, list_subcontractor_pipeline, show_subcontractor_profile, qualify_subcontractor, approve_subcontractor, decline_subcontractor, request_subcontractor_docs, list_subcontractor_missing_docs, list_subcontractor_followups, list_customers, show_customer_profile, list_customer_followups, list_hot_leads, update_customer_status, escalate_customer, block_contact, unblock_contact, list_do_not_contact, unknown';
  const schema = '{"action":"string","target":"string|null","content":"string|null","item_id":"number|null","rule_type":"string|null","rule_description":"string|null","contact_field":"string|null","contact_value":"string|null","owner_name":"string|null","agent_name":"string|null","confirm_required":false}';
  const systemMsg = 'You interpret natural language commands for an AI assistant. Return ONLY valid JSON: ' + schema + ' Actions: ' + actions + ' contact_field is one of "name","phone","email","address","relationship","notes" and is used with add_contact/update_contact along with contact_value. For schedule_appointment/reschedule_appointment, target is the contact name and content is the natural-language date/time phrase verbatim (e.g. "next tuesday at 2pm"). For set_working_hours, content is the natural-language hours/days phrase verbatim, whether setting hours (e.g. "9am to 5pm monday through friday") or marking a day off (e.g. "I don\'t work on Sundays", "closed on weekends") — both go to the same action. For set_appointment_duration, rule_type is the relationship/role (e.g. "lawyer") and content is the duration in minutes as a string (e.g. "60"). For set_business_info, target is the business/company name and content is a short description of what the business does, verbatim from what was said (e.g. "a home improvement company specializing in kitchen remodels"); if only a name is given with no description, content is null. owner_name is ONLY set when the message is clearly the assistant\'s owner/operator introducing themselves by their own name during setup (e.g. "my name is Sarah", "this is Ish, I run..."), NEVER for a name mentioned as the target/recipient/subject of an action like sending a message, adding a contact, or booking an appointment — leave owner_name null in every other case, including on set_business_info unless the same message also has the owner introducing themselves. For set_owner_name (used when only the owner\'s own name is given, with no business mentioned), target is the owner\'s name. agent_name is set (on ANY action) whenever the owner tells the assistant what name/persona IT should go by or be called (e.g. "call yourself Nova", "I want you to go by Max", "your name is Jarvis", "you can go by Restoricon") — this is distinct from owner_name, which is the owner\'s OWN name; when the same message sets both, populate both fields on whichever action the rest of the message maps to (or set_agent_name alone if nothing else was said). For a standalone set_agent_name action, target is the name to use. Examples: "text mom I love her"={"action":"send_sms","target":"mom","content":"I love her"} "email boss about the meeting"={"action":"send_email","target":"boss","content":"the meeting"} "find Mike"={"action":"find_contact","target":"Mike"} "delete all emails"={"action":"delete_all_emails"} "pause"={"action":"pause_all"} "save email john@x.com to Mike"={"action":"update_contact","target":"Mike","contact_field":"email","contact_value":"john@x.com"} "change Mike\'s name to Michael"={"action":"update_contact","target":"Mike","contact_field":"name","contact_value":"Michael"} "add contact Sarah phone 5551234567"={"action":"add_contact","target":"Sarah","contact_field":"phone","contact_value":"5551234567"} "delete contact Sarah"={"action":"delete_contact","target":"Sarah"} "book John for next tuesday at 2pm"={"action":"schedule_appointment","target":"John","content":"next tuesday at 2pm"} "move John\'s appointment to friday 3pm"={"action":"reschedule_appointment","target":"John","content":"friday 3pm"} "cancel John\'s appointment"={"action":"cancel_appointment","target":"John"} "what\'s on my calendar this week"={"action":"list_appointments","content":"this week"} "what\'s on my calendar today"={"action":"list_appointments","content":"today"} "what\'s on my calendar for next tuesday"={"action":"list_appointments","content":"next tuesday"} "set working hours 9 to 5 monday through friday"={"action":"set_working_hours","content":"9am to 5pm monday through friday"} "I don\'t work on Sundays"={"action":"set_working_hours","content":"I don\'t work on Sundays"} "lawyers get 60 minute appointments"={"action":"set_appointment_duration","rule_type":"lawyer","content":"60"} "the business name is Acme Restoration and we are a home improvement business who specializes in water damage restoration"={"action":"set_business_info","target":"Acme Restoration","content":"a home improvement business specializing in water damage restoration","owner_name":null} "my name is Sarah, the business is Acme Restoration, a home improvement company specializing in water damage restoration"={"action":"set_business_info","target":"Acme Restoration","content":"a home improvement company specializing in water damage restoration","owner_name":"Sarah"} "our business is called Acme Plumbing"={"action":"set_business_info","target":"Acme Plumbing","content":null,"owner_name":null} "my name is Sarah"={"action":"set_owner_name","target":"Sarah"} "call yourself Nova"={"action":"set_agent_name","target":"Nova"} "I want you to go by Restoricon"={"action":"set_agent_name","target":"Restoricon"} "my name is Sarah, call yourself Nova, the business is Acme Plumbing"={"action":"set_business_info","target":"Acme Plumbing","content":null,"owner_name":"Sarah","agent_name":"Nova"} "add contact Sarah phone 5551234567"={"action":"add_contact","target":"Sarah","contact_field":"phone","contact_value":"5551234567","owner_name":null} For list_subcontractors_by_trade, target is the trade being asked about, verbatim (e.g. "plumbers", "electricians", "painters") — used when the owner asks which subcontractors they have for a given trade. "list my plumbers"={"action":"list_subcontractors_by_trade","target":"plumbers"} "do I have any electricians on file"={"action":"list_subcontractors_by_trade","target":"electricians"} "who are my painters"={"action":"list_subcontractors_by_trade","target":"painters"} For add_subcontractor, target is the subcontractor\'s name or business name, and content is the rest of the message describing them verbatim (trade, phone, license, insurance, crew, capacity — whatever was given). "add subcontractor Bob\'s Plumbing, plumber, phone 5551234567, licensed, has GL and WC insurance, crew of 3"={"action":"add_subcontractor","target":"Bob\'s Plumbing","content":"plumber, phone 5551234567, licensed, has GL and WC insurance, crew of 3"} "mark Mike as a subcontractor, he does electrical work"={"action":"add_subcontractor","target":"Mike","content":"electrical work"} For list_subcontractor_pipeline, used for viewing the subcontractor recruitment pipeline / leads. "subcontractors"={"action":"list_subcontractor_pipeline"} "subcontractor pipeline"={"action":"list_subcontractor_pipeline"} "list subcontractor leads"={"action":"list_subcontractor_pipeline"} For show_subcontractor_profile, target is the subcontractor\'s name, business, or ID. "subcontractor Bob"={"action":"show_subcontractor_profile","target":"Bob"} "subcontractor sub_0001"={"action":"show_subcontractor_profile","target":"sub_0001"} For qualify_subcontractor / approve_subcontractor / decline_subcontractor: "qualify subcontractor Bob"={"action":"qualify_subcontractor","target":"Bob"} "approve subcontractor Bob"={"action":"approve_subcontractor","target":"Bob"} "decline subcontractor Bob"={"action":"decline_subcontractor","target":"Bob"} For request_subcontractor_docs / list_subcontractor_missing_docs: "request docs from Bob"={"action":"request_subcontractor_docs","target":"Bob"} "missing docs Bob"={"action":"list_subcontractor_missing_docs","target":"Bob"} For list_subcontractor_followups: "subcontractor followups"={"action":"list_subcontractor_followups"} "pending subcontractor followups"={"action":"list_subcontractor_followups"} For list_customers / customer_pipeline: "customers"={"action":"list_customers"} "customer pipeline"={"action":"list_customers"} "customer leads"={"action":"list_customers"} For show_customer_profile: "customer John"={"action":"show_customer_profile","target":"John"} "show customer CUST-123"={"action":"show_customer_profile","target":"CUST-123"} For list_customer_followups: "customer followups"={"action":"list_customer_followups"} For list_hot_leads: "hot leads"={"action":"list_hot_leads"} "hot customers"={"action":"list_hot_leads"} For block_contact/unblock_contact, target is a name, email, or phone number to permanently stop/resume contacting — used when the owner wants Aigentik to never message someone again (or reverse that). "block hello@contractorplus.app"={"action":"block_contact","target":"hello@contractorplus.app"} "never contact Sarah again"={"action":"block_contact","target":"Sarah"} "unblock hello@contractorplus.app"={"action":"unblock_contact","target":"hello@contractorplus.app"} "who\'s on the do not contact list"={"action":"list_do_not_contact"} "show blocked contacts"={"action":"list_do_not_contact"}';
  const userMsg = 'Command: "' + commandText + '"\nContext: ' + JSON.stringify(context || {});
  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ];
  log.info('llama', 'Interpreting command', { command: commandText });
  const raw = await chat(messages, 256);
  try {
    const parsed = extractJson(raw);
    if (parsed) return parsed;
    throw new Error('No JSON object found in response');
  } catch (e) {
    log.warn('llama', 'Failed to parse command JSON', { raw, error: e.message });
    return { action: 'unknown', target: null, content: commandText, confirm_required: false };
  }
}

// Classify whether an inbound message implies wanting an appointment (even
// if it never uses a word like "appointment" or "schedule" — a service/
// estimate inquiry is exactly the kind of message that needs to become
// one), and extract the raw natural-language time phrase if any — actual
// date math is done deterministically downstream (chrono-node in index.js),
// since the local model isn't reliable for exact date arithmetic. Called on
// every inbound non-admin message with no keyword pre-filter, since a
// contractor/service inquiry rarely says "appointment" outright.
async function classifySchedulingIntent(text, context) {
  const schema = '{"intent":"request_appointment|reschedule_appointment|cancel_appointment|none","raw_datetime_phrase":"string|null","duration_hint_minutes":"number|null"}';
  const systemMsg = 'You classify whether a message implies wanting to book, move, or cancel an appointment — including indirect requests like asking for a quote, estimate, price, or for someone to come look at or work on something, which all imply request_appointment even without the word "appointment". Return ONLY valid JSON: ' + schema + ' raw_datetime_phrase should be the exact phrase describing when, verbatim from the message (e.g. "next Tuesday at 2pm", "tomorrow afternoon"), or null if no time was mentioned. Examples: "can we set up an appointment for next tuesday at 2pm"={"intent":"request_appointment","raw_datetime_phrase":"next tuesday at 2pm","duration_hint_minutes":null} "can you give me an estimate for painting my house?"={"intent":"request_appointment","raw_datetime_phrase":null,"duration_hint_minutes":null} "how much would it cost to fix my fence, can someone come take a look"={"intent":"request_appointment","raw_datetime_phrase":null,"duration_hint_minutes":null} "I need to cancel my appointment"={"intent":"cancel_appointment","raw_datetime_phrase":null,"duration_hint_minutes":null} "can we move it to friday morning instead"={"intent":"reschedule_appointment","raw_datetime_phrase":"friday morning","duration_hint_minutes":null} "thanks, sounds good"={"intent":"none","raw_datetime_phrase":null,"duration_hint_minutes":null} "what are your business hours"={"intent":"none","raw_datetime_phrase":null,"duration_hint_minutes":null}';
  const userMsg = 'Message: "' + text + '"\nContext: ' + JSON.stringify(context || {});
  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ];
  const raw = await chat(messages, 150);
  try {
    const parsed = extractJson(raw);
    if (parsed) return parsed;
    throw new Error('No JSON object found in response');
  } catch (e) {
    log.warn('llama', 'Failed to parse scheduling intent JSON', { raw, error: e.message });
    return { intent: 'none', raw_datetime_phrase: null, duration_hint_minutes: null };
  }
}

// Extract specific missing contact details (name/email/phone/address) from a
// message — used while gathering info Aigentik doesn't have yet before
// booking an appointment. Only the fields asked for are requested, so the
// model isn't tempted to invent values for ones that weren't mentioned.
// One short, contextual sentence acknowledging what someone actually asked
// for — used to open the intake-form reply so it doesn't read as a canned
// form dropped on top of their message with no reference to what they said.
async function generateAcknowledgment(text, agentName, businessName, businessDescription) {
  const messages = [
    {
      role: 'system',
      content: `You are ${agentName || 'an assistant'}, an AI assistant — not the business owner, never claim or imply you are them. Someone just reached out.${businessContext(businessName, businessDescription)} Write ONE short, warm, professional sentence acknowledging their specific request or situation — reference what they actually said, don't be generic. No greeting, no "this is [name]" self-introduction, no signature, just that one sentence.`
    },
    { role: 'user', content: text }
  ];
  return await chat(messages, 100);
}

// Acknowledgment reply for a subcontractor application — deliberately a
// separate prompt from generateEmailReply rather than reusing it, since a
// subcontractor applying to work FOR the business needs a distinct voice
// (reviewing an application, not answering a customer) and must not
// promise work, a timeline, or a callback the way a customer reply might.
async function generateSubcontractorAck(principalName, applicantBusinessName, trade, agentName, ownerBusinessName, ownerBusinessDescription) {
  const agent = agentName || config.aigentik_name || 'Aigentik';
  const systemMsg = 'You are ' + agent + ', an AI assistant managing subcontractor applications on behalf of' +
    (ownerBusinessName ? ' ' + ownerBusinessName + (ownerBusinessDescription ? ', ' + ownerBusinessDescription : '') : ' the business') + '. ' +
    'Someone just submitted a subcontractor application' + (trade ? ' for ' + trade + ' work' : '') + '. ' +
    'Write a short, professional acknowledgment confirming the application was received and will be reviewed, and that they will be contacted if there is a fit. ' +
    'Do NOT promise work, a timeline, or a callback date. Do NOT add a signature — it will be added automatically. ' +
    'Reply with email body text only.';
  const userMsg = 'Applicant: ' + (principalName || 'Unknown') +
    (applicantBusinessName ? ' (' + applicantBusinessName + ')' : '') +
    (trade ? '\nTrade: ' + trade : '');

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ];

  log.info('llama', 'Generating subcontractor application ack', { principalName, trade });
  return await chat(messages, 200);
}

// Extract subcontractor details from a free-text owner command (e.g. "add
// subcontractor Bob's Plumbing, plumber, phone 5551234567, licensed, has GL
// and WC insurance, crew of 3, available 40 hours a week"). Separate from
// subcontractor-form.js's parseApplication — that one is a deterministic
// parser for the fixed "LABEL: value" lead-form layout; this is genuinely
// freeform natural language the admin typed, so the LLM is the right tool
// here the same way it's used for scheduling-intake free text.
async function extractSubcontractorDetails(text) {
  const schema = '{"business_name":"string|null","trade":"string|null","phone":"string|null","email":"string|null","licensed":"true|false|null","license_number":"string|null","gl_insurance":"true|false|null","wc_insurance":"true|false|null","has_tools":"true|false|null","crew_size":"number|null","weekly_capacity":"string|null"}';
  const systemMsg = `Extract subcontractor details mentioned in this message. Return ONLY valid JSON: ${schema} Use null for anything not mentioned. "trade" is their trade/specialty verbatim (e.g. "plumber", "general remodeling"). "licensed"/"gl_insurance"/"wc_insurance"/"has_tools" are true only if explicitly stated as yes/has/licensed, false only if explicitly stated as no/unlicensed/doesn't have, otherwise null.`;
  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: `Message: "${text}"` }
  ];
  const raw = await chat(messages, 200);
  try {
    const parsed = extractJson(raw);
    if (parsed) return parsed;
    throw new Error('No JSON object found in response');
  } catch (e) {
    log.warn('llama', 'Failed to parse extracted subcontractor details', { raw, error: e.message });
    return { business_name: null, trade: null, phone: null, email: null, licensed: null, license_number: null, gl_insurance: null, wc_insurance: null, has_tools: null, crew_size: null, weekly_capacity: null };
  }
}

async function extractContactDetails(text, fields) {
  const schema = '{' + fields.map(f => `"${f}":"string|null"`).join(',') + '}';
  const systemMsg = `Extract the following contact details if mentioned in this message: ${fields.join(', ')}. Return ONLY valid JSON: ${schema}. Use null for anything not mentioned. "address" means a home/mailing address.`;
  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: `Message: "${text}"` }
  ];
  const raw = await chat(messages, 200);
  try {
    const parsed = extractJson(raw);
    if (parsed) return parsed;
    throw new Error('No JSON object found in response');
  } catch (e) {
    log.warn('llama', 'Failed to parse extracted contact details', { raw, error: e.message });
    return fields.reduce((o, f) => { o[f] = null; return o; }, {});
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

async function generateRecruiterReply({
  channel = 'sms',
  senderPhone,
  senderEmail,
  senderName,
  message,
  subcontractor,
  agentName,
  ownerName,
  businessName,
  businessDescription
}) {
  const agent = agentName || config.aigentik_name || 'Aigentik';
  const owner = ownerName || 'the Restoricon management team';
  const busName = businessName || 'Restoricon, LLC';
  const busDesc = businessDescription || 'Connecticut residential remodeling, restoration, and general contracting';

  const systemMsg = buildRecruiterSystemPrompt(subcontractor, channel, agent, owner);

  const senderDisplay = senderName || senderPhone || senderEmail || 'Candidate';
  const userMsg = `Inbound message from ${senderDisplay}:\n"""\n${message || ''}\n"""`;

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ];

  log.info('llama', 'Generating Restoricon recruiter reply', { channel, from: senderPhone || senderEmail });
  const rawReply = await chat(messages, channel === 'sms' ? 250 : 450);

  if (channel === 'sms') {
    const signature = '\n\n— ' + agent + ', Restoricon Subcontractor Network';
    return rawReply + signature;
  } else {
    const signature = buildEmailSignature(
      agent,
      busName,
      owner,
      'Building our qualified subcontractor network ahead of our planned January 2027 ramp-up.'
    );
    return {
      text: rawReply + signature.text,
      html: textToHtml(rawReply) + signature.html
    };
  }
}

async function extractRecruiterQualification(message, currentData = {}) {
  const schema = '{"company_name":"string|null","legal_name":"string|null","dba":"string|null","contact_name":"string|null","title":"string|null","phone":"string|null","email":"string|null","website":"string|null","primary_trade":"string|null","secondary_trades":"string[]|null","service_area":"string|null","years_in_business":"number|null","crew_size":"number|null","typical_project_size":"string|null","availability":"string|null","availability_2027":"boolean|null","emergency_availability":"boolean|null","has_license":"boolean|null","license_number":"string|null","license_type":"string|null","general_liability":"boolean|null","workers_comp":"boolean|null","willing_to_onboard_msa":"boolean|null","permission_granted":"boolean|null","interested":"boolean|null","objection":"string|null","faq_inquiry":"string|null"}';

  const systemMsg = `You extract subcontractor recruitment and qualification information from conversational messages. Return ONLY valid JSON: ${schema}. Use null for anything not mentioned. Extract factual statements only, do not assume or invent facts.`;
  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: `Message: "${message}"\nCurrent Data: ${JSON.stringify(currentData)}` }
  ];

  try {
    const raw = await chat(messages, 350);
    const parsed = extractJson(raw);
    return parsed || {};
  } catch (err) {
    log.warn('llama', 'Failed to extract recruiter qualification JSON', { error: err.message });
    return {};
  }
}

async function generateCustomerReply({
  channel = 'sms',
  senderPhone,
  senderEmail,
  senderName,
  message,
  customer,
  agentName,
  ownerName,
  businessName,
  businessDescription
}) {
  const agent = agentName || config.aigentik_name || 'Aigentik';
  const owner = ownerName || 'the Restoricon management team';
  const busName = businessName || 'Restoricon, LLC';

  const systemMsg = buildCustomerSystemPrompt({
    customer,
    channel,
    agentName: agent,
    ownerName: owner
  });

  const senderDisplay = senderName || senderPhone || senderEmail || 'Customer';
  const userMsg = `Inbound message from ${senderDisplay}:\n"""\n${message || ''}\n"""`;

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: userMsg }
  ];

  log.info('llama', 'Generating Restoricon customer reply', { channel, from: senderPhone || senderEmail });
  const rawReply = await chat(messages, channel === 'sms' ? 250 : 450);

  if (channel === 'sms') {
    const signature = '\n\n— ' + agent + ', Restoricon';
    return rawReply + signature;
  } else {
    const signature = buildEmailSignature(
      agent,
      busName,
      owner,
      'Residential remodeling, restoration, repair, and general contracting across Connecticut.'
    );
    return {
      text: rawReply + signature.text,
      html: textToHtml(rawReply) + signature.html
    };
  }
}

async function extractCustomerIntake(message, currentData = {}) {
  const schema = '{"customer_name":"string|null","phone":"string|null","email":"string|null","property_address":"string|null","city":"string|null","state":"string|null","zip":"string|null","property_type":"string|null","owner_status":"boolean|null","occupancy_status":"string|null","project_category":"string|null","project_type":"string|null","project_description":"string|null","customer_goal":"string|null","rooms_affected":"string[]|null","approximate_size":"string|null","materials_requested":"string|null","design_needed":"boolean|null","project_urgency":"string|null","desired_start_date":"string|null","desired_completion_date":"string|null","customer_budget":"string|null","insurance_related":"boolean|null","insurance_company":"string|null","claim_number":"string|null","adjuster":"string|null","incident_date":"string|null","is_emergency":"boolean|null","requires_escalation":"boolean|null","escalation_reason":"string|null"}';

  const systemMsg = `You extract customer project intake, qualification, and support details from conversational messages. Return ONLY valid JSON: ${schema}. Use null for anything not mentioned. Extract factual statements only, do not assume or invent facts.`;
  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: `Message: "${message}"\nCurrent Data: ${JSON.stringify(currentData)}` }
  ];

  try {
    const raw = await chat(messages, 400);
    const parsed = extractJson(raw);
    return parsed || {};
  } catch (err) {
    log.warn('llama', 'Failed to extract customer intake JSON', { error: err.message });
    return {};
  }
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

export {
  warmUp,
  generateEmailReply,
  generateSmsReply,
  generateRecruiterReply,
  extractRecruiterQualification,
  generateCustomerReply,
  extractCustomerIntake,
  interpretCommand,
  extractContactDetails,
  extractSubcontractorDetails,
  generateAcknowledgment,
  generateSubcontractorAck,
  detectTone,
  generateContent,
  chat,
  classifySchedulingIntent,
  buildEmailSignature,
  textToHtml,
  SIGNATURE_ICON_PATH,
  SIGNATURE_ICON_CID
};