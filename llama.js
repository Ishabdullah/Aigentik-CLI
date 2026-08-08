// llama.js — Aigentik AI communication layer
import config from './config.json' with { type: 'json' };
import log from './logger.js';

const LLAMA_URL = `${config.llama.host}/v1/chat/completions`;
const MODEL = config.llama.model;
const MAX_TOKENS = config.llama.max_tokens;
const TEMPERATURE = config.llama.temperature;

async function chat(messages, maxTokens = MAX_TOKENS) {
  try {
    const response = await fetch(LLAMA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: TEMPERATURE }),
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

async function generateEmailReply(senderName, senderEmail, subject, body, relationship, contactInstructions, ownerName, agentName, businessName, businessDescription) {
  const agent = agentName || config.aigentik_name || 'Axon';
  const owner = ownerName || 'my owner';
  // Once a business is set, the signature identifies the agent as that
  // business's secretary rather than surfacing the owner's personal name to
  // customers — the owner's name stays internal (used only in the system
  // prompt) once there's a business persona to front instead.
  const signature = businessName
    ? '\n\n---\n' + agent + ' | ' + businessName + '\nFor anything urgent, please reply directly and we\'ll get back to you as soon as possible.'
    : '\n\n---\n' + agent + ' | Personal Agent of ' + owner + '\nIf you need to reach ' + owner + ' urgently, include "' + owner + '" in your subject line.';

  let instructionText = '';
  if (contactInstructions) {
    instructionText = 'IMPORTANT: Special instructions for this contact: ' + contactInstructions;
  }

  const systemMsg = 'You are ' + agent + ', an AI personal assistant managing email on behalf of ' + owner + '.' +
    businessContext(businessName, businessDescription) + ' ' +
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

async function generateSmsReply(senderNumber, senderName, message, tone, relationship, contactInstructions, ownerName, agentName, businessName, businessDescription) {
  const agent = agentName || config.aigentik_name || 'Axon';
  const owner = ownerName || 'my owner';
  const signature = businessName
    ? '\n\n— ' + agent + ', ' + businessName + '. For anything urgent, just reply and we\'ll get back to you ASAP.'
    : '\n\n— ' + agent + ', personal agent of ' + owner + '. If you need to reach ' + owner + ' urgently, reply with "' + owner + '" in your message.';

  let instructionText = '';
  if (contactInstructions) {
    instructionText = 'IMPORTANT: Special instructions for this contact: ' + contactInstructions;
  }

  const systemMsg = 'You are ' + agent + ', an AI personal assistant managing communications on behalf of ' + owner + '.' +
    businessContext(businessName, businessDescription) + ' ' +
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
  const actions = 'send_email, send_sms, list_pending, approve_reply, edit_reply, skip_item, spam_item, add_rule, remove_rule, list_rules, list_contacts, find_contact, add_contact, update_contact, delete_contact, set_contact_instructions, never_reply_to, always_reply_to, pause_all, pause_email, pause_sms, resume_all, resume_email, resume_sms, status, generate_content, delete_all_emails, archive_all_emails, spam_all_promotional, clean_inbox, sync_contacts, schedule_appointment, reschedule_appointment, cancel_appointment, list_appointments, set_working_hours, set_appointment_duration, set_business_info, set_owner_name, list_subcontractors_by_trade, add_subcontractor, block_contact, unblock_contact, list_do_not_contact, unknown';
  const schema = '{"action":"string","target":"string|null","content":"string|null","item_id":"number|null","rule_type":"string|null","rule_description":"string|null","contact_field":"string|null","contact_value":"string|null","owner_name":"string|null","confirm_required":false}';
  const systemMsg = 'You interpret natural language commands for an AI assistant. Return ONLY valid JSON: ' + schema + ' Actions: ' + actions + ' contact_field is one of "name","phone","email","address","relationship","notes" and is used with add_contact/update_contact along with contact_value. For schedule_appointment/reschedule_appointment, target is the contact name and content is the natural-language date/time phrase verbatim (e.g. "next tuesday at 2pm"). For set_working_hours, content is the natural-language hours/days phrase verbatim, whether setting hours (e.g. "9am to 5pm monday through friday") or marking a day off (e.g. "I don\'t work on Sundays", "closed on weekends") — both go to the same action. For set_appointment_duration, rule_type is the relationship/role (e.g. "lawyer") and content is the duration in minutes as a string (e.g. "60"). For set_business_info, target is the business/company name and content is a short description of what the business does, verbatim from what was said (e.g. "a home improvement company specializing in kitchen remodels"); if only a name is given with no description, content is null. owner_name is ONLY set when the message is clearly the assistant\'s owner/operator introducing themselves by their own name during setup (e.g. "my name is Sarah", "this is Ish, I run..."), NEVER for a name mentioned as the target/recipient/subject of an action like sending a message, adding a contact, or booking an appointment — leave owner_name null in every other case, including on set_business_info unless the same message also has the owner introducing themselves. For set_owner_name (used when only the owner\'s own name is given, with no business mentioned), target is the owner\'s name. Examples: "text mom I love her"={"action":"send_sms","target":"mom","content":"I love her"} "email boss about the meeting"={"action":"send_email","target":"boss","content":"the meeting"} "find Mike"={"action":"find_contact","target":"Mike"} "delete all emails"={"action":"delete_all_emails"} "pause"={"action":"pause_all"} "save email john@x.com to Mike"={"action":"update_contact","target":"Mike","contact_field":"email","contact_value":"john@x.com"} "change Mike\'s name to Michael"={"action":"update_contact","target":"Mike","contact_field":"name","contact_value":"Michael"} "add contact Sarah phone 5551234567"={"action":"add_contact","target":"Sarah","contact_field":"phone","contact_value":"5551234567"} "delete contact Sarah"={"action":"delete_contact","target":"Sarah"} "book John for next tuesday at 2pm"={"action":"schedule_appointment","target":"John","content":"next tuesday at 2pm"} "move John\'s appointment to friday 3pm"={"action":"reschedule_appointment","target":"John","content":"friday 3pm"} "cancel John\'s appointment"={"action":"cancel_appointment","target":"John"} "what\'s on my calendar this week"={"action":"list_appointments","content":"this week"} "what\'s on my calendar today"={"action":"list_appointments","content":"today"} "what\'s on my calendar for next tuesday"={"action":"list_appointments","content":"next tuesday"} "set working hours 9 to 5 monday through friday"={"action":"set_working_hours","content":"9am to 5pm monday through friday"} "I don\'t work on Sundays"={"action":"set_working_hours","content":"I don\'t work on Sundays"} "lawyers get 60 minute appointments"={"action":"set_appointment_duration","rule_type":"lawyer","content":"60"} "the business name is Acme Restoration and we are a home improvement business who specializes in water damage restoration"={"action":"set_business_info","target":"Acme Restoration","content":"a home improvement business specializing in water damage restoration","owner_name":null} "my name is Sarah, the business is Acme Restoration, a home improvement company specializing in water damage restoration"={"action":"set_business_info","target":"Acme Restoration","content":"a home improvement company specializing in water damage restoration","owner_name":"Sarah"} "our business is called Acme Plumbing"={"action":"set_business_info","target":"Acme Plumbing","content":null,"owner_name":null} "my name is Sarah"={"action":"set_owner_name","target":"Sarah"} "add contact Sarah phone 5551234567"={"action":"add_contact","target":"Sarah","contact_field":"phone","contact_value":"5551234567","owner_name":null} For list_subcontractors_by_trade, target is the trade being asked about, verbatim (e.g. "plumbers", "electricians", "painters") — used when the owner asks which subcontractors they have for a given trade. "list my plumbers"={"action":"list_subcontractors_by_trade","target":"plumbers"} "do I have any electricians on file"={"action":"list_subcontractors_by_trade","target":"electricians"} "who are my painters"={"action":"list_subcontractors_by_trade","target":"painters"} For add_subcontractor, target is the subcontractor\'s name or business name, and content is the rest of the message describing them verbatim (trade, phone, license, insurance, crew, capacity — whatever was given). "add subcontractor Bob\'s Plumbing, plumber, phone 5551234567, licensed, has GL and WC insurance, crew of 3"={"action":"add_subcontractor","target":"Bob\'s Plumbing","content":"plumber, phone 5551234567, licensed, has GL and WC insurance, crew of 3"} "mark Mike as a subcontractor, he does electrical work"={"action":"add_subcontractor","target":"Mike","content":"electrical work"} For block_contact/unblock_contact, target is a name, email, or phone number to permanently stop/resume contacting — used when the owner wants Aigentik to never message someone again (or reverse that). "block hello@contractorplus.app"={"action":"block_contact","target":"hello@contractorplus.app"} "never contact Sarah again"={"action":"block_contact","target":"Sarah"} "unblock hello@contractorplus.app"={"action":"unblock_contact","target":"hello@contractorplus.app"} "who\'s on the do not contact list"={"action":"list_do_not_contact"} "show blocked contacts"={"action":"list_do_not_contact"}';
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
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    log.warn('llama', 'Failed to parse scheduling intent JSON', { raw });
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
      content: `You are ${agentName || 'an assistant'}.${businessContext(businessName, businessDescription)} Someone just reached out. Write ONE short, warm, professional sentence acknowledging their specific request or situation — reference what they actually said, don't be generic. No greeting, no signature, just that one sentence.`
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
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    log.warn('llama', 'Failed to parse extracted subcontractor details', { raw });
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
    return JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch (e) {
    log.warn('llama', 'Failed to parse extracted contact details', { raw });
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

export { warmUp, generateEmailReply, generateSmsReply, interpretCommand, extractContactDetails, extractSubcontractorDetails, generateAcknowledgment, generateSubcontractorAck, detectTone, generateContent, chat, classifySchedulingIntent };