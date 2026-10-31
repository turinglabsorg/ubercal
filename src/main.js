#!/usr/bin/env node
import { createApp, settingsFromEnv } from "./app.js";

const settings = settingsFromEnv();
const app = await createApp(settings);
app.server.listen(settings.port, settings.host, () => {
  console.error(`ubercal on http://${settings.host}:${settings.port} (${settings.publicUrl}), sync every ${settings.syncMinutes} minutes${app.context.google.configured ? "" : ", Google sign-in not configured"}`);
});
app.syncer.start();

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    try { await app.close(); } finally { process.exit(0); }
  });
}
