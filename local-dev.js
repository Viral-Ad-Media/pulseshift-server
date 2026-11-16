// Isolated development database. Never reads or changes the hosted DATABASE_URL.
import { PGlite } from "@electric-sql/pglite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createDatabase } from "./database.js";
import { migrate } from "./scripts/migrate.js";
import { createAuthentication } from "./auth.js";
import { createApp } from "./app.js";
process.env.NODE_ENV = "development";
process.env.FRONTEND_URL = "http://localhost:3000";
// Local testing does not contact email or billing services unless explicitly opted in.
if (process.env.LOCAL_EXTERNAL_SERVICES !== "1")
  for (const key of [
    "RESEND_API_KEY",
    "MAIL_FROM",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
  ])
    delete process.env[key];
const directory = new URL("./.local-data/", import.meta.url);
await mkdir(directory, { recursive: true });
let secret;
try {
  secret = await readFile(new URL("auth-secret", directory), "utf8");
} catch {
  secret = randomBytes(32).toString("hex");
  await writeFile(new URL("auth-secret", directory), secret, { mode: 0o600 });
}
const engine = new PGlite(fileURLToPath(new URL("database", directory)));
let tail = Promise.resolve();
async function acquire() {
  let release;
  const next = new Promise((r) => {
    release = r;
  });
  const previous = tail;
  tail = next;
  await previous;
  return release;
}
const query = async (sql, values) => {
  const input = typeof sql === "string" ? sql : sql.text;
  const params = values || (typeof sql === "object" ? sql.values : undefined);
  const r = params
    ? await engine.query(input, params)
    : (await engine.exec(input)).at(-1);
  return {
    rows: r?.rows || [],
    rowCount: r?.affectedRows ?? r?.rows?.length ?? 0,
    command: input.trim().split(/\s+/)[0].toUpperCase(),
  };
};
const pool = {
  async query(sql, values) {
    const release = await acquire();
    try {
      return await query(sql, values);
    } finally {
      release();
    }
  },
  async connect() {
    const release = await acquire();
    return { query, release };
  },
  async end() {
    await engine.close();
  },
  on() {
    return pool;
  },
};
await migrate(pool);
const db = createDatabase(pool);
const authentication = createAuthentication({
  pool,
  secret,
  baseURL: "http://localhost:4000",
  trustedOrigins: ["http://localhost:3000", "http://localhost:4173"],
});
const server = createApp({
  db,
  authentication,
  corsOrigin: "http://localhost:3000,http://localhost:4173",
}).listen(4000, "127.0.0.1", () =>
  console.log(
    "PulseShift local test API: http://localhost:4000 — isolated local database; create a local test account.",
  ),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () =>
    server.close(async () => {
      await pool.end();
      process.exit(0);
    }),
  );
