import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID, createHmac } from "node:crypto";
import { testDatabase } from "./helpers.js";
import { migrate } from "../scripts/migrate.js";
import { createDatabase } from "../database.js";
import { createAuthentication } from "../auth.js";
import { createApp } from "../app.js";
import {
  payrollRows,
  parseCSV,
  csvCell,
  credentialIssues,
  coveredShiftDays,
} from "../workforce-rules.js";
import {
  verifyStripeSignature,
  makeResetMailer,
  createBilling,
} from "../integrations.js";
let pool, server, base, org, admin, nurse, colleague, authentication;
const reset = [];
const pass = "Test-password-2026!";
const api = async (path, { user = admin, method = "GET", body } = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user?.token ? { Authorization: `Bearer ${user.token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
};
const wf = async (user) => (await api(`/orgs/${org}/workforce`, { user })).body;
const schedule = async () => (await api(`/orgs/${org}/schedule`)).body;
const action = async (action, fields = {}, user = admin) => {
  const [w, s] = await Promise.all([wf(user), schedule()]);
  return api(`/orgs/${org}/workforce`, {
    user,
    method: "POST",
    body: {
      revision: w.revision,
      scheduleRevision: s.revision,
      operationId: randomUUID(),
      action,
      ...fields,
    },
  });
};
const sched = async (action, fields = {}) =>
  api(`/orgs/${org}/schedule`, {
    method: "POST",
    body: {
      revision: (await schedule()).revision,
      operationId: randomUUID(),
      action,
      ...fields,
    },
  });
const day = (offset) =>
  new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
const shift = (userId, offset = 3, patch = {}) => ({
  title: "Care shift",
  department: "Ward A",
  location: "Main",
  role: "Nurse",
  requiredCount: 1,
  localStart: day(offset) + "T08:00",
  localEnd: day(offset) + "T16:00",
  requiresAcknowledgement: true,
  assignments: userId
    ? [{ userId, breakStartMinutes: 0, breakMinutes: 0 }]
    : [],
  ...patch,
});
async function createShift(userId, offset = 3, patch = {}) {
  const r = await sched("SAVE_SHIFT", { shift: shift(userId, offset, patch) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (await schedule()).shifts.find(
    (s) => s.localStart === shift(userId, offset, patch).localStart,
  );
}
before(async () => {
  ({ pool } = await testDatabase({ scheduling: false }));
  await migrate(pool);
  authentication = createAuthentication({
    pool,
    secret: "f93ce57ab62980147d60285fac17d473",
    sendResetPassword: async (message) => {
      reset.push(message);
    },
  });
  process.env.FRONTEND_URL = "http://localhost:3000";
  server = createApp({
    db: createDatabase(pool),
    authentication,
    logger: {
      error(...args) {
        console.error(...args);
      },
    },
    authMax: 300,
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
  const a = await api("/auth/signup", {
    user: null,
    method: "POST",
    body: {
      name: "Owner",
      email: "owner@local.test",
      password: pass,
      orgName: "Local clinic",
      timezone: "UTC",
    },
  });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  admin = { id: a.body.user.id, token: a.body.token };
  org = a.body.orgs[0].id;
  for (const [key, email] of [
    ["nurse", "nurse@local.test"],
    ["colleague", "colleague@local.test"],
  ]) {
    const invite = await api(`/orgs/${org}/invitations`, {
      method: "POST",
      body: { email, role: "NURSE" },
    });
    const member = await api("/auth/signup", {
      user: null,
      method: "POST",
      body: {
        name: key,
        email,
        password: pass,
        inviteToken: invite.body.token,
        timezone: "UTC",
      },
    });
    assert.equal(member.status, 201, JSON.stringify(member.body));
    const value = { id: member.body.user.id, token: member.body.token };
    if (key === "nurse") nurse = value;
    else colleague = value;
  }
  for (const member of [admin, nurse, colleague])
    assert.equal(
      (
        await sched("SAVE_PROFILE", {
          profile: {
            userId: member.id,
            roles: ["Nurse"],
            minRestHours: 0,
            maxWeeklyHours: 0,
          },
        })
      ).status,
      200,
    );
});
after(async () => {
  delete process.env.FRONTEND_URL;
  await new Promise((r) => server?.close(r));
  await pool?.end();
});
test("workforce permissions redact coworker rates and credentials, reject staff settings, and detect stale revisions", async () => {
  assert.equal(
    (await action("RATE", { userId: nurse.id, hourlyCents: 3200 })).status,
    200,
  );
  assert.equal((await wf(colleague)).rates.length, 0);
  assert.equal(
    (await action("RATE", { userId: nurse.id, hourlyCents: 100 }, nurse))
      .status,
    403,
  );
  const old = await wf();
  await action(
    "PREFERENCES",
    { unavailableWeekdays: [], avoidNights: false },
    nurse,
  );
  assert.equal(
    (
      await api(`/orgs/${org}/workforce`, {
        method: "POST",
        body: {
          revision: old.revision,
          operationId: randomUUID(),
          action: "RATE",
          userId: nurse.id,
          hourlyCents: 100,
        },
      })
    ).status,
    409,
  );
});
test("builder uses confirmed availability, explains choices, and saves only a draft", async () => {
  const s = await createShift(null);
  const req = await api(`/orgs/${org}/requests`, {
    user: nurse,
    method: "POST",
    body: { date: day(3), type: "WORK" },
  });
  await api(`/orgs/${org}/requests/${req.body.request.id}`, {
    method: "PUT",
    body: { status: "APPROVED", version: 1 },
  });
  const p = await api(`/orgs/${org}/workforce/preview`, {
    method: "POST",
    body: { kind: "BUILD" },
  });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(
    p.body.shifts.find((x) => x.id === s.id).assignments[0].userId,
    nurse.id,
  );
  assert.match(p.body.explanation[0].message, /approved availability/);
  assert.equal((await schedule()).published.length, 0);
  assert.equal(
    (await action("APPLY_BUILD", { allowUnknownAvailability: false })).status,
    200,
  );
  assert.equal((await schedule()).published.length, 0);
  assert.equal((await sched("PUBLISH")).status, 200);
});
test("explicit accept and decline update confirmation and open a replacement vacancy, not a fake attendance record", async () => {
  const s = (await schedule()).published[0];
  assert.equal(
    (
      await action(
        "RESPOND_ASSIGNMENT",
        {
          shiftId: s.id,
          publicationVersion: s.publicationVersion,
          decision: "ACCEPT",
        },
        nurse,
      )
    ).status,
    200,
  );
  assert.ok(
    (await wf(nurse)).assignmentResponses.some(
      (r) => r.userId === nurse.id && r.decision === "ACCEPT",
    ),
  );
  assert.equal((await wf(nurse)).timesheets.length, 0);
  assert.equal(
    (
      await action(
        "RESPOND_ASSIGNMENT",
        {
          shiftId: s.id,
          publicationVersion: s.publicationVersion + 1,
          decision: "DECLINE",
        },
        nurse,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await action(
        "RESPOND_ASSIGNMENT",
        {
          shiftId: s.id,
          publicationVersion: s.publicationVersion,
          decision: "DECLINE",
        },
        nurse,
      )
    ).status,
    200,
  );
  assert.equal((await schedule()).published[0].assignments.length, 0);
  assert.equal((await wf()).vacancies.length, 1);
});
test("replacement rounds contact eligible people and the opening can be claimed only once", async () => {
  const vacancy = (await wf()).vacancies[0];
  assert.equal(
    (
      await action("CONTACT_ROUND", {
        vacancyId: vacancy.id,
        batchSize: 3,
        minutes: 15,
      })
    ).status,
    200,
  );
  const round = (await wf()).vacancies[0].rounds[0];
  assert.ok(round.candidates.includes(colleague.id));
  assert.equal(
    (await action("CONTACT_ROUND", { vacancyId: vacancy.id })).status,
    409,
  );
  assert.equal(
    (
      await action(
        "VACANCY_RESPONSE",
        { vacancyId: vacancy.id, decision: "ACCEPT" },
        colleague,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await action(
        "VACANCY_RESPONSE",
        { vacancyId: vacancy.id, decision: "ACCEPT" },
        admin,
      )
    ).status,
    409,
  );
  const s = (await schedule()).published[0];
  assert.equal(s.assignments.length, 1);
  assert.equal(s.assignments[0].userId, colleague.id);
});
test("safe trades need colleague consent and a separate manager approval", async () => {
  const from = await createShift(nurse.id, 4);
  const other = await createShift(colleague.id, 5);
  assert.equal((await sched("PUBLISH")).status, 200);
  assert.equal(
    (
      await action(
        "REQUEST_SWAP",
        { shiftId: from.id, toUserId: colleague.id, tradeShiftId: other.id },
        nurse,
      )
    ).status,
    200,
  );
  const swap = (await wf()).swaps[0];
  assert.equal((await action("APPROVE_SWAP", { swapId: swap.id })).status, 409);
  assert.equal(
    (
      await action(
        "RESPOND_SWAP",
        { swapId: swap.id, decision: "ACCEPT" },
        colleague,
      )
    ).status,
    200,
  );
  assert.equal((await action("APPROVE_SWAP", { swapId: swap.id })).status, 200);
  const changed = await schedule();
  assert.ok(
    changed.published
      .find((s) => s.id === from.id)
      .assignments.some((a) => a.userId === colleague.id),
  );
  assert.ok(
    changed.published
      .find((s) => s.id === other.id)
      .assignments.some((a) => a.userId === nurse.id),
  );
});
test("what-if previews never commit assignment changes", async () => {
  const before = await schedule();
  const response = await api(`/orgs/${org}/workforce/preview`, {
    method: "POST",
    body: { kind: "WHAT_IF", absentUserId: nurse.id, date: day(5) },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.committed, false);
  assert.deepEqual((await schedule()).published, before.published);
});
test("credential records separate upload and manager review and never allow self-review", async () => {
  assert.equal(
    (
      await action(
        "CREDENTIAL",
        { type: "RN License", expiresOn: day(365) },
        nurse,
      )
    ).status,
    200,
  );
  const credential = (await wf(nurse)).credentials[0];
  assert.equal(credential.status, "UPLOADED");
  assert.equal(
    (await action("REVIEW_CREDENTIAL", { credentialId: credential.id }, nurse))
      .status,
    403,
  );
  assert.equal(
    (await action("REVIEW_CREDENTIAL", { credentialId: credential.id })).status,
    200,
  );
  assert.equal((await wf(nurse)).credentials[0].status, "REVIEWED");
  assert.equal((await wf(colleague)).credentials.length, 0);
  const rules = {
    settings: { credentialRules: [{ role: "Nurse", types: ["RN License"] }] },
    credentials: [{ ...credential, status: "REVIEWED" }],
  };
  assert.equal(
    credentialIssues(
      [
        {
          ...shift(nurse.id),
          id: "q",
          startsAt: day(3) + "T08:00Z",
          endsAt: day(3) + "T16:00Z",
        },
      ],
      rules,
    ).length,
    0,
  );
  rules.credentials[0].expiresOn = day(1);
  assert.equal(
    credentialIssues(
      [
        {
          ...shift(nurse.id),
          id: "q",
          startsAt: day(3) + "T08:00Z",
          endsAt: day(3) + "T16:00Z",
        },
      ],
      rules,
    ).length,
    1,
  );
});
test("clock-in/out, corrections, approval and pay snapshots retain actual-time meaning", async () => {
  const local = (t) => new Date(t).toISOString().slice(0, 16);
  const now = Date.now();
  const s = await createShift(nurse.id, 0, {
    localStart: local(now - 30 * 60000),
    localEnd: local(now + 30 * 60000),
  });
  assert.equal((await sched("PUBLISH")).status, 200);
  assert.equal(
    (await action("CLOCK_IN", { shiftId: s.id }, nurse)).status,
    200,
  );
  assert.equal(
    (await action("CLOCK_IN", { shiftId: s.id }, nurse)).status,
    409,
  );
  let t = (await wf(nurse)).timesheets[0];
  assert.equal(t.status, "OPEN");
  assert.equal(
    (
      await action(
        "CLOCK_OUT",
        { timesheetId: t.id, version: t.version },
        colleague,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await action(
        "CLOCK_OUT",
        { timesheetId: t.id, version: t.version },
        nurse,
      )
    ).status,
    200,
  );
  t = (await wf(nurse)).timesheets[0];
  assert.equal(
    (
      await action(
        "CORRECT_TIME",
        {
          timesheetId: t.id,
          version: t.version,
          clockIn: new Date(now - 60 * 60000).toISOString(),
          clockOut: new Date(now - 5 * 60000).toISOString(),
          breakMinutes: 5,
          reason: "Correcting test record",
        },
        nurse,
      )
    ).status,
    200,
  );
  t = (await wf(nurse)).timesheets[0];
  assert.equal(
    (
      await action(
        "APPROVE_TIME",
        { timesheetId: t.id, version: t.version },
        nurse,
      )
    ).status,
    403,
  );
  assert.equal(
    (await action("APPROVE_TIME", { timesheetId: t.id, version: t.version }))
      .status,
    200,
  );
  t = (await wf(nurse)).timesheets[0];
  assert.equal(t.status, "APPROVED");
  assert.equal(t.paySnapshot.hourlyCents, 3200);
  await action("RATE", { userId: nurse.id, hourlyCents: 5000 });
  assert.equal((await wf(nurse)).timesheets[0].paySnapshot.hourlyCents, 3200);
});
test("CSV imports preview row errors, require confirmation and never grant admin accounts", async () => {
  const csv =
    "name,email\nNew Person,newperson@local.test\nDuplicate,newperson@local.test";
  const preview = await action("IMPORT", { kind: "STAFF", csv, commit: false });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.errors.length, 1);
  assert.equal(
    (
      await action("IMPORT", {
        kind: "STAFF",
        csv,
        commit: true,
        fingerprint: preview.body.fingerprint,
      })
    ).status,
    400,
  );
  const valid = "name,email\nNew Person,newperson@local.test";
  const checked = await action("IMPORT", {
    kind: "STAFF",
    csv: valid,
    commit: false,
  });
  const committed = await action("IMPORT", {
    kind: "STAFF",
    csv: valid,
    commit: true,
    fingerprint: checked.body.fingerprint,
  });
  assert.equal(committed.status, 200);
  assert.equal(committed.body.invitations.length, 1);
  const invitation = (
    await pool.query("select role from invitations where email=$1", [
      "newperson@local.test",
    ])
  ).rows[0];
  assert.equal(invitation.role, "NURSE");
});
test("department access permits scoped reports and blocks administrator-only settings", async () => {
  await action("ACCESS", { userId: nurse.id, departments: ["Ward A"] });
  await action("STAFF_UNITS", {
    userId: colleague.id,
    departments: ["Ward A"],
  });
  assert.deepEqual((await wf(nurse)).permissions.departments, ["Ward A"]);
  assert.equal(
    (await action("RATE", { userId: colleague.id, hourlyCents: 9000 }, nurse))
      .status,
    403,
  );
  const report = await api(
    `/orgs/${org}/workforce/reports?start=${day(-1)}&end=${day(7)}`,
    { user: nurse },
  );
  assert.equal(report.status, 200);
  assert.ok(report.body.plannedMinutes > 0);
  assert.ok(report.body.approvedWorkedMinutes > 0);
  assert.equal(
    (
      await api(
        `/orgs/${org}/workforce/reports?start=${day(-1)}&end=${day(7)}`,
        { user: colleague },
      )
    ).status,
    403,
  );
});
test("activity history records real changes and billing is explicitly unavailable without keys", async () => {
  const events = await api(`/orgs/${org}/workforce/audit?q=CLOCK`);
  assert.equal(events.status, 200);
  assert.ok(events.body.events.some((e) => e.action === "CLOCK_IN"));
  assert.equal((await api(`/orgs/${org}/billing`)).body.configured, false);
  assert.equal(
    (
      await api(`/orgs/${org}/billing/checkout`, {
        method: "POST",
        body: { plan: "TEAM", operationId: randomUUID() },
      })
    ).status,
    503,
  );
});
function totp(uri) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const secret = new URL(uri).searchParams.get("secret");
  let bits = "";
  for (const c of secret.toUpperCase().replace(/=+$/, ""))
    bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const bytes = Buffer.from(bits.match(/.{8}/g).map((v) => parseInt(v, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", bytes).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(
    6,
    "0",
  );
}
test("real authenticator enrollment, challenge sign-in and replay prevention work with bearer sessions", async () => {
  const setup = await api("/auth/security/enable", {
    method: "POST",
    body: { password: pass },
  });
  assert.equal(setup.status, 200, JSON.stringify(setup.body));
  assert.ok(setup.body.backupCodes.length);
  const verify = await api("/auth/security/verify", {
    method: "POST",
    body: { code: totp(setup.body.totpURI) },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.ok(verify.body.token);
  admin.token = verify.body.token;
  const login = await api("/auth/login", {
    user: null,
    method: "POST",
    body: { email: "owner@local.test", password: pass },
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.twoFactorRequired, true);
  assert.equal(login.body.token, undefined);
  const completed = await api("/auth/two-factor", {
    user: null,
    method: "POST",
    body: { challenge: login.body.challenge, code: totp(setup.body.totpURI) },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.ok(completed.body.token);
  admin.token = completed.body.token;
  assert.equal(
    (
      await api("/auth/two-factor", {
        user: null,
        method: "POST",
        body: {
          challenge: login.body.challenge,
          code: totp(setup.body.totpURI),
        },
      })
    ).status,
    401,
  );
});
test("password recovery is non-enumerating, single-use and revokes old sessions", async () => {
  const request = await api("/auth/recovery", {
    user: null,
    method: "POST",
    body: { email: "nurse@local.test" },
  });
  assert.equal(request.status, 200, JSON.stringify(request.body));
  assert.equal(reset.length, 1);
  assert.equal(
    (
      await api("/auth/recovery", {
        user: null,
        method: "POST",
        body: { email: "unknown@local.test" },
      })
    ).body.message,
    request.body.message,
  );
  const result = await api("/auth/recovery/reset", {
    user: null,
    method: "POST",
    body: { token: reset[0].token, newPassword: "Replacement-password-2026!" },
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal((await api("/me", { user: nurse })).status, 401);
  assert.equal(
    (
      await api("/auth/recovery/reset", {
        user: null,
        method: "POST",
        body: { token: reset[0].token, newPassword: pass },
      })
    ).status,
    400,
  );
});
test("payroll splits local weeks, protects unknown rates and escapes spreadsheet formulas", () => {
  const entry = (id, start, end) => ({
    id,
    userId: "n",
    clockIn: start,
    clockOut: end,
    timezone: "UTC",
    breaks: [],
    status: "APPROVED",
  });
  const settings = {
    currency: "USD",
    overtimeThresholdHours: 4,
    overtimeMultiplier: 1.5,
  };
  const rows = payrollRows(
    [
      entry("a", "2027-01-10T20:00Z", "2027-01-11T04:00Z"),
      entry("b", "2027-01-11T04:00Z", "2027-01-11T06:00Z"),
    ],
    settings,
    [{ userId: "n", hourlyCents: 3000 }],
  );
  assert.equal(rows[0].overtimeMinutes, 0);
  assert.equal(rows.find((r) => r.entryId === "b").overtimeMinutes, 120);
  assert.equal(rows.find((r) => r.entryId === "b").estimatedGrossCents, 9000);
  const unknown = {
    ...entry("u", "2027-01-12T08:00Z", "2027-01-12T09:00Z"),
    paySnapshot: { hourlyCents: null, policy: settings },
  };
  assert.equal(
    payrollRows([unknown], settings, [{ userId: "n", hourlyCents: 3000 }])[0]
      .estimatedGrossCents,
    null,
  );
  assert.match(csvCell('=HYPERLINK("bad")'), /^"'/);
  assert.equal(
    parseCSV('name,email\n"Doe, Jane",jane@local.test')[0].values.name,
    "Doe, Jane",
  );
});
test("billing signatures reject altered payloads and stale timestamps", () => {
  const raw = Buffer.from('{"id":"evt_test"}');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", "secret")
    .update(`${timestamp}.`)
    .update(raw)
    .digest("hex");
  assert.equal(
    verifyStripeSignature(raw, `t=${timestamp},v1=${signature}`, "secret"),
    true,
  );
  assert.equal(
    verifyStripeSignature(
      Buffer.from("altered"),
      `t=${timestamp},v1=${signature}`,
      "secret",
    ),
    false,
  );
  assert.equal(
    verifyStripeSignature(
      raw,
      `t=${timestamp},v1=${signature}`,
      "secret",
      Date.now() + 600000,
    ),
    false,
  );
  assert.equal(
    makeResetMailer({ apiKey: "", from: "", frontendURL: "" }),
    null,
  );
});

test("configured billing webhooks verify signatures, deduplicate and apply current subscription entitlements", async () => {
  const secret = "test-webhook-secret";
  let current = {
    id: "sub_local",
    customer: "cus_local",
    metadata: { orgId: org },
    status: "active",
    items: { data: [{ price: { id: "price_business" } }] },
  };
  await pool.query(
    "insert into billing_accounts(org_id,customer_id,status) values($1,'cus_local','PENDING') on conflict(org_id) do update set customer_id='cus_local'",
    [org],
  );
  const billing = createBilling({
    db: createDatabase(pool),
    secret: "sk_test_local",
    webhookSecret: secret,
    frontendURL: "http://localhost:3000",
    prices: { TEAM: "price_team", BUSINESS: "price_business" },
    send: async () =>
      new Response(JSON.stringify(current), {
        headers: { "Content-Type": "application/json" },
      }),
  });
  const deliver = async (id, created = 200) => {
    const raw = Buffer.from(
      JSON.stringify({
        id,
        type: "customer.subscription.updated",
        created,
        data: { object: { id: "sub_local" } },
      }),
    );
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.`)
      .update(raw)
      .digest("hex");
    let result, error;
    await billing.webhook(
      {
        body: raw,
        headers: { "stripe-signature": `t=${timestamp},v1=${signature}` },
      },
      {
        json(value) {
          result = value;
        },
      },
      (e) => {
        error = e;
      },
    );
    if (error) throw error;
    return result;
  };
  await deliver("evt-local-1");
  assert.equal(
    (await pool.query("select plan from organizations where id=$1", [org]))
      .rows[0].plan,
    "BUSINESS",
  );
  await deliver("evt-local-1");
  assert.equal(
    (
      await pool.query(
        "select count(*)::int n from billing_events where id='evt-local-1'",
      )
    ).rows[0].n,
    1,
  );
  current = { ...current, status: "canceled" };
  await deliver("evt-old", 199);
  assert.equal(
    (await pool.query("select plan from organizations where id=$1", [org]))
      .rows[0].plan,
    "BUSINESS",
  );
  await deliver("evt-local-2", 201);
  assert.equal(
    (await pool.query("select plan from organizations where id=$1", [org]))
      .rows[0].plan,
    "ESSENTIALS",
  );
});
test("reset mailer uses a fixed frontend URL and provider idempotency without sending real mail", async () => {
  let options;
  const mail = makeResetMailer({
    apiKey: "test-key",
    from: "PulseShift <support@example.test>",
    frontendURL: "http://localhost:3000",
    send: async (url, request) => {
      options = request;
      return new Response("{}", { status: 200 });
    },
  });
  await mail({
    user: { email: "staff@example.test" },
    token: "one-use-test-token",
  });
  const body = JSON.parse(options.body);
  assert.ok(
    body.text.includes("http://localhost:3000/#reset=one-use-test-token"),
  );
  assert.ok(options.headers["Idempotency-Key"].startsWith("reset/"));
  assert.equal(body.to[0], "staff@example.test");
});

test("overnight eligibility covers every working date and excludes a midnight endpoint", () => {
  assert.deepEqual(
    coveredShiftDays({
      localStart: "2027-01-11T20:00",
      localEnd: "2027-01-12T04:00",
    }),
    ["2027-01-11", "2027-01-12"],
  );
  assert.deepEqual(
    coveredShiftDays({
      localStart: "2027-01-11T16:00",
      localEnd: "2027-01-12T00:00",
    }),
    ["2027-01-11"],
  );
  const candidate = {
    id: "x",
    title: "Night",
    role: "Nurse",
    localStart: "2027-01-11T16:00",
    localEnd: "2027-01-12T00:00",
    endsAt: "2027-01-12T00:00Z",
    assignments: [{ userId: "n" }],
  };
  const wf = {
    settings: { credentialRules: [{ role: "Nurse", types: ["License"] }] },
    credentials: [
      {
        userId: "n",
        type: "License",
        status: "REVIEWED",
        expiresOn: "2027-01-11",
      },
    ],
  };
  assert.equal(credentialIssues([candidate], wf, 0).length, 0);
});
