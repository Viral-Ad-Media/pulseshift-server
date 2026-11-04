import "dotenv/config";
import { GoogleGenAI } from "@google/genai";
import { createPool, createDatabase } from "./database.js";
import { createAuthentication } from "./auth.js";
import { createApp } from "./app.js";
if (process.env.NODE_ENV === "production") {
  if (
    !process.env.BETTER_AUTH_URL ||
    new URL(process.env.BETTER_AUTH_URL).protocol !== "https:"
  )
    throw new Error("Set BETTER_AUTH_URL to the public HTTPS API URL");
  if (!process.env.CORS_ORIGIN)
    throw new Error("Set CORS_ORIGIN to the public frontend origin");
}
const pool = createPool();
const db = createDatabase(pool);
const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
const authentication = createAuthentication({
  pool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:4000",
  trustedOrigins: corsOrigin
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean),
});
const client = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;
const trustProxy = process.env.TRUST_PROXY_HOPS
  ? Number(process.env.TRUST_PROXY_HOPS)
  : false;
if (
  trustProxy !== false &&
  (!Number.isSafeInteger(trustProxy) || trustProxy < 1 || trustProxy > 3)
)
  throw new Error("Invalid TRUST_PROXY_HOPS");
const { data, error } = await db.rpc("pulse_schema_ready");
if (error || data !== true)
  throw new Error(
    "Database schema is not ready. Run npm run db:migrate against the Neon direct URL.",
  );
const app = createApp({
  db,
  authentication,
  corsOrigin,
  trustProxy,
  ai: client
    ? async (prompt) =>
        (
          await client.models.generateContent({
            model: "gemini-2.5-flash",
            contents: prompt,
            config: {
              responseMimeType: "application/json",
              httpOptions: { timeout: 20000 },
            },
          })
        ).text
    : null,
});
const port = Number(process.env.PORT || 4000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65535)
  throw new Error("Invalid PORT");
const server = app.listen(port, "0.0.0.0", () =>
  console.log(`PulseShift API listening on port ${port} (Neon + Better Auth)`),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.once(signal, () => {
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 25000).unref();
  });
