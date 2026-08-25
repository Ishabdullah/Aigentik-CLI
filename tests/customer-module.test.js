// tests/customer-module.test.js — Unit tests for Restoricon Customer Intake,
// Sales & Support Module.

import {
  RESTORICON_INFO,
  CUSTOMER_CATEGORIES,
  PROJECT_CATEGORIES,
  PROJECT_SUBTYPES,
  PROPERTY_TYPES,
  LEAD_STATUSES,
  LEAD_SCORES,
  SUPPORT_CATEGORIES,
  INITIAL_GREETING,
  APPROVED_FAQS,
  APPROVED_OBJECTIONS,
  QUALIFICATION_QUESTIONS,
  checkEmergencyKeywords,
  checkEscalationKeywords,
  calculateLeadScore,
  formatHandoffSummary,
  buildCustomerSystemPrompt,
  formatCustomerSummary,
  formatCustomerPipelineReport,
  formatCustomerFollowupList,
  createOrUpdateCustomer,
  getCustomerById,
  findCustomer,
  updateCustomer,
  loadCustomers
} from '../customer-module.js';

describe('Restoricon Customer Module — Positioning & Knowledge Base', () => {
  it('contains approved Restoricon company description and 2027 slow-launch context', () => {
    expect(RESTORICON_INFO.company_name).toBe('Restoricon, LLC');
    expect(RESTORICON_INFO.service_area).toContain('Hartford County');
    expect(RESTORICON_INFO.launch_phase).toContain('January 2027');
    expect(RESTORICON_INFO.core_principle).toContain('understand the customer’s problem');
  });

  it('includes natural initial greeting', () => {
    expect(INITIAL_GREETING).toContain('Thank you for contacting Restoricon');
    expect(INITIAL_GREETING).toContain('What type of work are you looking to have done?');
  });

  it('provides approved FAQ answers for key customer inquiries', () => {
    const serviceArea = APPROVED_FAQS.find(f => f.topic === 'service_area');
    expect(serviceArea.answer).toContain('Connecticut');
    expect(serviceArea.answer).toContain('Hartford County');

    const pricing = APPROVED_FAQS.find(f => f.topic === 'pricing_general');
    expect(pricing.answer.toLowerCase()).toContain('depends on the scope');

    const permits = APPROVED_FAQS.find(f => f.topic === 'permits');
    expect(permits.answer.toLowerCase()).toContain('permit requirements depend on the specific work');

    const whyChoose = APPROVED_FAQS.find(f => f.topic === 'why_choose_restoricon');
    expect(whyChoose.answer).toContain('professional project coordination');
  });

  it('provides approved objection handling', () => {
    expect(APPROVED_OBJECTIONS.multiple_estimates).toContain('completely understandable');
    expect(APPROVED_OBJECTIONS.price_too_high).toContain('review the scope');
    expect(APPROVED_OBJECTIONS.not_ready_yet).toContain('When are you thinking about starting');
  });

  it('contains specialized qualification questions by project category', () => {
    expect(QUALIFICATION_QUESTIONS.remodeling.kitchen.length).toBeGreaterThan(0);
    expect(QUALIFICATION_QUESTIONS.exterior.roofing.length).toBeGreaterThan(0);
    expect(QUALIFICATION_QUESTIONS.restoration.water_damage.length).toBeGreaterThan(0);
    expect(QUALIFICATION_QUESTIONS.restoration.mold_related.length).toBeGreaterThan(0);
  });
});

describe('Emergency & Escalation Keyword Detection', () => {
  it('detects urgent active emergencies', () => {
    expect(checkEmergencyKeywords('Water is gushing from a burst pipe in the basement!')).toBe(true);
    expect(checkEmergencyKeywords('Major flooding in living room')).toBe(true);
    expect(checkEmergencyKeywords('We smell gas and see smoke in the kitchen')).toBe(true);
    expect(checkEmergencyKeywords('Part of the ceiling is collapsing')).toBe(true);
  });

  it('does not false-positive on standard project inquiries', () => {
    expect(checkEmergencyKeywords('I would like an estimate for painting our dining room')).toBe(false);
    expect(checkEmergencyKeywords('Can someone look at replacing our vinyl siding next month?')).toBe(false);
  });

  it('detects escalation triggers (legal, BBB, human request, dispute)', () => {
    expect(checkEscalationKeywords('I want to speak with your lawyer about this lawsuit')).toBe(true);
    expect(checkEscalationKeywords('I am filing a complaint with the BBB and consumer protection')).toBe(true);
    expect(checkEscalationKeywords('Let me talk to a real person / human immediately')).toBe(true);
    expect(checkEscalationKeywords('I want to speak to the owner right now')).toBe(true);
  });

  it('does not trigger escalation for ordinary inquiries', () => {
    expect(checkEscalationKeywords('What is the typical timeframe for a bathroom remodel?')).toBe(false);
  });
});

describe('Lead Scoring Intelligence', () => {
  it('scores highly qualified, local, ready homeowners as HOT', () => {
    const hotLead = {
      customer_name: 'John Smith',
      phone: '860-555-1234',
      email: 'john@example.com',
      city: 'West Hartford',
      state: 'CT',
      owner_status: true,
      project_type: 'kitchen_remodeling',
      project_description: 'Full kitchen remodel with new cabinets and island',
      project_urgency: 'High',
      lead_status: LEAD_STATUSES.APPOINTMENT_REQUESTED
    };

    const score = calculateLeadScore(hotLead);
    expect(score).toBe(LEAD_SCORES.HOT);
  });

  it('scores exploratory inquiries as WARM or COLD', () => {
    const warmLead = {
      customer_name: 'Jane Doe',
      phone: '860-555-5678',
      city: 'Hartford',
      state: 'CT',
      owner_status: true,
      project_type: 'bathroom_remodeling',
      project_urgency: 'Standard'
    };

    const score = calculateLeadScore(warmLead);
    expect(score).toBe(LEAD_SCORES.WARM);

    const coldLead = {
      customer_name: 'Unknown Caller'
    };
    expect(calculateLeadScore(coldLead)).toBe(LEAD_SCORES.COLD);
  });

  it('scores DNC or out-of-service-area as UNQUALIFIED', () => {
    expect(calculateLeadScore({ dnc_status: true })).toBe(LEAD_SCORES.UNQUALIFIED);
    expect(calculateLeadScore({ lead_status: LEAD_STATUSES.OUT_OF_SERVICE_AREA })).toBe(LEAD_SCORES.UNQUALIFIED);
  });
});

describe('Human Handoff & Prompt Generation', () => {
  it('formats comprehensive human handoff summary', () => {
    const customer = {
      customer_name: 'Michael Scott',
      phone: '860-555-0199',
      email: 'mscott@example.com',
      property_address: '1725 Slough Ave',
      city: 'Scranton',
      state: 'CT',
      project_category: 'remodeling',
      project_type: 'office_renovation',
      photos_received: ['photo1.jpg', 'photo2.jpg'],
      appointment_date: '2026-09-01',
      appointment_time: '10:00 AM'
    };

    const handoff = formatHandoffSummary({
      customer,
      issue: 'Customer requested direct quote discount review',
      urgency: 'Medium',
      whatCustomerWants: 'Owner review on project pricing',
      nextAction: 'Call customer to discuss scope options'
    });

    expect(handoff).toContain('RESTORICON HUMAN HANDOFF REQUIRED');
    expect(handoff).toContain('Michael Scott');
    expect(handoff).toContain('1725 Slough Ave');
    expect(handoff).toContain('Customer requested direct quote discount review');
    expect(handoff).toContain('2 photo(s)');
  });

  it('builds customer system prompt enforcing safety guardrails and 2027 context', () => {
    const prompt = buildCustomerSystemPrompt({
      customer: {
        customer_name: 'Sarah Connor',
        project_type: 'basement_finishing',
        lead_status: 'QUALIFIED'
      },
      channel: 'sms'
    });

    expect(prompt).toContain('Restoricon, LLC');
    expect(prompt).toContain('January 2027');
    expect(prompt).toContain('NEVER INVENT PRICING');
    expect(prompt).toContain('NEVER DIAGNOSE REMOTELY');
    expect(prompt).toContain('NEVER GUARANTEE INSURANCE CLAIM APPROVAL');
    expect(prompt).toContain('NEVER DECLARE A STRUCTURE SAFE');
    expect(prompt).toContain('Sarah Connor');
  });
});

describe('CRM State & Reporting Operations', () => {
  it('creates and updates customer CRM records', () => {
    const newCust = createOrUpdateCustomer({
      customer_name: 'Alice Johnson',
      phone: '8602223344',
      email: 'alice@restoricon-test.com',
      property_address: '100 Main St',
      city: 'Hartford',
      state: 'CT',
      project_category: PROJECT_CATEGORIES.REMODELING,
      project_type: PROJECT_SUBTYPES.KITCHEN,
      owner_status: true
    });

    expect(newCust).toBeDefined();
    expect(newCust.customer_id).toBeDefined();
    expect(newCust.customer_name).toBe('Alice Johnson');

    const found = findCustomer('alice@restoricon-test.com');
    expect(found).toBeDefined();
    expect(found.customer_id).toBe(newCust.customer_id);

    const updated = updateCustomer(newCust.customer_id, {
      lead_status: LEAD_STATUSES.APPOINTMENT_SCHEDULED,
      appointment_date: '2026-09-05',
      appointment_time: '2:00 PM'
    });

    expect(updated.lead_status).toBe(LEAD_STATUSES.APPOINTMENT_SCHEDULED);
    expect(updated.appointment_date).toBe('2026-09-05');
  });

  it('formats customer profile summary', () => {
    const customer = {
      customer_id: 'CUST-TEST-1234',
      customer_name: 'Bob Miller',
      phone: '860-555-4321',
      email: 'bob@example.com',
      property_address: '45 Elm Street',
      city: 'Glastonbury',
      state: 'CT',
      lead_score: LEAD_SCORES.HOT,
      lead_status: LEAD_STATUSES.QUALIFIED,
      project_category: 'Remodeling',
      project_type: 'Bathroom',
      project_description: 'Master bathroom walk-in shower and double vanity',
      insurance_related: false
    };

    const summary = formatCustomerSummary(customer);
    expect(summary).toContain('Bob Miller');
    expect(summary).toContain('CUST-TEST-1234');
    expect(summary).toContain('Bathroom');
    expect(summary).toContain('HOT');
  });

  it('formats customer pipeline report and followup list', () => {
    const report = formatCustomerPipelineReport();
    expect(typeof report).toBe('string');
    expect(report.length).toBeGreaterThan(0);

    const followups = formatCustomerFollowupList();
    expect(typeof followups).toBe('string');
    expect(followups.length).toBeGreaterThan(0);
  });
});
