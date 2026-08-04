> [← Back to README](../README.md) · [All documentation](README.md)

# Testing

```bash
npm test
```

Runs the Jest suite (`tests/email-provider.test.js`, `tests/gmail-compat.test.js`, `tests/calendar.test.js`) covering the IMAP connection lifecycle, the new-mail trigger and concurrency guard, message parsing, spam-by-predicate and spam-by-UID, `.ics` invite/cancellation building, natural-language working-hours/date-phrase parsing, and the full `gmail.js` public API surface. File-backed calendar/contact operations (slot-finding, booking) aren't run under Jest — they read `paths.data_dir` from the real `config.json`, so exercising them via the test suite would write into your live `data/` directory; they're covered by manual sandbox testing instead, the same gap `contacts.js`/`queue.js` already have. `npm test` also collects coverage; a plain non-coverage run is available as:

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.mjs
```

To run a single test by name:

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --config jest.config.mjs -t "test name"
```

`node --check <file>.js` syntax-checks a single file — there's no bundler or linter configured in this repo.

---

[← Back to README](../README.md) · [All documentation](README.md)
