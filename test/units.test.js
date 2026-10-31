import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fold, parse, prop, serialize, unfold } from "../src/ics.js";
import { busyOnly, endsAt, identity } from "../src/events.js";
import { eventRecord, exdateLine } from "../src/google.js";
import { fetchCalendar, isPublicAddress, normalizeUrl } from "../src/net.js";
import { keyFrom, open, seal, signJson, verifyJson } from "../src/secrets.js";
import { instantOf, offsetAt, vtimezone, zonedToUtc } from "../src/tz.js";
import { clipEvent, feedWindow } from "../src/window.js";

const bytes = (text) => new TextEncoder().encode(text).length;

describe("ics", () => {
  test("long lines fold at 75 octets without splitting a character, and unfold back", () => {
    const line = `SUMMARY:${"Riunione già fissata — 会議 ".repeat(8)}`;
    const folded = fold(line);
    for (const piece of folded.split("\r\n")) assert.ok(bytes(piece) <= 75, piece);
    assert.deepEqual(unfold(folded), [line]);
  });

  test("a component keeps what ubercal does not read: alarms, vendor properties, quoted parameters", () => {
    const text = ["BEGIN:VEVENT", 'ATTENDEE;CN="Rossi; Mario":mailto:m@example.com', "X-APPLE-TRAVEL-ADVISORY-BEHAVIOR:AUTOMATIC", "UID:a@b", "DTSTART:20261101T090000Z", "BEGIN:VALARM", "ACTION:DISPLAY", "END:VALARM", "END:VEVENT"].join("\r\n");
    const event = parse(text).children[0];
    assert.equal(prop(event, "ATTENDEE").params.CN, "Rossi; Mario");
    assert.equal(serialize(event), text);
  });
});

describe("time zones", () => {
  test("Rome changes on the last Sundays of March and October", () => {
    const text = vtimezone("Europe/Rome", Date.UTC(2026, 9, 31));
    assert.match(text, /BEGIN:DAYLIGHT\r\nDTSTART:19700329T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nTZOFFSETFROM:\+0100\r\nTZOFFSETTO:\+0200/);
    assert.match(text, /BEGIN:STANDARD\r\nDTSTART:19701025T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nTZOFFSETFROM:\+0200\r\nTZOFFSETTO:\+0100/);
  });

  test("New York and Sydney follow their own rules; Tokyo has none", () => {
    assert.match(vtimezone("America/New_York"), /BYMONTH=3;BYDAY=2SU[\s\S]*TZOFFSETTO:-0400/);
    assert.match(vtimezone("America/New_York"), /BYMONTH=11;BYDAY=1SU[\s\S]*TZOFFSETTO:-0500/);
    assert.match(vtimezone("Australia/Sydney"), /BEGIN:DAYLIGHT\r\nDTSTART:\d{8}T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=1SU/);
    assert.match(vtimezone("Asia/Tokyo"), /BEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:\+0900\r\nTZOFFSETTO:\+0900/);
    assert.equal(vtimezone("Not/AZone"), "");
  });

  test("wall clock times become the right instant across a clock change", () => {
    assert.equal(zonedToUtc({ year: 2026, month: 7, day: 1, hour: 9, minute: 0, second: 0 }, "Europe/Rome"), Date.UTC(2026, 6, 1, 7));
    assert.equal(zonedToUtc({ year: 2026, month: 12, day: 1, hour: 9, minute: 0, second: 0 }, "Europe/Rome"), Date.UTC(2026, 11, 1, 8));
    assert.equal(offsetAt(Date.UTC(2026, 6, 1), "America/New_York"), -240);
    assert.equal(instantOf({ value: "20261101T090000", params: { TZID: "Europe/Rome" } }), Date.UTC(2026, 10, 1, 8));
  });
});

describe("events", () => {
  const event = (...lines) => parse(["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n")).children[0];

  test("an event stops mattering when its last occurrence ends", () => {
    assert.equal(endsAt(event("DTSTART:20261101T090000Z", "DTEND:20261101T100000Z")), Date.UTC(2026, 10, 1, 10));
    assert.equal(endsAt(event("DTSTART;VALUE=DATE:20261101")), Date.UTC(2026, 10, 2));
    assert.equal(endsAt(event("DTSTART:20261101T090000Z", "DURATION:PT1H30M")), Date.UTC(2026, 10, 1, 10, 30));
    assert.equal(endsAt(event("DTSTART;TZID=Europe/Rome:20260105T090000", "RRULE:FREQ=WEEKLY;UNTIL=20260301T000000Z")), Date.UTC(2026, 2, 2));
    assert.equal(endsAt(event("DTSTART:20260105T090000Z", "RRULE:FREQ=WEEKLY;COUNT=10")), null);
  });

  test("a changed occurrence is told apart from its series; an event with no UID gets a steady one", () => {
    assert.equal(identity(event("UID:x", "RECURRENCE-ID:20261102T090000Z")).key, `x#${Date.UTC(2026, 10, 2, 9)}`);
    const first = identity(event("DTSTART:20261101T090000Z", "SUMMARY:No uid"), "s1").uid;
    assert.equal(identity(event("DTSTART:20261101T090000Z", "SUMMARY:No uid"), "s1").uid, first);
  });

  test("busy time keeps when, and nothing about what or who", () => {
    const text = busyOnly(["BEGIN:VEVENT", "UID:x", "DTSTART:20261101T090000Z", "DTEND:20261101T100000Z", "SUMMARY:Doctor", "DESCRIPTION:Private", "LOCATION:Clinic", "ATTENDEE:mailto:a@b.c", "BEGIN:VALARM", "ACTION:DISPLAY", "END:VALARM", "END:VEVENT"].join("\r\n"));
    assert.match(text, /SUMMARY:Busy/);
    assert.match(text, /DTSTART:20261101T090000Z/);
    assert.doesNotMatch(text, /Doctor|Private|Clinic|ATTENDEE|VALARM/);
  });
});

describe("Google events as VEVENTs", () => {
  test("a weekly series keeps its zone, rule and conference link", () => {
    const record = eventRecord({
      id: "s1", iCalUID: "s1@google.com", status: "confirmed", summary: "Standup", hangoutLink: "https://meet.google.com/abc",
      start: { dateTime: "2026-11-02T09:30:00+01:00", timeZone: "Europe/Rome" }, end: { dateTime: "2026-11-02T09:45:00+01:00", timeZone: "Europe/Rome" },
      recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"],
    });
    assert.match(record.text, /DTSTART;TZID=Europe\/Rome:20261102T093000/);
    assert.match(record.text, /RRULE:FREQ=WEEKLY;BYDAY=MO/);
    assert.match(record.text, /Join: https:\/\/meet\.google\.com\/abc/);
    assert.equal(record.kind, "Europe/Rome");
    assert.equal(record.endsAt, null);
  });

  test("a moved occurrence names the one it replaces; a cancelled one becomes an EXDATE of its series", () => {
    const moved = eventRecord({ id: "s1_20261109", iCalUID: "s1@google.com", recurringEventId: "s1", status: "confirmed", start: { dateTime: "2026-11-09T11:00:00+01:00" }, end: { dateTime: "2026-11-09T11:15:00+01:00" }, originalStartTime: { dateTime: "2026-11-09T09:30:00+01:00", timeZone: "Europe/Rome" } });
    assert.match(moved.text, /RECURRENCE-ID;TZID=Europe\/Rome:20261109T093000/);
    assert.match(moved.text, /DTSTART:20261109T100000Z/);
    const cancelled = eventRecord({ id: "s1_20261116", recurringEventId: "s1", status: "cancelled", originalStartTime: { dateTime: "2026-11-16T09:30:00+01:00", timeZone: "Europe/Rome" } });
    assert.deepEqual(cancelled, { key: "s1_20261116", cancelledOf: "s1", original: { dateTime: "2026-11-16T09:30:00+01:00", timeZone: "Europe/Rome" } });
    assert.equal(exdateLine(cancelled.original, "Europe/Rome"), "EXDATE;TZID=Europe/Rome:20261116T093000");
    assert.equal(exdateLine({ date: "2026-11-16" }, "date"), "EXDATE;VALUE=DATE:20261116");
  });

  test("declined invitations and working-location markers are left out", () => {
    assert.deepEqual(eventRecord({ id: "d", status: "confirmed", start: { dateTime: "2026-11-02T09:30:00Z" }, end: { dateTime: "2026-11-02T10:00:00Z" }, attendees: [{ email: "me@x.y", self: true, responseStatus: "declined" }] }), { key: "d", remove: true });
    assert.deepEqual(eventRecord({ id: "w", status: "confirmed", eventType: "workingLocation", start: { date: "2026-11-02" }, end: { date: "2026-11-03" } }), { key: "w", remove: true });
  });

  test("an all-day event stays a date", () => {
    const record = eventRecord({ id: "a", status: "confirmed", summary: "Holiday", start: { date: "2026-12-24" }, end: { date: "2026-12-27" } });
    assert.match(record.text, /DTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261227/);
    assert.equal(record.endsAt, Date.UTC(2026, 11, 27));
  });
});

describe("links people paste", () => {
  test("webcal becomes https; other schemes, credentials and odd ports are refused", () => {
    assert.equal(normalizeUrl("webcal://example.com/a.ics").toString(), "https://example.com/a.ics");
    assert.throws(() => normalizeUrl("ftp://example.com/a.ics"));
    assert.throws(() => normalizeUrl("https://user:pw@example.com/a.ics"));
    assert.throws(() => normalizeUrl("https://example.com:6379/"));
  });

  test("private, loopback, tailnet and link-local addresses are not public", () => {
    for (const address of ["10.1.2.3", "127.0.0.1", "100.83.24.27", "169.254.169.254", "192.168.1.1", "::1", "fd7a:115c:a1e0::1", "::ffff:127.0.0.1"]) assert.equal(isPublicAddress(address), false, address);
    for (const address of ["8.8.8.8", "142.250.180.14", "2a00:1450:4002:800::200e"]) assert.equal(isPublicAddress(address), true, address);
  });

  test("a link to this machine is refused before any request", async () => {
    await assert.rejects(fetchCalendar("http://127.0.0.1/feed/x"), /private address/);
    await assert.rejects(fetchCalendar("http://localhost/x.ics"), /private address/);
    await assert.rejects(fetchCalendar("http://[::1]/x.ics"), /private address/);
  });
});

describe("secrets", () => {
  test("sealed values open only with their key; signed values expire", () => {
    const key = keyFrom("one key");
    const sealed = seal(key, "refresh-token");
    assert.equal(open(key, sealed), "refresh-token");
    assert.throws(() => open(keyFrom("another key"), sealed));
    const signed = signJson(key, { sub: "1", exp: 2000 });
    assert.deepEqual(verifyJson(key, signed, 1000), { sub: "1", exp: 2000 });
    assert.equal(verifyJson(key, signed, 3000), null);
    assert.equal(verifyJson(key, `${signed}x`, 1000), null);
  });
});

describe("a share link's dates", () => {
  const series = ["BEGIN:VEVENT", "UID:s@x", "DTSTART;TZID=Europe/Rome:20250106T093000", "DTEND;TZID=Europe/Rome:20250106T094500", "RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=100", "SUMMARY:Standup", "END:VEVENT"].join("\r\n");
  const zone = (tzid) => vtimezone(tzid);
  const window = { from: Date.UTC(2026, 10, 1), until: Date.UTC(2026, 11, 1) };

  test("a counted series keeps only the occurrences inside", () => {
    const text = clipEvent(series, window, zone);
    assert.match(text, /DTSTART;TZID=Europe\/Rome:20261102T093000/);
    assert.match(text, /RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=5/);
  });

  test("events and series wholly outside are left out; inside ones are untouched", () => {
    assert.equal(clipEvent(series.replace("COUNT=100", "COUNT=3"), window, zone), null);
    const single = ["BEGIN:VEVENT", "UID:a", "DTSTART:20261110T080000Z", "DTEND:20261110T090000Z", "END:VEVENT"].join("\r\n");
    assert.equal(clipEvent(single, window), single);
    assert.equal(clipEvent(single, { from: Date.UTC(2026, 10, 11), until: null }), null);
    assert.equal(clipEvent(single, { from: null, until: Date.UTC(2026, 10, 10) }), null);
  });

  test("links from before dates existed keep their past days", () => {
    assert.deepEqual(feedWindow({ pastDays: 30 }, Date.UTC(2026, 9, 31)), { from: Date.UTC(2026, 9, 1), until: null });
    assert.deepEqual(feedWindow({ from: null, until: null }), { from: null, until: null });
  });
});
