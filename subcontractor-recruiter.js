// subcontractor-recruiter.js — Restoricon Subcontractor Recruitment, Qualification,
// and Pipeline Management Module for Aigentik-CLI.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import log from './logger.js';
import * as contacts from './contacts.js';
import {
  normalizeTrade,
  extractAllTrades,
  getTradeDisplayName,
  getTradeSpecificQuestions,
  isRecognizedTrade
} from './trades.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUBCONTRACTORS_FILE = path.join(__dirname, 'data', 'subcontractors.json');

// Qualification Status Taxonomy
const QUALIFICATION_STATUSES = {
  NEW_LEAD: 'NEW_LEAD',
  CONTACTED: 'CONTACTED',
  CONVERSATION_STARTED: 'CONVERSATION_STARTED',
  INTERESTED: 'INTERESTED',
  QUALIFICATION_IN_PROGRESS: 'QUALIFICATION_IN_PROGRESS',
  QUALIFIED_PENDING_DOCUMENTS: 'QUALIFIED_PENDING_DOCUMENTS',
  DOCUMENTS_REQUESTED: 'DOCUMENTS_REQUESTED',
  DOCUMENTS_PARTIALLY_RECEIVED: 'DOCUMENTS_PARTIALLY_RECEIVED',
  MSA_PENDING: 'MSA_PENDING',
  INSURANCE_PENDING: 'INSURANCE_PENDING',
  LICENSE_PENDING: 'LICENSE_PENDING',
  DOCUMENTS_UNDER_REVIEW: 'DOCUMENTS_UNDER_REVIEW',
  APPROVED_ONBOARDING: 'APPROVED_ONBOARDING',
  ONBOARDING_COMPLETE: 'ONBOARDING_COMPLETE',
  DECLINED: 'DECLINED',
  DO_NOT_CONTACT: 'DO_NOT_CONTACT',
  FOLLOW_UP_REQUESTED: 'FOLLOW_UP_REQUESTED'
};

// Conversational Recruitment Steps
const RECRUITMENT_STEPS = {
  OPENING: 'OPENING',
  COMPANY_INFO: 'COMPANY_INFO',
  TRADE_QUALIFICATION: 'TRADE_QUALIFICATION',
  TRADE_SPECIFIC: 'TRADE_SPECIFIC',
  EXPERIENCE: 'EXPERIENCE',
  SERVICE_AREA: 'SERVICE_AREA',
  AVAILABILITY: 'AVAILABILITY',
  LICENSING: 'LICENSING',
  INSURANCE: 'INSURANCE',
  ONBOARDING_MSA: 'ONBOARDING_MSA',
  DOCUMENTS_REQUEST: 'DOCUMENTS_REQUEST',
  QUALIFIED_REVIEW: 'QUALIFIED_REVIEW'
};

// Approved Restoricon Q&A Knowledge Base
const RECRUITER_FAQS = [
  {
    topic: 'company_identity',
    match: ['what kind of company', 'what is restoricon', 'who is restoricon', 'what do you do', 'tell me about restoricon'],
    answer: "Restoricon is a Connecticut residential remodeling, restoration, repair, and general contracting company."
  },
  {
    topic: 'why_contacting',
    match: ['why are you contacting me', 'why did you text me', 'why are you reaching out', 'what is this about'],
    answer: "We're building our subcontractor network ahead of our planned January 2027 ramp-up and are looking to establish relationships with reliable contractors."
  },
  {
    topic: 'work_right_now',
    match: ['do you have work right now', 'any jobs today', 'do you have work now', 'immediate work', 'ready to start today'],
    answer: "We're currently developing our project pipeline and subcontractor network. We're preparing for increased project activity beginning around January 2027."
  },
  {
    topic: 'work_volume',
    match: ['how much work will i get', 'how many jobs', 'project volume', 'steady work'],
    answer: "Project opportunities will depend on our workload, your trade, location, availability, qualifications, and project requirements. We don't guarantee a specific amount of work."
  },
  {
    topic: 'guaranteed_work',
    match: ['is work guaranteed', 'guarantee work', 'guaranteed jobs'],
    answer: "No. Joining the subcontractor network does not guarantee projects. It gives Restoricon the opportunity to consider you for projects that match your capabilities."
  },
  {
    topic: 'pay_rates',
    match: ['how much do you pay', 'what are your rates', 'payment terms', 'how do you pay', 'pay scale'],
    answer: "Project pricing and compensation are determined based on the specific scope of work and the agreement between Restoricon and the subcontractor."
  },
  {
    topic: 'contract_requirement',
    match: ['do i have to sign a contract', 'need a contract', 'subcontractor agreement', 'msa required'],
    answer: "Restoricon requires qualified subcontractors to complete its onboarding process, which includes the Master Subcontractor Agreement and required business, licensing, and insurance documentation."
  },
  {
    topic: 'insurance_requirement',
    match: ['why do you need my insurance', 'why insurance', 'is insurance required', 'coi needed'],
    answer: "We require appropriate documentation so Restoricon can verify that subcontractors meet the company's project and risk-management requirements."
  },
  {
    topic: 'license_requirement',
    match: ['why do you need my license', 'why license', 'license needed'],
    answer: "Where licensing is required for the work being performed, Restoricon needs to verify the applicable credentials before approving a subcontractor."
  },
  {
    topic: 'exclusivity',
    match: ['exclusive', 'do i have to work exclusively', 'can i work for other people', 'only work for restoricon'],
    answer: "Restoricon does not represent that joining the network requires exclusivity. Any specific contractual requirements would be addressed in the applicable agreement."
  },
  {
    topic: 'choose_jobs',
    match: ['can i choose which jobs', 'can i turn down work', 'do i have to take every job'],
    answer: "Project opportunities are offered based on project requirements, availability, location, qualifications, and other factors. Whether you accept a particular opportunity would depend on the applicable project arrangement."
  },
  {
    topic: 'service_areas',
    match: ['where does restoricon work', 'what towns do you cover', 'service area', 'what areas in ct'],
    answer: "Restoricon is focused on Connecticut residential projects, with an emphasis on Hartford County and surrounding areas."
  },
  {
    topic: 'outside_hartford',
    match: ['outside hartford county', 'fairfield', 'new haven', 'other counties'],
    answer: "Potentially, depending on the project and service area. Restoricon can discuss specific opportunities as they become available."
  },
  {
    topic: 'how_to_apply',
    match: ['how do i apply', 'how do i join', 'sign up', 'how to get started'],
    answer: "I'll collect your basic information and provide the next step in the Restoricon subcontractor onboarding process."
  }
];

// Approved Objection Handlers
const RECRUITER_OBJECTIONS = {
  already_busy: "I understand. We're actually reaching out ahead of time because we're building the network before our 2027 ramp-up. We can keep your information on file and reconnect when your schedule allows.",
  dont_need_work: "No problem. We appreciate your time. If your situation changes in the future, we'd be happy to reconnect.",
  send_email: "Absolutely. What's the best email address? I'll send you the information and follow up with you.",
  how_got_number: (source) => source
    ? `We came across your contact details via ${source} during our local trade research.`
    : "We found your contact information through local Connecticut trade directories and public business listings while researching contractors in your area.",
  are_you_contractor: "I'm contacting you on behalf of Restoricon regarding its subcontractor network. Restoricon's team handles the formal contracting and approval process.",
  who_owns_restoricon: "Restoricon, LLC is a locally managed Connecticut general contracting and restoration firm. I can have someone from Restoricon follow up with you with additional company background."
};

// Opening Script
const OPENING_SCRIPT = "Hi, I'm reaching out on behalf of Restoricon, a Connecticut residential remodeling, restoration, and general contracting company. We're currently building our network of qualified subcontractors ahead of our planned January 2027 ramp-up. We're looking to establish relationships with reliable contractors who may be interested in additional project opportunities as our workload grows. May I ask you a few questions about your company and the work you do?";

// Follow-up Script Templates
const FOLLOW_UP_TEMPLATES = {
  first_followup: (name, agent) => `Hi ${name || 'there'}, this is ${agent || 'Aigentik'} following up regarding Restoricon's subcontractor network. We're continuing to build our contractor network ahead of our January 2027 ramp-up. I wanted to see if you're still interested in learning more.`,
  second_followup: (name, agent) => `Hi ${name || 'there'}, just following up one more time regarding the Restoricon subcontractor opportunity. If you're interested, I can help you with the next step. If now isn't a good time, that's completely fine.`,
  document_request: "To continue the onboarding process, Restoricon will need the applicable business, licensing, insurance, tax, and agreement documentation. I'll provide the appropriate instructions for submitting those documents securely."
};

// Load subcontractors storage
function loadSubcontractors() {
  try {
    if (!fs.existsSync(SUBCONTRACTORS_FILE)) {
      const dataDir = path.dirname(SUBCONTRACTORS_FILE);
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(SUBCONTRACTORS_FILE, JSON.stringify([], null, 2));
      return [];
    }
    const raw = fs.readFileSync(SUBCONTRACTORS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log.error('subcontractor-recruiter', 'Failed to load subcontractors data', { error: err.message });
    return [];
  }
}

// Save subcontractors storage
function saveSubcontractors(data) {
  try {
    const dataDir = path.dirname(SUBCONTRACTORS_FILE);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(SUBCONTRACTORS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    log.error('subcontractor-recruiter', 'Failed to save subcontractors data', { error: err.message });
  }
}

// Generate unique subcontractor ID (sub_0001)
function generateSubcontractorId(existing) {
  const nums = existing
    .map(s => {
      const m = s.subcontractor_id?.match(/sub_(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    })
    .filter(n => !isNaN(n));
  const max = nums.length ? Math.max(...nums) : 0;
  return `sub_${String(max + 1).padStart(4, '0')}`;
}

// Get subcontractor by ID
function getSubcontractorById(subcontractorId) {
  if (!subcontractorId) return null;
  const list = loadSubcontractors();
  return list.find(s => s.subcontractor_id === subcontractorId) || null;
}

// Find subcontractor by phone, email, name, or business name
function findSubcontractor(identifier) {
  if (!identifier) return null;
  const list = loadSubcontractors();
  const q = String(identifier).toLowerCase().trim();
  const cleanDigits = q.replace(/\D/g, '');

  return list.find(s => {
    if (s.subcontractor_id?.toLowerCase() === q) return true;
    if (s.email?.toLowerCase() === q) return true;
    if (s.company_name?.toLowerCase().includes(q)) return true;
    if (s.legal_name?.toLowerCase().includes(q)) return true;
    if (s.dba?.toLowerCase().includes(q)) return true;
    if (s.contact_name?.toLowerCase().includes(q)) return true;
    if (cleanDigits && cleanDigits.length >= 7) {
      const pDigits = (s.phone || '').replace(/\D/g, '');
      if (pDigits.includes(cleanDigits) || cleanDigits.includes(pDigits)) return true;
    }
    return false;
  }) || null;
}

// Create or update a subcontractor record
function createOrUpdateSubcontractorLead(data) {
  const list = loadSubcontractors();
  const existing = data.subcontractor_id
    ? list.find(s => s.subcontractor_id === data.subcontractor_id)
    : (data.phone || data.email || data.contact_name) ? findSubcontractor(data.phone || data.email || data.contact_name) : null;

  const now = new Date().toISOString();

  if (existing) {
    const idx = list.findIndex(s => s.subcontractor_id === existing.subcontractor_id);
    const updated = {
      ...existing,
      ...data,
      subcontractor_id: existing.subcontractor_id,
      last_contact: now,
      qualification_data: { ...(existing.qualification_data || {}), ...(data.qualification_data || {}) }
    };

    // Recalculate status if not explicitly overridden
    if (!data.qualification_status) {
      updated.qualification_status = determineQualificationStatus(updated);
    }

    list[idx] = updated;
    saveSubcontractors(list);
    syncWithContacts(updated);
    log.info('subcontractor-recruiter', `Updated subcontractor: ${updated.company_name || updated.contact_name} (${updated.subcontractor_id})`);
    return updated;
  }

  const newId = generateSubcontractorId(list);
  const record = {
    subcontractor_id: newId,
    contact_id: data.contact_id || null,
    company_name: data.company_name || null,
    legal_name: data.legal_name || data.company_name || null,
    dba: data.dba || null,
    contact_name: data.contact_name || null,
    title: data.title || null,
    phone: data.phone || null,
    email: data.email || null,
    website: data.website || null,
    primary_trade: data.primary_trade ? normalizeTrade(data.primary_trade) || data.primary_trade : null,
    secondary_trades: Array.isArray(data.secondary_trades) ? data.secondary_trades : [],
    service_area: data.service_area || null,
    years_in_business: data.years_in_business != null ? data.years_in_business : null,
    crew_size: data.crew_size != null ? data.crew_size : null,
    residential_experience: data.residential_experience != null ? data.residential_experience : null,
    commercial_experience: data.commercial_experience != null ? data.commercial_experience : null,
    typical_project_size: data.typical_project_size || null,
    availability: data.availability || null,
    emergency_availability: data.emergency_availability != null ? data.emergency_availability : null,

    // Licensing
    license_required: data.license_required != null ? data.license_required : null,
    license_type: data.license_type || null,
    license_number: data.license_number || null,
    license_expiration: data.license_expiration || null,
    license_status: data.license_status || (data.license_number ? 'LICENSE_PENDING_VERIFICATION' : null),

    // Insurance
    general_liability: data.general_liability != null ? data.general_liability : null,
    workers_comp: data.workers_comp != null ? data.workers_comp : null,
    coi_received: data.coi_received != null ? data.coi_received : false,
    coi_expiration: data.coi_expiration || null,
    additional_insured_status: data.additional_insured_status || null,
    insurance_status: data.insurance_status || (data.general_liability === false || data.workers_comp === false ? 'INSURANCE_REVIEW_REQUIRED' : (data.general_liability ? 'INSURANCE_PENDING' : null)),

    // Documents
    w9_received: data.w9_received != null ? data.w9_received : false,
    msa_sent: data.msa_sent != null ? data.msa_sent : false,
    msa_signed: data.msa_signed != null ? data.msa_signed : false,

    // References & Portfolio
    references: Array.isArray(data.references) ? data.references : [],
    portfolio_url: data.portfolio_url || null,

    // Status & Tracking
    qualification_status: data.qualification_status || QUALIFICATION_STATUSES.NEW_LEAD,
    recruitment_step: data.recruitment_step || RECRUITMENT_STEPS.OPENING,
    lead_source: data.lead_source || 'manual',
    last_contact: now,
    next_followup: data.next_followup || null,
    contact_attempts: data.contact_attempts || 1,
    dnc_status: false,
    notes: data.notes || null,
    qualification_data: data.qualification_data || {}
  };

  record.qualification_status = determineQualificationStatus(record);
  list.push(record);
  saveSubcontractors(list);
  syncWithContacts(record);
  log.info('subcontractor-recruiter', `Created new subcontractor lead: ${record.company_name || record.contact_name} (${record.subcontractor_id})`);
  return record;
}

// Update an existing subcontractor by ID
function updateSubcontractor(subcontractorId, updates) {
  if (!subcontractorId) return null;
  const list = loadSubcontractors();
  const idx = list.findIndex(s => s.subcontractor_id === subcontractorId);
  if (idx === -1) return null;

  const current = list[idx];
  const updated = {
    ...current,
    ...updates,
    subcontractor_id: current.subcontractor_id,
    last_contact: new Date().toISOString(),
    qualification_data: { ...(current.qualification_data || {}), ...(updates.qualification_data || {}) }
  };

  if (updates.primary_trade) {
    updated.primary_trade = normalizeTrade(updates.primary_trade) || updates.primary_trade;
  }

  // Ensure strict safety: NEVER set APPROVED_ONBOARDING / ONBOARDING_COMPLETE automatically
  if (!updates.qualification_status) {
    updated.qualification_status = determineQualificationStatus(updated);
  }

  list[idx] = updated;
  saveSubcontractors(list);
  syncWithContacts(updated);
  return updated;
}

// Synchronize subcontractor record with contacts.json
function syncWithContacts(subcontractor) {
  try {
    const contactList = contacts.loadContacts();
    let contact = null;

    if (subcontractor.contact_id) {
      contact = contactList.find(c => c.id === subcontractor.contact_id);
    }
    if (!contact && subcontractor.phone) {
      contact = contacts.findByPhone(subcontractor.phone);
    }
    if (!contact && subcontractor.email) {
      contact = contacts.findByEmail(subcontractor.email);
    }
    if (!contact && subcontractor.contact_name) {
      contact = contacts.findContact(subcontractor.contact_name);
    }

    const updates = {
      type: 'subcontractor',
      business_name: subcontractor.company_name || subcontractor.legal_name,
      trade: subcontractor.primary_trade,
      trade_raw: subcontractor.primary_trade ? getTradeDisplayName(subcontractor.primary_trade) : null,
      licensed: subcontractor.license_status === 'LICENSE_VERIFIED' ? true : (subcontractor.license_required === false ? false : null),
      license_number: subcontractor.license_number,
      gl_insurance: subcontractor.general_liability,
      wc_insurance: subcontractor.workers_comp,
      crew_size: subcontractor.crew_size,
      weekly_capacity: subcontractor.availability,
      references: subcontractor.references || []
    };

    if (contact) {
      contacts.updateContact(contact.id, updates);
      if (!subcontractor.contact_id) {
        subcontractor.contact_id = contact.id;
      }
    } else if (subcontractor.contact_name || subcontractor.phone || subcontractor.email) {
      const created = contacts.createContact({
        name: subcontractor.contact_name,
        phones: subcontractor.phone ? [subcontractor.phone] : [],
        emails: subcontractor.email ? [subcontractor.email] : [],
        relationship: subcontractor.primary_trade ? `subcontractor (${getTradeDisplayName(subcontractor.primary_trade)})` : 'subcontractor',
        type: 'subcontractor',
        notes: `Recruited for Restoricon 2027 network. ID: ${subcontractor.subcontractor_id}`,
        source: subcontractor.lead_source || 'recruitment'
      });
      contacts.updateContact(created.id, updates);
      subcontractor.contact_id = created.id;
    }
  } catch (err) {
    log.error('subcontractor-recruiter', 'Failed to sync with contacts', { error: err.message });
  }
}

// Compute missing onboarding documentation
function getMissingDocuments(subcontractor) {
  if (!subcontractor) return [];
  const missing = [];

  if (!subcontractor.w9_received) {
    missing.push('W-9 (Taxpayer Identification Form)');
  }
  if (!subcontractor.msa_signed) {
    missing.push('Signed Master Subcontractor Agreement (MSA)');
  }
  if (!subcontractor.coi_received) {
    missing.push('Certificate of Insurance (General Liability with Restoricon as Additional Insured)');
  }
  if (subcontractor.workers_comp === null || (!subcontractor.workers_comp && subcontractor.insurance_status === 'INSURANCE_REVIEW_REQUIRED')) {
    missing.push("Workers' Compensation Certificate or Applicable Exemption Verification");
  }
  if (subcontractor.license_required !== false && subcontractor.license_status !== 'LICENSE_VERIFIED' && subcontractor.license_status !== 'LICENSE_NOT_REQUIRED_FOR_REPORTED_SCOPE') {
    missing.push('State Trade License / HIC Registration Copy or Number');
  }
  if ((!subcontractor.references || subcontractor.references.length === 0) && !subcontractor.portfolio_url) {
    missing.push('Trade References / Project Portfolio');
  }

  return missing;
}

// Determine qualification status dynamically based on collected data and review standing
function determineQualificationStatus(subcontractor) {
  // Never automatically promote to APPROVED_ONBOARDING or ONBOARDING_COMPLETE without human owner action
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.APPROVED_ONBOARDING) {
    return QUALIFICATION_STATUSES.APPROVED_ONBOARDING;
  }
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.ONBOARDING_COMPLETE) {
    return QUALIFICATION_STATUSES.ONBOARDING_COMPLETE;
  }
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.DECLINED) {
    return QUALIFICATION_STATUSES.DECLINED;
  }
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.DO_NOT_CONTACT || subcontractor.dnc_status) {
    return QUALIFICATION_STATUSES.DO_NOT_CONTACT;
  }
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.FOLLOW_UP_REQUESTED) {
    return QUALIFICATION_STATUSES.FOLLOW_UP_REQUESTED;
  }

  // Check document review standing
  if (subcontractor.w9_received && subcontractor.msa_signed && subcontractor.coi_received) {
    return QUALIFICATION_STATUSES.DOCUMENTS_UNDER_REVIEW;
  }
  if (subcontractor.msa_sent && !subcontractor.msa_signed) {
    return QUALIFICATION_STATUSES.MSA_PENDING;
  }
  if (subcontractor.w9_received || subcontractor.coi_received || subcontractor.msa_signed) {
    return QUALIFICATION_STATUSES.DOCUMENTS_PARTIALLY_RECEIVED;
  }
  if (subcontractor.qualification_status === QUALIFICATION_STATUSES.DOCUMENTS_REQUESTED) {
    return QUALIFICATION_STATUSES.DOCUMENTS_REQUESTED;
  }

  // Check if basic qualification has been completed
  const hasBasicCompanyInfo = Boolean(subcontractor.company_name || subcontractor.legal_name || subcontractor.contact_name);
  const hasTrade = Boolean(subcontractor.primary_trade);
  const hasServiceArea = Boolean(subcontractor.service_area);
  const hasExperience = Boolean(subcontractor.years_in_business != null || subcontractor.qualification_data?.experience_years);
  const hasAvailability = Boolean(subcontractor.availability || subcontractor.qualification_data?.availability_2027 != null);
  const isInterested = subcontractor.qualification_data?.interested !== false;

  if (!isInterested) {
    return QUALIFICATION_STATUSES.DECLINED;
  }

  if (hasBasicCompanyInfo && hasTrade && hasServiceArea && hasExperience && hasAvailability) {
    return QUALIFICATION_STATUSES.QUALIFIED_PENDING_DOCUMENTS;
  }

  if (hasBasicCompanyInfo || hasTrade || subcontractor.recruitment_step !== RECRUITMENT_STEPS.OPENING) {
    return QUALIFICATION_STATUSES.QUALIFICATION_IN_PROGRESS;
  }

  if (subcontractor.contact_attempts > 0) {
    return QUALIFICATION_STATUSES.CONTACTED;
  }

  return QUALIFICATION_STATUSES.NEW_LEAD;
}

// Determine next logical conversational recruitment step
function determineNextRecruitmentStep(subcontractor) {
  if (!subcontractor) return RECRUITMENT_STEPS.OPENING;
  const q = subcontractor.qualification_data || {};

  if (q.permission_granted === false || q.interested === false) {
    return RECRUITMENT_STEPS.QUALIFIED_REVIEW;
  }
  if (!q.permission_granted && !subcontractor.company_name && !subcontractor.primary_trade) {
    return RECRUITMENT_STEPS.OPENING;
  }
  if (!subcontractor.company_name && !subcontractor.legal_name && !subcontractor.contact_name) {
    return RECRUITMENT_STEPS.COMPANY_INFO;
  }
  if (!subcontractor.primary_trade) {
    return RECRUITMENT_STEPS.TRADE_QUALIFICATION;
  }
  if (!q.trade_specific_answered) {
    return RECRUITMENT_STEPS.TRADE_SPECIFIC;
  }
  if (subcontractor.years_in_business == null && !q.experience_years) {
    return RECRUITMENT_STEPS.EXPERIENCE;
  }
  if (!subcontractor.service_area && !q.service_area_answered) {
    return RECRUITMENT_STEPS.SERVICE_AREA;
  }
  if (!subcontractor.availability && q.availability_2027 == null) {
    return RECRUITMENT_STEPS.AVAILABILITY;
  }
  if (subcontractor.license_status == null && subcontractor.license_required == null && q.license_answered == null) {
    return RECRUITMENT_STEPS.LICENSING;
  }
  if (subcontractor.general_liability == null && q.insurance_answered == null) {
    return RECRUITMENT_STEPS.INSURANCE;
  }
  if (q.willing_to_onboard_msa == null) {
    return RECRUITMENT_STEPS.ONBOARDING_MSA;
  }

  return RECRUITMENT_STEPS.DOCUMENTS_REQUEST;
}

// Build Recruiter System Prompt for LLM with comprehensive Restoricon context and guardrails
function buildRecruiterSystemPrompt(subcontractor, channel = 'sms', agentName = 'Aigentik', ownerName = 'the Restoricon management team') {
  const tradeSlug = subcontractor?.primary_trade ? normalizeTrade(subcontractor.primary_trade) || subcontractor.primary_trade : null;
  const tradeDisplay = tradeSlug ? getTradeDisplayName(tradeSlug) : 'residential construction';
  const tradeQuestions = tradeSlug ? getTradeSpecificQuestions(tradeSlug).slice(0, 2).join(' ') : '';
  const missingDocs = getMissingDocuments(subcontractor);
  const step = determineNextRecruitmentStep(subcontractor);

  return [
    `You are ${agentName}, a professional business-development representative for Restoricon, LLC.`,
    `Restoricon is a Connecticut-based residential remodeling, restoration, repair, and general contracting company.`,
    `We are currently in a slow-launch phase and are building our network of qualified subcontractors, suppliers, and industry partners ahead of our planned January 2027 operational ramp-up.`,
    `Primary Message: Restoricon wants to establish long-term relationships with reliable subcontractors and provide opportunities for additional project work as the company's project pipeline grows.`,
    `\nCRITICAL RESTORICON POSITIONING & LANGUAGE RULES:`,
    `- MANDATORY PHRASING: Always say "We're currently building our subcontractor network ahead of our planned January 2027 ramp-up."`,
    `- PROHIBITED PHRASES (NEVER SAY):`,
    `  * "We have hundreds of jobs waiting."`,
    `  * "We guarantee you'll get work."`,
    `  * "You are approved." (NEVER approve a contractor independently)`,
    `  * "You'll definitely receive projects."`,
    `- NEVER guarantee work, project volume, revenue, or specific income.`,
    `- NEVER invent pricing or pay rates. State that project pricing and compensation are determined based on the specific scope of work and agreement with Restoricon.`,
    `- NEVER give legal or insurance advice. Note license and insurance details for verification by Restoricon.`,
    `- Do NOT promise projects in any specific town. Restoricon is focused on CT residential projects, with emphasis on Hartford County and surrounding areas.`,
    `- Be conversational, courteous, and professional. Do NOT read questions mechanically like a robotic questionnaire.`,
    channel === 'sms' ? `- Keep responses concise for SMS (1 to 3 short sentences plus the question).` : `- Format as a clean, professional email.`,
    `\nCANDIDATE CONTEXT:`,
    `- Candidate / Business: ${subcontractor?.company_name || subcontractor?.contact_name || 'Prospect'}`,
    `- Trade: ${tradeDisplay}`,
    `- Current Step: ${step}`,
    `- Qualification Status: ${subcontractor?.qualification_status || 'NEW_LEAD'}`,
    tradeQuestions ? `- Relevant trade focus questions: ${tradeQuestions}` : '',
    missingDocs.length > 0 ? `- Missing Onboarding Documents: ${missingDocs.join(', ')}` : '',
    `\nCONVERSATIONAL GOAL:`,
    `Acknowledge what the candidate just said naturally, answer any questions using Restoricon facts, handle any objections politely, and guide the candidate through the next qualification step (${step}).`,
    `Do NOT ask every single question at once. Ask at most 1 or 2 natural questions at a time.`
  ].filter(Boolean).join('\n');
}

// Format detailed subcontractor profile summary
function formatSubcontractorSummary(s) {
  if (!s) return 'Subcontractor not found.';
  const trade = s.primary_trade ? getTradeDisplayName(s.primary_trade) : 'Not specified';
  const missing = getMissingDocuments(s);

  return [
    `🛠️ Subcontractor Profile: ${s.company_name || s.contact_name || 'Unnamed'} (${s.subcontractor_id})`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `👤 Contact: ${s.contact_name || 'N/A'}${s.title ? ' (' + s.title + ')' : ''}`,
    `🏢 Legal Name: ${s.legal_name || 'N/A'}${s.dba ? ' | DBA: ' + s.dba : ''}`,
    `📞 Phone: ${s.phone || 'N/A'} | ✉️ Email: ${s.email || 'N/A'}`,
    `🌐 Website: ${s.website || 'N/A'}`,
    `🔨 Primary Trade: ${trade}`,
    s.secondary_trades?.length ? `🪚 Secondary Trades: ${s.secondary_trades.map(t => getTradeDisplayName(t)).join(', ')}` : null,
    `📍 Service Area: ${s.service_area || 'Connecticut (Hartford County & surrounding)'}`,
    `👷 Crew Size: ${s.crew_size != null ? s.crew_size : 'N/A'} | Experience: ${s.years_in_business != null ? s.years_in_business + ' yrs' : 'N/A'}`,
    `🗓️ Availability: ${s.availability || 'Building network for Jan 2027 ramp-up'}`,
    `📄 License: ${s.license_number ? '#' + s.license_number + ' (' + (s.license_status || 'PENDING_VERIFICATION') + ')' : (s.license_required === false ? 'Not required for reported scope' : 'Unverified')}`,
    `🛡️ Insurance: GL: ${s.general_liability ? 'Yes' : (s.general_liability === false ? 'None/Review Required' : 'Pending')} | WC: ${s.workers_comp ? 'Yes' : (s.workers_comp === false ? 'None/Review Required' : 'Pending')} | COI: ${s.coi_received ? 'Received' : 'Pending'}`,
    `📑 Onboarding: MSA: ${s.msa_signed ? 'Signed' : (s.msa_sent ? 'Sent' : 'Pending')} | W-9: ${s.w9_received ? 'Received' : 'Pending'}`,
    `📊 Status: [${s.qualification_status || 'NEW_LEAD'}]`,
    missing.length > 0 ? `⚠️ Missing Docs:\n  - ${missing.join('\n  - ')}` : `✅ All core documents on file.`,
    s.notes ? `📝 Notes: ${s.notes}` : null
  ].filter(Boolean).join('\n');
}

// Format full pipeline report
function formatPipelineReport() {
  const list = loadSubcontractors();
  if (!list.length) return 'No subcontractors currently in the recruitment pipeline.';

  const counts = {};
  for (const status of Object.values(QUALIFICATION_STATUSES)) {
    counts[status] = 0;
  }
  for (const s of list) {
    const st = s.qualification_status || QUALIFICATION_STATUSES.NEW_LEAD;
    counts[st] = (counts[st] || 0) + 1;
  }

  const lines = [
    `📋 Restoricon Subcontractor Pipeline Report`,
    `Total Subcontractors: ${list.length}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `• New Leads: ${counts[QUALIFICATION_STATUSES.NEW_LEAD] || 0}`,
    `• In Qualification: ${(counts[QUALIFICATION_STATUSES.CONTACTED] || 0) + (counts[QUALIFICATION_STATUSES.CONVERSATION_STARTED] || 0) + (counts[QUALIFICATION_STATUSES.INTERESTED] || 0) + (counts[QUALIFICATION_STATUSES.QUALIFICATION_IN_PROGRESS] || 0)}`,
    `• Qualified (Pending Documents): ${counts[QUALIFICATION_STATUSES.QUALIFIED_PENDING_DOCUMENTS] || 0}`,
    `• Documents In Progress: ${(counts[QUALIFICATION_STATUSES.DOCUMENTS_REQUESTED] || 0) + (counts[QUALIFICATION_STATUSES.DOCUMENTS_PARTIALLY_RECEIVED] || 0) + (counts[QUALIFICATION_STATUSES.MSA_PENDING] || 0) + (counts[QUALIFICATION_STATUSES.INSURANCE_PENDING] || 0) + (counts[QUALIFICATION_STATUSES.LICENSE_PENDING] || 0)}`,
    `• Documents Under Review: ${counts[QUALIFICATION_STATUSES.DOCUMENTS_UNDER_REVIEW] || 0}`,
    `• Approved / Onboarded: ${(counts[QUALIFICATION_STATUSES.APPROVED_ONBOARDING] || 0) + (counts[QUALIFICATION_STATUSES.ONBOARDING_COMPLETE] || 0)}`,
    `• Declined / DNC: ${(counts[QUALIFICATION_STATUSES.DECLINED] || 0) + (counts[QUALIFICATION_STATUSES.DO_NOT_CONTACT] || 0)}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`
  ];

  // List recent active prospects
  const active = list.filter(s => s.qualification_status !== QUALIFICATION_STATUSES.DECLINED && s.qualification_status !== QUALIFICATION_STATUSES.DO_NOT_CONTACT).slice(0, 10);
  if (active.length) {
    lines.push('\nRecent Active Candidates:');
    for (const s of active) {
      const trade = s.primary_trade ? getTradeDisplayName(s.primary_trade) : 'Trade TBD';
      lines.push(`• [${s.subcontractor_id}] ${s.company_name || s.contact_name || 'Lead'} — ${trade} [${s.qualification_status}]`);
    }
  }

  return lines.join('\n');
}

// Format follow-up candidates list
function formatFollowupList() {
  const list = loadSubcontractors();
  const followups = list.filter(s =>
    s.qualification_status === QUALIFICATION_STATUSES.FOLLOW_UP_REQUESTED ||
    s.qualification_status === QUALIFICATION_STATUSES.CONTACTED ||
    s.qualification_status === QUALIFICATION_STATUSES.DOCUMENTS_REQUESTED ||
    s.qualification_status === QUALIFICATION_STATUSES.QUALIFIED_PENDING_DOCUMENTS
  );

  if (!followups.length) return 'No pending subcontractor follow-ups.';

  const lines = ['🔔 Subcontractors Pending Follow-up:\n'];
  for (const s of followups) {
    lines.push(`• [${s.subcontractor_id}] ${s.company_name || s.contact_name || s.phone || s.email} — Trade: ${s.primary_trade ? getTradeDisplayName(s.primary_trade) : 'TBD'} (Status: ${s.qualification_status}, Last: ${s.last_contact ? s.last_contact.substring(0, 10) : 'Never'})`);
  }
  return lines.join('\n');
}

export {
  QUALIFICATION_STATUSES,
  RECRUITMENT_STEPS,
  RECRUITER_FAQS,
  RECRUITER_OBJECTIONS,
  OPENING_SCRIPT,
  FOLLOW_UP_TEMPLATES,
  loadSubcontractors,
  saveSubcontractors,
  generateSubcontractorId,
  getSubcontractorById,
  findSubcontractor,
  createOrUpdateSubcontractorLead,
  updateSubcontractor,
  getMissingDocuments,
  determineQualificationStatus,
  determineNextRecruitmentStep,
  buildRecruiterSystemPrompt,
  formatSubcontractorSummary,
  formatPipelineReport,
  formatFollowupList
};
