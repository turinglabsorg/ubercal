/** ubercal assembled: Mongo, Google, the sync loop and the site, from one settings object. */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./db.js";
import { Google } from "./google.js";
import { keyFrom } from "./secrets.js";
import { createServer } from "./server.js";
import { Syncer } from "./sync.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** The settings from the environment. The keys and the Google secret come from hush (bin/run.sh). */
export function settingsFromEnv(env = process.env) {
  return {
    port: Number(env.PORT) || 4390,
    host: env.UBERCAL_LISTEN_HOST || "127.0.0.1",
    publicUrl: env.UBERCAL_PUBLIC_URL || `http://localhost:${Number(env.PORT) || 4390}`,
    mongoUrl: env.UBERCAL_MONGO_URL || "mongodb://127.0.0.1:27017/ubercal",
    mongoPassword: env.UBERCAL_MONGO_PASSWORD || "",
    sessionKey: env.FLUXKIT_SESSION_KEY || "",
    cookieDomain: env.FLUXKIT_COOKIE_DOMAIN || "",
    dataKey: env.UBERCAL_DATA_KEY || "",
    googleClientId: env.FLUXKIT_GOOGLE_CLIENT_ID || "",
    googleClientSecret: env.FLUXKIT_GOOGLE_CLIENT_SECRET || "",
    googleAuthUrl: env.UBERCAL_GOOGLE_AUTH_URL || "",
    googleTokenUrl: env.UBERCAL_GOOGLE_TOKEN_URL || "",
    googleApiBase: env.UBERCAL_GOOGLE_API_BASE || "",
    googleRevokeUrl: env.UBERCAL_GOOGLE_REVOKE_URL || "",
    syncMinutes: Number(env.UBERCAL_SYNC_MINUTES) || 10,
    allowPrivate: env.UBERCAL_ALLOW_PRIVATE_LINKS === "1",
    webDir: env.UBERCAL_WEB_DIR || join(ROOT, "web"),
  };
}

export async function createApp(settings, { now = () => Date.now(), log = (...parts) => console.error(new Date().toISOString(), ...parts) } = {}) {
  if (!settings.sessionKey) throw new Error("FLUXKIT_SESSION_KEY is missing: sessions could not be signed.");
  if (!settings.dataKey) throw new Error("UBERCAL_DATA_KEY is missing: Google tokens and private links could not be sealed.");
  const db = await connect(settings.mongoUrl, settings.mongoPassword);
  const google = new Google({
    clientId: settings.googleClientId, clientSecret: settings.googleClientSecret,
    authUrl: settings.googleAuthUrl, tokenUrl: settings.googleTokenUrl, apiBase: settings.googleApiBase, revokeUrl: settings.googleRevokeUrl,
  });
  const context = { db, google, dataKey: keyFrom(settings.dataKey), allowPrivate: settings.allowPrivate, now, log };
  const server = createServer(context, { ...settings, sessionKey: keyFrom(settings.sessionKey) });
  const syncer = new Syncer(context, { intervalMs: settings.syncMinutes * 60000 });
  return {
    context, server, syncer, db,
    async close() {
      syncer.stop();
      await new Promise((resolve) => server.close(() => resolve()));
      await db.client.close();
    },
  };
}
