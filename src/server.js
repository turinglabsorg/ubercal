/**
 * The site: the landing, the app behind Google sign-in, its JSON API, and the
 * feeds themselves at their secret links. One process, no framework.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { ObjectId } from "mongodb";
import { buildFeed, REFRESH_MINUTES, SHOWS } from "./feeds.js";
import { CALENDAR_SCOPES, GoogleError, SIGN_IN_SCOPES } from "./google.js";
import { normalizeUrl } from "./net.js";
import { open, seal, signJson, token, verifyJson } from "./secrets.js";
import { accessToken, rebuildFeeds, syncSource } from "./sync.js";

// The Fluxkit session: every Fluxkit tool on a fluxkit.dev subdomain reads the same signed cookie.
const SESSION = "fluxkit_session";
const OAUTH = "ubercal_oauth";
const SESSION_DAYS = 30;
export const LIMITS = { sources: 25, feeds: 10 };
const PAST_DAYS = [0, 7, 30, 90, 365];
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".webmanifest": "application/manifest+json",
};
const PAGE_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data: https://*.googleusercontent.com; style-src 'self'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function send(res, status, body, headers = {}) {
  const json = typeof body !== "string";
  res.writeHead(status, { "Content-Type": json ? "application/json; charset=utf-8" : "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers });
  res.end(json ? JSON.stringify(body) : body);
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store", ...headers });
  res.end();
}

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) throw new HttpError(415, "Send JSON.");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, "Too large.");
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, "Send a JSON object.");
  }
}

function objectId(value) {
  try { return new ObjectId(String(value)); } catch { throw new HttpError(404, "Not found."); }
}

function cleanName(value, fallback) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  return text || fallback;
}

export function createServer(context, config) {
  const { db, google, dataKey } = context;
  const sessionKey = config.sessionKey;
  const publicUrl = config.publicUrl.replace(/\/$/, "");
  const origin = new URL(publicUrl).origin;
  const secure = publicUrl.startsWith("https:");
  const redirectUri = `${publicUrl}/auth/google/callback`;
  const webDir = config.webDir;
  const recent = new Map();

  const host = new URL(publicUrl).hostname;
  const sharedDomain = config.cookieDomain && (host === config.cookieDomain || host.endsWith(`.${config.cookieDomain}`)) ? config.cookieDomain : "";
  const cookie = (name, value, { maxAge, path = "/", shared = false } = {}) =>
    `${name}=${encodeURIComponent(value)}; Path=${path}${shared && sharedDomain ? `; Domain=${sharedDomain}` : ""}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}${maxAge !== undefined ? `; Max-Age=${maxAge}` : ""}`;
  const sessionCookie = (value, maxAge) => cookie(SESSION, value, { maxAge, shared: true });

  /** The person behind the Fluxkit session; someone who signed in on another Fluxkit tool gets an ubercal account here. */
  async function currentUser(req) {
    const session = verifyJson(sessionKey, parseCookies(req.headers.cookie)[SESSION], context.now());
    if (!session?.sub || !session.email) return null;
    const known = await db.users.findOne({ googleSub: String(session.sub) });
    if (known) return known;
    return enroll({ sub: session.sub, email: session.email, name: session.name, picture: session.picture });
  }

  async function enroll(claims) {
    const now = new Date(context.now());
    const user = await db.users.findOneAndUpdate(
      { googleSub: String(claims.sub) },
      { $set: { email: claims.email, name: String(claims.name || "").slice(0, 120), picture: /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//.test(claims.picture || "") ? claims.picture : "", lastLoginAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true, returnDocument: "after" },
    );
    if (!(await db.feeds.countDocuments({ userId: user._id }))) await createFeed(user, { name: "All my calendars", others: "full" });
    return user;
  }

  function throttle(key, limit, windowMs) {
    const now = context.now();
    const hits = (recent.get(key) || []).filter((at) => at > now - windowMs);
    if (hits.length >= limit) throw new HttpError(429, "Too many requests: wait a minute.");
    hits.push(now);
    recent.set(key, hits);
    if (recent.size > 5000) for (const [entry, times] of recent) if (!times.some((at) => at > now - windowMs)) recent.delete(entry);
  }

  function feedView(feed) {
    const url = `${publicUrl}/feed/${feed.token}.ics`;
    return {
      id: String(feed._id), name: feed.name, url, webcal: url.replace(/^https?:/, "webcal:"), calendars: feed.calendars || {}, others: feed.others || "full", pastDays: feed.pastDays || 0, count: feed.count || 0, builtAt: feed.builtAt || null, changedAt: feed.changedAt || null, fetchedAt: feed.fetchedAt || null, error: feed.error || "",
    };
  }

  function sourceView(source) {
    return {
      id: String(source._id), kind: source.kind, name: source.name, enabled: source.enabled !== false, status: source.status || "pending", error: source.error || "",
      syncedAt: source.syncedAt || null, changedAt: source.changedAt || null, eventCount: source.eventCount || 0, color: source.color || "",
      connectionId: source.connectionId ? String(source.connectionId) : null, calendarId: source.calendarId || null, host: source.host || null,
    };
  }

  async function state(user) {
    const [connections, sources, feeds, lease] = await Promise.all([
      db.connections.find({ userId: user._id }).sort({ createdAt: 1 }).toArray(),
      db.sources.find({ userId: user._id }).sort({ createdAt: 1 }).toArray(),
      db.feeds.find({ userId: user._id }, { projection: { ics: 0 } }).sort({ createdAt: 1 }).toArray(),
      db.leases.findOne({ _id: "sync" }),
    ]);
    const last = lease?.finishedAt || null;
    return {
      user: { email: user.email, name: user.name || "", picture: user.picture || "" },
      google: { configured: google.configured },
      connections: connections.map((connection) => ({ id: String(connection._id), email: connection.email, status: connection.status || "ok" })),
      sources: sources.map(sourceView),
      feeds: feeds.map(feedView),
      sync: { minutes: REFRESH_MINUTES, lastRunAt: last, nextRunAt: last ? new Date(last.getTime() + REFRESH_MINUTES * 60000) : null },
      limits: LIMITS,
    };
  }

  async function feedSettings(user, body, current = {}) {
    const settings = {};
    if (body.name !== undefined || !current.name) settings.name = cleanName(body.name, current.name || "My calendars");
    if (body.others !== undefined) {
      if (!SHOWS.includes(body.others)) throw new HttpError(400, "A calendar is shown in full, as busy time, or not at all.");
      settings.others = body.others;
    }
    if (body.pastDays !== undefined) {
      if (!PAST_DAYS.includes(Number(body.pastDays))) throw new HttpError(400, "Choose how far back the feed goes.");
      settings.pastDays = Number(body.pastDays);
    }
    if (body.calendars !== undefined) {
      const entries = body.calendars && typeof body.calendars === "object" && !Array.isArray(body.calendars) ? Object.entries(body.calendars) : null;
      if (!entries || entries.length > LIMITS.sources || entries.some(([, show]) => !SHOWS.includes(show))) throw new HttpError(400, "A calendar is shown in full, as busy time, or not at all.");
      const ids = entries.map(([id]) => objectId(id));
      const owned = await db.sources.countDocuments({ _id: { $in: ids }, userId: user._id });
      if (owned !== ids.length) throw new HttpError(400, "Choose calendars from your list.");
      settings.calendars = Object.fromEntries(entries.map(([id, show]) => [String(objectId(id)), show]));
    }
    return settings;
  }

  async function createFeed(user, body) {
    if ((await db.feeds.countDocuments({ userId: user._id })) >= LIMITS.feeds) throw new HttpError(400, `You can have ${LIMITS.feeds} feeds.`);
    const now = new Date(context.now());
    const feed = { userId: user._id, token: token(), name: "My calendars", calendars: {}, others: "full", pastDays: 90, createdAt: now, ...(await feedSettings(user, body)) };
    const { insertedId } = await db.feeds.insertOne(feed);
    return buildFeed(db, { ...feed, _id: insertedId }, context.now());
  }

  async function ownSource(user, id) {
    const source = await db.sources.findOne({ _id: objectId(id), userId: user._id });
    if (!source) throw new HttpError(404, "This calendar is not in your list.");
    return source;
  }

  async function removeSources(user, filter) {
    const sources = await db.sources.find({ ...filter, userId: user._id }, { projection: { _id: 1 } }).toArray();
    const ids = sources.map((source) => source._id);
    if (!ids.length) return;
    await db.events.deleteMany({ sourceId: { $in: ids } });
    await db.sources.deleteMany({ _id: { $in: ids } });
    await db.feeds.updateMany({ userId: user._id }, { $unset: Object.fromEntries(ids.map((id) => [`calendars.${id}`, ""])) });
  }

  async function addSource(user, body) {
    if ((await db.sources.countDocuments({ userId: user._id })) >= LIMITS.sources) throw new HttpError(400, `You can merge up to ${LIMITS.sources} calendars.`);
    const now = new Date(context.now());
    let source;
    if (body.kind === "google") {
      const connection = await db.connections.findOne({ _id: objectId(body.connectionId), userId: user._id });
      if (!connection) throw new HttpError(404, "Connect this Google account first.");
      const calendarId = String(body.calendarId || "");
      if (await db.sources.findOne({ userId: user._id, connectionId: connection._id, calendarId })) throw new HttpError(409, "This calendar is already in your list.");
      const calendars = await google.calendars(await accessToken(context, connection));
      const calendar = calendars.find((entry) => entry.id === calendarId);
      if (!calendar) throw new HttpError(404, `${connection.email} cannot see this calendar.`);
      source = { userId: user._id, kind: "google", name: cleanName(body.name, calendar.name), connectionId: connection._id, calendarId, color: calendar.color, timeZone: calendar.timeZone, enabled: true, status: "pending", createdAt: now };
    } else if (body.kind === "link") {
      let url;
      try { url = normalizeUrl(body.url, { allowPrivate: context.allowPrivate }); } catch (error) { throw new HttpError(400, error.message); }
      const urlHash = createHash("sha256").update(`${user._id}\n${url}`).digest("base64url");
      if (await db.sources.findOne({ userId: user._id, urlHash })) throw new HttpError(409, "This link is already in your list.");
      source = { userId: user._id, kind: "link", name: cleanName(body.name, url.hostname), url: seal(dataKey, url.toString()), urlHash, host: url.hostname, enabled: true, status: "pending", createdAt: now };
    } else {
      throw new HttpError(400, "Add a Google calendar or a calendar link.");
    }
    const { insertedId } = await db.sources.insertOne(source);
    source._id = insertedId;
    await syncSource(context, source);
    if (source.kind === "link") {
      // A link that cannot be read the first time is not kept: the person sees why at once.
      const synced = await db.sources.findOne({ _id: insertedId });
      if (synced.status === "error") {
        await removeSources(user, { _id: insertedId });
        throw new HttpError(400, synced.error);
      }
      if (!body.name && synced.calendarName) await db.sources.updateOne({ _id: insertedId }, { $set: { name: cleanName(synced.calendarName, source.name) } });
    }
    await rebuildFeeds(context, [user._id]);
    return sourceView(await db.sources.findOne({ _id: insertedId }));
  }

  async function startGoogle(res, { purpose, next = "/app", loginHint = "" }) {
    if (!google.configured) return redirect(res, `/?problem=${encodeURIComponent("Google sign-in is not open yet. Try again soon.")}`);
    const state = token(18);
    const verifier = randomBytes(48).toString("base64url");
    const flow = signJson(sessionKey, { state, verifier, purpose, next, exp: context.now() + 10 * 60000 });
    const calendar = purpose === "calendar";
    const location = google.authorizeUrl({ scopes: calendar ? CALENDAR_SCOPES : SIGN_IN_SCOPES, state, verifier, redirectUri, offline: calendar, loginHint, selectAccount: !calendar });
    redirect(res, location, { "Set-Cookie": cookie(OAUTH, flow, { maxAge: 600, path: "/auth" }) });
  }

  async function finishGoogle(req, res, url) {
    const flow = verifyJson(sessionKey, parseCookies(req.headers.cookie)[OAUTH], context.now());
    const clear = cookie(OAUTH, "", { maxAge: 0, path: "/auth" });
    const back = (where, problem) => redirect(res, `${where}${where.includes("?") ? "&" : "?"}problem=${encodeURIComponent(problem)}`, { "Set-Cookie": clear });
    if (!flow || flow.state !== url.searchParams.get("state")) return back("/", "The sign-in took too long or was opened twice: try again.");
    if (url.searchParams.get("error")) return back(flow.purpose === "calendar" ? "/app" : "/", flow.purpose === "calendar" ? "Google did not share the calendars." : "Google sign-in was cancelled.");
    let granted;
    try {
      granted = await google.exchangeCode({ code: url.searchParams.get("code") || "", verifier: flow.verifier, redirectUri });
    } catch (error) {
      context.log?.("google code exchange failed", error?.code || error?.message);
      return back("/", "Google did not confirm the sign-in: try again.");
    }
    const claims = granted.claims;
    if (!claims.sub || !claims.email || claims.email_verified === false) return back("/", "This Google account has no verified email.");
    const now = new Date(context.now());
    if (flow.purpose === "calendar") {
      const user = await currentUser(req);
      if (!user) return back("/", "Sign in first.");
      if (!granted.scope.includes("calendar.readonly")) return back("/app", "ubercal can only merge calendars Google lets it read: tick the calendar box.");
      const existing = await db.connections.findOne({ userId: user._id, googleSub: claims.sub });
      if (!granted.refreshToken && !existing) return back("/app", "Google did not give lasting access: remove ubercal from your Google account's apps and connect again.");
      const fields = {
        email: claims.email, status: "ok", accessToken: seal(dataKey, granted.accessToken), accessExpiresAt: new Date(context.now() + granted.expiresIn * 1000), scope: granted.scope, updatedAt: now,
        ...(granted.refreshToken ? { refreshToken: seal(dataKey, granted.refreshToken) } : {}),
      };
      const connection = await db.connections.findOneAndUpdate(
        { userId: user._id, googleSub: claims.sub },
        { $set: fields, $setOnInsert: { createdAt: now } },
        { upsert: true, returnDocument: "after" },
      );
      if (existing) await db.sources.updateMany({ connectionId: connection._id }, { $set: { status: "pending", error: "" } });
      return redirect(res, `/app?connected=${connection._id}`, { "Set-Cookie": clear });
    }
    const user = await enroll(claims);
    const session = signJson(sessionKey, { sub: String(claims.sub), email: user.email, name: user.name, picture: user.picture, exp: context.now() + SESSION_DAYS * 86400000 });
    const next = typeof flow.next === "string" && flow.next.startsWith("/") && !flow.next.startsWith("//") ? flow.next : "/app";
    res.writeHead(302, { Location: next, "Cache-Control": "no-store", "Set-Cookie": [clear, sessionCookie(session, SESSION_DAYS * 86400)] });
    res.end();
  }

  async function serveFeed(req, res, feedToken) {
    const feed = await db.feeds.findOne({ token: feedToken });
    if (!feed) return send(res, 404, "No calendar at this link. It may have been replaced by a new link.");
    let built = feed;
    if (!feed.ics) built = (await buildFeed(db, feed, context.now())) || feed;
    if (!built.ics) return send(res, 503, "This calendar is not ready yet.");
    if (!feed.fetchedAt || context.now() - feed.fetchedAt.getTime() > 60000) {
      db.feeds.updateOne({ _id: feed._id }, { $set: { fetchedAt: new Date(context.now()) } }).catch(() => {});
    }
    const headers = {
      "Content-Type": "text/calendar; charset=utf-8", ETag: built.etag, "Cache-Control": "private, max-age=300",
      "Content-Disposition": `inline; filename="${(feed.name || "ubercal").replace(/[^A-Za-z0-9 ._-]/g, "").trim() || "ubercal"}.ics"`,
      "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex",
    };
    if (req.headers["if-none-match"] === built.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : built.ics);
  }

  async function serveFile(req, res, relative, { page = false } = {}) {
    const path = normalize(join(webDir, relative));
    if (!path.startsWith(webDir + sep)) return send(res, 404, "Not found.");
    let body;
    try {
      if (!(await stat(path)).isFile()) throw new Error();
      body = await readFile(path);
    } catch {
      return send(res, 404, "Not found.");
    }
    const type = MIME[extname(path)] || "application/octet-stream";
    const cache = page ? "no-cache" : extname(path) === ".woff2" ? "public, max-age=31536000, immutable" : "public, max-age=3600";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": cache, ...(page ? PAGE_HEADERS : { "X-Content-Type-Options": "nosniff" }) });
    res.end(req.method === "HEAD" ? undefined : body);
  }

  async function api(req, res, url, user) {
    const method = req.method;
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    if (method !== "GET") {
      const from = req.headers.origin;
      if (from && from !== origin) throw new HttpError(403, "Wrong origin.");
    }
    // A request with nothing to say (read now, new address) carries no body; one that does must be JSON.
    const empty = !req.headers["content-type"] && !Number(req.headers["content-length"] || 0) && !req.headers["transfer-encoding"];
    const body = ["POST", "PATCH", "PUT"].includes(method) && !empty ? await readJson(req) : {};
    const [area, id, action] = parts;
    if (area === "me" && method === "GET") return send(res, 200, await state(user));
    if (area === "account" && method === "DELETE") {
      for (const connection of await db.connections.find({ userId: user._id }).toArray()) {
        try { await google.revoke(open(dataKey, connection.refreshToken)); } catch {}
      }
      await removeSources(user, {});
      await Promise.all([db.feeds.deleteMany({ userId: user._id }), db.connections.deleteMany({ userId: user._id }), db.users.deleteOne({ _id: user._id })]);
      return send(res, 200, { ok: true }, { "Set-Cookie": sessionCookie("", 0) });
    }
    if (area === "connections" && id) {
      const connection = await db.connections.findOne({ _id: objectId(id), userId: user._id });
      if (!connection) throw new HttpError(404, "This Google account is not connected.");
      if (action === "calendars" && method === "GET") {
        let calendars;
        try {
          calendars = await google.calendars(await accessToken(context, connection));
        } catch (error) {
          throw new HttpError(502, error instanceof GoogleError ? `Google Calendar: ${error.message}` : error.message);
        }
        const added = new Map((await db.sources.find({ userId: user._id, connectionId: connection._id }).toArray()).map((source) => [source.calendarId, String(source._id)]));
        return send(res, 200, { calendars: calendars.map((calendar) => ({ ...calendar, sourceId: added.get(calendar.id) || null })) });
      }
      if (!action && method === "DELETE") {
        try { await google.revoke(open(dataKey, connection.refreshToken)); } catch {}
        await removeSources(user, { connectionId: connection._id });
        await db.connections.deleteOne({ _id: connection._id });
        await rebuildFeeds(context, [user._id]);
        return send(res, 200, await state(user));
      }
    }
    if (area === "sources") {
      if (!id && method === "POST") {
        throttle(`add:${user._id}`, 12, 60000);
        const source = await addSource(user, body);
        return send(res, 201, { source, state: await state(user) });
      }
      if (id && !action && method === "PATCH") {
        const source = await ownSource(user, id);
        const update = {};
        if (body.name !== undefined) update.name = cleanName(body.name, source.name);
        if (body.enabled !== undefined) update.enabled = Boolean(body.enabled);
        await db.sources.updateOne({ _id: source._id }, { $set: update });
        if (update.enabled === true && source.enabled === false) await syncSource(context, { ...source, ...update });
        await rebuildFeeds(context, [user._id]);
        return send(res, 200, await state(user));
      }
      if (id && !action && method === "DELETE") {
        await ownSource(user, id);
        await removeSources(user, { _id: objectId(id) });
        await rebuildFeeds(context, [user._id]);
        return send(res, 200, await state(user));
      }
      if (id && action === "sync" && method === "POST") {
        const source = await ownSource(user, id);
        if (source.syncedAt && context.now() - source.syncedAt.getTime() < 30000) throw new HttpError(429, "This calendar was read a moment ago.");
        throttle(`sync:${user._id}`, 10, 60000);
        await syncSource(context, source);
        await rebuildFeeds(context, [user._id]);
        return send(res, 200, await state(user));
      }
    }
    if (area === "feeds") {
      if (!id && method === "POST") {
        await createFeed(user, body);
        return send(res, 201, await state(user));
      }
      const feed = id ? await db.feeds.findOne({ _id: objectId(id), userId: user._id }) : null;
      if (id && !feed) throw new HttpError(404, "This feed is not yours.");
      if (feed && !action && method === "PATCH") {
        const settings = await feedSettings(user, body, feed);
        await db.feeds.updateOne({ _id: feed._id }, { $set: settings });
        await buildFeed(db, { ...feed, ...settings }, context.now());
        return send(res, 200, await state(user));
      }
      if (feed && action === "rotate" && method === "POST") {
        await db.feeds.updateOne({ _id: feed._id }, { $set: { token: token(), fetchedAt: null } });
        return send(res, 200, await state(user));
      }
      if (feed && !action && method === "DELETE") {
        await db.feeds.deleteOne({ _id: feed._id });
        return send(res, 200, await state(user));
      }
    }
    throw new HttpError(404, "Not found.");
  }

  async function handle(req, res) {
    const url = new URL(req.url, publicUrl);
    const path = url.pathname;
    if (path === "/healthz") return send(res, 200, "ok");
    const feedMatch = /^\/feed\/([A-Za-z0-9_-]{16,64})(?:\.ics)?$/.exec(path);
    if (feedMatch && (req.method === "GET" || req.method === "HEAD")) return serveFeed(req, res, feedMatch[1]);
    if (path === "/auth/google" && req.method === "GET") return startGoogle(res, { purpose: "signin", next: url.searchParams.get("next") || "/app" });
    if (path === "/auth/google/calendar" && req.method === "GET") {
      const user = await currentUser(req);
      if (!user) return redirect(res, "/auth/google?next=/app");
      return startGoogle(res, { purpose: "calendar", loginHint: url.searchParams.get("hint") === "self" ? user.email : "" });
    }
    if (path === "/auth/google/callback" && req.method === "GET") return finishGoogle(req, res, url);
    if (path === "/auth/session" && req.method === "GET") return send(res, 200, { signedIn: Boolean(await currentUser(req)) });
    if (path === "/auth/logout" && req.method === "POST") {
      const from = req.headers.origin;
      if (from && from !== origin) throw new HttpError(403, "Wrong origin.");
      return redirect(res, "/", { "Set-Cookie": sessionCookie("", 0) });
    }
    if (path.startsWith("/api/")) {
      const user = await currentUser(req);
      if (!user) throw new HttpError(401, "Sign in with Google.");
      return api(req, res, url, user);
    }
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Not allowed.");
    if (path === "/" || path === "/index.html") return serveFile(req, res, "index.html", { page: true });
    if (path === "/app") {
      if (!(await currentUser(req))) return redirect(res, "/auth/google?next=/app");
      return serveFile(req, res, "app.html", { page: true });
    }
    if (/^\/[a-z0-9-]+\.(?:svg|png|ico|txt|webmanifest)$/.test(path)) return serveFile(req, res, path.slice(1));
    if (path.startsWith("/static/")) return serveFile(req, res, path.slice(1));
    throw new HttpError(404, "Not found.");
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      // A feed's path is its secret: logs name the route, never the token.
      context.log?.("request failed", req.method, String(req.url || "").split("?")[0].replace(/^\/feed\/.*/, "/feed/…"), error?.stack || error);
      send(res, 500, { error: "Something went wrong on our side." });
    });
  });
}
