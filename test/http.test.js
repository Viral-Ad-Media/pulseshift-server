import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import bcrypt from "bcryptjs";
import { testDatabase } from "./helpers.js";
import { createDatabase } from "../database.js";
import { createAuthentication } from "../auth.js";
import { createApp } from "../app.js";
let pool, engine, db, authentication, server, base, token, adminToken;
const secret = "f93ce57ab62980147d60285fac17d473";
const rpc = async (name, args) => {
  const result = await db.rpc(name, args);
  if (result.error) throw result.error;
  return result.data;
};
const api = async (path, { method = "GET", body, auth = token } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
};
before(async () => {
  ({ pool, engine } = await testDatabase());
  db = createDatabase(pool);
  // Mimic existing app-managed bcrypt accounts before auth cutover.
  const hash = await bcrypt.hash("old-pass", 10);
  await rpc("pulse_signup", {
    p_user_id: "admin",
    p_org_id: "org",
    p_email: "admin@example.com",
    p_password_hash: hash,
    p_name: "Admin",
    p_org_name: "Clinic",
    p_timezone: "America/Chicago",
    p_industry: "Healthcare",
  });
  await rpc("pulse_create_invitation", {
    p_id: "inv",
    p_org_id: "org",
    p_user_id: "admin",
    p_email: "nurse@example.com",
    p_role: "NURSE",
    p_hash: "hash",
  });
  await rpc("pulse_signup", {
    p_user_id: "nurse",
    p_org_id: "unused",
    p_email: "nurse@example.com",
    p_password_hash: hash,
    p_name: "Nurse",
    p_org_name: null,
    p_timezone: "America/Chicago",
    p_industry: "Healthcare",
    p_invite_hash: "hash",
  });
  await rpc("pulse_create_request", {
    p_id: "req",
    p_org_id: "org",
    p_user_id: "admin",
    p_date: "2026-10-06",
    p_type: "SICK",
    p_notes: "Private medical reason",
  });
  await engine.exec(
    await readFile("db/migrations/20261104_better_auth.sql", "utf8"),
  );
  authentication = createAuthentication({ pool, secret });
  server = createApp({
    db,
    authentication,
    logger: { error() {} },
    authMax: 100,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  const signed = await api("/auth/login", {
    method: "POST",
    auth: null,
    body: { email: "nurse@example.com", password: "old-pass" },
  });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  token = signed.body.token;
  const admin = await api("/auth/login", {
    method: "POST",
    auth: null,
    body: { email: "admin@example.com", password: "old-pass" },
  });
  assert.equal(admin.status, 200);
  adminToken = admin.body.token;
});
after(async () => {
  await new Promise((resolve) => server?.close(resolve));
  await pool?.end();
});
test("legacy bcrypt passwords and IDs preserve memberships and request ownership", async () => {
  const result = await api("/me");
  assert.equal(result.status, 200);
  assert.equal(result.body.user.id, "nurse");
  assert.equal(result.body.memberships[0].orgId, "org");
  assert.equal(result.body.setupRequired, false);
  assert.equal(
    (
      await pool.query(
        "select user_id from auth_accounts where account_id='nurse' and provider_id='credential'",
      )
    ).rows[0].user_id,
    "nurse",
  );
});
test("native Better Auth and application API validate the same database-backed session", async () => {
  const current = await api("/api/auth/get-session");
  assert.equal(current.status, 200);
  assert.equal(current.body.user.id, "nurse");
  assert.ok(
    (
      await pool.query("select id from auth_sessions where user_id=$1", [
        "nurse",
      ])
    ).rows.length,
  );
  assert.equal((await api("/me", { auth: "old.jwt.token" })).status, 401);
});
test("read endpoints redact coworker notes while administrators retain access", async () => {
  for (const path of ["/orgs/org/full", "/orgs/org/requests"]) {
    const result = await api(path);
    assert.equal(result.status, 200);
    assert.equal(result.body.requests[0].notes, undefined);
  }
  assert.equal(
    (await api("/orgs/org/requests", { auth: adminToken })).body.requests[0]
      .notes,
    "Private medical reason",
  );
  assert.equal((await api("/orgs/other/full")).status, 403);
});
test("nurses cannot approve requests or create admin invitations", async () => {
  assert.equal(
    (
      await api("/orgs/org/requests/req", {
        method: "PUT",
        body: { status: "APPROVED", version: 1 },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("/orgs/org/invitations", {
        method: "POST",
        body: { email: "extra@example.com", role: "ADMIN" },
      })
    ).status,
    403,
  );
});
test("invalid data and impossible dates return 400", async () => {
  assert.equal(
    (
      await api("/auth/signup", {
        method: "POST",
        auth: null,
        body: { email: {}, password: "x" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api("/orgs/org/requests", {
        method: "POST",
        body: { date: "2026-02-30", type: "WORK" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await api("/orgs/org/requests/req", {
        method: "DELETE",
        body: { version: "1" },
      })
    ).status,
    400,
  );
});
test("signup creates Better Auth credentials and an isolated workspace; invites join the same tenant", async () => {
  const owner = await api("/auth/signup", {
    method: "POST",
    auth: null,
    body: {
      email: "owner@example.com",
      password: "new-secure-password",
      name: "Owner",
      orgName: "New Clinic",
      timezone: "America/Chicago",
    },
  });
  assert.equal(owner.status, 201, JSON.stringify(owner.body));
  assert.equal(owner.body.setupRequired, false);
  assert.equal(owner.body.user.password_hash, undefined);
  const org = owner.body.orgs[0];
  const invite = await api(`/orgs/${org.id}/invitations`, {
    method: "POST",
    auth: owner.body.token,
    body: { email: "staff@example.com", role: "NURSE" },
  });
  assert.equal(invite.status, 201);
  const staff = await api("/auth/signup", {
    method: "POST",
    auth: null,
    body: {
      email: "staff@example.com",
      password: "staff-secure-password",
      name: "Staff",
      inviteToken: invite.body.token,
    },
  });
  assert.equal(staff.status, 201, JSON.stringify(staff.body));
  assert.equal(staff.body.orgs[0].id, org.id);
  assert.equal(staff.body.memberships[0].role, "NURSE");
});
test("failed workspace setup preserves a usable identity and can resume without duplicates", async () => {
  const account = await api("/auth/signup", {
    method: "POST",
    auth: null,
    body: {
      email: "retry@example.com",
      password: "retry-secure-password",
      name: "Retry",
      inviteToken: "nonexistent",
    },
  });
  assert.equal(account.status, 201);
  assert.equal(account.body.setupRequired, true);
  assert.match(account.body.setupError, /Invitation/);
  const logged = await api("/auth/login", {
    method: "POST",
    auth: null,
    body: { email: "retry@example.com", password: "retry-secure-password" },
  });
  assert.equal(logged.status, 200);
  assert.equal(logged.body.setupRequired, true);
  const completed = await api("/workspaces", {
    method: "POST",
    auth: logged.body.token,
    body: { orgName: "Retry Clinic" },
  });
  assert.equal(completed.status, 201);
  assert.equal(completed.body.setupRequired, false);
  assert.equal(
    (
      await api("/workspaces", {
        method: "POST",
        auth: logged.body.token,
        body: { orgName: "Duplicate Clinic" },
      })
    ).status,
    409,
  );
});
test("unavailable AI does not consume a credit or imply coverage was checked", async () => {
  const result = await api("/ai/analyze", {
    method: "POST",
    body: { orgId: "org", date: "2026-10-06", type: "WORK" },
  });
  assert.equal(result.body.available, false);
  assert.match(result.body.message, /No staffing availability check/);
  assert.equal(
    (await pool.query("select ai_used from organizations where id='org'"))
      .rows[0].ai_used,
    0,
  );
});
test("malformed provider response is recorded and retains its reserved credit", async () => {
  const aiServer = createApp({
    db,
    authentication,
    ai: async () => '{"message":{},"isHighDemand":"false"}',
    logger: { error() {} },
  }).listen(0, "127.0.0.1");
  await once(aiServer, "listening");
  try {
    const res = await fetch(
      `http://127.0.0.1:${aiServer.address().port}/ai/analyze`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          orgId: "org",
          date: "2026-10-06",
          type: "WORK",
        }),
      },
    );
    const body = await res.json();
    assert.equal(body.available, false);
    assert.equal(body.aiUsed, 1);
  } finally {
    await new Promise((resolve) => aiServer.close(resolve));
  }
});
test("Better Auth password change upgrades a legacy credential and revokes other sessions", async () => {
  const other = await api("/auth/login", {
    method: "POST",
    auth: null,
    body: { email: "nurse@example.com", password: "old-pass" },
  });
  assert.equal(other.status, 200);
  const changed = await api("/api/auth/change-password", {
    method: "POST",
    body: {
      currentPassword: "old-pass",
      newPassword: "replacement-password",
      revokeOtherSessions: true,
    },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  if (changed.body.token) token = changed.body.token;
  assert.equal((await api("/me", { auth: other.body.token })).status, 401);
  assert.equal((await api("/me")).status, 200);
  assert.equal(
    (
      await api("/auth/login", {
        method: "POST",
        auth: null,
        body: { email: "nurse@example.com", password: "old-pass" },
      })
    ).status,
    401,
  );
  const credential = (
    await pool.query("select password from auth_accounts where user_id='nurse'")
  ).rows[0].password;
  assert.ok(!credential.startsWith("$2"));
  await pool.query("select public.pulse_import_legacy_accounts()");
  assert.equal(
    (
      await pool.query(
        "select password from auth_accounts where user_id='nurse'",
      )
    ).rows[0].password,
    credential,
  );
});
test("logout deletes sessions and rejects a previously valid token immediately", async () => {
  assert.equal(
    (await api("/auth/logout", { method: "POST", body: {} })).status,
    200,
  );
  assert.equal((await api("/me")).status, 401);
  assert.equal(
    (
      await pool.query(
        "select count(*)::int as n from auth_sessions where user_id='nurse'",
      )
    ).rows[0].n,
    0,
  );
});
test("database adapter parameterizes malicious values and rejects unsafe identifiers", async () => {
  const result = await db
    .from("users")
    .select("id")
    .eq("email", "x' OR 1=1 --");
  assert.deepEqual(result.data, []);
  assert.throws(() => db.from("users;drop table users"));
  assert.throws(() => db.from("users").select("password_hash;select 1"));
});
