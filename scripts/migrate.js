import "dotenv/config";
import { createPool } from "../database.js";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
export async function migrate(pool) {
  const client = await pool.connect();
  try {
    await client.query(
      "select pg_advisory_lock(hashtext('pulseshift-schema'))",
    );
    await client.query(
      "create table if not exists public.schema_migrations(name text primary key, checksum text not null, applied_at timestamptz not null default now())",
    );
    const files = [
      "schema.sql",
      ...(await readdir(new URL("../db/migrations/", import.meta.url)))
        .filter((f) => f.endsWith(".sql"))
        .sort()
        .map((f) => "migrations/" + f),
    ];
    for (const name of files) {
      const raw = await readFile(
        new URL("../db/" + name, import.meta.url),
        "utf8",
      );
      const checksum = createHash("sha256").update(raw).digest("hex");
      const previous = await client.query(
        "select checksum from public.schema_migrations where name=$1",
        [name],
      );
      if (previous.rows.length) {
        if (previous.rows[0].checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      const sql = raw
        .replace(/^\s*--[^\n]*\n/gm, "")
        .replace(/^\s*begin\s*;/i, "")
        .replace(/commit\s*;\s*$/i, "");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(
          "insert into public.schema_migrations(name,checksum) values($1,$2)",
          [name, checksum],
        );
        await client.query("commit");
        console.log(`Applied ${name}`);
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.query(
      "select pg_advisory_unlock(hashtext('pulseshift-schema'))",
    );
    client.release();
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (url && new URL(url).hostname.includes("-pooler"))
    throw new Error("Use DATABASE_URL_UNPOOLED for migrations");
  const pool = createPool(url);
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
