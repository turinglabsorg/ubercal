# ubercal

Every calendar, one link. ubercal merges Google calendars and any `.ics` / `webcal` link into **share links**: live ICS feeds that a calendar app subscribes to. Each share link decides, calendar by calendar, what it shows:

- **full**: the events with their details;
- **busy**: only when you are busy, with no title, place, people, notes or alarms;
- **off**: nothing.

A share link also has its own dates: by default it shows what happens from the day it is made, with no end, and any start and end can be chosen, in the past or the future. A series is cut to those dates (it starts again at its first occurrence inside and ends with the link), so a calendar app never shows what the link leaves out.

**Booking pages** work like Calendly: the owner chooses the durations (15 minutes to 2 hours), the weekly hours (several ranges a day), the time zone, the notice, how far ahead people may book and the gap between meetings. The page offers the times that are free in the whole merged calendar (free events aside), in the guest's own time zone; a booking is checked again, held, and written into a Google calendar the owner owns, and Google sends the guest the invitation, with a Meet link if the owner wants one. Writing needs one more Google permission, `calendar.events.owned`, asked only when the owner turns bookings on. A booking page can take a short address of its own (`ubercal.fluxkit.dev/<name>`). The booking page and the guest's emails speak Italian, English, Spanish and French (the browser's language, or the flags). With a Resend key, the guest gets a confirmation that asks them to accept Google's invitation, and reminders the day and the hour before; ubercal follows the guest's answer to the invitation on every pass, shows it to the owner, frees the time and tells the owner when the guest declines. Without a key, Google's invitation is the only email.

The app has four tabs: **accounts** (the Google accounts and links merged), **calendar** (the merged calendar by week, month or agenda, or as any share link shows it), **share** (the links) and **book** (the booking pages and what is coming up).

ubercal reads every calendar again every five minutes (Google through its sync tokens, links through their ETags) and keeps each share link built and cached. When a calendar app asks for a link whose calendars were read over a minute ago, they are read again first, for at most a few seconds; past that the app gets the copy ready.

It is a [Fluxkit](https://fluxkit.dev) tool, live at **https://ubercal.fluxkit.dev**. Sign-in is the shared Fluxkit Google sign-in; the [privacy policy](https://fluxkit.dev/privacy/) and [terms](https://fluxkit.dev/terms/) live on fluxkit.dev.

## How it works

- **One process.** `src/main.js` serves the landing, the app (behind Google sign-in), its JSON API and the feeds, and runs the ten-minute pass. A lease in Mongo keeps two processes from running the pass at once.
- **MongoDB** holds people, Google connections, calendars, their events and the share links with their last built text. The driver is the only dependency.
- **Calendars are kept whole.** Events from a link are stored as their own VEVENT text, so repeat rules, alarms and vendor properties survive. Google events are written as VEVENTs with their series, moved occurrences (`RECURRENCE-ID`) and cancelled ones (`EXDATE`). Declined invitations and working-location markers are left out.
- **Time zones** come from the runtime's own tz database: every TZID a feed names gets a VTIMEZONE.
- **The calendar view** expands series with [ical.js](https://github.com/kewisch/ical.js) from the same text a share link serves, so what the owner sees is what the link shows.
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
| `FLUXKIT_RESEND_API_KEY`, `UBERCAL_MAIL_FROM` | Booking emails through Resend, from `ubercal <bookings@fluxkit.dev>` by default. Optional. |

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
