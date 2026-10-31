/**
 * The sync: every source read again (a link through its ETag, a Google calendar
 * through its sync token), then every feed whose calendars changed rebuilt. It runs
 * every five minutes in the resident process, at once for a source just added, and
 * when a calendar app asks for a link whose calendars were read over a minute ago.
 */
import { createHash, randomUUID } from "node:crypto";
import { calendars, prop, serialize } from "./ics.js";
import { endsAt, identity } from "./events.js";
import { buildFeed, feedSources } from "./feeds.js";
import { eventRecord, GoogleError } from "./google.js";
import { fetchCalendar } from "./net.js";
import { open, seal } from "./secrets.js";

const MAX_EVENTS = 20000;
const PARALLEL = 6;
const DAY = 86400000;

export class SyncError extends Error {}

function asDate(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms) : null;
}

async function writeEvents(db, source, records, generation, { replace }) {
  const operations = [];
  for (const record of records) {
    if (record.remove) {
      operations.push({ deleteOne: { filter: { sourceId: source._id, key: record.key } } });
      operations.push({ deleteMany: { filter: { sourceId: source._id, $or: [{ cancelledOf: record.key }, { masterKey: record.key }] } } });
      continue;
    }
    const fields = record.cancelledOf
      ? { userId: source.userId, cancelledOf: record.cancelledOf, original: record.original, text: null, uid: null, generation }
      : { userId: source.userId, uid: record.uid, text: record.text, endsAt: asDate(record.endsAt), kind: record.kind || "", masterKey: record.masterKey || null, cancelledOf: null, generation };
    operations.push({ updateOne: { filter: { sourceId: source._id, key: record.key }, update: { $set: fields }, upsert: true } });
  }
  for (let index = 0; index < operations.length; index += 1000) await db.events.bulkWrite(operations.slice(index, index + 1000), { ordered: true });
  if (replace) await db.events.deleteMany({ sourceId: source._id, generation: { $ne: generation } });
}

/** A calendar link: read only when it changed, then its events replace the previous ones. */
async function syncLink(context, source) {
  const { db, dataKey, allowPrivate } = context;
  const fetched = await fetchCalendar(open(dataKey, source.url), { etag: source.etag || "", lastModified: source.lastModified || "", allowPrivate });
  if (fetched.status === 304) return false;
  const hash = createHash("sha256").update(fetched.body).digest("base64url");
  if (hash === source.bodyHash) {
    await db.sources.updateOne({ _id: source._id }, { $set: { etag: fetched.etag, lastModified: fetched.lastModified } });
    return false;
  }
  const records = new Map();
  const timezones = new Map();
  let calendarName = "";
  for (const calendar of calendars(fetched.body)) {
    calendarName ||= prop(calendar, "X-WR-CALNAME")?.value || "";
    for (const component of calendar.children) {
      if (component.name === "VTIMEZONE") {
        const tzid = prop(component, "TZID")?.value;
        if (tzid && !timezones.has(tzid)) timezones.set(tzid, serialize(component));
      } else if (component.name === "VEVENT") {
        const { uid, key } = identity(component, String(source._id));
        if (records.has(key)) continue;
        if (records.size >= MAX_EVENTS) throw new SyncError(`This calendar has more than ${MAX_EVENTS} events.`);
        records.set(key, { key, uid, text: serialize(component), endsAt: endsAt(component) });
      }
    }
  }
  const generation = (source.generation || 0) + 1;
  await writeEvents(db, source, [...records.values()], generation, { replace: true });
  await db.sources.updateOne({ _id: source._id }, {
    $set: {
      etag: fetched.etag, lastModified: fetched.lastModified, bodyHash: hash, generation, eventCount: records.size,
      timezones: [...timezones].map(([tzid, text]) => ({ tzid, text })), calendarName: calendarName.slice(0, 200),
    },
  });
  return true;
}

/** A connection's access token, refreshed when it is about to expire (or Google refused it). */
export async function accessToken(context, connection, force = false) {
  const { db, dataKey, google, now } = context;
  if (!force && connection.accessToken && connection.accessExpiresAt?.getTime() > now() + 60000) return open(dataKey, connection.accessToken);
  let fresh;
  try {
    fresh = await google.refresh(open(dataKey, connection.refreshToken));
  } catch (error) {
    if (error instanceof GoogleError && (error.code === "invalid_grant" || error.status === 400 || error.status === 401)) {
      await db.connections.updateOne({ _id: connection._id }, { $set: { status: "revoked" } });
      throw new SyncError(`Google no longer gives access to ${connection.email}: connect it again.`);
    }
    throw error;
  }
  const expires = new Date(now() + fresh.expiresIn * 1000);
  await db.connections.updateOne({ _id: connection._id }, { $set: { accessToken: seal(dataKey, fresh.accessToken), accessExpiresAt: expires, status: "ok" } });
  Object.assign(connection, { accessToken: seal(dataKey, fresh.accessToken), accessExpiresAt: expires });
  return fresh.accessToken;
}

/** A Google calendar: the changes since its sync token, or all of it when Google asks for a fresh start. */
async function syncGoogle(context, source) {
  const { db, google } = context;
  const connection = await db.connections.findOne({ _id: source.connectionId });
  if (!connection) throw new SyncError("The Google account of this calendar was removed.");
  if (connection.status === "revoked") throw new SyncError(`Google no longer gives access to ${connection.email}: connect it again.`);
  let token = await accessToken(context, connection);
  let full = !source.syncToken;
  let listed;
  for (let attempt = 0; ; attempt += 1) {
    try {
      listed = await google.events(token, source.calendarId, full ? "" : source.syncToken);
      break;
    } catch (error) {
      if (attempt > 1 || !(error instanceof GoogleError)) throw error;
      if (error.status === 410) full = true;
      else if (error.status === 401) token = await accessToken(context, connection, true);
      else if (error.status === 404 || error.status === 403) throw new SyncError(`${connection.email} can no longer see this calendar.`);
      else throw error;
    }
  }
  if (full && listed.items.length > MAX_EVENTS) throw new SyncError(`This calendar has more than ${MAX_EVENTS} events.`);
  const generation = full ? (source.generation || 0) + 1 : source.generation || 0;
  const records = listed.items.map((item) => ({ ...eventRecord(item, source.timeZone || "", context.now()), masterKey: item.recurringEventId ? String(item.recurringEventId) : null }));
  await writeEvents(db, source, records, generation, { replace: full });
  const eventCount = await db.events.countDocuments({ sourceId: source._id, text: { $ne: null } });
  await db.sources.updateOne({ _id: source._id }, { $set: { syncToken: listed.syncToken || "", generation, eventCount } });
  return full || listed.items.length > 0;
}

function friendly(error) {
  if (error instanceof SyncError) return error.message;
  if (error?.constructor?.name === "FetchError") return error.message;
  if (error instanceof GoogleError) return `Google Calendar: ${error.message}`;
  return "This calendar could not be read.";
}

/** One source read now; its status says how it went. Whether its events changed. A source already being read is not read twice. */
export function syncSource(context, source) {
  const reading = (context.reading ||= new Map());
  const key = String(source._id);
  if (!reading.has(key)) reading.set(key, readSource(context, source).finally(() => reading.delete(key)));
  return reading.get(key);
}

async function readSource(context, source) {
  const { db, now } = context;
  try {
    const changed = source.kind === "google" ? await syncGoogle(context, source) : await syncLink(context, source);
    await db.sources.updateOne({ _id: source._id }, { $set: { status: "ok", error: "", syncedAt: new Date(now()), ...(changed ? { changedAt: new Date(now()) } : {}) } });
    return changed;
  } catch (error) {
    if (!(error instanceof SyncError) && error?.constructor?.name !== "FetchError" && !(error instanceof GoogleError)) context.log?.("sync failed", String(source._id), error?.message || error);
    await db.sources.updateOne({ _id: source._id }, { $set: { status: "error", error: friendly(error), syncedAt: new Date(now()) } });
    return false;
  }
}

/**
 * Before a feed goes to a calendar app: its calendars read over `maxAgeMs` ago are
 * read again, for at most `budgetMs`; past that the app gets the copy ready and the
 * reading finishes on its own. Whether the feed was refreshed in time.
 */
export async function freshenFeed(context, feed, { maxAgeMs = 60000, budgetMs = 8000 } = {}) {
  const { now } = context;
  const stale = (await feedSources(context.db, feed)).map((entry) => entry.source).filter((source) => !source.syncedAt || now() - source.syncedAt.getTime() > maxAgeMs);
  if (!stale.length) return false;
  const work = Promise.all(stale.map((source) => syncSource(context, source))).then(async (changed) => {
    if (changed.some(Boolean)) await rebuildFeeds(context, [feed.userId]);
    return true;
  });
  work.catch((error) => context.log?.("feed refresh failed", error?.message || error));
  let timer;
  const done = await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => resolve(false), budgetMs); })]);
  clearTimeout(timer);
  return done;
}

/** Rebuild the feeds of these people (or the stale and marked ones). */
export async function rebuildFeeds(context, userIds = []) {
  const { db, now } = context;
  const filter = { $or: [{ userId: { $in: userIds } }, { dirty: true }, { builtAt: { $lt: new Date(now() - DAY) } }, { builtAt: { $exists: false } }] };
  for (const feed of await db.feeds.find(filter).toArray()) await buildFeed(db, feed, now());
}

async function pool(items, size, work) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await work(item);
  }));
}

/** The resident five-minute loop, held by one process at a time through a lease in Mongo. */
export class Syncer {
  constructor(context, { intervalMs = 5 * 60000 } = {}) {
    this.context = context;
    this.intervalMs = intervalMs;
    this.owner = randomUUID();
    this.timer = null;
    this.running = null;
  }

  async lease() {
    const { db, now } = this.context;
    const at = new Date(now());
    try {
      const held = await db.leases.findOneAndUpdate(
        { _id: "sync", $or: [{ until: { $lt: at } }, { owner: this.owner }] },
        { $set: { owner: this.owner, until: new Date(now() + this.intervalMs), startedAt: at } },
        { upsert: true, returnDocument: "after" },
      );
      return held?.owner === this.owner;
    } catch (error) {
      if (error?.code === 11000) return false;
      throw error;
    }
  }

  /** One full pass. Returns false when another process holds the lease. */
  async runOnce() {
    if (this.running) return this.running;
    this.running = (async () => {
      const { db, now } = this.context;
      if (!(await this.lease())) return false;
      const changedUsers = new Set();
      const sources = await db.sources.find({ enabled: true }).toArray();
      await pool(sources, PARALLEL, async (source) => {
        if (await syncSource(this.context, source)) changedUsers.add(String(source.userId));
      });
      const ids = sources.filter((source) => changedUsers.has(String(source.userId))).map((source) => source.userId);
      await rebuildFeeds(this.context, ids);
      await db.leases.updateOne({ _id: "sync", owner: this.owner }, { $set: { finishedAt: new Date(now()), until: new Date(now() + this.intervalMs - 30000), sources: sources.length } });
      return true;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  start() {
    const tick = async () => {
      try { await this.runOnce(); } catch (error) { this.context.log?.("sync pass failed", error?.message || error); }
      this.timer = setTimeout(tick, this.intervalMs);
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, 2000);
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.timer);
  }
}
