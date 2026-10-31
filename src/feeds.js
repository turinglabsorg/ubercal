/**
 * A feed: the calendars someone chose, merged into one VCALENDAR and kept ready
 * in Mongo, so a calendar app asking for it every few minutes costs one read.
 */
import { createHash } from "node:crypto";
import { escapeText, parse, prop, serialize } from "./ics.js";
import { busyOnly, isFreeOrCancelled, zonesOf } from "./events.js";
import { exdateLine } from "./google.js";
import { vtimezone } from "./tz.js";

const DAY = 86400000;
// A Mongo document holds 16 MB; a feed this large is not one anyone can subscribe to anyway.
const MAX_FEED_BYTES = 15 * 1024 * 1024;
export const REFRESH_MINUTES = 5;

export const SHOWS = ["full", "busy", "hidden"];

/** How a feed shows one calendar: full details, busy time only, or not at all. Calendars it does not name follow `others`. */
export function showing(feed, sourceId) {
  const chosen = feed.calendars?.[String(sourceId)];
  return SHOWS.includes(chosen) ? chosen : SHOWS.includes(feed.others) ? feed.others : "full";
}

/** The calendars a feed merges, oldest first, each with how the feed shows it. */
export async function feedSources(db, feed) {
  const sources = await db.sources.find({ userId: feed.userId, enabled: true }).sort({ createdAt: 1 }).toArray();
  return sources.map((source) => ({ source, show: showing(feed, source._id) })).filter((entry) => entry.show !== "hidden");
}

function withExdates(text, lines) {
  if (!lines.length) return text;
  const end = text.lastIndexOf("END:VEVENT");
  return `${text.slice(0, end)}${lines.join("\r\n")}\r\n${text.slice(end)}`;
}

function renameZones(text, renames) {
  if (!renames.size) return text;
  return text.replace(/;TZID=("[^"]*"|[^;:]*)/g, (whole, raw) => {
    const zone = raw.replace(/^"(.*)"$/, "$1");
    return renames.has(zone) ? `;TZID=${renames.get(zone)}` : whole;
  });
}

/**
 * The feed's calendar text. An event that two calendars share (an invitation seen
 * from two accounts) appears once: from a calendar shown in full when there is one,
 * otherwise from the oldest. A calendar shown as busy keeps only when it is busy.
 */
export async function renderFeed(db, feed, now = Date.now(), { annotate = false } = {}) {
  const sources = await feedSources(db, feed);
  const cutoff = feed.pastDays ? now - feed.pastDays * DAY : null;
  const zones = new Map();
  const taken = new Set();
  const events = [];
  sources.sort((a, b) => (a.show === "full" ? 0 : 1) - (b.show === "full" ? 0 : 1));
  for (const { source, show } of sources) {
    const renames = new Map();
    for (const zone of source.timezones || []) {
      if (!zones.has(zone.tzid)) zones.set(zone.tzid, zone.text);
      else if (zones.get(zone.tzid) !== zone.text) {
        const renamed = `${zone.tzid}-${String(source._id).slice(-6)}`;
        renames.set(zone.tzid, renamed);
        zones.set(renamed, zone.text.replace(/^TZID:.*$/m, `TZID:${renamed}`));
      }
    }
    const docs = await db.events.find({ sourceId: source._id }, { projection: { _id: 0, key: 1, uid: 1, text: 1, endsAt: 1, kind: 1, cancelledOf: 1, original: 1 } }).toArray();
    const cancelled = new Map();
    for (const doc of docs) {
      if (!doc.cancelledOf) continue;
      if (!cancelled.has(doc.cancelledOf)) cancelled.set(doc.cancelledOf, []);
      cancelled.get(doc.cancelledOf).push(doc.original);
    }
    const mine = new Set();
    const hidden = new Set();
    const ordered = docs.filter((doc) => doc.text).sort((a, b) => (a.text.includes("\nRECURRENCE-ID") ? 1 : 0) - (b.text.includes("\nRECURRENCE-ID") ? 1 : 0));
    for (const doc of ordered) {
      if (taken.has(doc.uid) || hidden.has(doc.uid)) continue;
      if (cutoff && doc.endsAt && doc.endsAt.getTime() < cutoff) continue;
      let text = withExdates(doc.text, (cancelled.get(doc.key) || []).map((original) => exdateLine(original, doc.kind)).filter(Boolean));
      text = renameZones(text, renames);
      const override = /\nRECURRENCE-ID[;:]/.test(text);
      if (show === "busy") {
        if (!override && isFreeOrCancelled(text)) {
          hidden.add(doc.uid);
          continue;
        }
        text = busyOnly(text, feed.busyLabel || "Busy");
      }
      const event = parse(text).children[0];
      if (!event || !prop(event, "DTSTART")) continue;
      // The app's own calendar view needs to know where each event comes from; public feeds never carry this.
      if (annotate) event.lines.push(`X-UBERCAL-SOURCE:${source._id}`, `X-UBERCAL-SHOW:${show}`);
      events.push(serialize(event));
      mine.add(doc.uid);
    }
    for (const uid of mine) taken.add(uid);
  }
  const used = new Set();
  for (const event of events) for (const zone of zonesOf(event)) used.add(zone);
  const timezones = [];
  for (const zone of [...used].sort()) {
    const text = zones.get(zone) || vtimezone(zone, now);
    if (text) timezones.push(serialize(parse(text).children[0]));
  }
  const name = escapeText(feed.name || "ubercal");
  const head = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ubercal//ubercal 0.1//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `NAME:${name}`, `X-WR-CALNAME:${name}`, `REFRESH-INTERVAL;VALUE=DURATION:PT${REFRESH_MINUTES}M`, `X-PUBLISHED-TTL:PT${REFRESH_MINUTES}M`,
  ];
  const ics = `${[...head, ...timezones, ...events, "END:VCALENDAR"].join("\r\n")}\r\n`;
  return { ics, count: events.length };
}

/** Render a feed and keep the result; unchanged text keeps its ETag. */
export async function buildFeed(db, feed, now = Date.now()) {
  const { ics, count } = await renderFeed(db, feed, now);
  if (Buffer.byteLength(ics) > MAX_FEED_BYTES) {
    await db.feeds.updateOne({ _id: feed._id }, { $set: { error: "This feed is too large: choose fewer calendars or a shorter past.", builtAt: new Date(now) } });
    return null;
  }
  const etag = `"${createHash("sha256").update(ics).digest("base64url").slice(0, 27)}"`;
  const update = { builtAt: new Date(now), error: "", count, dirty: false };
  if (etag !== feed.etag) Object.assign(update, { ics, etag, changedAt: new Date(now) });
  await db.feeds.updateOne({ _id: feed._id }, { $set: update });
  return { ...feed, ...update };
}
