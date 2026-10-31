/** MongoDB: the collections ubercal keeps and their indexes. */
import { MongoClient } from "mongodb";

/** The connection URL with the password from its own variable, so it never sits in a file. */
export function mongoUrl(url, password = "") {
  if (!password) return url;
  const parsed = new URL(url);
  parsed.password = encodeURIComponent(password);
  return parsed.toString();
}

export async function connect(url, password = "") {
  const client = new MongoClient(mongoUrl(url, password), { serverSelectionTimeoutMS: 10000, appName: "ubercal" });
  await client.connect();
  const db = client.db();
  const collections = {
    client,
    db,
    users: db.collection("users"),
    connections: db.collection("connections"),
    sources: db.collection("sources"),
    events: db.collection("events"),
    feeds: db.collection("feeds"),
    leases: db.collection("leases"),
    pages: db.collection("pages"),
    appointments: db.collection("appointments"),
  };
  await Promise.all([
    collections.users.createIndex({ googleSub: 1 }, { unique: true }),
    collections.connections.createIndex({ userId: 1, googleSub: 1 }, { unique: true }),
    collections.sources.createIndex({ userId: 1 }),
    collections.sources.createIndex({ enabled: 1, syncedAt: 1 }),
    collections.events.createIndex({ sourceId: 1, key: 1 }, { unique: true }),
    collections.events.createIndex({ sourceId: 1, generation: 1 }),
    collections.feeds.createIndex({ token: 1 }, { unique: true }),
    collections.feeds.createIndex({ userId: 1 }),
    collections.pages.createIndex({ token: 1 }, { unique: true }),
    collections.pages.createIndex({ userId: 1 }),
    collections.appointments.createIndex({ userId: 1, start: 1 }),
    collections.appointments.createIndex({ pageId: 1, createdAt: 1 }),
  ]);
  return collections;
}
