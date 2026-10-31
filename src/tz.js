/**
 * Time zones from the runtime's own tz database (Intl), so a feed carries a
 * VTIMEZONE for every TZID it names, as RFC 5545 asks, without bundling one.
 */

const formatters = new Map();
const DAY = 86400000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

function formatter(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }));
  }
  return formatters.get(timeZone);
}

/** Whether the runtime knows this IANA zone. */
export function isZone(timeZone) {
  if (!timeZone || typeof timeZone !== "string") return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    formatters.delete(timeZone);
    return false;
  }
}

/** The wall clock of an instant in a zone: {year, month, day, hour, minute, second}. */
export function wallClock(ms, timeZone) {
  const parts = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

/** The zone's offset from UTC at an instant, in minutes. */
export function offsetAt(ms, timeZone) {
  const at = Math.floor(ms / 1000) * 1000;
  const wall = wallClock(at, timeZone);
  return Math.round((Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - at) / 60000);
}

/** The instant a wall clock time names in a zone (the earlier one when the clock repeats). */
export function zonedToUtc(wall, timeZone) {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour || 0, wall.minute || 0, wall.second || 0);
  let result = guess - offsetAt(guess, timeZone) * 60000;
  const second = guess - offsetAt(result, timeZone) * 60000;
  if (second !== result) result = Math.min(result, second);
  return result;
}

const pad = (value, size = 2) => String(value).padStart(size, "0");

export function formatLocal(wall) {
  return `${pad(wall.year, 4)}${pad(wall.month)}${pad(wall.day)}T${pad(wall.hour)}${pad(wall.minute)}${pad(wall.second)}`;
}

export function formatUtc(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

export function formatDate(text) {
  return String(text).replace(/-/g, "");
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}

/** Every offset change of a zone in a calendar year, to the minute. */
function transitions(timeZone, year) {
  const found = [];
  let previous = offsetAt(Date.UTC(year, 0, 1), timeZone);
  for (let day = Date.UTC(year, 0, 1); day < Date.UTC(year + 1, 0, 1); day += DAY) {
    const next = offsetAt(day + DAY, timeZone);
    if (next === previous) continue;
    let low = day;
    let high = day + DAY;
    while (high - low > 60000) {
      const middle = low + Math.floor((high - low) / 120000) * 60000;
      if (offsetAt(middle, timeZone) === previous) low = middle;
      else high = middle;
    }
    found.push({ at: high, from: previous, to: next });
    previous = next;
  }
  return found;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** "Last Sunday of March", "second Sunday of March": the rule a transition follows. */
function ruleOf(change) {
  const local = new Date(change.at + change.from * 60000);
  const day = local.getUTCDate();
  const month = local.getUTCMonth() + 1;
  const last = day + 7 > daysInMonth(local.getUTCFullYear(), month);
  return { month, weekday: local.getUTCDay(), nth: last ? -1 : Math.ceil(day / 7), hour: local.getUTCHours(), minute: local.getUTCMinutes() };
}

function dayByRule(year, rule) {
  if (rule.nth === -1) {
    const lastDay = daysInMonth(year, rule.month);
    const weekday = new Date(Date.UTC(year, rule.month - 1, lastDay)).getUTCDay();
    return lastDay - ((weekday - rule.weekday + 7) % 7);
  }
  const weekday = new Date(Date.UTC(year, rule.month - 1, 1)).getUTCDay();
  return 1 + ((rule.weekday - weekday + 7) % 7) + (rule.nth - 1) * 7;
}

function sameRule(change, rule) {
  const local = new Date(change.at + change.from * 60000);
  return local.getUTCMonth() + 1 === rule.month && local.getUTCDate() === dayByRule(local.getUTCFullYear(), rule)
    && local.getUTCHours() === rule.hour && local.getUTCMinutes() === rule.minute;
}

function observance(kind, start, from, to, rrule) {
  return [`BEGIN:${kind}`, `DTSTART:${start}`, ...(rrule ? [rrule] : []), `TZOFFSETFROM:${formatOffset(from)}`, `TZOFFSETTO:${formatOffset(to)}`, `END:${kind}`];
}

/**
 * The VTIMEZONE of an IANA zone, or "" when the runtime does not know it. A zone
 * whose clock changes by a yearly weekday rule gets that rule; any other zone gets
 * its actual changes from a few years back to a few years ahead.
 */
export function vtimezone(timeZone, now = Date.now()) {
  if (!isZone(timeZone)) return "";
  const year = new Date(now).getUTCFullYear();
  const lines = ["BEGIN:VTIMEZONE", `TZID:${timeZone}`];
  const changes = transitions(timeZone, year);
  const offsets = changes.map((change) => change.to);
  const standard = Math.min(...offsets, offsetAt(now, timeZone));
  if (!changes.length) {
    const offset = offsetAt(now, timeZone);
    lines.push(...observance("STANDARD", "19700101T000000", offset, offset));
  } else {
    const rules = changes.map(ruleOf);
    const steady = changes.length === 2 && [year + 1, year + 2].every((later) => {
      const next = transitions(timeZone, later);
      return next.length === 2 && next.every((change, index) => change.from === changes[index].from && change.to === changes[index].to && sameRule(change, rules[index]));
    });
    if (steady) {
      changes.forEach((change, index) => {
        const rule = rules[index];
        const start = formatLocal({ year: 1970, month: rule.month, day: dayByRule(1970, rule), hour: rule.hour, minute: rule.minute, second: 0 });
        lines.push(...observance(change.to > standard ? "DAYLIGHT" : "STANDARD", start, change.from, change.to, `RRULE:FREQ=YEARLY;BYMONTH=${rule.month};BYDAY=${rule.nth}${WEEKDAYS[rule.weekday]}`));
      });
    } else {
      const all = [];
      for (let each = year - 3; each <= year + 5; each += 1) all.push(...transitions(timeZone, each));
      const first = all[0];
      lines.push(...observance("STANDARD", "19700101T000000", first.from, first.from));
      for (const change of all) {
        lines.push(...observance(change.to > standard ? "DAYLIGHT" : "STANDARD", formatUtc(change.at + change.from * 60000).replace("Z", ""), change.from, change.to));
      }
    }
  }
  lines.push("END:VTIMEZONE");
  return lines.join("\r\n");
}

/** A DATE or DATE-TIME property value as an instant (all-day values at UTC midnight), or null. */
export function instantOf(entry, defaultZone = "") {
  if (!entry) return null;
  const value = String(entry.value || "").trim();
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  if (hour === undefined) return Date.UTC(+year, +month - 1, +day);
  const wall = { year: +year, month: +month, day: +day, hour: +hour, minute: +minute, second: +second };
  if (utc) return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  const zone = entry.params?.TZID || defaultZone;
  if (zone && isZone(zone)) return zonedToUtc(wall, zone);
  // A floating time, or a zone the runtime does not know: the UTC reading is at most a day off.
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
}

/** An ISO 8601 duration (P1D, PT1H30M, P2W) in milliseconds, or null. */
export function durationMs(text) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(text || "").trim());
  if (!match) return null;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const total = ((+weeks || 0) * 7 * 24 * 3600 + (+days || 0) * 24 * 3600 + (+hours || 0) * 3600 + (+minutes || 0) * 60 + (+seconds || 0)) * 1000;
  return sign === "-" ? -total : total;
}
