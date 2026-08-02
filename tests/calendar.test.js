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

describe('mentionsToday', () => {
  it('recognizes "today" and "tonight"', () => {
    expect(calendar.mentionsToday('can you fit me in today at 3pm')).toBe(true);
    expect(calendar.mentionsToday('tonight around 7')).toBe(true);
  });

  it('does not match unrelated phrases, including ones that only imply "today"', () => {
    expect(calendar.mentionsToday('next tuesday at 2pm')).toBe(false);
    expect(calendar.mentionsToday('as soon as possible')).toBe(false);
    expect(calendar.mentionsToday(null)).toBe(false);
  });
});

describe('startOfTomorrow', () => {
  it('returns midnight of the day after the given date', () => {
    const result = calendar.startOfTomorrow(new Date('2026-08-02T15:30:00'));
    expect(result.getDate()).toBe(3);
    expect(result.getHours()).toBe(0);
    expect(result.getMinutes()).toBe(0);
  });

  it('rolls over the month/year correctly', () => {
    const result = calendar.startOfTomorrow(new Date('2026-12-31T23:00:00'));
    expect(result.getFullYear()).toBe(2027);
    expect(result.getMonth()).toBe(0);
    expect(result.getDate()).toBe(1);
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
