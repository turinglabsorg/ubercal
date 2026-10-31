/**
 * A share link's window: it shows events from `from` until `until` (either may be
 * open). A series is cut, not just kept: it starts again at its first occurrence in
 * the window and ends with it, so a calendar app shows nothing outside.
 */
import ICAL from "ical.js";
import { formatLine, parse, parseLine, prop, props, serialize } from "./ics.js";
import { durationMs, instantOf } from "./tz.js";

const DAY = 86400000;
const MAX_STEPS = 20000;

/** The window of a feed, as instants (null = open). Links from before windows kept a number of past days. */
export function feedWindow(feed, now = Date.now()) {
  if ("from" in feed || "until" in feed) {
    return { from: feed.from ? new Date(feed.from).getTime() : null, until: feed.until ? new Date(feed.until).getTime() : null };
  }
  return { from: feed.pastDays ? now - feed.pastDays * DAY : null, until: null };
}

function register(tzid, zoneText) {
  if (!tzid || ICAL.TimezoneService.has(tzid)) return;
  const text = zoneText(tzid);
  if (!text) return;
  try {
    const zone = new ICAL.Timezone(new ICAL.Component(ICAL.parse(text)));
    ICAL.TimezoneService.register(tzid, zone);
  } catch {}
}

function replaceProperty(event, name, line) {
  const index = event.lines.findIndex((entry) => parseLine(entry).name === name);
  if (index >= 0) event.lines[index] = line;
  else if (line) event.lines.push(line);
  event.lines = event.lines.filter(Boolean);
}

function withRule(rule, changes) {
  const parts = rule.split(";").filter((part) => part && !Object.keys(changes).includes(part.split("=")[0].toUpperCase()));
  for (const [key, value] of Object.entries(changes)) if (value !== null) parts.push(`${key}=${value}`);
  return parts.join(";");
}

function utcStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** The event as the window shows it: unchanged, cut to the window, or null when nothing of it is inside. */
export function clipEvent(text, { from, until }, zoneText = () => "") {
  if (from === null && until === null) return text;
  const event = parse(text).children[0];
  const startProp = prop(event, "DTSTART");
  const start = instantOf(startProp);
  if (start === null) return text;
  const endValue = instantOf(prop(event, "DTEND"));
  const length = endValue !== null ? endValue - start : durationMs(prop(event, "DURATION")?.value) ?? (/^\d{8}$/.test(String(startProp.value)) ? DAY : 0);
  const recurring = props(event, "RRULE").length > 0 || props(event, "RDATE").length > 0;
  if (!recurring) {
    const end = start + length;
    if (from !== null && (length > 0 ? end <= from : start < from)) return null;
    if (until !== null && start >= until) return null;
    return text;
  }
  register(startProp.params?.TZID, zoneText);
  const series = new ICAL.Event(new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${serialize(event)}\r\nEND:VCALENDAR`)).getFirstSubcomponent("vevent"));
  const iterator = series.iterator();
  let skipped = 0;
  let first = null;
  for (let next = iterator.next(), steps = 0; next && steps < MAX_STEPS; next = iterator.next(), steps += 1) {
    const at = next.toJSDate().getTime();
    if (until !== null && at >= until) break;
    if (from !== null && at + Math.max(length, 1) <= from) { skipped += 1; continue; }
    first = next;
    break;
  }
  if (!first) return null;
  const rule = props(event, "RRULE")[0];
  const count = Number(/(?:^|;)COUNT=(\d+)/i.exec(rule?.value || "")?.[1] || 0);
  if (count && count - skipped <= 0) return null;
  if (skipped) {
    replaceProperty(event, "DTSTART", formatLine("DTSTART", startProp.params, first.toICALString()));
    const endProp = prop(event, "DTEND");
    if (endProp) {
      const end = first.clone();
      end.addDuration(series.duration);
      replaceProperty(event, "DTEND", formatLine("DTEND", endProp.params, end.toICALString()));
    }
  }
  if (rule) {
    const changes = {};
    if (count) changes.COUNT = String(count - skipped);
    if (until !== null) {
      if (count) {
        let inside = 0;
        const counter = new ICAL.Event(new ICAL.Component(ICAL.parse(`BEGIN:VCALENDAR\r\n${serialize(event)}\r\nEND:VCALENDAR`)).getFirstSubcomponent("vevent")).iterator();
        for (let next = counter.next(); next && inside < count - skipped && next.toJSDate().getTime() < until; next = counter.next()) inside += 1;
        changes.COUNT = String(inside);
      } else {
        const existing = /(?:^|;)UNTIL=([0-9TZ]+)/i.exec(rule.value)?.[1];
        const existingMs = existing ? instantOf({ value: existing }) : null;
        if (existingMs === null || existingMs >= until) changes.UNTIL = first.isDate ? utcStamp(until - DAY).slice(0, 8) : utcStamp(until - 1000);
      }
    }
    if (Object.keys(changes).length) replaceProperty(event, "RRULE", formatLine("RRULE", rule.params, withRule(rule.value, changes)));
  }
  // Extra dates outside the window would bring back what the window leaves out.
  event.lines = event.lines.filter((line) => {
    const entry = parseLine(line);
    if (entry.name !== "RDATE") return true;
    const at = instantOf({ value: entry.value.split(",")[0], params: entry.params });
    return at === null || ((from === null || at + length > from) && (until === null || at < until));
  });
  return serialize(event);
}
