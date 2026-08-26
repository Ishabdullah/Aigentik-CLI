// tests/email-provider.test.js — Unit tests for EmailProvider

import { jest } from '@jest/globals';
import { EmailProvider } from '../email-provider.js';

describe('EmailProvider', () => {
  let provider;

  beforeEach(() => {
    provider = new EmailProvider({
      config: {
        gmail: {
          email: 'test@gmail.com',
          app_password: 'testpassword',
          imap_host: 'imap.gmail.com',
          imap_port: 993,
          smtp_host: 'smtp.gmail.com',
          smtp_port: 587
        },
        aigentik_name: 'TestAgent',
        paths: { data_dir: '/tmp/test', logs_dir: '/tmp/test/logs' },
        owner: { admin_number_formatted: '+15551234567' }
      }
    });
  });

  afterEach(async () => {
    if (provider) {
      provider.isShuttingDown = true;
      try {
        await provider.disconnect();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  });

  describe('constructor', () => {
    it('should initialize with default values', () => {
      expect(provider.isConnected).toBe(false);
      expect(provider.isConnecting).toBe(false);
      expect(provider.reconnectAttempts).toBe(0);
      expect(provider.maxReconnectAttempts).toBe(10);
      expect(provider.baseReconnectDelay).toBe(5000);
      expect(provider.maxReconnectDelay).toBe(300000);
    });

    it('should accept custom options', () => {
      const customProvider = new EmailProvider({
        maxReconnectAttempts: 5,
        baseReconnectDelay: 1000,
        maxManagementConnections: 5
      });
      expect(customProvider.maxReconnectAttempts).toBe(5);
      expect(customProvider.baseReconnectDelay).toBe(1000);
      expect(customProvider.maxManagementConnections).toBe(5);
    });
  });

  describe('getImapConfig', () => {
    it('should return secure IMAP configuration', () => {
      const config = provider.getImapConfig();
      expect(config.host).toBe('imap.gmail.com');
      expect(config.port).toBe(993);
      expect(config.secure).toBe(true);
      expect(config.auth.user).toBe('test@gmail.com');
      expect(config.auth.pass).toBe('testpassword');
      expect(config.tls.rejectUnauthorized).toBe(true);
      expect(config.tls.minVersion).toBe('TLSv1.2');
      expect(config.disableCompression).toBe(true);
    });
  });

  describe('calculateReconnectDelay', () => {
    it('should calculate exponential backoff with jitter', () => {
      const delay0 = provider.calculateReconnectDelay(0);
      expect(delay0).toBeGreaterThanOrEqual(3750);
      expect(delay0).toBeLessThanOrEqual(6250);

      const delay1 = provider.calculateReconnectDelay(1);
      expect(delay1).toBeGreaterThanOrEqual(7500);
      expect(delay1).toBeLessThanOrEqual(12500);

      const delay10 = provider.calculateReconnectDelay(10);
      expect(delay10).toBeLessThanOrEqual(provider.maxReconnectDelay * 1.25);
    });
  });

  describe('Google Voice parsing', () => {
    it('should detect Google Voice text emails', () => {
      const gvEmail = { subject: 'New text message from John (555) 123-4567' };
      const normalEmail = { subject: 'Regular email subject' };

      expect(provider.isGoogleVoiceText(gvEmail)).toBe(true);
      expect(provider.isGoogleVoiceText(normalEmail)).toBe(false);
    });

    it('should parse Google Voice email correctly', () => {
      const email = {
        subject: 'New text message from John Doe (555) 123-4567',
        body: 'Hello world\nTo respond to this text message reply to this email',
        from_email: 'voice-noreply@google.com'
      };

      const parsed = provider.parseGoogleVoiceEmail(email);
      expect(parsed.type).toBe('google_voice');
      expect(parsed.sender_name).toBe('John Doe');
      expect(parsed.sender_phone).toBe('5551234567');
      expect(parsed.body).toBe('Hello world');
      expect(parsed.reply_to_email).toBe('voice-noreply@google.com');
    });

    it('should handle group text messages', () => {
      const email = {
        subject: 'New text message from Jane (555) 987-6543',
        body: 'Group message',
        from_email: 'voice-noreply@google.com'
      };

      const parsed = provider.parseGoogleVoiceEmail(email);
      expect(parsed.sender_name).toBe('Jane');
      expect(parsed.sender_phone).toBe('5559876543');
    });

    // Google Voice's current forwarded-text template appends a YOUR ACCOUNT /
    // HELP CENTER / HELP FORUM nav block plus boilerplate ending in Google's
    // own corporate mailing address — confirmed live to have been fed
    // straight into an LLM extraction call and picked up as if it were the
    // customer's own address, since nothing stripped it beforehand.
    it('strips the current YOUR ACCOUNT / HELP CENTER footer, not just the older one', () => {
      const email = {
        subject: 'New text message from John Doe (555) 123-4567',
        body: "I'd like to schedule a call for Friday at noon\nYOUR ACCOUNT  HELP CENTER\n HELP FORUM\n\nThis email was sent to you because you indicated that you'd like to receive text messages sent to your Google Voice number via email.\n\n© 2026 Google LLC 1600 Amphitheatre Parkway, Mountain View, CA 94043",
        from_email: 'voice-noreply@google.com'
      };

      const parsed = provider.parseGoogleVoiceEmail(email);
      expect(parsed.body).toBe("I'd like to schedule a call for Friday at noon");
      expect(parsed.body).not.toContain('Amphitheatre');
    });
  });

  describe('Calendar response detection', () => {
    it('detects accepted/declined/tentative subjects, case-insensitively', () => {
      expect(provider.isCalendarResponse({ subject: 'Accepted: Appointment with John @ Wed Aug 5' })).toBe(true);
      expect(provider.isCalendarResponse({ subject: 'declined: Appointment with John' })).toBe(true);
      expect(provider.isCalendarResponse({ subject: 'Tentative: Appointment with John' })).toBe(true);
      expect(provider.isCalendarResponse({ subject: 'Regular email subject' })).toBe(false);
      expect(provider.isCalendarResponse({})).toBe(false);
    });

    it('parses status and attendee email from a response email', () => {
      const parsed = provider.parseCalendarResponse({
        subject: 'Accepted: Appointment with John @ Wed Aug 5',
        from_email: 'john@example.com'
      });
      expect(parsed).toEqual({
        status: 'accepted',
        attendeeEmail: 'john@example.com',
        subject: 'Accepted: Appointment with John @ Wed Aug 5'
      });
    });

    it('returns a null status for a non-matching subject', () => {
      const parsed = provider.parseCalendarResponse({ subject: 'Hello', from_email: 'x@y.com' });
      expect(parsed.status).toBeNull();
    });
  });

  describe('Calendar invite building', () => {
    const appointment = {
      id: 'appt_0001',
      uid: 'appt_0001@aigentik.local',
      ics_sequence: 0,
      title: 'Appointment with John Smith',
      start: '2026-08-05T18:00:00.000Z',
      end: '2026-08-05T18:30:00.000Z',
      attendee_email: 'john@example.com'
    };

    it('builds a REQUEST VEVENT with the right UID, times, and attendee', () => {
      const ics = provider.buildIcs(appointment, 'REQUEST');
      expect(ics).toContain('METHOD:REQUEST');
      expect(ics).toContain('UID:appt_0001@aigentik.local');
      expect(ics).toContain('SEQUENCE:0');
      expect(ics).toContain('DTSTART:20260805T180000Z');
      expect(ics).toContain('DTEND:20260805T183000Z');
      expect(ics).toContain('ATTENDEE:mailto:john@example.com');
      expect(ics).toContain('ORGANIZER:mailto:test@gmail.com');
      expect(ics).toContain('STATUS:CONFIRMED');
    });

    it('builds a CANCEL VEVENT with matching UID and CANCELLED status', () => {
      const ics = provider.buildIcs(appointment, 'CANCEL');
      expect(ics).toContain('METHOD:CANCEL');
      expect(ics).toContain('UID:appt_0001@aigentik.local');
      expect(ics).toContain('STATUS:CANCELLED');
    });

    it('bumps SEQUENCE on a rescheduled appointment', () => {
      const rescheduled = { ...appointment, ics_sequence: 2 };
      const ics = provider.buildIcs(rescheduled, 'REQUEST');
      expect(ics).toContain('SEQUENCE:2');
    });

    it('falls back to the organizer address when no attendee email is set', () => {
      const noAttendee = { ...appointment, attendee_email: null };
      const ics = provider.buildIcs(noAttendee, 'REQUEST');
      expect(ics).toContain('ATTENDEE:mailto:test@gmail.com');
    });
  });
});

describe('EmailProvider new mail handling', () => {
  let provider;

  beforeEach(() => {
    provider = new EmailProvider({
      config: {
        gmail: {
          email: 'test@gmail.com',
          app_password: 'testpassword',
          imap_host: 'imap.gmail.com',
          imap_port: 993,
          smtp_host: 'smtp.gmail.com',
          smtp_port: 587
        }
      }
    });
  });

  it('setupEventHandlers triggers handleNewMail when exists count increases', () => {
    const handlers = {};
    provider.imapClient = {
      on: (event, handler) => {
        handlers[event] = handler;
      }
    };
    provider.handleNewMail = jest.fn().mockResolvedValue();

    provider.setupEventHandlers();
    handlers.exists({ count: 26, prevCount: 25 });

    expect(provider.handleNewMail).toHaveBeenCalledTimes(1);
  });

  it('setupEventHandlers does not trigger handleNewMail when exists count decreases', () => {
    const handlers = {};
    provider.imapClient = {
      on: (event, handler) => {
        handlers[event] = handler;
      }
    };
    provider.handleNewMail = jest.fn().mockResolvedValue();

    provider.setupEventHandlers();
    handlers.exists({ count: 24, prevCount: 25 });

    expect(provider.handleNewMail).not.toHaveBeenCalled();
  });

  it('does not run handleNewMail concurrently with itself, but rechecks once after finishing', async () => {
    let resolveFirst;
    let callCount = 0;
    provider.handleNewMail = jest.fn(() => {
      callCount++;
      if (callCount === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve();
    });

    provider.triggerHandleNewMail();
    provider.triggerHandleNewMail();
    provider.triggerHandleNewMail();

    expect(provider.handleNewMail).toHaveBeenCalledTimes(1);

    resolveFirst();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(provider.handleNewMail).toHaveBeenCalledTimes(2);
  });

  it('handleNewMail iterates the async-generator fetch result and processes each message', async () => {
    provider.startupTime = new Date('2020-01-01T00:00:00Z');
    provider.onNewMailCallback = jest.fn().mockResolvedValue();

    async function* fakeFetch() {
      yield { uid: 1, source: Buffer.from('From: a@b.com\r\nSubject: Hi\r\n\r\nBody') };
    }

    provider.imapClient = {
      fetch: () => fakeFetch(),
      messageFlagsAdd: jest.fn().mockResolvedValue(true)
    };

    await provider.handleNewMail();

    expect(provider.imapClient.messageFlagsAdd).toHaveBeenCalledWith(1, ['\\Seen'], { uid: true });
    expect(provider.onNewMailCallback).toHaveBeenCalledTimes(1);
    expect(provider.onNewMailCallback.mock.calls[0][0].uid).toBe(1);
  });

  it('spamMatchingEmails only moves messages the predicate matches, using UID addressing', async () => {
    async function* fakeFetch() {
      yield { uid: 10, source: Buffer.from('From: promo@shop.com\r\nSubject: Big Sale\r\n\r\nBuy now') };
      yield { uid: 11, source: Buffer.from('From: friend@example.com\r\nSubject: Hi\r\n\r\nHey there') };
    }

    const client = {
      mailboxOpen: jest.fn().mockResolvedValue(),
      search: jest.fn().mockResolvedValue([10, 11]),
      fetch: jest.fn(() => fakeFetch()),
      messageMove: jest.fn().mockResolvedValue(true)
    };
    provider.withManagementConnection = jest.fn((operation) => operation(client));

    const predicate = ({ subject }) => subject.toLowerCase().includes('sale');
    const result = await provider.spamMatchingEmails(predicate);

    expect(client.search).toHaveBeenCalledWith({ all: true }, { uid: true });
    expect(client.fetch).toHaveBeenCalledWith([10, 11], { source: true, uid: true }, { uid: true });
    expect(client.messageMove).toHaveBeenCalledWith([10], '[Gmail]/Spam', { uid: true });
    expect(result).toEqual({ spam: 1, scanned: 2 });
  });

  it('spamByUid moves only the exact message by UID', async () => {
    const client = {
      mailboxOpen: jest.fn().mockResolvedValue(),
      messageMove: jest.fn().mockResolvedValue(true)
    };
    provider.withManagementConnection = jest.fn((operation) => operation(client));

    const result = await provider.spamByUid(42);

    expect(client.messageMove).toHaveBeenCalledWith([42], '[Gmail]/Spam', { uid: true });
    expect(result).toEqual({ spam: 1 });
  });
});

describe('EmailProvider exports', () => {
  it('should export EmailProvider class', () => {
    expect(EmailProvider).toBeDefined();
    expect(typeof EmailProvider).toBe('function');
  });
});