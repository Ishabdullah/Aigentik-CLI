// role-router.js — Dynamic Identity, Multi-Role & Workflow Routing Architecture
// Implements complete separation of Identity (Person/Organization), Multi-Roles,
// Current Intent, Dynamic Workflow Switching, Ambiguity Clarification, and State Tracking.

import log from './logger.js';
import * as contacts from './contacts.js';
import * as recruiter from './subcontractor-recruiter.js';
import * as customerModule from './customer-module.js';
import * as doNotContact from './do-not-contact.js';
import * as llama from './llama.js';

// ==========================================
// 1. ROLES, WORKFLOWS, INTENTS & TAXONOMY
// ==========================================

export const ROLES = {
  CUSTOMER: 'CUSTOMER',
  SUBCONTRACTOR: 'SUBCONTRACTOR',
  PROPERTY_MANAGER: 'PROPERTY_MANAGER',
  REAL_ESTATE_PROFESSIONAL: 'REAL_ESTATE_PROFESSIONAL',
  SUPPLIER: 'SUPPLIER',
  PARTNER: 'PARTNER',
  EMPLOYEE: 'EMPLOYEE',
  INVESTOR: 'INVESTOR',
  OTHER: 'OTHER'
};

export const WORKFLOWS = {
  CUSTOMER_INTAKE_SALES: 'CUSTOMER_INTAKE_SALES',
  CUSTOMER_SUPPORT: 'CUSTOMER_SUPPORT',
  SUBCONTRACTOR_RECRUITMENT: 'SUBCONTRACTOR_RECRUITMENT',
  SUBCONTRACTOR_ACTIVE: 'SUBCONTRACTOR_ACTIVE',
  GENERAL_INQUIRY: 'GENERAL_INQUIRY',
  AMBIGUOUS_CLARIFICATION: 'AMBIGUOUS_CLARIFICATION',
  DO_NOT_CONTACT: 'DO_NOT_CONTACT'
};

export const INTENTS = {
  // Customer Intents
  CUSTOMER_PROJECT_INQUIRY: 'CUSTOMER_PROJECT_INQUIRY',
  CUSTOMER_ESTIMATE_REQUEST: 'CUSTOMER_ESTIMATE_REQUEST',
  CUSTOMER_EMERGENCY: 'CUSTOMER_EMERGENCY',
  CUSTOMER_JOB_STATUS: 'CUSTOMER_JOB_STATUS',
  CUSTOMER_BILLING_INQUIRY: 'CUSTOMER_BILLING_INQUIRY',

  // Subcontractor Intents
  SUBCONTRACTOR_INQUIRY: 'SUBCONTRACTOR_INQUIRY',
  SUBCONTRACTOR_APPLICATION: 'SUBCONTRACTOR_APPLICATION',
  SUBCONTRACTOR_DOC_SUBMISSION: 'SUBCONTRACTOR_DOC_SUBMISSION',
  SUBCONTRACTOR_CAPACITY_UPDATE: 'SUBCONTRACTOR_CAPACITY_UPDATE',
  SUBCONTRACTOR_GENERAL_PRICING_INQUIRY: 'SUBCONTRACTOR_GENERAL_PRICING_INQUIRY',

  // Dual / Hybrid
  DUAL_INTENT_CUSTOMER_AND_SUB: 'DUAL_INTENT_CUSTOMER_AND_SUB',

  // System & Support
  ROLE_CLARIFICATION: 'ROLE_CLARIFICATION',
  GENERAL_BUSINESS_QUESTION: 'GENERAL_BUSINESS_QUESTION',
  OPTOUT_DNC: 'OPTOUT_DNC',
  UNKNOWN: 'UNKNOWN'
};

// Transition indicator markers
const TOPIC_SHIFT_PATTERNS = [
  /\b(actually|by the way|on another note|i also|can i also|i wanted to ask about)\b/i,
  /\b(i own a (company|business)|i('?m| am) a contractor myself|i do (roofing|plumbing|electrical|painting|construction|drywall|framing) too)\b/i
];

// Subcontractor indicators
const SUBCONTRACTOR_PATTERNS = [
  /\b(hire|hiring|work with|take on|partner with)\s+(subcontractors?|subs|trades|contractors)\b/i,
  /\b(subcontractor|sub-contractor|trade partner|sub work|subcontract work|subcontract for you)\b/i,
  /\b(i('?m| am)\s+a\s+(plumber|electrician|carpenter|painter|roofer|mason|tiler|hvac technician|drywaller|contractor|subcontractor))\b/i,
  /\b(i own|i run|my company)\s+([a-z\s]+)?\s*(roofing|plumbing|electrical|painting|framing|masonry|flooring|drywall|construction|contracting|remodeling)\s*(company|business|llc|inc|services)?\b/i,
  /\b(looking for (sub|contract|subcontract)\s*work)\b/i,
  /\b(become a subcontractor|on your contractor list|bid on your jobs)\b/i,
  /\b(need|looking for)\s+(any\s+)?(electricians?|plumbers?|roofers?|painters?|subs?|subcontractors?|trades?|carpenters?|masons?)\b/i,
  /\b(w9|coi|certificate of insurance|general liability|workers comp|wc insurance|license number)\b/i,
  /\b(send(ing)? (my|our) (rates|pricing sheet|portfolio|references|insurance|license))\b/i
];

// Customer project indicators
const CUSTOMER_PATTERNS = [
  /\b(my house|my home|my kitchen|my bathroom|my basement|my roof|my property|my living room|my ceiling|own bathroom|own house|own home|own kitchen)\b/i,
  /\b(need (an estimate|a quote|a consultation|work done|someone to fix|remodeling|restoration|repair))\b/i,
  /\b(how much (would it cost|does it cost|do you charge for|is the cost to))\s+([a-z\s]+)?(remodel|renovate|fix|roof|paint|replace)\b/i,
  /\b(water damage|leak in|flooding in|mold in|ceiling collapsing|storm damage|fire damage)\b/i,
  /\b(remodel|remodeling|renovation|renovating|finish(ing)? (my|the) basement)\b/i,
  /\b(hire you|hire restoricon) to (remodel|renovate|fix|repair|paint|build|install)\b/i,
  /\b(work on houses in|service area in|residential work)\b/i
];

// Ambiguous crossover patterns
const AMBIGUOUS_PATTERNS = [
  /^i (do|am doing|work in)\s+([a-z\s]+)\s+and\s+(need|wanted|want)\s+(some|more)?\s*(info|information)\.?$/i,
  /^do you guys (do|offer|handle)\s+([a-z\s]+)\??$/i,
  /^what kind of (work|projects|services) do you (do|take on)\??$/i,
  /^are you working on (any projects|anything) in\s+([a-z\s]+)\??$/i,
  /^i do ([a-z\s]+) and wanted to know if you have any work\.?$/i,
  /^i('?m| am) a contractor too\.?$/i
];

// ==========================================
// 2. IDENTITY & PERSON RESOLUTION
// ==========================================

export function resolvePersonAndRoles({
  phone,
  email,
  name
}) {
  // Look up contact in memory
  const contact = contacts.findContact(phone) ||
                  (email ? contacts.findContact(email) : null) ||
                  (name ? contacts.findContact(name) : null);

  // Look up CRM entities
  const subRecord = recruiter.findSubcontractor(phone) ||
                    (email ? recruiter.findSubcontractor(email) : null) ||
                    (contact?.id ? recruiter.findSubcontractor(contact.id) : null);

  const custRecord = customerModule.findCustomer(phone) ||
                     (email ? customerModule.findCustomer(email) : null) ||
                     (contact?.id ? customerModule.findCustomer(contact.id) : null);

  // Build non-destructive roles list
  const rolesSet = new Set();
  if (contact?.roles && Array.isArray(contact.roles)) {
    contact.roles.forEach(r => rolesSet.add(r));
  }
  if (contact?.type === 'subcontractor' || subRecord) {
    rolesSet.add(ROLES.SUBCONTRACTOR);
  }
  if (contact?.type === 'customer' || custRecord) {
    rolesSet.add(ROLES.CUSTOMER);
  }
  if (contact?.type === 'business') {
    rolesSet.add(ROLES.PARTNER);
  }

  // Default exploratory role if unknown
  if (rolesSet.size === 0) {
    rolesSet.add(ROLES.CUSTOMER);
  }

  const roles = Array.from(rolesSet);

  return {
    person_id: contact?.id || custRecord?.customer_id || subRecord?.subcontractor_id || generatePersonId(),
    name: name || contact?.name || custRecord?.customer_name || subRecord?.contact_name || null,
    phone: phone || contact?.phones?.[0] || custRecord?.phone || subRecord?.phone || null,
    email: email || contact?.emails?.[0] || custRecord?.email || subRecord?.email || null,
    organization: {
      organization_id: subRecord?.company_name ? `org_${subRecord.company_name.toLowerCase().replace(/[^a-z0-9]/g, '_')}` : null,
      company_name: subRecord?.company_name || contact?.business_name || null,
      trade: subRecord?.primary_trade || contact?.trade || null
    },
    roles,
    active_roles: roles,
    active_role: contact?.active_role || (roles.includes(ROLES.SUBCONTRACTOR) && !roles.includes(ROLES.CUSTOMER) ? ROLES.SUBCONTRACTOR : ROLES.CUSTOMER),
    existing_contact: contact,
    subcontractor_record: subRecord,
    customer_record: custRecord
  };
}

function generatePersonId() {
  return `person_${Date.now().toString(36)}_${Math.floor(Math.random() * 1000)}`;
}

// ==========================================
// 3. DYNAMIC ROLE & INTENT CLASSIFICATION
// ==========================================

export async function detectRoleAndIntent({
  message,
  person,
  channel = 'sms'
}) {
  const text = (message || '').trim();
  const lower = text.toLowerCase();

  // 1. Check Opt-out / DNC
  if (doNotContact.detectOptOutRequest(text)) {
    logTransition('OPTOUT_DETECTED', person, { intent: INTENTS.OPTOUT_DNC, workflow: WORKFLOWS.DO_NOT_CONTACT });
    return {
      known_roles: person.roles,
      detected_role: person.active_role || ROLES.OTHER,
      role_change_detected: false,
      role_change_confidence: 1.0,
      current_intent: INTENTS.OPTOUT_DNC,
      workflow: WORKFLOWS.DO_NOT_CONTACT,
      needs_clarification: false,
      clarification_question: null,
      dual_role_candidate: null
    };
  }

  // 2. Emergency Detection
  if (customerModule.checkEmergencyKeywords(text)) {
    const isNewRole = !person.roles.includes(ROLES.CUSTOMER);
    logTransition('EMERGENCY_ROLE_OVERRIDE', person, { intent: INTENTS.CUSTOMER_EMERGENCY, workflow: WORKFLOWS.CUSTOMER_INTAKE_SALES });
    return {
      known_roles: person.roles,
      detected_role: ROLES.CUSTOMER,
      role_change_detected: isNewRole || person.active_role !== ROLES.CUSTOMER,
      role_change_confidence: 0.99,
      current_intent: INTENTS.CUSTOMER_EMERGENCY,
      workflow: WORKFLOWS.CUSTOMER_INTAKE_SALES,
      needs_clarification: false,
      clarification_question: null,
      dual_role_candidate: isNewRole ? ROLES.CUSTOMER : null
    };
  }

  // 3. Dual Intent Check (Customer project AND Subcontractor inquiry in one message)
  const mentionsKitchenOrRemodel = /remodel|renovat|bathroom|kitchen|basement|roof estimate|own property/i.test(text);
  const mentionsSubOrCompany = /subcontract for you|become a subcontractor|my company can subcontract|partner as a sub/i.test(text);

  if (mentionsKitchenOrRemodel && mentionsSubOrCompany) {
    logTransition('DUAL_ROLE_DETECTED', person, { intent: INTENTS.DUAL_INTENT_CUSTOMER_AND_SUB, workflow: WORKFLOWS.CUSTOMER_INTAKE_SALES });
    return {
      known_roles: person.roles,
      detected_role: ROLES.CUSTOMER,
      role_change_detected: true,
      role_change_confidence: 0.95,
      current_intent: INTENTS.DUAL_INTENT_CUSTOMER_AND_SUB,
      workflow: WORKFLOWS.CUSTOMER_INTAKE_SALES,
      needs_clarification: false,
      clarification_question: null,
      dual_role_candidate: ROLES.SUBCONTRACTOR,
      dual_intents: [INTENTS.CUSTOMER_PROJECT_INQUIRY, INTENTS.SUBCONTRACTOR_INQUIRY]
    };
  }

  // 4. Ambiguity Check (Deterministic)
  const isAmbiguousQuery = AMBIGUOUS_PATTERNS.some(p => p.test(text));
  if (isAmbiguousQuery) {
    const isSubcontractor = person.roles.includes(ROLES.SUBCONTRACTOR);
    const clarification = "Absolutely. Just to make sure I point you in the right direction, are you looking to have work done on your property, or are you a trade contractor interested in working with Restoricon?";

    logTransition('AMBIGUITY_DETECTED', person, { trigger: text, clarification });

    return {
      known_roles: person.roles,
      detected_role: null,
      role_change_detected: false,
      confidence: 0.5,
      current_intent: INTENTS.ROLE_CLARIFICATION,
      workflow: WORKFLOWS.AMBIGUOUS_CLARIFICATION,
      needs_clarification: true,
      clarification_question: clarification,
      dual_role_candidate: isSubcontractor ? ROLES.CUSTOMER : ROLES.SUBCONTRACTOR
    };
  }

  // 5. Topic Shift & Intent Matching
  const matchesSub = SUBCONTRACTOR_PATTERNS.some(p => p.test(text));
  const matchesCust = CUSTOMER_PATTERNS.some(p => p.test(text));

  // Subcontractor inquiry from existing customer
  if (matchesSub && !matchesCust) {
    // If asking "Do you need any electricians?" or "Do you guys hire subcontractors?"
    const isQuestionAboutHiring = /\b(do you (need|hire|take on)|are you (looking for|hiring))\b/i.test(text);
    const isExplicitApplication = /\b(i own|i am|i'd like to (become|work|bid)|my company)\b/i.test(text);

    const isNewRole = !person.roles.includes(ROLES.SUBCONTRACTOR);

    logTransition(isNewRole ? 'ROLE_ADDED' : 'ROLE_CHANGED', person, {
      fromRole: person.active_role,
      toRole: ROLES.SUBCONTRACTOR,
      intent: INTENTS.SUBCONTRACTOR_INQUIRY
    });

    return {
      known_roles: person.roles,
      detected_role: ROLES.SUBCONTRACTOR,
      role_change_detected: isNewRole || person.active_role !== ROLES.SUBCONTRACTOR,
      role_change_confidence: isExplicitApplication ? 0.96 : 0.88,
      current_intent: isExplicitApplication ? INTENTS.SUBCONTRACTOR_APPLICATION : INTENTS.SUBCONTRACTOR_INQUIRY,
      workflow: WORKFLOWS.SUBCONTRACTOR_RECRUITMENT,
      needs_clarification: false,
      clarification_question: null,
      dual_role_candidate: isNewRole ? ROLES.SUBCONTRACTOR : null
    };
  }

  // Customer project from existing subcontractor
  if (matchesCust && !matchesSub) {
    const isNewRole = !person.roles.includes(ROLES.CUSTOMER);

    logTransition(isNewRole ? 'ROLE_ADDED' : 'ROLE_CHANGED', person, {
      fromRole: person.active_role,
      toRole: ROLES.CUSTOMER,
      intent: INTENTS.CUSTOMER_PROJECT_INQUIRY
    });

    return {
      known_roles: person.roles,
      detected_role: ROLES.CUSTOMER,
      role_change_detected: isNewRole || person.active_role !== ROLES.CUSTOMER,
      role_change_confidence: 0.95,
      current_intent: INTENTS.CUSTOMER_PROJECT_INQUIRY,
      workflow: WORKFLOWS.CUSTOMER_INTAKE_SALES,
      needs_clarification: false,
      clarification_question: null,
      dual_role_candidate: isNewRole ? ROLES.CUSTOMER : null
    };
  }

  // Subcontractor asking general pricing / charge question
  if (person.roles.includes(ROLES.SUBCONTRACTOR) && !person.roles.includes(ROLES.CUSTOMER)) {
    if (/how much do you charge homeowners/i.test(text)) {
      return {
        known_roles: person.roles,
        detected_role: ROLES.SUBCONTRACTOR,
        role_change_detected: false,
        role_change_confidence: 0.9,
        current_intent: INTENTS.SUBCONTRACTOR_GENERAL_PRICING_INQUIRY,
        workflow: WORKFLOWS.SUBCONTRACTOR_RECRUITMENT,
        needs_clarification: false,
        clarification_question: null,
        dual_role_candidate: null
      };
    }
  }

  // 6. LLM Semantic Classification for Nuanced Phrasing
  return await classifyWithLLM(text, person);
}

// --- LLM Intent Classifier ---

async function classifyWithLLM(message, person) {
  const schema = '{"detected_role":"CUSTOMER|SUBCONTRACTOR|PROPERTY_MANAGER|OTHER","current_intent":"string","workflow":"CUSTOMER_INTAKE_SALES|CUSTOMER_SUPPORT|SUBCONTRACTOR_RECRUITMENT|SUBCONTRACTOR_ACTIVE|GENERAL_INQUIRY|AMBIGUOUS_CLARIFICATION","confidence":0.95,"needs_clarification":false,"clarification_question":"string|null","new_role_detected":"CUSTOMER|SUBCONTRACTOR|null"}';

  const systemMsg = `You are the intent and dynamic role classifier for Restoricon, LLC (a CT remodeling & restoration contractor).
Determine the contact's role and workflow for this message.

Context:
- Known Roles: ${JSON.stringify(person.roles || [])}
- Active Role: "${person.active_role || 'CUSTOMER'}"
- Trade: "${person.organization?.trade || 'None'}"

Rules:
1. A PERSON is not a static role. A customer asking to do sub work switches to SUBCONTRACTOR. A sub asking for work on their home switches to CUSTOMER.
2. If ambiguous, set needs_clarification=true and provide a polite clarification question asking if this is for their own property or trade subcontracting.
3. Return JSON only: ${schema}`;

  const messages = [
    { role: 'system', content: systemMsg },
    { role: 'user', content: `Message: "${message}"` }
  ];

  try {
    const raw = await llama.chat(messages, 250);
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    const detectedRole = parsed.detected_role || (person.roles.includes(ROLES.SUBCONTRACTOR) ? ROLES.SUBCONTRACTOR : ROLES.CUSTOMER);
    const workflow = parsed.needs_clarification ? WORKFLOWS.AMBIGUOUS_CLARIFICATION : (parsed.workflow || WORKFLOWS.CUSTOMER_INTAKE_SALES);

    return {
      known_roles: person.roles,
      detected_role: parsed.needs_clarification ? null : detectedRole,
      role_change_detected: detectedRole !== person.active_role,
      role_change_confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.85,
      current_intent: parsed.current_intent || INTENTS.GENERAL_BUSINESS_QUESTION,
      workflow,
      needs_clarification: Boolean(parsed.needs_clarification),
      clarification_question: parsed.clarification_question || null,
      dual_role_candidate: parsed.new_role_detected && !person.roles.includes(parsed.new_role_detected) ? parsed.new_role_detected : null
    };
  } catch (err) {
    log.warn('role-router', 'LLM classification fallback', { error: err.message });
    return {
      known_roles: person.roles,
      detected_role: person.active_role || ROLES.CUSTOMER,
      role_change_detected: false,
      role_change_confidence: 0.6,
      current_intent: INTENTS.GENERAL_BUSINESS_QUESTION,
      workflow: person.active_role === ROLES.SUBCONTRACTOR ? WORKFLOWS.SUBCONTRACTOR_RECRUITMENT : WORKFLOWS.CUSTOMER_INTAKE_SALES,
      needs_clarification: false,
      clarification_question: null,
      dual_role_candidate: null
    };
  }
}

// ==========================================
// 4. RETRIEVAL & KNOWLEDGE DOMAIN METADATA
// ==========================================

export function buildRetrievalMetadata({
  classification,
  person,
  trade = null
}) {
  const isSub = classification.detected_role === ROLES.SUBCONTRACTOR ||
                classification.workflow === WORKFLOWS.SUBCONTRACTOR_RECRUITMENT;

  return {
    domain: isSub ? 'subcontractor' : 'customer',
    trade: trade || person.organization?.trade || null,
    intent: classification.current_intent || 'inquiry',
    workflow: classification.workflow || (isSub ? 'subcontractor_recruitment' : 'customer_intake'),
    tags: isSub ? ['RECRUITMENT', 'ONBOARDING', 'MSA', 'INSURANCE', 'LICENSING'] : ['CUSTOMER', 'ESTIMATE', 'REMODELING', 'RESTORATION']
  };
}

// ==========================================
// 5. STATE UPDATE & MULTI-ROLE PERSISTENCE
// ==========================================

export function updatePersonRolesAndState({
  person,
  classification,
  contactId
}) {
  const existingRoles = new Set(person.roles || []);

  // Add new detected role without overwriting existing
  if (classification.detected_role && classification.detected_role !== ROLES.OTHER) {
    existingRoles.add(classification.detected_role);
  }
  if (classification.dual_role_candidate) {
    existingRoles.add(classification.dual_role_candidate);
  }

  const updatedRoles = Array.from(existingRoles);
  const activeRole = classification.detected_role || person.active_role;

  // Persist to contacts.json. `roles`/`active_role` are the source of truth
  // for role membership — `type` is left untouched here, since things like
  // findSubcontractorsByTrade filter on `type === 'subcontractor'` and a
  // customer-role addition must not make a subcontractor invisible to that.
  if (contactId || person.existing_contact?.id) {
    const id = contactId || person.existing_contact.id;
    contacts.updateContact(id, {
      roles: updatedRoles,
      active_role: activeRole
    });
  }

  logTransition('STATE_UPDATED', person, {
    roles: updatedRoles,
    active_role: activeRole,
    workflow: classification.workflow
  });

  return {
    ...person,
    roles: updatedRoles,
    active_roles: updatedRoles,
    active_role: activeRole
  };
}

// ==========================================
// 6. STRUCTURED LOGGING
// ==========================================

function logTransition(event, person, details = {}) {
  const payload = {
    event,
    person_id: person?.person_id || 'unknown',
    name: person?.name || 'unknown',
    timestamp: new Date().toISOString(),
    ...details
  };
  log.info('role-router', `[${event}] ${person?.name || person?.phone || 'Contact'}: ${JSON.stringify(details)}`, payload);
}
