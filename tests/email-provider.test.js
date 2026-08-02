// tests/email-provider.test.js — Unit tests for EmailProvider

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

describe('EmailProvider exports', () => {
  it('should export EmailProvider class', () => {
    expect(EmailProvider).toBeDefined();
    expect(typeof EmailProvider).toBe('function');
  });
});