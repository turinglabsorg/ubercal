/**
 * Booking pages: when someone may book the owner, for how long, and the free slots
 * that leaves once the merged calendar and earlier bookings are taken out.
 */
import { occurrences } from "./agenda.js";
import { renderFeed } from "./feeds.js";
import { isZone, wallClock, zonedToUtc } from "./tz.js";

const DAY = 86400000;
const MINUTE = 60000;
export const DURATIONS = [15, 20, 30, 45, 60, 90, 120];
export const NOTICE = [0, 60, 120, 240, 720, 1440, 2880];
export const AHEAD = [7, 14, 30, 60, 90];
export const BUFFERS = [0, 5, 10, 15, 30];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
  const booked = await db.appointments.find({ userId, status: { $ne: "cancelled" }, start: { $lt: new Date(to) }, end: { $gt: new Date(from) } }, { projection: { start: 1, end: 1 } }).toArray();
  return [...busy, ...booked.map((entry) => [entry.start.getTime(), entry.end.getTime()])];
}
