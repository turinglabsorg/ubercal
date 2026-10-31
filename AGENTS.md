# ubercal: instructions for agents

ubercal merges Google calendars and `.ics` links into share links (live ICS feeds), each showing every calendar as `full`, `busy` or `off`. Read `README.md` for how it works and `DESIGN.md` before touching anything a person sees.

## Rules

- **Stack.** Node 22 ESM, no framework, no build. Two dependencies: MongoDB through the official driver, and ical.js to expand series for the calendar view and to cut series to a link's dates. Never SQLite. Add a dependency only when the platform cannot do the job, through `mcaifee`, pinned exactly.
- **One text, two uses.** The calendar tab (`GET /api/calendar?from&to[&link]`) expands the same text `renderFeed` serves to calendar apps (with `annotate` adding the source of each event), so the owner sees exactly what a link shows. Keep it that way: never compute the view from a second path.
- **A link's dates** (`from`, `until`, each an instant or null) are applied in `src/window.js`: a series is cut (new start at its first occurrence inside, UNTIL or a smaller COUNT at the end), not just kept. Links made before dates existed fall back to their old `pastDays`.
- **Tests.** `node:test` against a real MongoDB (`UBERCAL_TEST_MONGO_URL`, default `mongodb://127.0.0.1:27999`) with the fakes in `test/helpers.js`. Every behaviour change gets an integration test in `test/app.test.js`; pure functions get unit tests in `test/units.test.js`. Run the whole suite before committing.
- **Login.** Google sign-in is the shared Fluxkit one: the `fluxkit_session` cookie on `fluxkit.dev`, signed with `FLUXKIT_SESSION_KEY`, holding the Google `sub`, email, name and picture. Do not add a password, another provider or a per-tool OAuth brand. A session made by another Fluxkit tool signs the person in here.
- **Google requests** never set `include_granted_scopes`: the Google project is shared with other Fluxkit tools (milo holds Gmail grants), and incremental grants would fold their scopes into ubercal's tokens and make Google refuse accounts that granted them. Ask only for the scopes of the step at hand.
- **Legal pages** live on fluxkit.dev (`/privacy/`, `/terms/`, repository meaningtech/fluxkit). When ubercal starts keeping or using data in a new way, update them there first.
- **Google data** follows Google's Limited Use rules: read-only scope, used only to build the person's share links, never for anything else, never logged. Errors and logs carry ids and reasons, never event text, tokens or links.
- **Bookings** (`src/booking.js`, `/book/<token>/{info,slots,reserve}`): slots come from the same merged calendar as everything else plus `appointments`; a reservation is checked again inside `oneAtATime` (one booking at a time per owner), held as `pending`, written to Google with `calendar.events.owned` (never a wider scope), then confirmed; a Google failure removes the hold. Test guests are `robin+<tag>@ambox.dev`, never a real person.
- **Pasted links** go through `src/net.js` only (`fetchCalendar`): public addresses, usual web ports, redirects checked, size and time limits. Never fetch a user-supplied URL another way.
- **Secrets** come from hush by name (`bin/run.sh`): `FLUXKIT_SESSION_KEY`, `UBERCAL_DATA_KEY`, `UBERCAL_MONGO_PASSWORD`, `FLUXKIT_GOOGLE_CLIENT_SECRET`, `FLUXKIT_RESEND_API_KEY` (optional: no key, no booking emails). Never write a value anywhere.
- **Booking emails** (`src/mail.js`): the guest's confirmation and the owner's notice after a booking, reminders the day and the hour before from the five-minute pass, each claimed in Mongo before sending. User text is always escaped in HTML. Test guests are `robin+<tag>@ambox.dev`.
- **Pages** keep a strict CSP (`script-src 'self'`, `style-src 'self'`): no inline scripts or `style` attributes; set calendar colors through CSSOM. Build DOM with `textContent`, never with HTML strings from data.
- **Words.** English in code, docs, commits and the product.
