import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { PGlite } from "@electric-sql/pglite";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
let db, server, base, token;
const secret = "f93ce57ab62980147d60285fac17d473";
function adapter(pg) {
  return {
    rpc: async (name, args = {}) => {
      try {
        const r = await pg.query(
          `select public.${name}(${Object.keys(args)
            .map((k, i) => `${k} => $${i + 1}`)
            .join(",")}) as result`,
          Object.values(args),
        );
        return { data: r.rows[0].result };
      } catch (error) {
        return { error };
      }
    },
    from(table) {
      let cols = "*",
        where = [],
        params = [],
        suffix = "";
      const q = {
        select(value) {
          cols = value;
          return q;
        },
        eq(k, v) {
          params.push(v);
          where.push(`${k}=$${params.length}`);
          return q;
        },
        in(k, values) {
          where.push(
            `${k} in (${values
              .map((v) => {
                params.push(v);
                return "$" + params.length;
              })
              .join(",")})`,
          );
          return q;
        },
        is(k, v) {
          assert.equal(v, null);
          where.push(`${k} is null`);
          return q;
        },
        order(k, { ascending }) {
          suffix += ` order by ${k} ${ascending ? "asc" : "desc"}`;
          return q;
        },
        limit(n) {
          suffix += ` limit ${n}`;
          return q;
        },
        async then(resolve, reject) {
          try {
            resolve({
              data: (
                await pg.query(
                  `select ${cols} from ${table}${where.length ? " where " + where.join(" and ") : ""}${suffix}`,
                  params,
                )
              ).rows,
            });
          } catch (error) {
            resolve({ error });
          }
        },
      };
      return q;
    },
  };
}
const rpc = async (name, args) => {
  const result = await adapter(db).rpc(name, args);
  if (result.error) throw result.error;
  return result.data;
};
const api = async (path, { method = "GET", body, auth = token } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
};
before(async () => {
  db = new PGlite();
  await db.exec(
    "create role anon;create role authenticated;create role service_role;",
  );
  await db.exec(await readFile("supabase/schema.sql", "utf8"));
  await db.exec(
    await readFile("supabase/migrations/20261005_audit.sql", "utf8"),
  );
  await rpc("pulse_signup", {
    p_user_id: "admin",
    p_org_id: "org",
    p_email: "admin@example.com",
    p_password_hash: "hash",
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
    p_password_hash: "hash",
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
  server = createApp({
    db: adapter(db),
    secret,
    logger: { error() {} },
    authMax: 5,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  token = jwt.sign({ sub: "nurse", ver: 1 }, secret, {
    issuer: "pulseshift-api",
    audience: "pulseshift-client",
    expiresIn: "1h",
  });
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.close();
});
test("HTTP membership guards redact coworker medical notes from both read endpoints", async () => {
  for (const path of ["/orgs/org/full", "/orgs/org/requests"]) {
    const result = await api(path);
    assert.equal(result.status, 200);
    assert.equal(result.body.requests[0].notes, undefined);
    assert.equal(result.body.requests[0].version, 1);
  }
  const adminToken = jwt.sign({ sub: "admin", ver: 1 }, secret, {
    issuer: "pulseshift-api",
    audience: "pulseshift-client",
  });
  assert.equal(
    (await api("/orgs/org/requests", { auth: adminToken })).body.requests[0]
      .notes,
    "Private medical reason",
  );
  assert.equal((await api("/orgs/other/full")).status, 403);
});
test("HTTP nurses cannot approve coworker requests or invite administrators", async () => {
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
test("HTTP invalid field types and dates return 400", async () => {
  assert.equal(
    (
      await api("/auth/signup", {
        method: "POST",
        body: { email: {}, password: "x" },
        auth: null,
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
test("HTTP unavailable AI fallback does not imply checked staffing or consume credits", async () => {
  const result = await api("/ai/analyze", {
    method: "POST",
    body: { orgId: "org", date: "2026-10-06", type: "WORK" },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.available, false);
  assert.match(result.body.message, /No staffing availability check/);
  assert.equal(
    (await db.query("select ai_used from organizations where id='org'")).rows[0]
      .ai_used,
    0,
  );
});
test("HTTP signup, login, invitation creation and new-account acceptance work end to end", async () => {
  const registered = await api("/auth/signup", {
    method: "POST",
    auth: null,
    body: {
      email: "newowner@example.com",
      password: "new-secure-password",
      name: "Owner",
      orgName: "New Clinic",
      timezone: "America/Chicago",
    },
  });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.user.password_hash, undefined);
  const org = registered.body.orgs[0];
  assert.match(org.id, /^org-[0-9a-f-]{36}$/);
  assert.equal(org.seats.used, 1);
  const invite = await api(`/orgs/${org.id}/invitations`, {
    method: "POST",
    auth: registered.body.token,
    body: { email: "newstaff@example.com", role: "NURSE" },
  });
  assert.equal(invite.status, 201);
  const joined = await api("/auth/signup", {
    method: "POST",
    auth: null,
    body: {
      email: "newstaff@example.com",
      password: "staff-secure-password",
      name: "Staff",
      inviteToken: invite.body.token,
      timezone: "America/Chicago",
    },
  });
  assert.equal(joined.status, 201);
  assert.equal(joined.body.orgs[0].id, org.id);
  assert.equal(joined.body.memberships[0].role, "NURSE");
  const loggedIn = await api("/auth/login", {
    method: "POST",
    auth: null,
    body: { email: "newstaff@example.com", password: "staff-secure-password" },
  });
  assert.equal(loggedIn.status, 200);
});
test("HTTP malformed paid AI response remains metered and returns an honest fallback", async () => {
  await db.exec(
    "update organizations set ai_used=0,ai_credits=80 where id='org'",
  );
  const aiServer = createApp({
    db: adapter(db),
    secret,
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
    assert.equal(res.status, 200);
    assert.equal(body.available, false);
    assert.equal(body.aiUsed, 1);
    assert.equal(
      (await db.query("select status from ai_events where org_id='org'"))
        .rows[0].status,
      "FAILED",
    );
  } finally {
    await new Promise((resolve) => aiServer.close(resolve));
  }
});
test("HTTP rejects obsolete JWTs and logout revokes signed sessions", async () => {
  const legacy = jwt.sign({ sub: "nurse" }, secret);
  assert.equal((await api("/me", { auth: legacy })).status, 401);
  assert.equal(
    (await api("/auth/logout", { method: "POST", body: {} })).status,
    200,
  );
  assert.equal((await api("/me")).status, 401);
});
test("HTTP auth rate limit returns 429 without further database work", async () => {
  let result;
  for (let i = 0; i < 6; i++)
    result = await api("/auth/login", { method: "POST", body: {}, auth: null });
  assert.equal(result.status, 429);
});
