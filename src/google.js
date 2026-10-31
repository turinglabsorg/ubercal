/**
 * Google: sign-in (openid email profile), the calendar connection (calendar.readonly,
 * offline), and Google Calendar events written as VEVENTs. Endpoints are settings,
 * so the tests can stand a fake Google in front of them.
 */
import { createHash } from "node:crypto";
import { escapeText, parse } from "./ics.js";
import { endsAt } from "./events.js";
import { formatDate, formatLocal, formatUtc, isZone, wallClock } from "./tz.js";

export const SIGN_IN_SCOPES = ["openid", "email", "profile"];
export const CALENDAR_SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"];

export class GoogleError extends Error {
  constructor(message, { status = 0, code = "" } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function pkceChallenge(verifier) {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** The claims of an ID token Google just returned to us over TLS from its token endpoint. */
export function idClaims(idToken) {
  try {
    return JSON.parse(Buffer.from(String(idToken).split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export class Google {
  constructor({ clientId = "", clientSecret = "", authUrl, tokenUrl, apiBase, revokeUrl, timeoutMs = 30000 } = {}) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.authUrl = authUrl || "https://accounts.google.com/o/oauth2/v2/auth";
    this.tokenUrl = tokenUrl || "https://oauth2.googleapis.com/token";
    this.apiBase = apiBase || "https://www.googleapis.com/calendar/v3";
    this.revokeUrl = revokeUrl || "https://oauth2.googleapis.com/revoke";
    this.timeoutMs = timeoutMs;
  }

  get configured() {
    return Boolean(this.clientId && this.clientSecret);
  }

  authorizeUrl({ scopes, state, verifier, redirectUri, offline = false, loginHint = "", selectAccount = false }) {
    const url = new URL(this.authUrl);
    const params = {
      client_id: this.clientId, redirect_uri: redirectUri, response_type: "code", scope: scopes.join(" "), state,
      code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", include_granted_scopes: "true",
    };
    if (offline) Object.assign(params, { access_type: "offline", prompt: "consent" });
    else if (selectAccount) params.prompt = "select_account";
    if (loginHint) params.login_hint = loginHint;
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  async token(form) {
    let response;
    try {
      response = await fetch(this.tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...form }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new GoogleError("Google did not answer.", { code: "unreachable" });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new GoogleError(data.error_description || data.error || `Google refused (${response.status}).`, { status: response.status, code: data.error || "" });
    return data;
  }

  async exchangeCode({ code, verifier, redirectUri }) {
    const data = await this.token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri });
    return { accessToken: data.access_token, refreshToken: data.refresh_token || "", expiresIn: Number(data.expires_in) || 3600, scope: String(data.scope || ""), claims: idClaims(data.id_token) };
  }

  async refresh(refreshToken) {
    const data = await this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
    return { accessToken: data.access_token, expiresIn: Number(data.expires_in) || 3600 };
  }

  async revoke(tokenValue) {
    try {
      await fetch(this.revokeUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokenValue }), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch {}
  }

  async api(accessToken, path, params = {}) {
    const url = new URL(`${this.apiBase}${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch {
        if (attempt < 2) { await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt)); continue; }
        throw new GoogleError("Google Calendar did not answer.", { code: "unreachable" });
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const reason = data.error?.errors?.[0]?.reason || "";
        throw new GoogleError(data.error?.message || `Google Calendar refused (${response.status}).`, { status: response.status, code: reason });
      }
      return data;
    }
  }

  async calendars(accessToken) {
    const items = [];
    let pageToken = "";
    do {
      const page = await this.api(accessToken, "/users/me/calendarList", { minAccessRole: "reader", maxResults: 250, pageToken });
      items.push(...(page.items || []));
      pageToken = page.nextPageToken || "";
    } while (pageToken);
    return items.map((item) => ({
      id: item.id, name: item.summaryOverride || item.summary || item.id, color: item.backgroundColor || "", primary: Boolean(item.primary), timeZone: item.timeZone || "", access: item.accessRole || "",
    }));
  }

  /**
   * Every change since `syncToken` (or every event, without one), as Google lists
   * them with recurring events whole: {items, syncToken}. A token Google no longer
   * accepts throws with status 410.
   */
  async events(accessToken, calendarId, syncToken = "") {
    const items = [];
    let pageToken = "";
    let next = "";
    do {
      const page = await this.api(accessToken, `/calendars/${encodeURIComponent(calendarId)}/events`, syncToken
        ? { syncToken, pageToken, maxResults: 2500 }
        : { singleEvents: "false", showDeleted: "false", pageToken, maxResults: 2500 });
      items.push(...(page.items || []));
      pageToken = page.nextPageToken || "";
      next = page.nextSyncToken || next;
    } while (pageToken);
    return { items, syncToken: next };
  }
}

const PARTSTAT = { accepted: "ACCEPTED", declined: "DECLINED", tentative: "TENTATIVE", needsAction: "NEEDS-ACTION" };

function moment(when, zone) {
  if (when?.date) return { params: ";VALUE=DATE", value: formatDate(when.date), kind: "date" };
  const ms = Date.parse(when?.dateTime || "");
  if (Number.isNaN(ms)) return null;
  if (zone && isZone(zone)) return { params: `;TZID=${zone}`, value: formatLocal(wallClock(ms, zone)), kind: zone };
  return { params: "", value: formatUtc(ms), kind: "" };
}

/** How a cancelled occurrence is written as an EXDATE of a series whose start is written as `kind`. */
export function exdateLine(original, kind) {
  if (original?.date) return `EXDATE;VALUE=DATE:${formatDate(original.date)}`;
  const ms = Date.parse(original?.dateTime || "");
  if (Number.isNaN(ms)) return "";
  if (kind && kind !== "date" && isZone(kind)) return `EXDATE;TZID=${kind}:${formatLocal(wallClock(ms, kind))}`;
  return `EXDATE:${formatUtc(ms)}`;
}

/**
 * One item of a Google events list as what ubercal stores:
 * - {key, remove: true} when it is gone, or is nothing to show (declined, a working-location marker);
 * - {key, cancelledOf, original} for a cancelled (or declined) occurrence of a series;
 * - {key, uid, text, endsAt, kind} for an event, a series or a changed occurrence.
 */
export function eventRecord(event, calendarZone = "", now = Date.now()) {
  const key = String(event.id);
  const declined = (event.attendees || []).some((attendee) => attendee.self && attendee.responseStatus === "declined");
  if (event.recurringEventId && event.originalStartTime && (event.status === "cancelled" || declined)) {
    return { key, cancelledOf: String(event.recurringEventId), original: event.originalStartTime };
  }
  if (event.status === "cancelled" || declined || event.eventType === "workingLocation") return { key, remove: true };
  const recurring = Array.isArray(event.recurrence) && event.recurrence.length > 0;
  const zone = recurring ? event.start?.timeZone || calendarZone : "";
  const start = moment(event.start, zone);
  const end = moment(event.end, recurring ? event.end?.timeZone || zone : "");
  if (!start) return { key, remove: true };
  const uid = event.iCalUID || `${key}@google.com`;
  const lines = [`UID:${uid}`, `DTSTAMP:${formatUtc(Date.parse(event.updated || "") || now)}`, `DTSTART${start.params}:${start.value}`];
  if (end) lines.push(`DTEND${end.params}:${end.value}`);
  if (recurring) lines.push(...event.recurrence.filter((line) => /^(RRULE|EXRULE|RDATE|EXDATE)[;:]/i.test(line)));
  if (event.recurringEventId && event.originalStartTime) {
    const original = moment(event.originalStartTime, event.originalStartTime.timeZone || calendarZone);
    if (original) lines.push(`RECURRENCE-ID${original.params}:${original.value}`);
  }
  lines.push(`SUMMARY:${escapeText(event.summary || "(No title)")}`);
  const join = event.hangoutLink || event.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video")?.uri || "";
  let description = String(event.description || "");
  if (join && !description.includes(join)) description = description ? `${description}\n\nJoin: ${join}` : `Join: ${join}`;
  if (description) lines.push(`DESCRIPTION:${escapeText(description.slice(0, 8000))}`);
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
  lines.push(`STATUS:${event.status === "tentative" ? "TENTATIVE" : "CONFIRMED"}`);
  lines.push(`TRANSP:${event.transparency === "transparent" ? "TRANSPARENT" : "OPAQUE"}`);
  if (event.visibility === "private" || event.visibility === "confidential") lines.push(`CLASS:${event.visibility.toUpperCase()}`);
  if (Number.isInteger(event.sequence)) lines.push(`SEQUENCE:${event.sequence}`);
  if (event.created) lines.push(`CREATED:${formatUtc(Date.parse(event.created))}`);
  if (event.updated) lines.push(`LAST-MODIFIED:${formatUtc(Date.parse(event.updated))}`);
  if (event.organizer?.email) lines.push(`ORGANIZER${event.organizer.displayName ? `;CN=${JSON.stringify(event.organizer.displayName.replace(/"/g, "'"))}` : ""}:mailto:${event.organizer.email}`);
  for (const attendee of (event.attendees || []).slice(0, 100)) {
    if (!attendee.email || attendee.resource) continue;
    const name = attendee.displayName ? `;CN=${JSON.stringify(attendee.displayName.replace(/"/g, "'"))}` : "";
    lines.push(`ATTENDEE${name};ROLE=${attendee.optional ? "OPT-PARTICIPANT" : "REQ-PARTICIPANT"};PARTSTAT=${PARTSTAT[attendee.responseStatus] || "NEEDS-ACTION"}:mailto:${attendee.email}`);
  }
  const text = ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
  return { key, uid, text, endsAt: endsAt(parse(text).children[0]), kind: recurring ? start.kind : "" };
}
