import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
let db;
const rpc = async (name, args) =>
  (
    await db.query(
      `select public.${name}(${Object.keys(args)
        .map((key, i) => `${key} => $${i + 1}`)
        .join(",")}) as result`,
      Object.values(args),
    )
  ).rows[0].result;
const signup = (id, org, mail) =>
  rpc("pulse_signup", {
    p_user_id: id,
    p_org_id: org,
    p_email: mail,
    p_password_hash: "hash",
    p_name: id,
    p_org_name: org,
    p_timezone: "America/Chicago",
    p_industry: "Healthcare",
    p_invite_hash: null,
  });
const request = (id, org = "org", user = "admin", date = "2026-10-06") =>
  rpc("pulse_create_request", {
    p_id: id,
    p_org_id: org,
    p_user_id: user,
    p_date: date,
    p_type: "WORK",
    p_notes: "Private note",
  });
before(async () => {
  db = new PGlite();
  await db.exec(
    "create role anon; create role authenticated; create role service_role;",
  );
  await db.exec(await readFile("supabase/schema.sql", "utf8"));
  await db.exec(
    await readFile("supabase/migrations/20261005_audit.sql", "utf8"),
  );
  await db.exec(
    await readFile("supabase/migrations/20261005_audit.sql", "utf8"),
  );
  await signup("admin", "org", "admin@example.com");
});
after(async () => db.close());
test("migration is rerunnable and functions are unavailable to browser roles", async () => {
  assert.equal(await rpc("pulse_schema_ready", {}), true);
  const acl = await db.query(
    "select has_function_privilege('authenticated','public.pulse_reserve_ai(text,text,text,text)','execute') as allowed",
  );
  assert.equal(acl.rows[0].allowed, false);
});
test("signup collision rolls back without deleting existing organization or user", async () => {
  await assert.rejects(
    signup("new-admin", "org", "new@example.com"),
    /duplicate key/,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from organizations where id='org'",
      )
    ).rows[0].n,
    1,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from users where id='new-admin'",
      )
    ).rows[0].n,
    0,
  );
});
test("request quota serializes concurrent calls and cancellation retains audit history", async () => {
  await signup("quota-admin", "quota-org", "quota@example.com");
  await db.exec(
    "update organizations set request_limit=1 where id='quota-org'",
  );
  const outcomes = await Promise.allSettled([
    request("q1", "quota-org", "quota-admin", "2026-10-01"),
    request("q2", "quota-org", "quota-admin", "2026-10-02"),
  ]);
  assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
  const created = outcomes.find((x) => x.status === "fulfilled").value;
  await rpc("pulse_cancel_request", {
    p_org_id: "quota-org",
    p_id: created.id,
    p_user_id: "quota-admin",
    p_version: 1,
  });
  assert.equal(
    (
      await db.query(
        "select count(*)::int as n from request_events where request_id=$1",
        [created.id],
      )
    ).rows[0].n,
    2,
  );
  assert.equal(
    (
      await db.query(
        "select canceled_at is not null as canceled from requests where id=$1",
        [created.id],
      )
    ).rows[0].canceled,
    true,
  );
  await request("q3", "quota-org", "quota-admin", created.date);
});
test("AI credit reservation charges each call and rejects over-quota attempts", async () => {
  await db.exec(
    "update organizations set ai_used=79,ai_credits=80 where id='org'",
  );
  const args = { p_org_id: "org", p_user_id: "admin", p_kind: "ANALYZE" };
  const results = await Promise.allSettled([
    rpc("pulse_reserve_ai", { ...args, p_id: "ai-1" }),
    rpc("pulse_reserve_ai", { ...args, p_id: "ai-2" }),
  ]);
  assert.equal(results.filter((x) => x.status === "fulfilled").length, 1);
  assert.equal(
    (await db.query("select ai_used from organizations where id='org'")).rows[0]
      .ai_used,
    80,
  );
});
test("stale owner edit cannot change an approved request and cross-tenant writes fail", async () => {
  const created = await request("r1");
  await rpc("pulse_update_request", {
    p_org_id: "org",
    p_id: created.id,
    p_user_id: "admin",
    p_version: 1,
    p_status: "APPROVED",
  });
  await assert.rejects(
    rpc("pulse_update_request", {
      p_org_id: "org",
      p_id: created.id,
      p_user_id: "admin",
      p_version: 1,
      p_type: "PTO",
    }),
    /changed or already decided/,
  );
  const current = (
    await db.query("select type,status,version from requests where id='r1'")
  ).rows[0];
  assert.deepEqual(current, { type: "WORK", status: "APPROVED", version: 2 });
  await assert.rejects(
    rpc("pulse_update_request", {
      p_org_id: "quota-org",
      p_id: created.id,
      p_user_id: "admin",
      p_version: 2,
      p_type: "PTO",
    }),
    /access denied/,
  );
});
test("expired trial blocks AI and applies Essentials request cap", async () => {
  await signup("expired-admin", "expired-org", "expired@example.com");
  await db.exec(
    "update organizations set trial_expires_at=now()-interval '1 day' where id='expired-org'",
  );
  await assert.rejects(
    rpc("pulse_reserve_ai", {
      p_id: "expired-ai",
      p_org_id: "expired-org",
      p_user_id: "expired-admin",
      p_kind: "ANALYZE",
    }),
    /expired trial/,
  );
  for (let i = 0; i < 40; i++)
    await request(
      `expired-${i}`,
      "expired-org",
      "expired-admin",
      `2026-${String(1 + Math.floor(i / 28)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`,
    );
  await assert.rejects(
    request("expired-over", "expired-org", "expired-admin", "2026-12-31"),
    /limit reached/,
  );
});
test("invitations enforce email, expiry, one-use, seat caps and last admin preservation", async () => {
  const invite = await rpc("pulse_create_invitation", {
    p_id: "inv1",
    p_org_id: "org",
    p_user_id: "admin",
    p_email: "nurse@example.com",
    p_role: "NURSE",
    p_hash: "hash1",
  });
  assert.equal(invite.role, "NURSE");
  await assert.rejects(
    rpc("pulse_signup", {
      p_user_id: "wrong",
      p_org_id: "unused",
      p_email: "wrong@example.com",
      p_password_hash: "hash",
      p_name: "wrong",
      p_org_name: null,
      p_timezone: "America/Chicago",
      p_industry: "Healthcare",
      p_invite_hash: "hash1",
    }),
    /email address/,
  );
  assert.equal(
    (await db.query("select count(*)::int as n from users where id='wrong'"))
      .rows[0].n,
    0,
  );
  await rpc("pulse_signup", {
    p_user_id: "nurse",
    p_org_id: "unused",
    p_email: "nurse@example.com",
    p_password_hash: "hash",
    p_name: "Nurse",
    p_org_name: null,
    p_timezone: "America/Chicago",
    p_industry: "Healthcare",
    p_invite_hash: "hash1",
  });
  await assert.rejects(
    rpc("pulse_accept_invitation", { p_user_id: "nurse", p_hash: "hash1" }),
    /already used/,
  );
  await assert.rejects(
    rpc("pulse_manage_member", {
      p_org_id: "org",
      p_actor_id: "admin",
      p_user_id: "admin",
      p_role: "NURSE",
      p_remove: false,
    }),
    /at least one/,
  );
  await db.exec("update organizations set seats_total=2 where id='org'");
  await assert.rejects(
    rpc("pulse_create_invitation", {
      p_id: "inv2",
      p_org_id: "org",
      p_user_id: "admin",
      p_email: "extra@example.com",
      p_role: "NURSE",
      p_hash: "hash2",
    }),
    /available workspace seats/,
  );
  await assert.rejects(
    rpc("pulse_create_invitation", {
      p_id: "inv3",
      p_org_id: "org",
      p_user_id: "nurse",
      p_email: "extra@example.com",
      p_role: "ADMIN",
      p_hash: "hash3",
    }),
    /access denied/,
  );
});
test("database rejects impossible dates", async () => {
  await assert.rejects(
    request("invalid", "org", "admin", "2026-02-30"),
    /out of range/,
  );
});
