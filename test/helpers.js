/** A real Mongo (UBERCAL_TEST_MONGO_URL), a fake Google and a fake calendar host around a real ubercal. */
import { randomBytes } from "node:crypto";
import http from "node:http";
import { createApp } from "../src/app.js";
import { signJson, keyFrom } from "../src/secrets.js";

export const MONGO_URL = process.env.UBERCAL_TEST_MONGO_URL || "mongodb://127.0.0.1:27999";
export const SESSION_KEY = "test-session-key-for-fluxkit";

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

const b64 = (data) => Buffer.from(JSON.stringify(data)).toString("base64url");

/**
 * Google as ubercal sees it. `people` are Google accounts; `calendars[sub]` their
 * calendar lists; `events[calendarId]` a changelog, so sync tokens work like Google's.
 */
export async function fakeGoogle() {
  const state = {
    codes: new Map(), access: new Map(), refresh: new Map(), revoked: [], calendars: {}, log: new Map(), seq: 0, pageSize: 2500, gone: new Set(), requests: [], inserted: [],
  };
  const google = {
    state,
    /** The code Google would hand back for this person after consent. */
    code(person, scope = "openid email profile") {
      const code = `code-${randomBytes(6).toString("hex")}`;
      state.codes.set(code, { person, scope });
      return code;
    },
    put(calendarId, event) {
      state.seq += 1;
      if (!state.log.has(calendarId)) state.log.set(calendarId, []);
      state.log.get(calendarId).push({ seq: state.seq, event: { updated: new Date(Date.UTC(2026, 9, 1) + state.seq * 1000).toISOString(), ...event } });
    },
    current(calendarId) {
      const latest = new Map();
      for (const entry of state.log.get(calendarId) || []) latest.set(entry.event.id, entry);
      return latest;
    },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://google.test");
    state.requests.push(`${req.method} ${url.pathname}`);
    if (url.pathname === "/token" && req.method === "POST") {
      const form = new URLSearchParams(await body(req));
      if (form.get("grant_type") === "authorization_code") {
        const granted = state.codes.get(form.get("code"));
        state.codes.delete(form.get("code"));
        if (!granted || !form.get("code_verifier")) return json(res, 400, { error: "invalid_grant" });
        const access = `at-${randomBytes(6).toString("hex")}`;
        state.access.set(access, { sub: granted.person.sub, scope: granted.scope });
        const result = { access_token: access, expires_in: 3600, scope: granted.scope, id_token: `${b64({ alg: "RS256" })}.${b64({ sub: granted.person.sub, email: granted.person.email, email_verified: true, name: granted.person.name || "" })}.sig` };
        if (granted.scope.includes("calendar")) {
          const refresh = `rt-${randomBytes(6).toString("hex")}`;
          state.refresh.set(refresh, { sub: granted.person.sub, scope: granted.scope });
          result.refresh_token = refresh;
        }
        return json(res, 200, result);
      }
      if (form.get("grant_type") === "refresh_token") {
        const grant = state.refresh.get(form.get("refresh_token"));
        if (!grant) return json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
        const access = `at-${randomBytes(6).toString("hex")}`;
        state.access.set(access, grant);
        return json(res, 200, { access_token: access, expires_in: 3600 });
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/revoke") {
      const tokenValue = new URLSearchParams(await body(req)).get("token");
      state.revoked.push(tokenValue);
      state.refresh.delete(tokenValue);
      return json(res, 200, {});
    }
    const grant = state.access.get(String(req.headers.authorization || "").replace(/^Bearer /, ""));
    const sub = grant?.sub;
    if (!sub) return json(res, 401, { error: { message: "Invalid Credentials", errors: [{ reason: "authError" }] } });
    if (url.pathname === "/calendar/v3/users/me/calendarList") return json(res, 200, { items: state.calendars[sub] || [] });
    const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(url.pathname);
    if (match && req.method === "POST") {
      if (!/calendar\.events/.test(grant.scope)) return json(res, 403, { error: { message: "Request had insufficient authentication scopes.", errors: [{ reason: "insufficientPermissions" }] } });
      const event = JSON.parse(await body(req));
      const id = `booked${state.inserted.length + 1}`;
      state.inserted.push({ calendarId: decodeURIComponent(match[1]), query: Object.fromEntries(url.searchParams), event });
      return json(res, 200, { id, htmlLink: `https://calendar.google.com/event?eid=${id}`, ...(event.conferenceData ? { hangoutLink: "https://meet.google.com/abc-defg-hij" } : {}) });
    }
    if (match) {
      const calendarId = decodeURIComponent(match[1]);
      if (!(state.calendars[sub] || []).some((calendar) => calendar.id === calendarId)) return json(res, 404, { error: { message: "Not Found", errors: [{ reason: "notFound" }] } });
      const syncToken = url.searchParams.get("syncToken");
      if (syncToken && state.gone.has(syncToken)) return json(res, 410, { error: { message: "Sync token is no longer valid", errors: [{ reason: "fullSyncRequired" }] } });
      const since = syncToken ? Number(syncToken.replace("sync-", "")) : 0;
      let items = [...google.current(calendarId).values()].filter((entry) => entry.seq > since).map((entry) => entry.event);
      if (!syncToken) items = items.filter((event) => event.status !== "cancelled" || event.recurringEventId);
      const offset = Number(url.searchParams.get("pageToken") || 0);
      const page = items.slice(offset, offset + state.pageSize);
      const more = offset + state.pageSize < items.length;
      return json(res, 200, { items: page, ...(more ? { nextPageToken: String(offset + state.pageSize) } : { nextSyncToken: `sync-${state.seq}` }) });
    }
    json(res, 404, { error: { message: "Not Found" } });
  });
  const port = await listen(server);
  google.base = `http://127.0.0.1:${port}`;
  google.close = () => new Promise((resolve) => server.close(resolve));
  return google;
}

/** A host serving calendar files with ETags; `hits` counts full and 304 answers. */
export async function fakeHost() {
  const files = new Map();
  const hits = [];
  const server = http.createServer((req, res) => {
    const file = files.get(req.url);
    if (!file) {
      hits.push(`${req.url} 404`);
      res.writeHead(404);
      return res.end("nope");
    }
    if (file.redirect) {
      hits.push(`${req.url} 302`);
      res.writeHead(302, { Location: file.redirect });
      return res.end();
    }
    const etag = `"${Buffer.from(file.body).length}-${file.version}"`;
    if (req.headers["if-none-match"] === etag) {
      hits.push(`${req.url} 304`);
      res.writeHead(304, { ETag: etag });
      return res.end();
    }
    hits.push(`${req.url} 200`);
    res.writeHead(200, { "Content-Type": "text/calendar", ETag: etag });
    res.end(file.body);
  });
  const port = await listen(server);
  const host = {
    base: `http://127.0.0.1:${port}`,
    hits,
    serve(path, body) {
      const previous = files.get(path);
      files.set(path, { body, version: (previous?.version || 0) + 1 });
      return `${host.base}${path}`;
    },
    redirect(path, to) { files.set(path, { redirect: to }); },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
  return host;
}

/** Resend as ubercal sees it: every email it is asked to send lands in `sent`. */
export async function fakeResend() {
  const sent = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "POST" && req.url === "/emails" && req.headers.authorization === "Bearer re_test") {
      const email = JSON.parse(await body(req));
      sent.push(email);
      return json(res, 200, { id: `email-${sent.length}` });
    }
    json(res, 401, { name: "validation_error", message: "API key is invalid" });
  });
  const port = await listen(server);
  return { base: `http://127.0.0.1:${port}`, sent, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** A running ubercal on its own database, with a clock the test moves. */
export async function startApp(t, { google, resend, allowPrivate = true, publicHost = "127.0.0.1", cookieDomain = "" } = {}) {
  const port = await freePort();
  const clock = { now: Date.UTC(2026, 9, 31, 9, 0, 0) };
  const database = `ubercal_test_${randomBytes(5).toString("hex")}`;
  const settings = {
    port, host: "127.0.0.1", publicUrl: `http://${publicHost}:${port}`, mongoUrl: `${MONGO_URL}/${database}`, mongoPassword: "",
    sessionKey: SESSION_KEY, cookieDomain, dataKey: "test-data-key-for-ubercal",
    googleClientId: google ? "client-id" : "", googleClientSecret: google ? "client-secret" : "",
    googleAuthUrl: google ? `${google.base}/auth` : "", googleTokenUrl: google ? `${google.base}/token` : "",
    googleApiBase: google ? `${google.base}/calendar/v3` : "", googleRevokeUrl: google ? `${google.base}/revoke` : "",
    syncMinutes: 5, allowPrivate, webDir: new URL("../web", import.meta.url).pathname,
    resendKey: resend ? "re_test" : "", resendApi: resend ? resend.base : "", mailFrom: "ubercal <bookings@fluxkit.test>",
  };
  const logs = [];
  const app = await createApp(settings, { now: () => clock.now, log: (...parts) => logs.push(parts.join(" ")) });
  await new Promise((resolve) => app.server.listen(port, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    await app.db.db.dropDatabase();
    await app.close();
  });
  return { app, base, clock, settings, logs, origin: settings.publicUrl };
}

/** A fetch that never follows redirects, with the cookies given. */
export function request(base, path, { method = "GET", cookie = "", body, headers = {}, origin } = {}) {
  return fetch(`${base}${path}`, {
    method, redirect: "manual",
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(origin ? { Origin: origin } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

function cookiesOf(response) {
  return response.headers.getSetCookie().map((line) => line.split(";")[0]).filter((pair) => !pair.endsWith("="));
}

/** The whole Google sign-in, as a browser would go through it: the Fluxkit session cookie. */
export async function signIn(running, google, person) {
  const start = await request(running.base, "/auth/google?next=/app");
  const flow = cookiesOf(start).join("; ");
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const back = await request(running.base, `/auth/google/callback?code=${google.code(person)}&state=${state}`, { cookie: flow });
  const session = cookiesOf(back).find((pair) => pair.startsWith("fluxkit_session="));
  if (!session) throw new Error(`sign-in failed: ${back.status} ${back.headers.get("location")}`);
  return session;
}

/** Google's calendar consent for `person`, made while signed in as `cookie`. */
export async function connectCalendars(running, google, cookie, person, scope = "openid email https://www.googleapis.com/auth/calendar.readonly", write = false) {
  const start = await request(running.base, `/auth/google/calendar${write ? "?write=1" : ""}`, { cookie });
  const flow = cookiesOf(start).join("; ");
  const location = new URL(start.headers.get("location"));
  const back = await request(running.base, `/auth/google/callback?code=${google.code(person, scope)}&state=${location.searchParams.get("state")}`, { cookie: `${cookie}; ${flow}` });
  return { response: back, authorize: location };
}

export async function api(running, cookie, method, path, body) {
  const response = await request(running.base, `/api${path}`, { method, cookie, body, origin: running.origin });
  const data = await response.json().catch(() => null);
  return { status: response.status, data };
}

/** A session another Fluxkit tool would have set for this Google account. */
export function foreignSession(person, exp = Date.UTC(2026, 11, 1)) {
  return `fluxkit_session=${encodeURIComponent(signJson(keyFrom(SESSION_KEY), { sub: person.sub, email: person.email, name: person.name || "", exp }))}`;
}

export function ics(...events) {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", "X-WR-CALNAME:Team rota", ...events, "END:VCALENDAR", ""].join("\r\n");
}
