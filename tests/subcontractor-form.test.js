// tests/subcontractor-form.test.js — Unit tests for the deterministic
// subcontractor application form parser. Pure functions, no file I/O, so
// unlike contacts.js/queue.js this can be exercised directly.

import * as subForm from '../subcontractor-form.js';
import { normalizeTrade } from '../trades.js';

describe('isSubcontractorApplication', () => {
  it('detects the standard lead-form subject', () => {
    expect(subForm.isSubcontractorApplication({ subject: 'New Subcontractor Application - Al Jennah Contracotrs', body: '' })).toBe(true);
  });

  it('detects via the form body when the subject is generic', () => {
    expect(subForm.isSubcontractorApplication({ subject: 'Website form submission', body: 'INQUIRY TYPE: subcontractor\nBUSINESS NAME: Foo' })).toBe(true);
  });

  it('is false for a normal customer email', () => {
    expect(subForm.isSubcontractorApplication({ subject: 'Quote request', body: 'Can I get a quote for painting my house?' })).toBe(false);
  });
});

describe('parseApplication', () => {
  const sampleBody = [
    'New Form Submission (Subcontractor Application):',
    '',
    'INQUIRY TYPE: subcontractor',
    'SUBJECT: New Subcontractor Application -',
    'BUSINESS NAME: Al Jennah Contracotrs',
    'TRADE SPECIALTY: General Remodeling',
    'PRINCIPAL NAME: Ismail Abdullah',
    'SC PHONE: 8602669332',
    'SC EMAIL: cadre.projectmanager@gmail.com',
    'HAS LICENSE: No',
    'LICENSE NUMBER:',
    'HAS GL INSURANCE: No',
    'HAS WC INSURANCE: No',
    'HAS CREW TOOLS: No',
    'CREW SIZE: 1',
    'WEEKLY CAPACITY: 40+ hours weekly',
    'REFERENCES: Mike',
    'AGREE TERMS: on'
  ].join('\n');

  it('parses every field of a fully-formatted submission', () => {
    const parsed = subForm.parseApplication(sampleBody);
    expect(parsed).toMatchObject({
      business_name: 'Al Jennah Contracotrs',
      trade_raw: 'General Remodeling',
      trade: 'general_remodeling',
      principal_name: 'Ismail Abdullah',
      phone: '8602669332',
      email: 'cadre.projectmanager@gmail.com',
      licensed: false,
      license_number: null,
      gl_insurance: false,
      wc_insurance: false,
      has_tools: false,
      crew_size: 1,
      weekly_capacity: '40+ hours weekly',
      agree_terms: true
    });
    expect(parsed.references).toEqual([{ raw: 'Mike', name: 'Mike', phone: null, email: null }]);
  });

  it('tolerates differently-worded/cased labels and checkbox-style values', () => {
    const body = [
      'inquiry type: Subcontractor',
      "company name: Bob's Plumbing LLC",
      'specialty: Plumber',
      'contact name: Bob Smith',
      'phone number: (860) 555-1234',
      'email address: bob@bobsplumbing.com',
      'licensed: Yes',
      'license #: PL-99231',
      'gl insurance: on',
      'wc insurance: off',
      'own tools: Y',
      'team size: 4',
      'availability: weekends only',
      'agree to terms: on'
    ].join('\n');

    const parsed = subForm.parseApplication(body);
    expect(parsed).toMatchObject({
      business_name: "Bob's Plumbing LLC",
      trade: 'plumbing',
      principal_name: 'Bob Smith',
      licensed: true,
      license_number: 'PL-99231',
      gl_insurance: true,
      wc_insurance: false,
      has_tools: true,
      crew_size: 4,
      agree_terms: true
    });
  });

  it('returns nulls/empty array for an empty body rather than throwing', () => {
    const parsed = subForm.parseApplication('');
    expect(parsed.business_name).toBeNull();
    expect(parsed.trade).toBeNull();
    expect(parsed.references).toEqual([]);
  });
});

describe('parseReferences', () => {
  it('splits multiple references across lines and ; and extracts phone/email from each', () => {
    const raw = 'Jane Doe 860-111-2222 jane@acme.com; Tom Lee, ABC Corp, 860-333-4444\ntom@abc.com';
    const refs = subForm.parseReferences(raw);
    expect(refs).toEqual([
      { raw: 'Jane Doe 860-111-2222 jane@acme.com', name: 'Jane Doe', phone: '860-111-2222', email: 'jane@acme.com' },
      { raw: 'Tom Lee, ABC Corp, 860-333-4444', name: 'Tom Lee ABC Corp', phone: '860-333-4444', email: null },
      { raw: 'tom@abc.com', name: null, phone: null, email: 'tom@abc.com' }
    ]);
  });

  it('returns an empty array for no references', () => {
    expect(subForm.parseReferences(null)).toEqual([]);
    expect(subForm.parseReferences('')).toEqual([]);
  });
});

describe('normalizeTrade', () => {
  it('maps common trade synonyms to a canonical slug', () => {
    expect(normalizeTrade('electrician')).toBe('electrical');
    expect(normalizeTrade('Plumber')).toBe('plumbing');
    expect(normalizeTrade('General Remodeling')).toBe('general_remodeling');
  });

  it('returns null for an unrecognized trade', () => {
    expect(normalizeTrade('exotic bird husbandry')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(normalizeTrade(null)).toBeNull();
  });
});
