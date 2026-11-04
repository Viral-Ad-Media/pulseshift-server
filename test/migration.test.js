import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import bcrypt from "bcryptjs";
import { testDatabase } from "./helpers.js";
import { migrate } from "../scripts/migrate.js";
import { importLegacy } from "../scripts/import-legacy.js";
import { createDatabase } from "../database.js";
import { createAuthentication } from "../auth.js";
test("versioned migration runner is repeatable and produces a ready Better Auth schema", async () => {
  const { pool } = await testDatabase();
  try {
    await migrate(pool);
    await migrate(pool);
    assert.equal(
      (await pool.query("select public.pulse_schema_ready() as ready")).rows[0]
        .ready,
      true,
    );
    assert.equal(
      (await pool.query("select count(*)::int as n from schema_migrations"))
        .rows[0].n,
      3,
    );
  } finally {
    await pool.end();
  }
});
test("read-only legacy import preserves identities, memberships and medical notes; refuses nonempty targets", async () => {
  const source = await testDatabase(),
    target = await testDatabase();
  try {
    await target.engine.exec(
      await readFile("db/migrations/20261104_better_auth.sql", "utf8"),
    );
    const sourceDb = createDatabase(source.pool);
    const passwordHash = await bcrypt.hash("shortpass", 10);
    const created = await sourceDb.rpc("pulse_signup", {
      p_user_id: "legacy-id",
      p_org_id: "legacy-org",
      p_email: "legacy@example.com",
      p_password_hash: passwordHash,
      p_name: "Legacy Nurse",
      p_org_name: "Existing Clinic",
      p_timezone: "America/Chicago",
      p_industry: "Healthcare",
    });
    assert.equal(created.error, undefined);
    await sourceDb.rpc("pulse_create_request", {
      p_id: "history",
      p_org_id: "legacy-org",
      p_user_id: "legacy-id",
      p_date: "2026-11-04",
      p_type: "SICK",
      p_notes: "Retained private note",
    });
    const counts = await importLegacy(source.pool, target.pool);
    assert.equal(counts.users, 1);
    assert.equal(counts.requests, 1);
    assert.equal(
      (await target.pool.query("select notes from requests where id='history'"))
        .rows[0].notes,
      "Retained private note",
    );
    assert.equal(
      (
        await source.pool.query(
          "select count(*)::int as n from requests where id='history'",
        )
      ).rows[0].n,
      1,
    );
    const auth = createAuthentication({
      pool: target.pool,
      secret: "f93ce57ab62980147d60285fac17d473",
    });
    const signed = await auth.api.signInEmail({
      body: { email: "legacy@example.com", password: "shortpass" },
    });
    assert.equal(signed.user.id, "legacy-id");
    await assert.rejects(importLegacy(source.pool, target.pool), /empty/);
  } finally {
    await source.pool.end();
    await target.pool.end();
  }
});
