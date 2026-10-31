/** The occurrences of a calendar text between two instants, series expanded, for the app's calendar view. */
import ICAL from "ical.js";

const MAX_STEPS = 20000;
const MAX_OCCURRENCES = 4000;

function moment(time) {
  if (time.isDate) return { date: `${String(time.year).padStart(4, "0")}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}` };
  return { at: time.toJSDate().toISOString() };
}

function occurrence(event, start, end, item = event) {
  const component = item.component || event.component;
  return {
    source: component.getFirstPropertyValue("x-ubercal-source") || "",
    show: component.getFirstPropertyValue("x-ubercal-show") || "full",
    title: item.summary || "",
    location: item.location || "",
    status: String(component.getFirstPropertyValue("status") || "").toUpperCase(),
    free: String(component.getFirstPropertyValue("transp") || "").toUpperCase() === "TRANSPARENT",
    allDay: start.isDate,
    start: moment(start),
    end: moment(end || start),
  };
}

/** Occurrences overlapping [from, to), oldest first; series, moved and cancelled occurrences resolved. */
export function occurrences(ics, from, to) {
  const calendar = new ICAL.Component(ICAL.parse(ics));
  for (const zone of calendar.getAllSubcomponents("vtimezone")) {
    const timezone = new ICAL.Timezone(zone);
    if (!ICAL.TimezoneService.has(timezone.tzid)) ICAL.TimezoneService.register(timezone.tzid, timezone);
  }
  const rangeStart = ICAL.Time.fromJSDate(new Date(from), true);
  const rangeEnd = ICAL.Time.fromJSDate(new Date(to), true);
  const events = calendar.getAllSubcomponents("vevent").map((component) => new ICAL.Event(component));
  const masters = new Map();
  const loose = [];
  for (const event of events) if (!event.isRecurrenceException()) masters.set(event.uid, event);
  for (const event of events) {
    if (!event.isRecurrenceException()) continue;
    const master = masters.get(event.uid);
    if (master?.isRecurring()) master.relateException(event);
    else loose.push(event);
  }
  const found = [];
  const overlaps = (start, end) => (end || start).compare(rangeStart) > 0 && start.compare(rangeEnd) < 0 || (start.isDate && start.compare(rangeStart) >= 0 && start.compare(rangeEnd) < 0);
  for (const event of [...masters.values(), ...loose]) {
    if (found.length >= MAX_OCCURRENCES) break;
    if (!event.isRecurring()) {
      if (overlaps(event.startDate, event.endDate)) found.push(occurrence(event, event.startDate, event.endDate));
      continue;
    }
    const iterator = event.iterator();
    for (let next = iterator.next(), steps = 0; next && steps < MAX_STEPS && found.length < MAX_OCCURRENCES; next = iterator.next(), steps += 1) {
      if (next.compare(rangeEnd) >= 0) break;
      const details = event.getOccurrenceDetails(next);
      if (overlaps(details.startDate, details.endDate)) found.push(occurrence(event, details.startDate, details.endDate, details.item));
    }
  }
  return found
    .filter((entry) => entry.status !== "CANCELLED")
    .sort((a, b) => String(a.start.at || a.start.date).localeCompare(String(b.start.at || b.start.date)));
}
