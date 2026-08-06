// subcontractor-form.js — deterministic parser for subcontractor
// application lead-form emails ("New Form Submission (Subcontractor
// Application)"-style: one "LABEL: value" per line). Field extraction uses
// a label/synonym lookup rather than the LLM — same reasoning as
// calendar.js keeping date arithmetic out of the model: this is a
// structured key:value layout, and a synonym-tolerant regex parser is both
// more reliable and far cheaper than a model call, while still absorbing
// minor label-wording differences between form templates/vendors.

import { normalizeTrade } from './trades.js';

const LABEL_ALIASES = {
  INQUIRYTYPE: 'inquiry_type',
  BUSINESSNAME: 'business_name',
  COMPANYNAME: 'business_name',
  COMPANY: 'business_name',
  TRADESPECIALTY: 'trade_raw',
  TRADE: 'trade_raw',
  SPECIALTY: 'trade_raw',
  TYPEOFWORK: 'trade_raw',
  PRINCIPALNAME: 'principal_name',
  CONTACTNAME: 'principal_name',
  OWNERNAME: 'principal_name',
  APPLICANTNAME: 'principal_name',
  SCPHONE: 'phone',
  PHONE: 'phone',
  PHONENUMBER: 'phone',
  SCEMAIL: 'email',
  EMAIL: 'email',
  EMAILADDRESS: 'email',
  HASLICENSE: 'licensed_raw',
  LICENSED: 'licensed_raw',
  LICENSENUMBER: 'license_number',
  LICENSENO: 'license_number',
  LICENSE: 'license_number',
  HASGLINSURANCE: 'gl_insurance_raw',
  GLINSURANCE: 'gl_insurance_raw',
  GENERALLIABILITYINSURANCE: 'gl_insurance_raw',
  HASWCINSURANCE: 'wc_insurance_raw',
  WCINSURANCE: 'wc_insurance_raw',
  WORKERSCOMPINSURANCE: 'wc_insurance_raw',
  WORKERSCOMP: 'wc_insurance_raw',
  HASCREWTOOLS: 'has_tools_raw',
  CREWTOOLS: 'has_tools_raw',
  OWNTOOLS: 'has_tools_raw',
  HASTOOLS: 'has_tools_raw',
  CREWSIZE: 'crew_size_raw',
  TEAMSIZE: 'crew_size_raw',
  WEEKLYCAPACITY: 'weekly_capacity',
  AVAILABILITY: 'weekly_capacity',
  HOURSAVAILABLE: 'weekly_capacity',
  REFERENCES: 'references_raw',
  AGREETERMS: 'agree_terms_raw',
  AGREETOTERMS: 'agree_terms_raw'
};

// Fields that can legitimately span multiple lines (a textarea in the
// original form) — once one of these is the active field, subsequent
// non-labeled lines keep appending to it instead of being dropped.
const MULTILINE_FIELDS = new Set(['references_raw']);

function normalizeLabel(raw) {
  return raw.toUpperCase().replace(/[^A-Z]/g, '');
}

function parseBool(v) {
  if (v == null) return null;
  const t = v.trim().toLowerCase();
  if (!t) return null;
  if (['yes', 'y', 'true', 'on', 'checked', '1'].includes(t)) return true;
  if (['no', 'n', 'false', 'off', 'unchecked', '0'].includes(t)) return false;
  return null;
}

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const PHONE_RE = /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

// A references textarea rarely comes back as clean structured data — split
// on newlines (one reference per line is the common case), then ';' within
// a line, and pull whatever phone/email each chunk happens to contain out
// of it. The leftover text is kept as `name` (it may still include a
// company name too — good enough to read at a glance; `raw` preserves the
// untouched original text so nothing is lost to a bad split).
function parseReferences(raw) {
  if (!raw) return [];
  const lines = raw.split(/\n/).map(l => l.trim()).filter(Boolean);
  const chunks = lines.flatMap(l => l.split(';').map(s => s.trim()).filter(Boolean));
  return chunks.map(chunk => {
    const emailMatch = chunk.match(EMAIL_RE);
    const phoneMatch = chunk.match(PHONE_RE);
    let rest = chunk;
    if (emailMatch) rest = rest.replace(emailMatch[0], '');
    if (phoneMatch) rest = rest.replace(phoneMatch[0], '');
    rest = rest.replace(/[,\-–|]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return {
      raw: chunk,
      name: rest || null,
      phone: phoneMatch ? phoneMatch[0] : null,
      email: emailMatch ? emailMatch[0] : null
    };
  });
}

// Cheap, deterministic check for whether an inbound email is a
// subcontractor application rather than a normal customer message —
// checked before the normal auto-reply/scheduling flow, same tier as
// isGoogleVoiceText/isCalendarResponse in email-provider.js.
function isSubcontractorApplication(email) {
  const subject = email?.subject || '';
  const body = email?.body || '';
  if (/subcontractor\s*application/i.test(subject)) return true;
  if (/new form submission[^\n]{0,60}subcontractor/i.test(body)) return true;
  if (/inquiry\s*type\s*:\s*subcontractor/i.test(body)) return true;
  return false;
}

// Parse a "Field: Value" per-line lead-form body into a flat, normalized
// object — null/false for anything not present rather than guessing.
function parseApplication(body) {
  const fields = {};
  let currentField = null;

  (body || '').split(/\r?\n/).forEach(line => {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 _/#-]{1,40}?)\s*:\s*(.*)$/);
    if (match) {
      const key = LABEL_ALIASES[normalizeLabel(match[1])];
      if (key) {
        fields[key] = (fields[key] ? fields[key] + '\n' : '') + match[2].trim();
        currentField = MULTILINE_FIELDS.has(key) ? key : null;
        return;
      }
      currentField = null;
      return;
    }
    if (currentField && line.trim()) {
      fields[currentField] = (fields[currentField] ? fields[currentField] + '\n' : '') + line.trim();
    }
  });

  const crewSizeMatch = fields.crew_size_raw?.match(/\d+/);

  return {
    inquiry_type: fields.inquiry_type || null,
    business_name: fields.business_name || null,
    trade_raw: fields.trade_raw || null,
    trade: normalizeTrade(fields.trade_raw),
    principal_name: fields.principal_name || null,
    phone: fields.phone || null,
    email: fields.email || null,
    licensed: parseBool(fields.licensed_raw),
    license_number: fields.license_number || null,
    gl_insurance: parseBool(fields.gl_insurance_raw),
    wc_insurance: parseBool(fields.wc_insurance_raw),
    has_tools: parseBool(fields.has_tools_raw),
    crew_size: crewSizeMatch ? parseInt(crewSizeMatch[0], 10) : null,
    weekly_capacity: fields.weekly_capacity || null,
    references: parseReferences(fields.references_raw),
    agree_terms: parseBool(fields.agree_terms_raw)
  };
}

// Full-detail summary for the owner notification email.
function formatApplicationSummary(parsed) {
  const yn = v => (v === true ? 'Yes' : v === false ? 'No' : 'Unknown');
  const lines = [
    `🧰 New subcontractor application: ${parsed.business_name || parsed.principal_name || 'Unnamed'}`,
    `Trade: ${parsed.trade_raw || 'Not specified'}`,
    `Principal: ${parsed.principal_name || 'Unknown'}`,
    `Phone: ${parsed.phone || 'Not given'}`,
    `Email: ${parsed.email || 'Not given'}`,
    `Licensed: ${yn(parsed.licensed)}${parsed.license_number ? ' (#' + parsed.license_number + ')' : ''}`,
    `GL Insurance: ${yn(parsed.gl_insurance)}`,
    `WC Insurance: ${yn(parsed.wc_insurance)}`,
    `Has crew/tools: ${yn(parsed.has_tools)}`,
    `Crew size: ${parsed.crew_size ?? 'Not given'}`,
    `Weekly capacity: ${parsed.weekly_capacity || 'Not given'}`
  ];
  if (parsed.references?.length) {
    lines.push('References:');
    parsed.references.forEach(r => lines.push(`  • ${r.raw}`));
  }
  return lines.join('\n');
}

export { isSubcontractorApplication, parseApplication, parseReferences, formatApplicationSummary };
