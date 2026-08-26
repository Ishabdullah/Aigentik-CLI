// email-provider.js — Aigentik Email Provider
// Modern IMAP/SMTP implementation using imapflow and nodemailer 9.x
// Features: async/await, auto-reconnect, exponential backoff, connection pooling,
// structured logging, TLS validation, secure authentication

import fs from 'fs';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import config from './config.json' with { type: 'json' };
import log from './logger.js';
import { SIGNATURE_ICON_PATH, SIGNATURE_ICON_CID } from './llama.js';

class EmailProvider {
  constructor(options = {}) {
    this.config = options.config || config;
    this.logger = options.logger || log;

    // IMAP connection state
    this.imapClient = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 10;
    this.baseReconnectDelay = options.baseReconnectDelay || 5000; // 5 seconds
    this.maxReconnectDelay = options.maxReconnectDelay || 300000; // 5 minutes

    // IDLE state
    this.idlePromise = null;
    this.onNewMailCallback = null;
    this.startupTime = new Date();

    // Guards against overlapping handleNewMail() runs: if two 'exists' events
    // fire close together, a second run is deferred (not started concurrently)
    // until the first finishes, then re-checked once more.
    this.isHandlingNewMail = false;
    this.newMailRecheckPending = false;

    // SMTP transporter (singleton)
    this.smtpTransporter = null;

    // Connection pool for management operations
    this.managementPool = [];
    this.maxManagementConnections = options.maxManagementConnections || 3;

    // Shutdown flag
    this.isShuttingDown = false;
  }

  /**
   * Get IMAP configuration with secure defaults
   */
  getImapConfig() {
    return {
      host: this.config.gmail.imap_host,
      port: this.config.gmail.imap_port,
      secure: true, // Use TLS
      auth: {
        user: this.config.gmail.email,
        pass: this.config.gmail.app_password
      },
      // Security: enforce certificate validation
      tls: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2'
      },
      // Connection resilience
      keepalive: {
        interval: 30000, // Send NOOP every 30s
        timeout: 10000
      },
      // Disable compression to avoid issues
      disableCompression: true,
      // Logger for debugging
      logger: this.logger.debug ? (msg) => this.logger.debug('imapflow', msg) : false
    };
  }

  /**
   * The address that customer-facing mail (replies, invites) appears to come
   * from. Defaults to the authenticated Gmail account, but if that account
   * has a verified "Send mail as" alias configured in Gmail (Settings →
   * Accounts → Send mail as), set `gmail.send_as` in config.json to that
   * alias and outgoing mail carries it instead — e.g. a business address
   * like contact@yourbusiness.com that forwards into the Gmail inbox
   * Aigentik actually monitors. IMAP/SMTP auth is unaffected; this only
   * changes the From header, and Gmail rejects it silently (falling back to
   * the real account) if the alias isn't verified first.
   */
  senderAddress() {
    return this.config.gmail.send_as || this.config.gmail.email;
  }

  /**
   * Get SMTP transporter with secure defaults
   */
  getTransporter() {
    if (!this.smtpTransporter) {
      this.smtpTransporter = nodemailer.createTransport({
        host: this.config.gmail.smtp_host,
        port: this.config.gmail.smtp_port,
        secure: this.config.gmail.smtp_port === 465, // true for 465, false for 587
        auth: {
          user: this.config.gmail.email,
          pass: this.config.gmail.app_password
        },
        // Security: enforce certificate validation
        tls: {
          rejectUnauthorized: true,
          minVersion: 'TLSv1.2'
        },
        // Prevent header injection
        disableFileAccess: true,
        disableUrlAccess: true,
        // Connection pool
        pool: true,
        maxConnections: 5,
        maxMessages: 100,
        rateDelta: 1000,
        rateLimit: 10
      });

      // Verify connection on startup
      this.smtpTransporter.verify().then(() => {
        this.logger.info('email-provider', 'SMTP connection verified');
      }).catch((err) => {
        this.logger.error('email-provider', 'SMTP verification failed', { error: err.message });
      });
    }
    return this.smtpTransporter;
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  calculateReconnectDelay(attempt) {
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, attempt),
      this.maxReconnectDelay
    );
    // Add jitter (±25%)
    const jitter = delay * 0.25 * (Math.random() * 2 - 1);
    return Math.floor(delay + jitter);
  }

  /**
   * Connect to IMAP server with automatic reconnection
   */
  async connect(onNewMailCallback) {
    if (this.isConnecting) {
      this.logger.warn('email-provider', 'Connection already in progress');
      return;
    }

    if (this.isConnected && this.imapClient) {
      this.logger.info('email-provider', 'Already connected');
      if (onNewMailCallback) this.onNewMailCallback = onNewMailCallback;
      return;
    }

    this.onNewMailCallback = onNewMailCallback;
    this.isConnecting = true;
    this.isShuttingDown = false;

    while (!this.isShuttingDown) {
      try {
        this.logger.info('email-provider', `Connecting to IMAP as ${this.config.gmail.email}...`);
        this.imapClient = new ImapFlow(this.getImapConfig());

        // Set up event handlers
        this.setupEventHandlers();

        // Connect with timeout
        await Promise.race([
          this.imapClient.connect(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout')), 30000)
          )
        ]);

        this.isConnected = true;
        this.isConnecting = false;
        this.reconnectAttempts = 0;

        this.logger.info('email-provider', 'IMAP connected successfully');

        // Open INBOX and start IDLE
        await this.openInboxAndWatch();

        // Wait for connection to end
        await new Promise((resolve) => {
          this.imapClient.once('close', resolve);
          this.imapClient.once('error', resolve);
        });

      } catch (error) {
        this.isConnecting = false;
        this.isConnected = false;

        if (this.isShuttingDown) {
          this.logger.info('email-provider', 'Shutdown requested, stopping reconnect attempts');
          break;
        }

        this.reconnectAttempts++;
        const delay = this.calculateReconnectDelay(this.reconnectAttempts - 1);

        this.logger.warn('email-provider', `IMAP connection failed (attempt ${this.reconnectAttempts}), reconnecting in ${delay}ms`, {
          error: error.message,
          nextAttempt: this.reconnectAttempts + 1
        });

        await this.sleep(delay);
      }
    }
  }

  /**
   * Set up IMAP event handlers
   */
  setupEventHandlers() {
    this.imapClient.on('exists', ({ count, prevCount }) => {
      this.logger.debug('email-provider', `Mailbox exists update: ${count} messages`);
      if (count > prevCount) {
        this.triggerHandleNewMail();
      }
    });

    this.imapClient.on('update', (update) => {
      this.logger.debug('email-provider', 'Mailbox update', { update });
    });

    this.imapClient.on('expunge', ({ seq }) => {
      this.logger.debug('email-provider', `Message expunged: ${seq}`);
    });

    this.imapClient.on('close', () => {
      this.logger.warn('email-provider', 'IMAP connection closed');
      this.isConnected = false;
    });

    this.imapClient.on('error', (error) => {
      this.logger.error('email-provider', 'IMAP error', { error: error.message });
      this.isConnected = false;
    });
  }

  /**
   * Open INBOX and start IDLE monitoring
   */
  async openInboxAndWatch() {
    if (!this.imapClient || !this.isConnected) {
      throw new Error('Not connected to IMAP');
    }

    // Open INBOX read-write
    const lock = await this.imapClient.getMailboxLock('INBOX');
    try {
      await this.imapClient.mailboxOpen('INBOX', { readOnly: false });
      const mailbox = this.imapClient.mailbox;
      this.logger.info('email-provider', `INBOX opened. ${mailbox.exists} total messages.`);

      // Start IDLE loop
      this.idlePromise = this.idleLoop();
    } finally {
      lock.release();
    }
  }

  /**
   * IDLE loop with automatic restart on failure
   */
  async idleLoop() {
    while (this.isConnected && !this.isShuttingDown) {
      try {
        this.logger.debug('email-provider', 'Starting IDLE...');
        await this.imapClient.idle();
        this.logger.debug('email-provider', 'IDLE ended, restarting');
      } catch (error) {
        if (!this.isShuttingDown) {
          this.logger.error('email-provider', 'IDLE error', { error: error.message });
          // Brief pause before retry
          await this.sleep(5000);
        }
      }
    }
  }

  /**
   * Trigger handleNewMail(), but never run it concurrently with itself. If an
   * 'exists' event fires while a run is already in progress, defer instead of
   * starting a second overlapping search+fetch over the same connection.
   */
  triggerHandleNewMail() {
    if (this.isHandlingNewMail) {
      this.newMailRecheckPending = true;
      return;
    }
    this.isHandlingNewMail = true;
    this.handleNewMail()
      .catch((error) => {
        this.logger.error('email-provider', 'Failed to handle new mail from exists event', { error: error.message });
      })
      .finally(() => {
        this.isHandlingNewMail = false;
        if (this.newMailRecheckPending) {
          this.newMailRecheckPending = false;
          this.triggerHandleNewMail();
        }
      });
  }

  /**
   * Handle new mail notification from IDLE
   */
  async handleNewMail() {
    if (!this.onNewMailCallback) return;

    try {
      // Search for unseen messages since startup. Gmail's IMAP SINCE search
      // evaluates the date in Gmail's own timezone (Pacific), not UTC, so a
      // sinceDate taken straight from a UTC ISO string can be a calendar day
      // ahead of what Gmail considers "today" for several hours after UTC
      // midnight — silently excluding brand-new unseen mail from the search.
      // Back it off by a day; the exact cutoff is still enforced below via
      // the per-message startupTime comparison.
      const sinceDate = new Date(this.startupTime.getTime() - 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0]; // YYYY-MM-DD

      // Fully drain the fetch generator before issuing any other command on this
      // connection: the underlying FETCH command doesn't complete (and release the
      // connection) until every yielded row is pulled, so running messageFlagsAdd
      // or anything else per-row here would deadlock the connection against itself.
      const messages = [];
      for await (const msg of this.imapClient.fetch(
        { unseen: true, since: sinceDate },
        { source: true, uid: true }
      )) {
        messages.push(msg);
      }

      for (const msg of messages) {
        try {
          const email = await this.parseMessage(msg.source);
          email.uid = msg.uid;

          // Double-check email is newer than startup time
          const emailDate = new Date(email.date);
          if (emailDate < this.startupTime) {
            this.logger.debug('email-provider', `Skipping old email from ${email.from_email}`);
            continue;
          }

          this.logger.info('email-provider', `Processing new email from ${email.from_email}`, {
            subject: email.subject,
            uid: msg.uid
          });

          // Mark as seen (uid: true is required — otherwise msg.uid is misread as a
          // sequence number, silently marking the wrong message and leaving this one
          // "unseen" forever, so it gets reprocessed and re-replied to on every poll)
          await this.imapClient.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });

          // Callback to application
          await this.onNewMailCallback(email);

        } catch (error) {
          this.logger.error('email-provider', 'Failed to process email', {
            error: error.message,
            uid: msg.uid
          });
        }
      }
    } catch (error) {
      this.logger.error('email-provider', 'Failed to fetch new mail', { error: error.message });
    }
  }

  /**
   * Parse raw email message using mailparser
   */
  async parseMessage(source) {
    const parsed = await simpleParser(source);
    return {
      from: parsed.from?.text || '',
      from_email: parsed.from?.value?.[0]?.address || '',
      from_name: parsed.from?.value?.[0]?.name || '',
      to: parsed.to?.text || '',
      subject: parsed.subject || '(no subject)',
      body: parsed.text || parsed.html || '',
      date: parsed.date || new Date(),
      message_id: parsed.messageId || ''
    };
  }

  /**
   * Get a management connection from pool or create new one
   */
  async getManagementConnection() {
    // Try to reuse an existing connection
    for (let i = this.managementPool.length - 1; i >= 0; i--) {
      const client = this.managementPool[i];
      if (client && client.usable) {
        this.managementPool.splice(i, 1);
        return client;
      }
    }

    // Create new connection
    const client = new ImapFlow(this.getImapConfig());
    await client.connect();
    return client;
  }

  /**
   * Release management connection back to pool
   */
  async releaseManagementConnection(client) {
    if (this.managementPool.length < this.maxManagementConnections && client.usable) {
      this.managementPool.push(client);
    } else {
      try {
        await client.logout();
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Execute a management operation with its own connection
   */
  async withManagementConnection(operation) {
    let client = await this.getManagementConnection();
    try {
      return await operation(client);
    } catch (error) {
      if (!this.isShuttingDown && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || !client.usable || /closed|broken|destroy|timeout/i.test(error.message || ''))) {
        this.logger.warn('email-provider', 'Management connection error, retrying with fresh client...', { error: error.message });
        try { await client.logout(); } catch (e) {}
        client = new ImapFlow(this.getImapConfig());
        await client.connect();
        return await operation(client);
      }
      throw error;
    } finally {
      await this.releaseManagementConnection(client);
    }
  }

  /**
   * Search emails by criteria
   */
  async searchEmails(criteria) {
    return this.withManagementConnection(async (client) => {
      await client.mailboxOpen('INBOX', { readOnly: true });
      const uids = await client.search(criteria, { uid: true });
      return uids || [];
    });
  }

  /**
   * Delete emails permanently (move to Trash)
   */
  async deleteEmails(criteria) {
    return this.withManagementConnection(async (client) => {
      await client.mailboxOpen('INBOX', { readOnly: false });
      const uids = await client.search(criteria, { uid: true });
      if (!uids.length) return { deleted: 0 };

      await client.messageMove(uids, '[Gmail]/Trash', { uid: true });
      this.logger.action('email-provider', `Deleted ${uids.length} email(s)`);
      return { deleted: uids.length };
    });
  }

  /**
   * Archive emails (move to All Mail)
   */
  async archiveEmails(criteria) {
    return this.withManagementConnection(async (client) => {
      await client.mailboxOpen('INBOX', { readOnly: false });
      const uids = await client.search(criteria, { uid: true });
      if (!uids.length) return { archived: 0 };

      await client.messageMove(uids, '[Gmail]/All Mail', { uid: true });
      this.logger.action('email-provider', `Archived ${uids.length} email(s)`);
      return { archived: uids.length };
    });
  }

  /**
   * Mark emails as spam
   */
  async markAsSpam(criteria) {
    return this.withManagementConnection(async (client) => {
      await client.mailboxOpen('INBOX', { readOnly: false });
      const uids = await client.search(criteria, { uid: true });
      if (!uids.length) return { spam: 0 };

      await client.messageMove(uids, '[Gmail]/Spam', { uid: true });
      this.logger.action('email-provider', `Marked ${uids.length} email(s) as spam`);
      return { spam: uids.length };
    });
  }

  /**
   * Scan every message in the inbox, parse it, and move to Spam only the ones
   * where predicate({ from, subject, body }) returns true. Used for filters
   * (e.g. "promotional") that aren't expressible as a single IMAP SEARCH query
   * and have to be evaluated against the actual message content.
   */
  async spamMatchingEmails(predicate) {
    return this.withManagementConnection(async (client) => {
      await client.mailboxOpen('INBOX', { readOnly: false });
      const uids = await client.search({ all: true }, { uid: true });
      if (!uids.length) return { spam: 0, scanned: 0 };

      const matchedUids = [];
      for await (const msg of client.fetch(uids, { source: true, uid: true }, { uid: true })) {
        try {
          const email = await this.parseMessage(msg.source);
          if (predicate({ from: email.from_email, subject: email.subject, body: email.body })) {
            matchedUids.push(msg.uid);
          }
        } catch (error) {
          this.logger.warn('email-provider', 'Failed to parse message while scanning for spam match', {
            error: error.message,
            uid: msg.uid
          });
        }
      }

      if (!matchedUids.length) return { spam: 0, scanned: uids.length };

      await client.messageMove(matchedUids, '[Gmail]/Spam', { uid: true });
      this.logger.action('email-provider', `Marked ${matchedUids.length} of ${uids.length} scanned email(s) as spam`);
      return { spam: matchedUids.length, scanned: uids.length };
    });
  }

  /**
   * Move a single message to Spam by its exact UID — used when the caller
   * already knows which message it means (e.g. a queued item), so it doesn't
   * have to fall back to spamming everything from that sender.
   */
  async spamByUid(uid) {
    return this.withManagementConnection(async (client) => {
      await client.mailboxOpen('INBOX', { readOnly: false });
      await client.messageMove([uid], '[Gmail]/Spam', { uid: true });
      this.logger.action('email-provider', `Marked message UID ${uid} as spam`);
      return { spam: 1 };
    });
  }

  /**
   * Mark emails as read
   */
  async markAsRead(criteria) {
    return this.withManagementConnection(async (client) => {
      await client.mailboxOpen('INBOX', { readOnly: false });
      const uids = await client.search(criteria, { uid: true });
      if (!uids.length) return { marked: 0 };

      await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      this.logger.action('email-provider', `Marked ${uids.length} email(s) as read`);
      return { marked: uids.length };
    });
  }

  /**
   * Mark emails as unread
   */
  async markAsUnread(criteria) {
    return this.withManagementConnection(async (client) => {
      await client.mailboxOpen('INBOX', { readOnly: false });
      const uids = await client.search(criteria, { uid: true });
      if (!uids.length) return { marked: 0 };

      await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
      this.logger.action('email-provider', `Marked ${uids.length} email(s) as unread`);
      return { marked: uids.length };
    });
  }

  /**
   * Add a label to emails
   */
  async labelEmails(criteria, labelName) {
    return this.withManagementConnection(async (client) => {
      await client.mailboxOpen('INBOX', { readOnly: false });
      const uids = await client.search(criteria, { uid: true });
      if (!uids.length) return { labeled: 0 };

      // Gmail uses labels as flags
      await client.messageFlagsAdd(uids, [labelName], { uid: true });
      this.logger.action('email-provider', `Labeled ${uids.length} email(s) as "${labelName}"`);
      return { labeled: uids.length };
    });
  }

  /**
   * Mark all current inbox emails as seen
   */
  async markAllAsSeen() {
    return this.withManagementConnection(async (client) => {
      await client.mailboxOpen('INBOX', { readOnly: false });
      const uids = await client.search({ unseen: true }, { uid: true });
      if (!uids.length) return { marked: 0 };

      await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      this.logger.action('email-provider', `Marked all ${uids.length} emails as seen`);
      return { marked: uids.length };
    });
  }

  /**
   * Send email reply
   */
  async sendReply(toEmail, originalSubject, body, html) {
    const subject = originalSubject.startsWith('Re:') ? originalSubject : `Re: ${originalSubject}`;
    return this.sendEmail(toEmail, subject, body, html, true);
  }

  /**
   * Send new email. When `html` is given, the message is sent as HTML (with
   * `body` as the plain-text fallback) and the RESTORICON icon thumbnail is
   * embedded as a cid attachment so the AI's signature renders inline.
   */
  async sendEmail(toEmail, subject, body, html, isReply = false) {
    const transporter = this.getTransporter();
    const fromName = this.config.aigentik_name || 'Aigentik';

    try {
      const hasIcon = html && fs.existsSync(SIGNATURE_ICON_PATH);
      const info = await transporter.sendMail({
        from: `${fromName} <${this.senderAddress()}>`,
        to: toEmail,
        subject,
        text: body,
        ...(html ? {
          html,
          ...(hasIcon ? {
            attachments: [{
              filename: 'restoricon-icon-thumb.png',
              path: SIGNATURE_ICON_PATH,
              cid: SIGNATURE_ICON_CID
            }]
          } : {})
        } : {}),
        // Security headers
        headers: {
          'X-Auto-Response-Suppress': 'OOF, AutoReply',
          'X-Priority': '3',
          'X-MSMail-Priority': 'Normal'
        }
      });

      this.logger.action('email-provider', `${isReply ? 'Reply' : 'Email'} sent to ${toEmail}`, {
        subject,
        messageId: info.messageId
      });
      return true;
    } catch (error) {
      this.logger.error('email-provider', `Failed to send ${isReply ? 'reply' : 'email'} to ${toEmail}`, {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Send notification to owner via email
   */
  async sendOwnerNotification(message) {
    const transporter = this.getTransporter();
    const to = this.config.owner?.admin_email || this.config.gmail.email;
    try {
      await transporter.sendMail({
        from: this.config.gmail.email,
        to,
        subject: 'Aigentik Notification',
        text: message
      });
      this.logger.info('email-provider', `Owner notification sent to ${to}`);
      return true;
    } catch (error) {
      this.logger.error('email-provider', 'Failed to send owner notification', {
        error: error.message
      });
      return false;
    }
  }

  /**
   * Check if email is a Google Voice forwarded text
   */
  isGoogleVoiceText(email) {
    return email.subject?.startsWith('New text message from') ||
           email.subject?.startsWith('New group text message');
  }

  /**
   * Detect a calendar invite-response email — when an attendee accepts,
   * declines, or tentatively accepts an .ics invite in their own mail
   * client, it sends the organizer a reply whose subject Gmail/Outlook
   * prefix with "Accepted:"/"Declined:"/"Tentative:". No .ics parsing
   * needed — this convention is reliable enough on its own.
   */
  isCalendarResponse(email) {
    return /^(accepted|declined|tentative):/i.test(email.subject || '');
  }

  /**
   * Parse a calendar invite-response email into { status, attendeeEmail, subject }
   */
  parseCalendarResponse(email) {
    const match = (email.subject || '').match(/^(accepted|declined|tentative):/i);
    return {
      status: match ? match[1].toLowerCase() : null,
      attendeeEmail: email.from_email || null,
      subject: email.subject
    };
  }

  /**
   * Parse Google Voice forwarded email into SMS-like object
   */
  parseGoogleVoiceEmail(email) {
    // Match both "New text message from" and "New group text message from".
    // The name is optional — Google Voice omits it for numbers with no saved
    // contact name, giving a subject like "New text message from (555) 123-4567".
    const subjectMatch = email.subject?.match(
      /New (?:group )?text message from (?:(.+?)\s*)?\((\d{3})\)\s*(\d{3})-(\d{4})/
    );

    let senderName = null;
    let senderPhone = null;

    if (subjectMatch) {
      senderName = subjectMatch[1] ? subjectMatch[1].trim() : null;
      senderPhone = subjectMatch[2] + subjectMatch[3] + subjectMatch[4];
    }

    let body = email.body || '';
    // Google Voice's forwarded-text template has changed over time, and this
    // account is on a newer one than "To respond to this text message" (kept
    // for older/other accounts still on it) — its current footer is a
    // YOUR ACCOUNT / HELP CENTER / HELP FORUM nav block followed by boilerplate
    // that ends with Google's own corporate mailing address. Verified live:
    // leaving this in `body` fed it straight into every downstream LLM call
    // as if it were part of the actual message, and an extraction call picked
    // up Google's address as if it were the customer's — not a hallucination,
    // it was genuinely sitting right there in the "message" text.
    const footerMarkers = ['To respond to this text message', 'YOUR ACCOUNT'];
    let footerIdx = -1;
    for (const marker of footerMarkers) {
      const idx = body.indexOf(marker);
      if (idx !== -1 && (footerIdx === -1 || idx < footerIdx)) footerIdx = idx;
    }
    if (footerIdx !== -1) {
      body = body.substring(0, footerIdx).trim();
    }
    body = body.replace(/<[^>]*>/g, '').trim();

    return {
      type: 'google_voice',
      sender_name: senderName,
      sender_phone: senderPhone,
      sender_email: email.from_email,
      reply_to_email: email.from_email,
      body: body,
      original_subject: email.subject,
      original_email: email
    };
  }

  /**
   * Reply to a Google Voice forwarded text
   */
  async replyToGoogleVoiceText(voiceMessage, replyText) {
    const transporter = this.getTransporter();
    try {
      // Google Voice's email-to-SMS relay only delivers the text up through
      // the first blank line, silently dropping everything after it (it
      // reads a blank line as a quote/signature boundary). Collapse blank
      // lines so multi-paragraph replies (e.g. the scheduling intake form)
      // actually arrive in full as a text.
      const smsText = replyText.replace(/\n{2,}/g, '\n');
      await transporter.sendMail({
        from: this.config.gmail.email,
        to: voiceMessage.reply_to_email,
        subject: 'Re: ' + voiceMessage.original_subject,
        text: smsText
      });
      this.logger.action('email-provider', 'Google Voice reply sent', {
        to: voiceMessage.sender_name
      });
      return true;
    } catch (error) {
      this.logger.error('email-provider', 'Failed to send Google Voice reply', {
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Build a VCALENDAR/VEVENT block for an appointment. method is 'REQUEST'
   * for new/updated bookings or 'CANCEL' to retract — mail clients that
   * understand iCalendar (Gmail, Outlook, Apple Mail) auto-render an
   * "Add to Calendar" affordance for REQUEST and auto-remove the event for
   * CANCEL, entirely client-side — no calendar API/OAuth involved.
   */
  buildIcs(appointment, method) {
    const toIcsDate = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const organizerEmail = this.senderAddress();
    const attendeeEmail = appointment.attendee_email || organizerEmail;
    const status = method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED';

    return [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Aigentik//Scheduling//EN',
      `METHOD:${method}`,
      'BEGIN:VEVENT',
      `UID:${appointment.uid}`,
      `SEQUENCE:${appointment.ics_sequence || 0}`,
      `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
      `DTSTART:${toIcsDate(appointment.start)}`,
      `DTEND:${toIcsDate(appointment.end)}`,
      `SUMMARY:${appointment.title}`,
      `ORGANIZER:mailto:${organizerEmail}`,
      `ATTENDEE:mailto:${attendeeEmail}`,
      `STATUS:${status}`,
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n');
  }

  /**
   * Send (or resend, on reschedule) a calendar invite for an appointment to
   * one recipient. Call once per recipient (attendee, owner) since nodemailer
   * only supports a single icalEvent per message.
   */
  async sendCalendarInvite(appointment, toEmail, bodyText) {
    const transporter = this.getTransporter();
    const fromName = this.config.aigentik_name || 'Aigentik';
    try {
      await transporter.sendMail({
        from: `${fromName} <${this.senderAddress()}>`,
        to: toEmail,
        subject: appointment.title,
        text: bodyText || `You're booked: ${appointment.title} at ${new Date(appointment.start).toLocaleString()}.`,
        icalEvent: {
          filename: 'invite.ics',
          method: 'REQUEST',
          content: this.buildIcs(appointment, 'REQUEST')
        }
      });
      this.logger.action('email-provider', `Calendar invite sent to ${toEmail}`, { appointmentId: appointment.id });
      return true;
    } catch (error) {
      this.logger.error('email-provider', `Failed to send calendar invite to ${toEmail}`, { error: error.message });
      return false;
    }
  }

  /**
   * Send a cancellation for an appointment to one recipient — matches the
   * original UID so calendar apps remove the event automatically.
   */
  async sendCalendarCancellation(appointment, toEmail, bodyText) {
    const transporter = this.getTransporter();
    const fromName = this.config.aigentik_name || 'Aigentik';
    try {
      await transporter.sendMail({
        from: `${fromName} <${this.senderAddress()}>`,
        to: toEmail,
        subject: `Cancelled: ${appointment.title}`,
        text: bodyText || `This appointment has been cancelled: ${appointment.title} (was ${new Date(appointment.start).toLocaleString()}).`,
        icalEvent: {
          filename: 'cancel.ics',
          method: 'CANCEL',
          content: this.buildIcs(appointment, 'CANCEL')
        }
      });
      this.logger.action('email-provider', `Calendar cancellation sent to ${toEmail}`, { appointmentId: appointment.id });
      return true;
    } catch (error) {
      this.logger.error('email-provider', `Failed to send calendar cancellation to ${toEmail}`, { error: error.message });
      return false;
    }
  }

  /**
   * Graceful disconnect
   */
  async disconnect() {
    this.logger.info('email-provider', 'Disconnecting...');
    this.isShuttingDown = true;

    // Close main connection
    if (this.imapClient) {
      try {
        await this.imapClient.logout();
      } catch (e) {
        this.logger.warn('email-provider', 'Error closing main IMAP connection', { error: e.message });
      }
      this.imapClient = null;
    }

    // Close management pool connections
    for (const client of this.managementPool) {
      try {
        await client.logout();
      } catch (e) {
        // Ignore
      }
    }
    this.managementPool = [];

    // Close SMTP transporter
    if (this.smtpTransporter) {
      this.smtpTransporter.close();
      this.smtpTransporter = null;
    }

    this.isConnected = false;
    this.logger.info('email-provider', 'Disconnected successfully');
  }

  /**
   * Utility: sleep for specified milliseconds
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
let emailProviderInstance = null;

export function getEmailProvider(options) {
  if (!emailProviderInstance) {
    emailProviderInstance = new EmailProvider(options);
  }
  return emailProviderInstance;
}

export { EmailProvider };
export default EmailProvider;