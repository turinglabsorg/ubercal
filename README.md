# ubercal

Every calendar, one link. ubercal merges Google calendars and any `.ics` / `webcal` link into **share links**: live ICS feeds that a calendar app subscribes to. Each share link decides, calendar by calendar, what it shows:

- **full**: the events with their details;
- **busy**: only when you are busy, with no title, place, people, notes or alarms;
- **off**: nothing.

ubercal reads every calendar again every five minutes (Google through its sync tokens, links through their ETags) and keeps each share link built and cached. When a calendar app asks for a link whose calendars were read over a minute ago, they are read again first, for at most a few seconds; past that the app gets the copy ready.

It is a [Fluxkit](https://fluxkit.dev) tool, live at **https://ubercal.fluxkit.dev**. Sign-in is the shared Fluxkit Google sign-in; the [privacy policy](https://fluxkit.dev/privacy/) and [terms](https://fluxkit.dev/terms/) live on fluxkit.dev.

## How it works

- **One process.** `src/main.js` serves the landing, the app (behind Google sign-in), its JSON API and the feeds, and runs the ten-minute pass. A lease in Mongo keeps two processes from running the pass at once.
- **MongoDB** holds people, Google connections, calendars, their events and the share links with their last built text. The driver is the only dependency.
- **Calendars are kept whole.** Events from a link are stored as their own VEVENT text, so repeat rules, alarms and vendor properties survive. Google events are written as VEVENTs with their series, moved occurrences (`RECURRENCE-ID`) and cancelled ones (`EXDATE`). Declined invitations and working-location markers are left out.
- **Time zones** come from the runtime's own tz database: every TZID a feed names gets a VTIMEZONE.
- **Merging.** An event two calendars share (an invitation seen from two accounts) appears once, from a calendar shown in full when there is one.
- **Safety.** Google refresh tokens and pasted links are sealed with AES-256-GCM. A pasted link may only reach public addresses: every address a name resolves to is checked when the connection opens, and on every redirect. Share links are 192-bit random addresses that can be replaced at any time.

## Run it

Node 22.13+ and a MongoDB.

```sh
npm install
UBERCAL_MONGO_URL=mongodb://127.0.0.1:27017/ubercal \
FLUXKIT_SESSION_KEY=… UBERCAL_DATA_KEY=… \
FLUXKIT_GOOGLE_CLIENT_ID=… FLUXKIT_GOOGLE_CLIENT_SECRET=… \
npm start
```

| Variable | |
| --- | --- |
| `PORT`, `UBERCAL_LISTEN_HOST` | Where it listens (default `127.0.0.1:4390`). |
| `UBERCAL_PUBLIC_URL` | The address people use; the Google redirect is `<url>/auth/google/callback`. |
| `UBERCAL_MONGO_URL`, `UBERCAL_MONGO_PASSWORD` | The database; the password is kept out of the URL. |
| `FLUXKIT_SESSION_KEY` | Signs the `fluxkit_session` cookie. Every Fluxkit tool that shares the login uses the same key. |
| `FLUXKIT_COOKIE_DOMAIN` | `fluxkit.dev` in production, so one sign-in serves every Fluxkit subdomain. |
| `UBERCAL_DATA_KEY` | Seals Google tokens and pasted links. Losing it means reconnecting every account. |
| `FLUXKIT_GOOGLE_CLIENT_ID`, `FLUXKIT_GOOGLE_CLIENT_SECRET` | The Fluxkit Google OAuth client (scopes `openid email profile`, and `calendar.readonly` when someone connects their calendars). Without them the site runs and Google is off. |
| `UBERCAL_SYNC_MINUTES` | The pass interval (default 5). |

`bin/run.sh` starts it with the secrets injected by [hush](https://github.com/turinglabsorg/hush), by name, and reads the other settings from `~/.ubercal/env`.

## Test

The tests run a real ubercal against a real MongoDB, a fake Google (OAuth, calendar list, events with sync tokens) and a fake calendar host.

```sh
docker run -d --rm --name ubercal-test-mongo -p 127.0.0.1:27999:27017 mongo:8
npm test
```

`UBERCAL_TEST_MONGO_URL` points them elsewhere. Each test file works in its own database and drops it.

## License

MIT
