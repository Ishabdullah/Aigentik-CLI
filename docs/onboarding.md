> [← Back to README](../README.md) · [All documentation](README.md)

# First-run onboarding & business identity

## Table of Contents

- [First-run onboarding](#first-run-onboarding)
- [Business identity and persona](#business-identity-and-persona)

## First-run onboarding

`data/profile.json` isn't checked into git, so a brand-new install starts with no owner name and no business info — only Aigentik's own name (`Aigentik`) is set by default. On every startup, `index.js`'s `sendOnboardingEmail()` checks whether `owner_name` and/or `business_name` are still unset; if so, and it hasn't already sent this request (`profile.json`'s `onboarding_sent` flag), it emails `admin_email` asking for whichever is missing:

> 👋 Hi! I'm Aigentik, your new AI assistant.
>
> Before I start replying to emails and texts on your behalf, I need a couple things:
>
> - Your name, so I know what to call you
> - Your business name
> - A short description of what your business does
>
> Just reply to this email in your own words, filling in the blanks...

Reply to that email in plain language — e.g. *"My name is Sarah. The business is Acme Restoration, a home improvement company specializing in water damage restoration."* The reply is picked up by the normal admin-email path (see [Who Aigentik listens to as "the owner"](architecture.md#who-aigentik-listens-to-as-the-owner)) and interpreted by the same natural-language command pipeline as everything else: `interpretCommand` (in `llama.js`) recognizes it as `set_business_info` (optionally carrying `owner_name` alongside it if you introduce yourself in the same message) or `set_owner_name` if you only give your name. Both get written to `profile.json` and applied immediately — no restart needed.

The onboarding email is sent once per install, not on every restart (so a crash-loop doesn't spam the admin inbox), but the admin can answer it — or set/change either field later with an ordinary command — at any time; see [set_business_info in the owner command reference](commands.md#natural-language-commands). Your Android contacts are synced on every startup regardless of onboarding state (see [The contact directory](contacts.md)), so a fresh install picks up your real contacts immediately even before you've answered the onboarding email.

## Business identity and persona

By default Aigentik is a generic personal assistant, replying "on behalf of [owner]" with no company affiliation. Once `business_name` is set (via onboarding or the `set_business_info` command — see [Owner command reference](commands.md)), it takes on that business's persona instead:

- **Email and SMS replies** (`generateEmailReply`/`generateSmsReply` in `llama.js`) get an extra system-prompt clause — built by `businessContext()` — telling the model it works as the secretary/personal assistant for that business, optionally with a description of what the business does, so replies and any Q&A about "what do you do" answer in character.
- **The intake acknowledgment** (`generateAcknowledgment`, used when opening the combined intake form for a fresh appointment request) gets the same business context instead of a hardcoded "home services business" assumption.
- **Reply signatures switch too.** With no business set, replies sign off "`<Agent>` | Personal Agent of `<Owner>`" and mention reaching the owner by name for anything urgent. Once a business is set, they sign "`<Agent>` | `<Business>`" instead and drop the owner's personal name from the customer-facing signature entirely — anything urgent gets a generic "reply and we'll get back to you" instead.

Check what's currently set anytime with `business info` / `company info` / `who do you work for`. Restating just a business name preserves its last-set description; naming a *different* business without a description clears the old one rather than inheriting it.

Note: the appointment-negotiation templates (the closing reassurance line about "qualified technicians," the intake form wording — see [Appointment scheduling](scheduling.md)) are still hardcoded for a home-improvement-style business and don't adapt to `business_description` — they happen to fit a business like Acme Restoration, but a business in an unrelated trade would want to edit `closingReassurance()` and `sendIntakeForm()` in `index.js` directly.

---

[← Back to README](../README.md) · [All documentation](README.md)
