import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Syncer } from "../src/sync.js";
import { api, connectCalendars, fakeGoogle, fakeHost, foreignSession, ics, request, signIn, startApp } from "./helpers.js";

const ADA = { sub: "100000000000000000001", email: "ada@example.com", name: "Ada" };
const BOB = { sub: "100000000000000000002", email: "bob@example.com", name: "Bob" };

const vevent = (...lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
const ROTA = vevent("UID:rota-1@team", "DTSTAMP:20261001T000000Z", "DTSTART;TZID=Europe/Rome:20261102T090000", "DTEND;TZID=Europe/Rome:20261102T100000", "SUMMARY:Support rota", "RRULE:FREQ=WEEKLY");
const ROME = ["BEGIN:VTIMEZONE", "TZID:Europe/Rome", "BEGIN:STANDARD", "DTSTART:19701025T030000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU", "TZOFFSETFROM:+0200", "TZOFFSETTO:+0100", "END:STANDARD", "END:VTIMEZONE"].join("\r\n");

async function feedText(running, feed, headers = {}) {
  const response = await request(running.base, new URL(feed.url).pathname, { headers });
  return { response, text: response.status === 200 ? await response.text() : "" };
}

describe("the site and sign-in", () => {
  test("anyone sees the landing; the app and its API need a Google sign-in", async (t) => {
    const google = await fakeGoogle();
    t.after(google.close);
    const running = await startApp(t, { google });
    const landing = await request(running.base, "/");
    assert.equal(landing.status, 200);
    assert.match(landing.headers.get("content-security-policy"), /default-src 'self'/);
    assert.match(await landing.text(), /href="\/static\/site\.css\?v=[a-z0-9]+"/);
    const style = await request(running.base, "/static/site.css");
    assert.equal(style.headers.get("cache-control"), "no-cache");
    assert.equal((await request(running.base, "/static/site.css", { headers: { "If-None-Match": style.headers.get("etag") } })).status, 304);
    const app = await request(running.base, "/app");
    assert.equal(app.status, 302);
    assert.equal(app.headers.get("location"), "/auth/google?next=/app");
    assert.equal((await api(running, "", "GET", "/me")).status, 401);
    const start = await request(running.base, "/auth/google");
    const authorize = new URL(start.headers.get("location"));
    assert.equal(authorize.searchParams.get("scope"), "openid email profile");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorize.searchParams.get("redirect_uri"), `${running.origin}/auth/google/callback`);
  });

  test("signing in makes an account with one feed of every calendar", async (t) => {
    const google = await fakeGoogle();
    t.after(google.close);
    const running = await startApp(t, { google });
    const cookie = await signIn(running, google, ADA);
    const { data } = await api(running, cookie, "GET", "/me");
    assert.equal(data.user.email, ADA.email);
    assert.equal(data.feeds.length, 1);
    assert.equal(data.feeds[0].name, "All my calendars");
    assert.equal(data.feeds[0].others, "full");
    assert.equal((await request(running.base, "/app", { cookie })).status, 200);
    assert.deepEqual(await (await request(running.base, "/auth/session", { cookie })).json(), { signedIn: true });
    assert.deepEqual(await (await request(running.base, "/auth/session")).json(), { signedIn: false });
  });

  test("the session is the Fluxkit one: shared across fluxkit.dev, and a session from another Fluxkit tool signs in here", async (t) => {
    const google = await fakeGoogle();
    t.after(google.close);
    const running = await startApp(t, { google, publicHost: "ubercal.fluxkit.test", cookieDomain: "fluxkit.test" });
    const start = await request(running.base, "/auth/google");
    const flow = start.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const back = await request(running.base, `/auth/google/callback?code=${google.code(ADA)}&state=${state}`, { cookie: flow });
    assert.ok(back.headers.getSetCookie().some((line) => line.startsWith("fluxkit_session=") && /Domain=fluxkit\.test/.test(line)));
    const { status, data } = await api(running, foreignSession(BOB), "GET", "/me");
    assert.equal(status, 200);
    assert.equal(data.user.email, BOB.email);
  });

  test("a forged or foreign-origin request is refused", async (t) => {
    const google = await fakeGoogle();
    t.after(google.close);
    const running = await startApp(t, { google });
    const cookie = await signIn(running, google, ADA);
    const forged = cookie.replace(/.$/, (char) => (char === "A" ? "B" : "A"));
    assert.equal((await api(running, forged, "GET", "/me")).status, 401);
    const response = await request(running.base, "/api/feeds", { method: "POST", cookie, body: { name: "x" }, origin: "https://evil.example" });
    assert.equal(response.status, 403);
    const wrongState = await request(running.base, `/auth/google/callback?code=${google.code(ADA)}&state=nope`);
    assert.match(wrongState.headers.get("location"), /problem=/);
  });
});

describe("calendar links", () => {
  test("a link is read, merged with its time zones, and served with an ETag", async (t) => {
    const google = await fakeGoogle();
    const host = await fakeHost();
    t.after(google.close);
    t.after(host.close);
    const running = await startApp(t, { google });
    const cookie = await signIn(running, google, ADA);
    const url = host.serve("/team.ics", ics(ROME, ROTA));
    const added = await api(running, cookie, "POST", "/sources", { kind: "link", url });
    assert.equal(added.status, 201);
    assert.equal(added.data.source.name, "Team rota");
    assert.equal(added.data.source.status, "ok");
    assert.equal(added.data.source.eventCount, 1);
    const feed = added.data.state.feeds[0];
    const { response, text } = await feedText(running, feed);
    assert.equal(response.headers.get("content-type"), "text/calendar; charset=utf-8");
    assert.match(text, /^BEGIN:VCALENDAR\r\n/);
    assert.match(text, /X-WR-CALNAME:All my calendars/);
    assert.match(text, /REFRESH-INTERVAL;VALUE=DURATION:PT10M/);
    assert.match(text, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Rome/);
    assert.match(text, /SUMMARY:Support rota/);
    const again = await request(running.base, new URL(feed.url).pathname, { headers: { "If-None-Match": response.headers.get("etag") } });
    assert.equal(again.status, 304);
  });

  test("the ten-minute pass reads a changed link, and an unchanged one costs a 304", async (t) => {
    const google = await fakeGoogle();
    const host = await fakeHost();
    t.after(google.close);
    t.after(host.close);
    const running = await startApp(t, { google });
    const cookie = await signIn(running, google, ADA);
    const url = host.serve("/team.ics", ics(ROTA));
    const { data } = await api(running, cookie, "POST", "/sources", { kind: "link", url, name: "Rota" });
    const feed = data.state.feeds[0];
    host.serve("/team.ics", ics(ROTA, vevent("UID:offsite@team", "DTSTART;VALUE=DATE:20261120", "SUMMARY:Offsite")));
    running.clock.now += 10 * 60000;
    assert.equal(await running.app.syncer.runOnce(), true);
    assert.match((await feedText(running, feed)).text, /SUMMARY:Offsite/);
    running.clock.now += 10 * 60000;
    await running.app.syncer.runOnce();
    assert.equal(host.hits.at(-1), "/team.ics 304");
  });

  test("a link that is not a calendar, is gone, or points inside our network is not kept", async (t) => {
    const google = await fakeGoogle();
    const host = await fakeHost();
    t.after(google.close);
    t.after(host.close);
    const running = await startApp(t, { google });
    const cookie = await signIn(running, google, ADA);
    host.serve("/page.html", "<html>hello</html>");
    assert.match((await api(running, cookie, "POST", "/sources", { kind: "link", url: `${host.base}/page.html` })).data.error, /not lead to a calendar/);
    assert.match((await api(running, cookie, "POST", "/sources", { kind: "link", url: `${host.base}/missing.ics` })).data.error, /Nothing is at this link/);
    const strict = await startApp(t, { google, allowPrivate: false });
    const strictCookie = await signIn(strict, google, ADA);
    const refused = await api(strict, strictCookie, "POST", "/sources", { kind: "link", url: host.serve("/team.ics", ics(ROTA)).replace(/:\d+/, "") });
    assert.equal(refused.status, 400);
    assert.match(refused.data.error, /private address/);
    assert.equal((await api(running, cookie, "GET", "/me")).data.sources.length, 0);
  });
});

describe("Google calendars", () => {
  async function setup(t) {
    const google = await fakeGoogle();
    t.after(google.close);
    const running = await startApp(t, { google });
    google.state.calendars[ADA.sub] = [{ id: "ada@example.com", summary: "Ada", primary: true, timeZone: "Europe/Rome", accessRole: "owner", backgroundColor: "#f2a93b" }];
    const zone = "Europe/Rome";
    google.put("ada@example.com", { id: "standup", iCalUID: "standup@google.com", status: "confirmed", summary: "Standup", start: { dateTime: "2026-11-02T09:30:00+01:00", timeZone: zone }, end: { dateTime: "2026-11-02T09:45:00+01:00", timeZone: zone }, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"] });
    google.put("ada@example.com", { id: "standup_20261109", iCalUID: "standup@google.com", recurringEventId: "standup", status: "confirmed", summary: "Standup (moved)", start: { dateTime: "2026-11-09T11:00:00+01:00" }, end: { dateTime: "2026-11-09T11:15:00+01:00" }, originalStartTime: { dateTime: "2026-11-09T09:30:00+01:00", timeZone: zone } });
    google.put("ada@example.com", { id: "standup_20261116", recurringEventId: "standup", status: "cancelled", originalStartTime: { dateTime: "2026-11-16T09:30:00+01:00", timeZone: zone } });
    google.put("ada@example.com", { id: "dentist", iCalUID: "dentist@google.com", status: "confirmed", summary: "Dentist", location: "Via Roma 1", start: { dateTime: "2026-11-03T15:00:00Z" }, end: { dateTime: "2026-11-03T16:00:00Z" } });
    google.put("ada@example.com", { id: "lunch", iCalUID: "lunch@google.com", status: "confirmed", summary: "Lunch with Bob", start: { dateTime: "2026-11-04T12:00:00Z" }, end: { dateTime: "2026-11-04T13:00:00Z" }, attendees: [{ email: ADA.email, self: true, responseStatus: "declined" }] });
    google.put("ada@example.com", { id: "free", iCalUID: "free@google.com", status: "confirmed", transparency: "transparent", summary: "Maybe gym", start: { dateTime: "2026-11-05T18:00:00Z" }, end: { dateTime: "2026-11-05T19:00:00Z" } });
    google.state.pageSize = 2;
    const cookie = await signIn(running, google, ADA);
    const { response, authorize } = await connectCalendars(running, google, cookie, ADA);
    assert.equal(authorize.searchParams.get("access_type"), "offline");
    assert.match(authorize.searchParams.get("scope"), /calendar\.readonly/);
    assert.match(response.headers.get("location"), /^\/app\?connected=/);
    const me = (await api(running, cookie, "GET", "/me")).data;
    return { google, running, cookie, connection: me.connections[0], feed: me.feeds[0] };
  }

  test("a connected account lists its calendars, and an added one is merged whole: series, moved and cancelled occurrences", async (t) => {
    const { running, cookie, connection, feed } = await setup(t);
    assert.equal(connection.email, ADA.email);
    const listed = await api(running, cookie, "GET", `/connections/${connection.id}/calendars`);
    assert.deepEqual(listed.data.calendars.map((calendar) => [calendar.id, calendar.sourceId]), [["ada@example.com", null]]);
    const added = await api(running, cookie, "POST", "/sources", { kind: "google", connectionId: connection.id, calendarId: "ada@example.com" });
    assert.equal(added.status, 201);
    assert.equal(added.data.source.status, "ok");
    const { text } = await feedText(running, feed);
    assert.match(text, /DTSTART;TZID=Europe\/Rome:20261102T093000\r\nDTEND;TZID=Europe\/Rome:20261102T094500\r\nRRULE:FREQ=WEEKLY;BYDAY=MO/);
    assert.match(text, /EXDATE;TZID=Europe\/Rome:20261116T093000/);
    assert.match(text, /RECURRENCE-ID;TZID=Europe\/Rome:20261109T093000/);
    assert.match(text, /BEGIN:VTIMEZONE\r\nTZID:Europe\/Rome/);
    assert.match(text, /SUMMARY:Dentist/);
    assert.doesNotMatch(text, /Lunch with Bob/);
  });

  test("the pass after brings only Google's changes, and starts over when Google asks", async (t) => {
    const { google, running, cookie, connection, feed } = await setup(t);
    await api(running, cookie, "POST", "/sources", { kind: "google", connectionId: connection.id, calendarId: "ada@example.com" });
    google.put("ada@example.com", { id: "dentist", status: "cancelled" });
    google.put("ada@example.com", { id: "review", iCalUID: "review@google.com", status: "confirmed", summary: "Design review", start: { dateTime: "2026-11-06T10:00:00Z" }, end: { dateTime: "2026-11-06T11:00:00Z" } });
    running.clock.now += 10 * 60000;
    await running.app.syncer.runOnce();
    let { text } = await feedText(running, feed);
    assert.doesNotMatch(text, /Dentist/);
    assert.match(text, /Design review/);
    const source = await running.app.db.sources.findOne({});
    google.state.gone.add(source.syncToken);
    google.put("ada@example.com", { id: "retro", iCalUID: "retro@google.com", status: "confirmed", summary: "Retro", start: { dateTime: "2026-11-07T10:00:00Z" }, end: { dateTime: "2026-11-07T11:00:00Z" } });
    running.clock.now += 10 * 60000;
    await running.app.syncer.runOnce();
    ({ text } = await feedText(running, feed));
    assert.match(text, /Retro/);
    assert.match(text, /Design review/);
    assert.equal((await running.app.db.sources.findOne({})).status, "ok");
  });

  test("when Google takes the access back, the calendar says so and keeps what it had", async (t) => {
    const { google, running, cookie, connection, feed } = await setup(t);
    await api(running, cookie, "POST", "/sources", { kind: "google", connectionId: connection.id, calendarId: "ada@example.com" });
    google.state.refresh.clear();
    await running.app.db.connections.updateOne({}, { $set: { accessExpiresAt: new Date(0) } });
    running.clock.now += 10 * 60000;
    await running.app.syncer.runOnce();
    const me = (await api(running, cookie, "GET", "/me")).data;
    assert.equal(me.connections[0].status, "revoked");
    assert.equal(me.sources[0].status, "error");
    assert.match(me.sources[0].error, /connect it again/);
    assert.match((await feedText(running, feed)).text, /Standup/);
  });

  test("a consent without the calendar box ticked connects nothing", async (t) => {
    const google = await fakeGoogle();
    t.after(google.close);
    const running = await startApp(t, { google });
    const cookie = await signIn(running, google, ADA);
    const { response } = await connectCalendars(running, google, cookie, ADA, "openid email");
    assert.match(decodeURIComponent(response.headers.get("location")), /tick the calendar box/);
    assert.equal((await api(running, cookie, "GET", "/me")).data.connections.length, 0);
  });
});

describe("share links", () => {
  async function twoCalendars(t) {
    const google = await fakeGoogle();
    const host = await fakeHost();
    t.after(google.close);
    t.after(host.close);
    const running = await startApp(t, { google });
    const cookie = await signIn(running, google, ADA);
    const work = (await api(running, cookie, "POST", "/sources", { kind: "link", url: host.serve("/work.ics", ics(
      vevent("UID:board@work", "DTSTART:20261102T140000Z", "DTEND:20261102T150000Z", "SUMMARY:Board meeting", "DESCRIPTION:Budget", "LOCATION:Room 4", "ATTENDEE:mailto:ceo@work.example"),
      vevent("UID:shared@both", "DTSTART:20261103T080000Z", "DTEND:20261103T090000Z", "SUMMARY:Shared invite"),
      vevent("UID:old@work", "DTSTART:20260101T080000Z", "DTEND:20260101T090000Z", "SUMMARY:Ancient history"),
    )), name: "Work" })).data.source;
    const home = (await api(running, cookie, "POST", "/sources", { kind: "link", url: host.serve("/home.ics", ics(
      vevent("UID:doctor@home", "DTSTART:20261104T100000Z", "DTEND:20261104T110000Z", "SUMMARY:Doctor", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "END:VALARM"),
      vevent("UID:gym@home", "DTSTART:20261105T180000Z", "DTEND:20261105T190000Z", "SUMMARY:Gym maybe", "TRANSP:TRANSPARENT"),
      vevent("UID:shared@both", "DTSTART:20261103T080000Z", "DTEND:20261103T090000Z", "SUMMARY:Shared invite"),
    )), name: "Home" })).data.source;
    return { running, cookie, work, home, google };
  }

  test("one link can show a calendar in full, another only as busy time, and leave a third out", async (t) => {
    const { running, cookie, work, home } = await twoCalendars(t);
    const created = await api(running, cookie, "POST", "/feeds", { name: "For my team", calendars: { [work.id]: "full", [home.id]: "busy" }, others: "hidden" });
    assert.equal(created.status, 201);
    const feed = created.data.feeds.find((entry) => entry.name === "For my team");
    let { text } = await feedText(running, feed);
    assert.match(text, /SUMMARY:Board meeting/);
    assert.match(text, /LOCATION:Room 4/);
    assert.match(text, /UID:doctor@home[\s\S]*?SUMMARY:Busy/);
    assert.doesNotMatch(text, /Doctor|VALARM|Gym maybe/);
    assert.equal(text.match(/UID:shared@both/g).length, 1);
    await api(running, cookie, "PATCH", `/feeds/${feed.id}`, { calendars: { [work.id]: "hidden", [home.id]: "busy" } });
    ({ text } = await feedText(running, feed));
    assert.doesNotMatch(text, /Board meeting|Budget/);
    assert.match(text, /SUMMARY:Busy/);
    const all = created.data.feeds.find((entry) => entry.name === "All my calendars");
    assert.match((await feedText(running, all)).text, /SUMMARY:Doctor/);
  });

  test("a link goes back as far as asked, and a new link replaces the old one", async (t) => {
    const { running, cookie } = await twoCalendars(t);
    const feed = (await api(running, cookie, "GET", "/me")).data.feeds[0];
    assert.doesNotMatch((await feedText(running, feed)).text, /Ancient history/);
    await api(running, cookie, "PATCH", `/feeds/${feed.id}`, { pastDays: 0 });
    assert.match((await feedText(running, feed)).text, /Ancient history/);
    const rotated = (await api(running, cookie, "POST", `/feeds/${feed.id}/rotate`)).data.feeds[0];
    assert.notEqual(rotated.url, feed.url);
    assert.equal((await feedText(running, feed)).response.status, 404);
    assert.equal((await feedText(running, rotated)).response.status, 200);
  });

  test("nobody reaches another person's calendars or links", async (t) => {
    const { running, cookie, work, google } = await twoCalendars(t);
    const bob = await signIn(running, google, BOB);
    const ada = (await api(running, cookie, "GET", "/me")).data;
    assert.equal((await api(running, bob, "DELETE", `/sources/${work.id}`)).status, 404);
    assert.equal((await api(running, bob, "PATCH", `/feeds/${ada.feeds[0].id}`, { name: "mine" })).status, 404);
    assert.equal((await api(running, bob, "POST", "/feeds", { calendars: { [work.id]: "full" } })).status, 400);
    assert.equal((await api(running, cookie, "GET", "/me")).data.sources.length, 2);
  });

  test("deleting the account removes every calendar, event and link", async (t) => {
    const { running, cookie } = await twoCalendars(t);
    const feed = (await api(running, cookie, "GET", "/me")).data.feeds[0];
    assert.equal((await api(running, cookie, "DELETE", "/account")).status, 200);
    assert.equal(await running.app.db.events.countDocuments({}), 0);
    assert.equal(await running.app.db.sources.countDocuments({}), 0);
    assert.equal(await running.app.db.users.countDocuments({}), 0);
    assert.equal((await feedText(running, feed)).response.status, 404);
  });
});

test("without a Google client the site still runs, and sign-in says it is not open yet", async (t) => {
  const running = await startApp(t, {});
  assert.equal((await request(running.base, "/")).status, 200);
  const start = await request(running.base, "/auth/google");
  assert.equal(start.status, 302);
  assert.match(decodeURIComponent(start.headers.get("location")), /^\/\?problem=Google sign-in is not open yet/);
});

test("only one process runs the pass at a time", async (t) => {
  const running = await startApp(t, {});
  const second = new Syncer(running.app.context);
  assert.equal(await running.app.syncer.runOnce(), true);
  assert.equal(await second.runOnce(), false);
  running.clock.now += 10 * 60000;
  assert.equal(await second.runOnce(), true);
});
