/** What ubercal reads from one VEVENT: who it is, when it stops mattering, and its busy-only form. */
import { createHash } from "node:crypto";
import { parse, parseLine, prop, props, serialize } from "./ics.js";
import { durationMs, instantOf } from "./tz.js";

const DAY = 86400000;
// What a busy-only feed keeps of an event: when it is, and nothing about what it is.
const BUSY_KEEPS = new Set(["UID", "DTSTAMP", "DTSTART", "DTEND", "DURATION", "RRULE", "RDATE", "EXDATE", "RECURRENCE-ID", "SEQUENCE", "STATUS", "TRANSP", "CREATED", "LAST-MODIFIED"]);

/** The instant an event's last occurrence ends, or null when it repeats with no end. */
export function endsAt(event) {
  const start = prop(event, "DTSTART");
  const rrules = props(event, "RRULE");
  if (rrules.length || props(event, "RDATE").length) {
    let latest = 0;
    for (const rule of rrules) {
      const until = /(?:^|;)UNTIL=([0-9TZ]+)/i.exec(rule.value)?.[1];
      if (!until) return null;
      const ms = instantOf({ value: until, params: start?.params?.TZID && !until.endsWith("Z") ? { TZID: start.params.TZID } : {} });
      if (ms === null) return null;
      latest = Math.max(latest, ms + DAY);
    }
    if (props(event, "RDATE").length) return null;
    return latest || null;
  }
  const begin = instantOf(start);
  if (begin === null) return null;
  const end = instantOf(prop(event, "DTEND"));
  if (end !== null) return end;
  const duration = durationMs(prop(event, "DURATION")?.value);
  if (duration !== null) return begin + duration;
  return begin + (/^\d{8}$/.test(String(start.value).trim()) ? DAY : 0);
}

/** The identity of an event inside its source: its UID, plus the occurrence it overrides. */
export function identity(event, fallbackSeed) {
  let uid = prop(event, "UID")?.value?.trim();
  if (!uid) {
    uid = `${createHash("sha256").update(`${fallbackSeed}\n${event.lines.join("\n")}`).digest("hex").slice(0, 32)}@ubercal`;
    event.lines.unshift(`UID:${uid}`);
  }
  const recurrence = prop(event, "RECURRENCE-ID");
  const recurrenceId = recurrence ? String(instantOf(recurrence) ?? recurrence.value) : "";
  return { uid, recurrenceId, key: recurrenceId ? `${uid}#${recurrenceId}` : uid };
}

/** Every TZID an event names, in its own properties and its nested components. */
export function zonesOf(text) {
  const zones = new Set();
  for (const match of String(text).matchAll(/;TZID=("[^"]*"|[^;:]*)/g)) zones.add(match[1].replace(/^"(.*)"$/, "$1"));
  return zones;
}

/** The event as only a block of busy time: no title, place, people, notes or alarms. */
export function busyOnly(text, label = "Busy") {
  const event = parse(text).children[0];
  if (!event) return "";
  const lines = event.lines.filter((line) => BUSY_KEEPS.has(parseLine(line).name));
  lines.push(`SUMMARY:${label}`, "CLASS:PRIVATE");
  return serialize({ name: "VEVENT", lines, children: [] });
}

/** Whether an event asks to be shown as free time, or is cancelled. */
export function isFreeOrCancelled(text) {
  const event = parse(text).children[0];
  if (!event) return true;
  return prop(event, "TRANSP")?.value?.trim().toUpperCase() === "TRANSPARENT" || prop(event, "STATUS")?.value?.trim().toUpperCase() === "CANCELLED";
}
