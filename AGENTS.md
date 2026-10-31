# ubercal: instructions for agents

ubercal merges Google calendars and `.ics` links into share links (live ICS feeds), each showing every calendar as `full`, `busy` or `off`. Read `README.md` for how it works and `DESIGN.md` before touching anything a person sees.

## Rules

- **Stack.** Node 22 ESM, no framework, no build. MongoDB through the official driver, which is the only dependency. Never SQLite. Add a dependency only when the platform cannot do the job, through `mcaifee`, pinned exactly.
- **Tests.** `node:test` against a real MongoDB (`UBERCAL_TEST_MONGO_URL`, default `mongodb://127.0.0.1:27999`) with the fakes in `test/helpers.js`. Every behaviour change gets an integration test in `test/app.test.js`; pure functions get unit tests in `test/units.test.js`. Run the whole suite before committing.
- **Login.** Google sign-in is the shared Fluxkit one: the `fluxkit_session` cookie on `fluxkit.dev`, signed with `FLUXKIT_SESSION_KEY`, holding the Google `sub`, email, name and picture. Do not add a password, another provider or a per-tool OAuth brand. A session made by another Fluxkit tool signs the person in here.
- **Legal pages** live on fluxkit.dev (`/privacy/`, `/terms/`, repository meaningtech/fluxkit). When ubercal starts keeping or using data in a new way, update them there first.
- **Google data** follows Google's Limited Use rules: read-only scope, used only to build the person's share links, never for anything else, never logged. Errors and logs carry ids and reasons, never event text, tokens or links.
- **Pasted links** go through `src/net.js` only (`fetchCalendar`): public addresses, usual web ports, redirects checked, size and time limits. Never fetch a user-supplied URL another way.
- **Secrets** come from hush by name (`bin/run.sh`): `FLUXKIT_SESSION_KEY`, `UBERCAL_DATA_KEY`, `UBERCAL_MONGO_PASSWORD`, `FLUXKIT_GOOGLE_CLIENT_SECRET`. Never write a value anywhere.
- **Pages** keep a strict CSP (`script-src 'self'`, `style-src 'self'`): no inline scripts or `style` attributes; set calendar colors through CSSOM. Build DOM with `textContent`, never with HTML strings from data.
- **Words.** English in code, docs, commits and the product.
