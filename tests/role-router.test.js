// tests/role-router.test.js — Complete Test Suite for Aigentik Dynamic Role & Identity Routing Engine

import {
  ROLES,
  WORKFLOWS,
  INTENTS,
  resolvePersonAndRoles,
  detectRoleAndIntent,
  updatePersonRolesAndState,
  buildRetrievalMetadata
} from '../role-router.js';

describe('Aigentik Dynamic Role & Identity Routing Engine', () => {

  describe('Section 1 & 2: Identity Resolution & Concept Separation', () => {
    // Admin senders never reach role-router: index.js intercepts a Google
    // Voice text from admin_number or an email from admin_email and routes
    // it to owner-command.js before this module runs, so there is no
    // admin-detection path here to test.
    it('resolves new contacts with clean Person and Organization structures', () => {
      const person = resolvePersonAndRoles({
        phone: '860-555-1234',
        name: 'Jane Smith'
      });

      expect(person.name).toBe('Jane Smith');
      expect(person.roles).toContain(ROLES.CUSTOMER);
      expect(person.active_role).toBe(ROLES.CUSTOMER);
    });
  });

  describe('Section 18: Mandatory Test Cases (1 to 10)', () => {

    it('TEST 1: New person: "I need a bathroom remodel." -> CUSTOMER', async () => {
      const person = resolvePersonAndRoles({ phone: '860-555-0001' });

      const result = await detectRoleAndIntent({
        message: 'I need a bathroom remodel.',
        person
      });

      expect(result.detected_role).toBe(ROLES.CUSTOMER);
      expect(result.workflow).toBe(WORKFLOWS.CUSTOMER_INTAKE_SALES);
      expect(result.current_intent).toBe(INTENTS.CUSTOMER_PROJECT_INQUIRY);
    });

    it('TEST 2: New person: "I own a plumbing company and want to work with Restoricon." -> SUBCONTRACTOR', async () => {
      const person = resolvePersonAndRoles({ phone: '860-555-0002' });

      const result = await detectRoleAndIntent({
        message: 'I own a plumbing company and want to work with Restoricon.',
        person
      });

      expect(result.detected_role).toBe(ROLES.SUBCONTRACTOR);
      expect(result.workflow).toBe(WORKFLOWS.SUBCONTRACTOR_RECRUITMENT);
      expect([INTENTS.SUBCONTRACTOR_INQUIRY, INTENTS.SUBCONTRACTOR_APPLICATION]).toContain(result.current_intent);
    });

    it('TEST 3: Existing CUSTOMER: "Do you need any electricians?" -> SUBCONTRACTOR inquiry / candidate', async () => {
      const person = {
        person_id: 'p_cust_3',
        name: 'Mark',
        roles: [ROLES.CUSTOMER],
        active_role: ROLES.CUSTOMER
      };

      const result = await detectRoleAndIntent({
        message: 'Do you need any electricians?',
        person
      });

      expect(result.detected_role).toBe(ROLES.SUBCONTRACTOR);
      expect(result.workflow).toBe(WORKFLOWS.SUBCONTRACTOR_RECRUITMENT);
      expect(result.dual_role_candidate).toBe(ROLES.SUBCONTRACTOR);
      expect(result.role_change_detected).toBe(true);
    });

    it('TEST 4: Existing CUSTOMER: "I actually own a roofing company and would like to become a subcontractor." -> roles = [CUSTOMER, SUBCONTRACTOR], active_role = SUBCONTRACTOR', async () => {
      const person = {
        person_id: 'p_cust_4',
        name: 'Sarah',
        roles: [ROLES.CUSTOMER],
        active_role: ROLES.CUSTOMER
      };

      const result = await detectRoleAndIntent({
        message: 'I actually own a roofing company and would like to become a subcontractor.',
        person
      });

      expect(result.detected_role).toBe(ROLES.SUBCONTRACTOR);
      expect(result.workflow).toBe(WORKFLOWS.SUBCONTRACTOR_RECRUITMENT);
      expect(result.dual_role_candidate).toBe(ROLES.SUBCONTRACTOR);

      const updated = updatePersonRolesAndState({ person, classification: result });
      expect(updated.roles).toEqual([ROLES.CUSTOMER, ROLES.SUBCONTRACTOR]);
      expect(updated.active_role).toBe(ROLES.SUBCONTRACTOR);
    });

    it('TEST 5: Existing SUBCONTRACTOR: "I want to remodel my kitchen." -> roles = [SUBCONTRACTOR, CUSTOMER], active_role = CUSTOMER', async () => {
      const person = {
        person_id: 'p_sub_5',
        name: 'Dave Electrician',
        roles: [ROLES.SUBCONTRACTOR],
        active_role: ROLES.SUBCONTRACTOR,
        organization: { company_name: 'Dave Electric LLC', trade: 'electrical' }
      };

      const result = await detectRoleAndIntent({
        message: 'I want to remodel my kitchen.',
        person
      });

      expect(result.detected_role).toBe(ROLES.CUSTOMER);
      expect(result.workflow).toBe(WORKFLOWS.CUSTOMER_INTAKE_SALES);
      expect(result.dual_role_candidate).toBe(ROLES.CUSTOMER);

      const updated = updatePersonRolesAndState({ person, classification: result });
      expect(updated.roles).toEqual([ROLES.SUBCONTRACTOR, ROLES.CUSTOMER]);
      expect(updated.active_role).toBe(ROLES.CUSTOMER);
    });

    it('TEST 6: Existing customer: "How much does roofing cost?" -> CUSTOMER, NOT SUBCONTRACTOR', async () => {
      const person = {
        person_id: 'p_cust_6',
        name: 'Emily',
        roles: [ROLES.CUSTOMER],
        active_role: ROLES.CUSTOMER
      };

      const result = await detectRoleAndIntent({
        message: 'How much does roofing cost for a residential house?',
        person
      });

      expect(result.detected_role).toBe(ROLES.CUSTOMER);
      expect(result.workflow).toBe(WORKFLOWS.CUSTOMER_INTAKE_SALES);
      expect(result.dual_role_candidate).toBe(null);
    });

    it('TEST 7: Existing subcontractor: "How much do you charge homeowners for roofing?" -> SUBCONTRACTOR', async () => {
      const person = {
        person_id: 'p_sub_7',
        name: 'Tom Painter',
        roles: [ROLES.SUBCONTRACTOR],
        active_role: ROLES.SUBCONTRACTOR
      };

      const result = await detectRoleAndIntent({
        message: 'How much do you charge homeowners for roofing?',
        person
      });

      expect(result.detected_role).toBe(ROLES.SUBCONTRACTOR);
      expect(result.workflow).toBe(WORKFLOWS.SUBCONTRACTOR_RECRUITMENT);
      expect(result.current_intent).toBe(INTENTS.SUBCONTRACTOR_GENERAL_PRICING_INQUIRY);
    });

    it('TEST 8: Ambiguous: "I do roofing and need some information." -> CLARIFICATION without guessing', async () => {
      const person = {
        person_id: 'p_8',
        name: 'Chris',
        roles: [ROLES.CUSTOMER],
        active_role: ROLES.CUSTOMER
      };

      const result = await detectRoleAndIntent({
        message: 'I do roofing and need some information.',
        person
      });

      expect(result.needs_clarification).toBe(true);
      expect(result.workflow).toBe(WORKFLOWS.AMBIGUOUS_CLARIFICATION);
      expect(result.clarification_question).toContain('trade contractor');
    });

    it('TEST 9: Customer: "I\'m a contractor too." -> Asks clarification question before overwriting', async () => {
      const person = {
        person_id: 'p_9',
        name: 'Gary',
        roles: [ROLES.CUSTOMER],
        active_role: ROLES.CUSTOMER
      };

      const result = await detectRoleAndIntent({
        message: "I'm a contractor too.",
        person
      });

      expect(result.needs_clarification).toBe(true);
      expect(result.workflow).toBe(WORKFLOWS.AMBIGUOUS_CLARIFICATION);
      expect(result.clarification_question).toContain('working with Restoricon');
    });

    it('TEST 10: Customer asks about both: "I need a kitchen remodel, and I also want to see if my company can subcontract for you." -> DUAL ROLE tracked', async () => {
      const person = {
        person_id: 'p_10',
        name: 'Lisa',
        roles: [ROLES.CUSTOMER],
        active_role: ROLES.CUSTOMER
      };

      const result = await detectRoleAndIntent({
        message: 'I need a kitchen remodel, and I also want to see if my company can subcontract for you.',
        person
      });

      expect(result.current_intent).toBe(INTENTS.DUAL_INTENT_CUSTOMER_AND_SUB);
      expect(result.dual_role_candidate).toBe(ROLES.SUBCONTRACTOR);
      expect(result.dual_intents).toContain(INTENTS.CUSTOMER_PROJECT_INQUIRY);
      expect(result.dual_intents).toContain(INTENTS.SUBCONTRACTOR_INQUIRY);

      const updated = updatePersonRolesAndState({ person, classification: result });
      expect(updated.roles).toContain(ROLES.CUSTOMER);
      expect(updated.roles).toContain(ROLES.SUBCONTRACTOR);
    });
  });

  describe('Section 12: Knowledge Domain & Retrieval Metadata', () => {
    it('generates targeted metadata filtering for subcontractor vs customer domains', () => {
      const subMeta = buildRetrievalMetadata({
        classification: { detected_role: ROLES.SUBCONTRACTOR, current_intent: 'onboarding' },
        person: { organization: { trade: 'plumbing' } }
      });

      expect(subMeta.domain).toBe('subcontractor');
      expect(subMeta.trade).toBe('plumbing');
      expect(subMeta.tags).toContain('RECRUITMENT');
      expect(subMeta.tags).toContain('MSA');

      const custMeta = buildRetrievalMetadata({
        classification: { detected_role: ROLES.CUSTOMER, current_intent: 'estimate' },
        person: {}
      });

      expect(custMeta.domain).toBe('customer');
      expect(custMeta.tags).toContain('ESTIMATE');
    });
  });
});
