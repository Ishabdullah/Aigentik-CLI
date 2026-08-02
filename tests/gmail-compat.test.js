// tests/gmail-compat.test.js — Tests for gmail.js compatibility wrapper

describe('gmail.js compatibility wrapper', () => {
  it('should have all required exports', async () => {
    const gmail = await import('../gmail.js');
    
    // Test all named exports exist
    expect(typeof gmail.connect).toBe('function');
    expect(typeof gmail.disconnect).toBe('function');
    expect(typeof gmail.sendReply).toBe('function');
    expect(typeof gmail.sendEmail).toBe('function');
    expect(typeof gmail.sendOwnerNotification).toBe('function');
    expect(typeof gmail.sendCalendarInvite).toBe('function');
    expect(typeof gmail.sendCalendarCancellation).toBe('function');
    expect(typeof gmail.deleteEmails).toBe('function');
    expect(typeof gmail.archiveEmails).toBe('function');
    expect(typeof gmail.markAsSpam).toBe('function');
    expect(typeof gmail.spamMatchingEmails).toBe('function');
    expect(typeof gmail.spamByUid).toBe('function');
    expect(typeof gmail.markAsRead).toBe('function');
    expect(typeof gmail.markAsUnread).toBe('function');
    expect(typeof gmail.labelEmails).toBe('function');
    expect(typeof gmail.markAllAsSeen).toBe('function');
    expect(typeof gmail.isGoogleVoiceText).toBe('function');
    expect(typeof gmail.isCalendarResponse).toBe('function');
    expect(typeof gmail.parseCalendarResponse).toBe('function');
    expect(typeof gmail.parseGoogleVoiceEmail).toBe('function');
    expect(typeof gmail.replyToGoogleVoiceText).toBe('function');
    
    // Test default export
    const defaultExport = gmail.default;
    expect(defaultExport.connect).toBeDefined();
    expect(defaultExport.disconnect).toBeDefined();
    expect(defaultExport.sendReply).toBeDefined();
    expect(defaultExport.sendEmail).toBeDefined();
    expect(defaultExport.sendOwnerNotification).toBeDefined();
    expect(defaultExport.sendCalendarInvite).toBeDefined();
    expect(defaultExport.sendCalendarCancellation).toBeDefined();
    expect(defaultExport.deleteEmails).toBeDefined();
    expect(defaultExport.archiveEmails).toBeDefined();
    expect(defaultExport.markAsSpam).toBeDefined();
    expect(defaultExport.spamMatchingEmails).toBeDefined();
    expect(defaultExport.spamByUid).toBeDefined();
    expect(defaultExport.markAsRead).toBeDefined();
    expect(defaultExport.markAsUnread).toBeDefined();
    expect(defaultExport.labelEmails).toBeDefined();
    expect(defaultExport.markAllAsSeen).toBeDefined();
    expect(defaultExport.isGoogleVoiceText).toBeDefined();
    expect(defaultExport.isCalendarResponse).toBeDefined();
    expect(defaultExport.parseCalendarResponse).toBeDefined();
    expect(defaultExport.parseGoogleVoiceEmail).toBeDefined();
    expect(defaultExport.replyToGoogleVoiceText).toBeDefined();
  });
});
