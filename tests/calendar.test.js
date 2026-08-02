// tests/calendar.test.js — Unit tests for calendar.js's pure logic
// (phrase parsing). File-backed slot-finding/booking is exercised manually
// against a sandbox data dir rather than here, since calendar.js reads its
// paths from the real config.json — same limitation contacts.js/queue.js
// already have with no dedicated test file.

import * as calendar from '../calendar.js';

describe('parseWorkingHoursPhrase', () => {
  it('expands a weekday range', () => {
    const result = calendar.parseWorkingHoursPhrase('9am to 5pm monday through friday');
    expect(result).toEqual({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' });
  });

  it('understands "weekdays" shorthand and bare hour numbers', () => {
    const result = calendar.parseWorkingHoursPhrase('9 to 5 weekdays');
    expect(result).toEqual({ days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' });
  });

  it('handles a single day', () => {
    const result = calendar.parseWorkingHoursPhrase('10am to 2pm on saturdays');
    expect(result).toEqual({ days: ['sat'], start: '10:00', end: '14:00' });
  });

  it('returns null when it cannot find a time range', () => {
    expect(calendar.parseWorkingHoursPhrase('whenever works')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(calendar.parseWorkingHoursPhrase(null)).toBeNull();
  });
});

describe('parseDatetimePhrase', () => {
  const anchor = new Date('2026-08-02T12:00:00');

  it('resolves a relative weekday + time phrase to a real Date', () => {
    const result = calendar.parseDatetimePhrase('next tuesday at 2pm', anchor);
    expect(result).toBeInstanceOf(Date);
    expect(result.getTime()).toBeGreaterThan(anchor.getTime());
  });

  it('returns null when no date is mentioned', () => {
    expect(calendar.parseDatetimePhrase('asap', anchor)).toBeNull();
  });

  it('returns null for null input', () => {
    expect(calendar.parseDatetimePhrase(null, anchor)).toBeNull();
  });
});
