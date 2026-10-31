/**
 * Booking pages: when someone may book the owner, for how long, and the free slots
 * that leaves once the merged calendar and earlier bookings are taken out.
 */
import { occurrences } from "./agenda.js";
import { renderFeed } from "./feeds.js";
import { GoogleError } from "./google.js";
import { bookingEmail } from "./mail.js";
import { accessToken } from "./sync.js";
import { isZone, wallClock, zonedToUtc } from "./tz.js";

const DAY = 86400000;
const MINUTE = 60000;
export const DURATIONS = [15, 20, 30, 45, 60, 90, 120];
export const NOTICE = [0, 60, 120, 240, 720, 1440, 2880];
export const AHEAD = [7, 14, 30, 60, 90];
export const BUFFERS = [0, 5, 10, 15, 30];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
// A booking page's own short address: ubercal.fluxkit.dev/<slug>. Words the site uses for itself are not for taking.
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
export const RESERVED = new Set(["app", "api", "auth", "book", "feed", "static", "healthz", "favicon", "robots", "sitemap", "index", "privacy", "terms", "login", "logout", "signin", "signup", "admin", "help", "about", "settings", "account", "accounts", "calendar", "share", "fluxkit", "ubercal", "google", "www", "mail", "support"]);

export function slugProblem(slug) {
  if (!SLUG.test(slug)) return "Use 3 to 40 lowercase letters, numbers and dashes, starting and ending with a letter or number.";
  if (RESERVED.has(slug)) return "ubercal uses this word for itself: choose another.";
  return "";
}

export const DEFAULT_HOURS = Object.fromEntries([1, 2, 3, 4, 5].map((day) => [String(day), [["09:00", "17:00"]]]));

const minutes = (text) => { const [, h, m] = TIME.exec(text); return Number(h) * 60 + Number(m); };

/** Weekly hours as {"1".."7": [["HH:MM","HH:MM"], ...]} (ISO weekdays), or null when they do not make sense. */
export function cleanHours(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const hours = {};
  for (const [day, ranges] of Object.entries(input)) {
    if (!/^[1-7]$/.test(day) || !Array.isArray(ranges) || ranges.length > 4) return null;
    const clean = [];
    for (const range of ranges) {
      if (!Array.isArray(range) || range.length !== 2 || !TIME.test(range[0]) || !TIME.test(range[1])) return null;
      if (minutes(range[1]) <= minutes(range[0])) return null;
      clean.push([range[0], range[1]]);
    }
    clean.sort((a, b) => minutes(a[0]) - minutes(b[0]));
    for (let index = 1; index < clean.length; index += 1) if (minutes(clean[index][0]) < minutes(clean[index - 1][1])) return null;
    if (clean.length) hours[day] = clean;
  }
  return hours;
}

/**
 * The starts of every free slot of `duration` minutes between `from` and `to`:
 * inside the page's hours (in its time zone), after the notice, within the days
 * ahead, and clear of every busy interval by the buffer. Instants in ms.
 */
export function freeSlots({ page, busy, now, from, to, duration }) {
  const zone = isZone(page.timeZone) ? page.timeZone : "UTC";
  const length = duration * MINUTE;
  const step = Math.min(duration, 30) * MINUTE;
  const buffer = (page.bufferMinutes || 0) * MINUTE;
  const earliest = Math.max(from, now + (page.noticeMinutes || 0) * MINUTE);
  const latest = Math.min(to, now + (page.daysAhead || 30) * DAY);
  if (latest <= earliest) return [];
  const blocks = busy.map(([start, end]) => [start - buffer, end + buffer]).sort((a, b) => a[0] - b[0]);
  const clear = (start) => !blocks.some(([busyStart, busyEnd]) => busyStart < start + length && busyEnd > start);
  const first = wallClock(earliest, zone);
  const slots = [];
  for (let offset = 0; offset < 100; offset += 1) {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
    const day = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
    if (zonedToUtc({ ...day, hour: 0, minute: 0, second: 0 }, zone) >= latest) break;
    for (const [open, close] of page.hours?.[String(date.getUTCDay() || 7)] || []) {
      const start = zonedToUtc({ ...day, hour: Math.floor(minutes(open) / 60), minute: minutes(open) % 60, second: 0 }, zone);
      const end = zonedToUtc({ ...day, hour: Math.floor(minutes(close) / 60), minute: minutes(close) % 60, second: 0 }, zone);
      for (let at = start; at + length <= end; at += step) {
        if (at >= earliest && at < latest && clear(at)) slots.push(at);
      }
    }
  }
  return slots;
}

/** What keeps the owner busy between two instants: their merged calendar (free events aside) and ubercal's own bookings. */
export async function busyBetween(db, userId, from, to, now = Date.now()) {
  const everything = { userId, name: "Busy", calendars: {}, others: "full", pastDays: 0 };
  const { ics } = await renderFeed(db, everything, now);
  const busy = occurrences(ics, from, to)
    .filter((entry) => !entry.free && entry.status !== "CANCELLED")
    .map((entry) => entry.allDay
      ? [Date.parse(`${entry.start.date}T00:00:00Z`), Date.parse(`${entry.end.date}T00:00:00Z`)]
      : [Date.parse(entry.start.at), Date.parse(entry.end.at)]);
  const booked = await db.appointments.find({ userId, status: { $nin: ["cancelled", "declined"] }, start: { $lt: new Date(to) }, end: { $gt: new Date(from) } }, { projection: { start: 1, end: 1 } }).toArray();
  return [...busy, ...booked.map((entry) => [entry.start.getTime(), entry.end.getTime()])];
}

/** The confirmation to the guest and the notice to the owner, once a booking is in Google. */
export async function notifyBooking(context, appointmentId) {
  const { db, mailer } = context;
  if (!mailer?.enabled) return;
  const appointment = await db.appointments.findOne({ _id: appointmentId });
  if (!appointment) return;
  const parts = await bookingParts(db, appointment);
  if (!parts) return;
  for (const kind of ["confirmed", "owner"]) await mailer.send(bookingEmail(kind, parts));
}

async function bookingParts(db, appointment) {
  const page = await db.pages.findOne({ _id: appointment.pageId });
  const owner = await db.users.findOne({ _id: appointment.userId });
  if (!page || !owner) return null;
  const connection = page.target ? await db.connections.findOne({ _id: page.target.connectionId }) : null;
  return { appointment, page, ownerName: owner.name || "", ownerEmail: connection?.email || owner.email };
}

/**
 * Reminders to guests: the day before and an hour before, each once, and only when
 * the booking was made earlier than that. Claimed in Mongo before sending, so two
 * passes never send the same one.
 */
export async function remind(context) {
  const { db, mailer, now } = context;
  if (!mailer?.enabled) return;
  const at = now();
  for (const [kind, ahead, field] of [["hour", 3600000, "remindedHour"], ["day", DAY, "remindedDay"]]) {
    const due = await db.appointments.find({ status: "confirmed", start: { $gt: new Date(at), $lte: new Date(at + ahead) }, [field]: { $exists: false } }).toArray();
    for (const appointment of due) {
      const late = appointment.createdAt.getTime() > appointment.start.getTime() - ahead;
      const soon = kind === "day" && appointment.start.getTime() - at <= 3600000;
      const claimed = await db.appointments.findOneAndUpdate({ _id: appointment._id, [field]: { $exists: false } }, { $set: { [field]: late || soon ? "skipped" : new Date(at) } });
      if (!claimed || late || soon) continue;
      const parts = await bookingParts(db, appointment);
      if (parts) await mailer.send(bookingEmail(kind, parts));
    }
  }
}

/**
 * The guest's answer to Google's invitation, read again from the event on every
 * pass until the meeting: accepted, tentative, declined or still waiting. A declined
 * or deleted meeting frees its time; the owner hears about a decline.
 */
export async function followGuests(context) {
  const { db, google, mailer, now, log } = context;
  const upcoming = await db.appointments.find({ status: "confirmed", end: { $gt: new Date(now()) }, eventId: { $nin: ["", null] } }).limit(500).toArray();
  for (const appointment of upcoming) {
    const connection = await db.connections.findOne({ _id: appointment.connectionId });
    if (!connection || connection.status === "revoked") continue;
    let event;
    try {
      event = await google.api(await accessToken(context, connection), `/calendars/${encodeURIComponent(appointment.calendarId)}/events/${encodeURIComponent(appointment.eventId)}`);
    } catch (error) {
      if (error instanceof GoogleError && (error.status === 404 || error.status === 410)) event = { status: "cancelled" };
      else { log?.("guest answer unread", String(appointment._id), error?.status || error?.message || ""); continue; }
    }
    if (event.status === "cancelled") {
      await db.appointments.updateOne({ _id: appointment._id }, { $set: { status: "cancelled", checkedAt: new Date(now()) } });
      continue;
    }
    const guest = (event.attendees || []).find((attendee) => String(attendee.email || "").toLowerCase() === appointment.email);
    const answer = guest?.responseStatus || "needsAction";
    const declined = answer === "declined";
    await db.appointments.updateOne({ _id: appointment._id }, { $set: { guestStatus: answer, checkedAt: new Date(now()), ...(declined ? { status: "declined" } : {}) } });
    if (declined && mailer?.enabled) {
      const parts = await bookingParts(db, { ...appointment, guestStatus: answer });
      if (parts) await mailer.send(bookingEmail("declined", parts));
    }
  }
}
