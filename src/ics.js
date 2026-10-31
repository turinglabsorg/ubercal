/**
 * Just enough iCalendar (RFC 5545) to merge calendars without losing anything:
 * components are kept as their own property lines, so recurrence rules, alarms
 * and vendor properties survive untouched, and only what ubercal needs is read.
 */

const encoder = new TextEncoder();

/** The logical lines of a calendar: line endings normalised, folded lines joined. */
export function unfold(text) {
  const lines = [];
  for (const raw of String(text).replace(/^\uFEFF/, "").split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && lines.length) lines[lines.length - 1] += raw.slice(1);
    else if (raw) lines.push(raw);
  }
  return lines;
}

/** A content line folded at 75 octets, never inside a UTF-8 character. */
export function fold(line) {
  if (encoder.encode(line).length <= 75) return line;
  const parts = [];
  let current = "";
  let size = 0;
  let limit = 75;
  for (const char of line) {
    const width = encoder.encode(char).length;
    if (size + width > limit) {
      parts.push(current);
      current = "";
      size = 0;
      limit = 74;
    }
    current += char;
    size += width;
  }
  parts.push(current);
  return parts.join("\r\n ");
}

/** `NAME;PARAM=a;X="b:c":value` as {name, params, value}; a quoted parameter may hold `:` and `;`. */
export function parseLine(line) {
  let index = 0;
  let quoted = false;
  const cuts = [];
  for (; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === ";") cuts.push(index);
    else if (!quoted && char === ":") break;
  }
  const head = line.slice(0, index);
  const value = line.slice(index + 1);
  const pieces = [];
  let start = 0;
  for (const cut of cuts) {
    pieces.push(head.slice(start, cut));
    start = cut + 1;
  }
  pieces.push(head.slice(start));
  const params = {};
  for (const piece of pieces.slice(1)) {
    const equals = piece.indexOf("=");
    if (equals < 1) continue;
    params[piece.slice(0, equals).toUpperCase()] = piece.slice(equals + 1).replace(/^"(.*)"$/, "$1");
  }
  return { name: pieces[0].toUpperCase(), params, value };
}

/** A property line from its parts; parameter values with special characters are quoted. */
export function formatLine(name, params, value) {
  let line = name;
  for (const [key, raw] of Object.entries(params || {})) {
    if (raw === undefined || raw === null || raw === "") continue;
    const text = String(raw).replace(/"/g, "'");
    line += `;${key}=${/[;:,]/.test(text) ? `"${text}"` : text}`;
  }
  return `${line}:${value}`;
}

export function escapeText(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n|\r|\n/g, "\\n");
}

export function unescapeText(value) {
  return String(value ?? "").replace(/\\([\\;,nN])/g, (_, char) => (char === "n" || char === "N" ? "\n" : char));
}

/**
 * The component tree of a calendar text. Each component keeps its property lines
 * (unfolded) and its nested components, in order.
 */
export function parse(text) {
  const root = { name: "ROOT", lines: [], children: [] };
  const stack = [root];
  for (const line of unfold(text)) {
    const upper = line.toUpperCase();
    if (upper.startsWith("BEGIN:")) {
      const component = { name: upper.slice(6).trim(), lines: [], children: [] };
      stack[stack.length - 1].children.push(component);
      stack.push(component);
    } else if (upper.startsWith("END:")) {
      if (stack.length > 1 && stack[stack.length - 1].name === upper.slice(4).trim()) stack.pop();
    } else {
      stack[stack.length - 1].lines.push(line);
    }
  }
  return root;
}

/** The text of a component, each line folded. */
export function serialize(component) {
  const out = [`BEGIN:${component.name}`];
  for (const line of component.lines) out.push(fold(line));
  for (const child of component.children) out.push(serialize(child));
  out.push(`END:${component.name}`);
  return out.join("\r\n");
}

/** The first property called `name` of a component, parsed, or null. */
export function prop(component, name) {
  for (const line of component.lines) {
    const colon = line.indexOf(":");
    const semi = line.indexOf(";");
    const end = semi >= 0 && semi < colon ? semi : colon;
    if (end > 0 && line.slice(0, end).toUpperCase() === name) return parseLine(line);
  }
  return null;
}

export function props(component, name) {
  return component.lines.map(parseLine).filter((entry) => entry.name === name);
}

/** The calendars inside a text: one VCALENDAR usually, several in a few exports. */
export function calendars(text) {
  const root = parse(text);
  return root.children.filter((component) => component.name === "VCALENDAR");
}
