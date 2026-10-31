import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { cleanHours, DEFAULT_HOURS, freeSlots } from "../src/booking.js";
import { api, connectCalendars, fakeGoogle, fakeResend, request, signIn, startApp } from "./helpers.js";

const ADA = { sub: "100000000000000000001", email: "ada@example.com", name: "Ada" };
const READ_WRITE = "openid email https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events.owned";
const rome = (day, hour, minute = 0) => new Date(Date.UTC(2026, 10, day, hour - 1, minute)).toISOString();

describe("free slots", () => {
  const page = { timeZone: "Europe/Rome", hours: DEFAULT_HOURS, noticeMinutes: 60, daysAhead: 30, bufferMinutes: 0 };
  const now = Date.UTC(2026, 10, 2, 7, 0);
  const local = (slots) => slots.map((at) => new Date(at).toLocaleTimeString("en-GB", { timeZone: "Europe/Rome", hour: "2-digit", minute: "2-digit" }));

  test("inside the hours, after the notice, around what is busy", () => {
    const busy = [[Date.UTC(2026, 10, 2, 10), Date.UTC(2026, 10, 2, 11)]];
    const slots = freeSlots({ page, busy, now, from: now, to: Date.UTC(2026, 10, 3), duration: 60 });
    assert.deepEqual(local(slots), ["09:00", "09:30", "10:00", "12:00", "12:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00"]);
  });

  test("a buffer keeps room around meetings; weekends and closed days have nothing", () => {
    const busy = [[Date.UTC(2026, 10, 2, 10), Date.UTC(2026, 10, 2, 11)]];
    const buffered = freeSlots({ page: { ...page, bufferMinutes: 15 }, busy, now, from: now, to: Date.UTC(2026, 10, 3), duration: 30 });
    assert.ok(!local(buffered).includes("10:30") && !local(buffered).includes("12:00") && local(buffered).includes("12:30"));
    assert.deepEqual(freeSlots({ page, busy: [], now, from: Date.UTC(2026, 10, 7), to: Date.UTC(2026, 10, 9), duration: 30 }), []);
  });

  test("hours stay on the wall clock across a clock change, and stop at the days ahead", () => {
    const march = Date.UTC(2027, 2, 26, 12);
    const monday = freeSlots({ page, busy: [], now: march, from: Date.UTC(2027, 2, 29), to: Date.UTC(2027, 2, 30), duration: 30 });
    assert.equal(new Date(monday[0]).toISOString(), "2027-03-29T07:00:00.000Z");
    assert.deepEqual(freeSlots({ page: { ...page, daysAhead: 7 }, busy: [], now, from: Date.UTC(2026, 10, 20), to: Date.UTC(2026, 10, 21), duration: 30 }), []);
  });

  test("hours that overlap or end before they start are refused", () => {
    assert.equal(cleanHours({ 1: [["09:00", "12:00"], ["11:00", "13:00"]] }), null);
    assert.equal(cleanHours({ 1: [["12:00", "09:00"]] }), null);
    assert.deepEqual(cleanHours({ 2: [["14:00", "18:00"], ["09:00", "13:00"]], 3: [] }), { 2: [["09:00", "13:00"], ["14:00", "18:00"]] });
  });
});

describe("booking pages", () => {
  async function owner(t, { write = true, resend } = {}) {
    const google = await fakeGoogle();
    t.after(google.close);
    const running = await startApp(t, { google, resend });
    google.state.calendars[ADA.sub] = [{ id: "ada@example.com", summary: "Ada", primary: true, timeZone: "Europe/Rome", accessRole: "owner" }];
    google.put("ada@example.com", { id: "standup", iCalUID: "standup@google.com", status: "confirmed", summary: "Standup", start: { dateTime: "2026-11-02T09:30:00+01:00", timeZone: "Europe/Rome" }, end: { dateTime: "2026-11-02T10:00:00+01:00", timeZone: "Europe/Rome" }, recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO"] });
    google.put("ada@example.com", { id: "gym", iCalUID: "gym@google.com", status: "confirmed", transparency: "transparent", summary: "Maybe gym", start: { dateTime: "2026-11-02T13:00:00+01:00" }, end: { dateTime: "2026-11-02T14:00:00+01:00" } });
    const cookie = await signIn(running, google, ADA);
    const { response } = await connectCalendars(running, google, cookie, ADA, write ? READ_WRITE : undefined, write);
    const me = (await api(running, cookie, "GET", "/me")).data;
    await api(running, cookie, "POST", "/sources", { kind: "google", connectionId: me.connections[0].id, calendarId: "ada@example.com" });
    const page = (await api(running, cookie, "POST", "/pages", { timeZone: "Europe/Rome" })).data.pages[0];
    return { google, running, cookie, page, response, resend, token: new URL(page.url).pathname.split("/").pop() };
  }

  const slots = async (running, token, duration = 30, from = "2026-11-02T00:00:00Z", to = "2026-11-03T00:00:00Z") =>
    (await request(running.base, `/book/${token}/slots?duration=${duration}&from=${from}&to=${to}`)).json();
  const reserve = (running, token, body) => request(running.base, `/book/${token}/reserve`, { method: "POST", body, origin: running.origin });

  test("a page offers the owner's free hours, and a booking lands in Google with the invitation and a Meet link", async (t) => {
    const { google, running, cookie, page, response, token } = await owner(t);
    assert.match(response.headers.get("location"), /write=1#book$/);
    assert.equal(page.ready, true);
    assert.deepEqual(page.durations, [30]);
    const info = await (await request(running.base, `/book/${token}/info`)).json();
    assert.equal(info.ready, true);
    assert.equal(info.owner.name, "Ada");
    const offered = (await slots(running, token)).slots;
    assert.ok(offered.includes(rome(2, 9)), "09:00 is free");
    assert.ok(!offered.includes(rome(2, 9, 30)), "09:30 is the standup");
    assert.ok(offered.includes(rome(2, 13)), "a free event does not block");
    const booked = await reserve(running, token, { duration: 30, start: rome(2, 10), name: "Bob Rossi", email: "bob@example.com", notes: "About the launch" });
    assert.equal(booked.status, 201);
    assert.equal((await booked.json()).meet, "https://meet.google.com/abc-defg-hij");
    const [inserted] = google.state.inserted;
    assert.equal(inserted.calendarId, "ada@example.com");
    assert.equal(inserted.query.sendUpdates, "all");
    assert.equal(inserted.query.conferenceDataVersion, "1");
    assert.equal(inserted.event.start.dateTime, "2026-11-02T09:00:00.000Z");
    assert.equal(inserted.event.end.dateTime, "2026-11-02T09:30:00.000Z");
    assert.deepEqual(inserted.event.attendees[0], { email: "bob@example.com", displayName: "Bob Rossi" });
    assert.match(inserted.event.description, /About the launch/);
    assert.equal((await reserve(running, token, { duration: 30, start: rome(2, 10), name: "Eve", email: "eve@example.com" })).status, 409);
    assert.ok(!(await slots(running, token)).slots.includes(rome(2, 10)));
    const me = (await api(running, cookie, "GET", "/me")).data;
    assert.deepEqual(me.pages[0].upcoming.map((entry) => [entry.name, entry.email]), [["Bob Rossi", "bob@example.com"]]);
    running.clock.now = Date.UTC(2026, 11, 3);
    await running.app.syncer.runOnce();
    assert.equal(await running.app.db.appointments.countDocuments({}), 0, "guest data goes 30 days after the meeting");
  });

  test("a booking needs a real name, a working email and a time from the list", async (t) => {
    const { running, token } = await owner(t);
    assert.equal((await reserve(running, token, { duration: 30, start: rome(2, 10), name: "Bob", email: "not-an-email" })).status, 400);
    assert.equal((await reserve(running, token, { duration: 30, start: rome(2, 10), name: "", email: "bob@example.com" })).status, 400);
    assert.equal((await reserve(running, token, { duration: 45, start: rome(2, 10), name: "Bob", email: "bob@example.com" })).status, 400);
    assert.equal((await reserve(running, token, { duration: 30, start: rome(2, 10, 10), name: "Bob", email: "bob@example.com" })).status, 409);
    assert.equal((await reserve(running, token, { duration: 30, start: rome(7, 10), name: "Bob", email: "bob@example.com" })).status, 409);
    assert.equal((await request(running.base, `/book/${token}/reserve`, { method: "POST", body: { duration: 30, start: rome(2, 10), name: "Bob", email: "bob@example.com" }, origin: "https://evil.example" })).status, 403);
  });

  test("without leave to add events, a page is not open", async (t) => {
    const { running, page, token } = await owner(t, { write: false });
    assert.equal(page.ready, false);
    assert.equal((await (await request(running.base, `/book/${token}/info`)).json()).ready, false);
    assert.equal((await reserve(running, token, { duration: 30, start: rome(2, 10), name: "Bob", email: "bob@example.com" })).status, 409);
  });

  test("the owner shapes the page: durations, hours and limits are checked", async (t) => {
    const { running, cookie, page, token } = await owner(t);
    const changed = await api(running, cookie, "PATCH", `/pages/${page.id}`, { durations: [30, 60], hours: { 1: [["10:00", "12:00"]] }, noticeMinutes: 0, bufferMinutes: 15, name: "Intro call" });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.data.pages[0].durations, [30, 60]);
    assert.equal(changed.data.pages[0].name, "Intro call");
    // Monday 10-12 for an hour, fifteen minutes clear of the standup that ends at 10:00.
    assert.deepEqual((await slots(running, token, 60)).slots, [rome(2, 10, 30), rome(2, 11)]);
    assert.equal((await api(running, cookie, "PATCH", `/pages/${page.id}`, { durations: [7] })).status, 400);
    assert.equal((await api(running, cookie, "PATCH", `/pages/${page.id}`, { hours: { 1: [["12:00", "10:00"]] } })).status, 400);
    assert.equal((await api(running, cookie, "PATCH", `/pages/${page.id}`, { daysAhead: 1000 })).status, 400);
    assert.equal((await api(running, cookie, "PATCH", `/pages/${page.id}`, { active: false })).status, 200);
    assert.equal((await request(running.base, `/book/${token}/info`)).status, 404);
  });

  test("a page can take a short address of its own, once, and words the site uses stay free", async (t) => {
    const { google, running, cookie, page } = await owner(t);
    assert.equal((await api(running, cookie, "GET", "/slugs/ada")).data.available, true);
    assert.equal((await api(running, cookie, "GET", "/slugs/app")).data.available, false);
    const named = await api(running, cookie, "PATCH", `/pages/${page.id}`, { slug: "Ada" });
    assert.equal(named.status, 200);
    assert.equal(named.data.pages[0].url, `${running.origin}/ada`);
    const short = await request(running.base, "/ada");
    assert.equal(short.status, 200);
    assert.match(await short.text(), /book\.js/);
    assert.equal((await (await request(running.base, "/book/ada/info")).json()).name, "30 minute meeting");
    assert.equal((await request(running.base, `/book/${new URL(page.url).pathname.split("/").pop()}/info`)).status, 200, "the long address keeps working");
    for (const bad of ["a", "app", "-ada", "ada_lovelace"]) assert.equal((await api(running, cookie, "PATCH", `/pages/${page.id}`, { slug: bad })).status, 400, bad);
    const BOB = { sub: "100000000000000000002", email: "bob@example.com", name: "Bob" };
    google.state.calendars[BOB.sub] = [{ id: "bob@example.com", summary: "Bob", primary: true, accessRole: "owner" }];
    const bob = await signIn(running, google, BOB);
    const bobPage = (await api(running, bob, "POST", "/pages", {})).data.pages[0];
    assert.equal((await api(running, bob, "GET", "/slugs/ada")).data.available, false);
    assert.equal((await api(running, bob, "PATCH", `/pages/${bobPage.id}`, { slug: "ada" })).status, 409);
    assert.equal((await request(running.base, "/nobody-here")).status, 404);
  });

  test("a booking sends the guest a confirmation and the owner a notice, then reminders the day and the hour before", async (t) => {
    const resend = await fakeResend();
    t.after(resend.close);
    const { running, token } = await owner(t, { resend });
    const booked = await reserve(running, token, { duration: 30, start: rome(4, 10), name: "Bob Rossi", email: "bob@example.com", notes: "About <the launch>", timeZone: "America/New_York" });
    assert.equal(booked.status, 201);
    for (let i = 0; i < 20 && resend.sent.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    const [guest, notice] = resend.sent;
    assert.deepEqual(guest.to, ["bob@example.com"]);
    assert.equal(guest.from, "ubercal <bookings@fluxkit.test>");
    assert.equal(guest.reply_to, "ada@example.com");
    assert.match(guest.subject, /^Booked: 30 minute meeting with Ada, Wednesday 4 November, 04:00–04:30 \(America\/New York\)$/);
    assert.match(guest.html, /About &lt;the launch&gt;/);
    assert.match(guest.html, /meet\.google\.com/);
    assert.deepEqual(notice.to, ["ada@example.com"]);
    assert.equal(notice.reply_to, "bob@example.com");
    assert.match(notice.subject, /^New booking: Bob Rossi, Wednesday 4 November, 10:00–10:30 \(Europe\/Rome\)$/);
    running.clock.now = Date.parse(rome(3, 10, 3));
    await running.app.syncer.runOnce();
    assert.match(resend.sent[2].subject, /^Tomorrow: 30 minute meeting with Ada/);
    running.clock.now = Date.parse(rome(4, 9, 2));
    await running.app.syncer.runOnce();
    assert.match(resend.sent[3].subject, /^In an hour: 30 minute meeting with Ada$/);
    running.clock.now = Date.parse(rome(4, 9, 7));
    await running.app.syncer.runOnce();
    assert.equal(resend.sent.length, 4, "each reminder goes once");
  });

  test("a booking made at the last minute gets no reminder it would not need", async (t) => {
    const resend = await fakeResend();
    t.after(resend.close);
    const { running, token, cookie, page } = await owner(t, { resend });
    await api(running, cookie, "PATCH", `/pages/${page.id}`, { noticeMinutes: 0 });
    running.clock.now = Date.parse(rome(2, 10, 15));
    assert.equal((await reserve(running, token, { duration: 30, start: rome(2, 11), name: "Bob", email: "bob@example.com" })).status, 201);
    for (let i = 0; i < 20 && resend.sent.length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    running.clock.now = Date.parse(rome(2, 10, 20));
    await running.app.syncer.runOnce();
    assert.equal(resend.sent.length, 2, "only the confirmation and the notice");
  });
});
