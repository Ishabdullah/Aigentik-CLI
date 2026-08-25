// tests/subcontractor-recruiter.test.js — Unit tests for the Restoricon Subcontractor
// Recruitment, Qualification, and Pipeline Management Module.

import {
  TRADES,
  TRADE_DISPLAY_NAMES,
  TRADE_SPECIFIC_QUESTIONS,
  normalizeTrade,
  extractAllTrades,
  getTradeDisplayName,
  getTradeSpecificQuestions,
  isRecognizedTrade,
  getAllTradeSlugs
} from '../trades.js';

import {
  QUALIFICATION_STATUSES,
  RECRUITMENT_STEPS,
  RECRUITER_FAQS,
  RECRUITER_OBJECTIONS,
  OPENING_SCRIPT,
  FOLLOW_UP_TEMPLATES,
  getMissingDocuments,
  determineQualificationStatus,
  determineNextRecruitmentStep,
  buildRecruiterSystemPrompt,
  formatSubcontractorSummary,
  formatPipelineReport,
  formatFollowupList
} from '../subcontractor-recruiter.js';

describe('Trades Taxonomy & Helpers', () => {
  it('normalizes common trade names and synonyms', () => {
    expect(normalizeTrade('General Contractor')).toBe('general_remodeling');
    expect(normalizeTrade('residential roofer')).toBe('roofing');
    expect(normalizeTrade('vinyl siding installer')).toBe('siding');
    expect(normalizeTrade('gutter cleaning and seamless gutters')).toBe('gutters');
    expect(normalizeTrade('interior painter')).toBe('painting');
    expect(normalizeTrade('master electrician')).toBe('electrical');
    expect(normalizeTrade('licensed plumber')).toBe('plumbing');
    expect(normalizeTrade('hvac technician')).toBe('hvac');
    expect(normalizeTrade('emergency water damage restoration')).toBe('water_damage_restoration');
    expect(normalizeTrade('mold remediation specialist')).toBe('mold_remediation');
    expect(normalizeTrade('custom trim and finish carpenter')).toBe('finish_carpentry');
  });

  it('extracts all matching trades for multi-trade contractors', () => {
    const extracted = extractAllTrades('We do painting, drywall, and finish carpentry');
    expect(extracted).toContain('painting');
    expect(extracted).toContain('drywall');
    expect(extracted).toContain('finish_carpentry');
  });

  it('returns clean trade display names', () => {
    expect(getTradeDisplayName('roofing')).toBe('Roofing');
    expect(getTradeDisplayName('water_damage_restoration')).toBe('Water Damage Restoration');
    expect(getTradeDisplayName('hvac')).toBe('HVAC / Heating & Cooling');
  });

  it('provides tailored trade-specific qualification questions', () => {
    const roofingQuestions = getTradeSpecificQuestions('roofing');
    expect(roofingQuestions.length).toBeGreaterThan(0);
    expect(roofingQuestions.some(q => q.toLowerCase().includes('shingle') || q.toLowerCase().includes('tear-off'))).toBe(true);

    const electricalQuestions = getTradeSpecificQuestions('electrical');
    expect(electricalQuestions.some(q => q.includes('E-1') || q.includes('license') || q.includes('service'))).toBe(true);

    const waterQuestions = getTradeSpecificQuestions('water_damage_restoration');
    expect(waterQuestions.some(q => q.includes('IICRC') || q.includes('drying') || q.includes('extraction'))).toBe(true);
  });
});

describe('Subcontractor Recruiter Knowledge Base & Guardrails', () => {
  it('includes mandatory 2027 ramp-up positioning in opening script', () => {
    expect(OPENING_SCRIPT).toContain('January 2027 ramp-up');
    expect(OPENING_SCRIPT).toContain('Restoricon');
  });

  it('enforces safety guardrails in recruiter prompt', () => {
    const prompt = buildRecruiterSystemPrompt({
      company_name: 'Apex Builders',
      primary_trade: 'roofing',
      qualification_status: 'NEW_LEAD'
    });

    expect(prompt).toContain('January 2027');
    expect(prompt).toContain('PROHIBITED PHRASES');
    expect(prompt).toContain('NEVER guarantee work');
    expect(prompt).toContain('NEVER approve a contractor independently');
    expect(prompt).toContain('NEVER invent pricing');
  });

  it('provides approved standard answers to common subcontractor questions', () => {
    const workNowFaq = RECRUITER_FAQS.find(f => f.topic === 'work_right_now');
    expect(workNowFaq.answer).toContain('January 2027');

    const guaranteedFaq = RECRUITER_FAQS.find(f => f.topic === 'guaranteed_work');
    expect(guaranteedFaq.answer.toLowerCase()).toContain('does not guarantee');

    const ratesFaq = RECRUITER_FAQS.find(f => f.topic === 'pay_rates');
    expect(ratesFaq.answer).toContain('scope of work');
  });

  it('provides approved objection handling', () => {
    expect(RECRUITER_OBJECTIONS.already_busy).toContain('2027');
    expect(RECRUITER_OBJECTIONS.are_you_contractor).toContain('Restoricon');
    expect(RECRUITER_OBJECTIONS.how_got_number('Google Maps')).toContain('Google Maps');
  });
});

describe('Missing Documents Computation', () => {
  it('calculates all missing docs for a new lead', () => {
    const lead = {
      w9_received: false,
      msa_signed: false,
      coi_received: false,
      workers_comp: null,
      license_required: true,
      license_status: 'LICENSE_PENDING_VERIFICATION',
      references: []
    };

    const missing = getMissingDocuments(lead);
    expect(missing).toContain('W-9 (Taxpayer Identification Form)');
    expect(missing).toContain('Signed Master Subcontractor Agreement (MSA)');
    expect(missing).toContain('Certificate of Insurance (General Liability with Restoricon as Additional Insured)');
    expect(missing).toContain("Workers' Compensation Certificate or Applicable Exemption Verification");
    expect(missing).toContain('State Trade License / HIC Registration Copy or Number');
    expect(missing).toContain('Trade References / Project Portfolio');
  });

  it('returns empty missing list when all documentation is verified', () => {
    const complete = {
      w9_received: true,
      msa_signed: true,
      coi_received: true,
      workers_comp: true,
      license_required: true,
      license_status: 'LICENSE_VERIFIED',
      references: ['Reference 1', 'Reference 2']
    };

    const missing = getMissingDocuments(complete);
    expect(missing).toHaveLength(0);
  });
});

describe('Qualification Status & Progression Logic', () => {
  it('NEVER auto-promotes to APPROVED_ONBOARDING without explicit human owner approval', () => {
    const fullyDocumented = {
      w9_received: true,
      msa_signed: true,
      coi_received: true,
      workers_comp: true,
      license_status: 'LICENSE_VERIFIED',
      qualification_status: QUALIFICATION_STATUSES.DOCUMENTS_UNDER_REVIEW
    };

    const calculated = determineQualificationStatus(fullyDocumented);
    expect(calculated).toBe(QUALIFICATION_STATUSES.DOCUMENTS_UNDER_REVIEW);
    expect(calculated).not.toBe(QUALIFICATION_STATUSES.APPROVED_ONBOARDING);
    expect(calculated).not.toBe(QUALIFICATION_STATUSES.ONBOARDING_COMPLETE);
  });

  it('determines next recruitment steps systematically', () => {
    expect(determineNextRecruitmentStep(null)).toBe(RECRUITMENT_STEPS.OPENING);

    const stepCompany = determineNextRecruitmentStep({
      qualification_data: { permission_granted: true }
    });
    expect(stepCompany).toBe(RECRUITMENT_STEPS.COMPANY_INFO);

    const stepTrade = determineNextRecruitmentStep({
      company_name: 'CT Pro Painting',
      qualification_data: { permission_granted: true }
    });
    expect(stepTrade).toBe(RECRUITMENT_STEPS.TRADE_QUALIFICATION);

    const stepTradeSpecific = determineNextRecruitmentStep({
      company_name: 'CT Pro Painting',
      primary_trade: 'painting',
      qualification_data: { permission_granted: true }
    });
    expect(stepTradeSpecific).toBe(RECRUITMENT_STEPS.TRADE_SPECIFIC);
  });
});

describe('Reporting & Summaries', () => {
  it('formats detailed profile summary', () => {
    const summary = formatSubcontractorSummary({
      subcontractor_id: 'sub_0001',
      company_name: 'Elite Roofing LLC',
      contact_name: 'John Doe',
      primary_trade: 'roofing',
      crew_size: 4,
      years_in_business: 10,
      license_number: 'HIC.0654321',
      qualification_status: QUALIFICATION_STATUSES.QUALIFIED_PENDING_DOCUMENTS
    });

    expect(summary).toContain('sub_0001');
    expect(summary).toContain('Elite Roofing LLC');
    expect(summary).toContain('Roofing');
    expect(summary).toContain('QUALIFIED_PENDING_DOCUMENTS');
  });

  it('formats pipeline report for empty and active states', () => {
    const report = formatPipelineReport();
    expect(typeof report).toBe('string');
    expect(report.length).toBeGreaterThan(0);
  });
});
