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
  });
});

describe('EmailProvider exports', () => {
  it('should export EmailProvider class', () => {
    expect(EmailProvider).toBeDefined();
    expect(typeof EmailProvider).toBe('function');
  });
});