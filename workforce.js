import { randomUUID, randomBytes } from "node:crypto";
import { httpError, text, isIsoDate, hashInvite } from "./security.js";
import {
  withScheduleLock,
  normalizeShift,
  resolveLocal,
  context,
  schedulingIssues,
  shiftMinutes,
  shiftFingerprint,
} from "./scheduling.js";
import {
  blankWorkforce,
  hash,
  minutes,
  localDay,
  localHour,
  actualMinutes,
  credentialIssues,
  parseCSV,
  payrollRows,
  fairness,
  csvCell,
  clippedWorkMinutes,
  coveredShiftDays,
} from "./workforce-rules.js";
const num = (v, name, min, max) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw httpError(400, `Invalid ${name}`);
  return v;
};
const integer = (v, name, min, max) => {
  num(v, name, min, max);
  if (!Number.isInteger(v))
    throw httpError(400, `${name} must be a whole number`);
  return v;
};
const iso = (v, name) => {
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v)))
    throw httpError(400, `Invalid ${name}`);
  return new Date(v).toISOString();
};
const future = (s) => Date.parse(s.endsAt) > Date.now();
const same = (a, b) => hash(a) === hash(b);
const emptySchedule = () => ({
  shifts: [],
  published: [],
  profiles: [],
  templates: [],
});
export async function getWorkforce(client, orgId) {
  const row = (
    await client.query(
      "select revision,data from workforce_state where org_id=$1",
      [orgId],
    )
  ).rows[0];
  return row || { revision: 0, data: blankWorkforce() };
}
export function createWorkforce({ db, verifyCredential = null }) {
  const access = (wf, userId, role) => ({
    admin: role === "ADMIN",
    departments: wf.access.find((a) => a.userId === userId)?.departments || [],
  });
  const canManage = (a, department) =>
    a.admin || a.departments.includes(department);
  const canUser = (a, wf, userId) =>
    a.admin ||
    wf.staffUnits.some(
      (u) =>
        u.userId === userId &&
        u.departments.some((d) => a.departments.includes(d)),
    );
  const assertManage = (a, department) => {
    if (!canManage(a, department))
      throw httpError(403, "Manager access to this department required");
  };
  const notify = async (client, org, user, kind, message, id, key) =>
    client.query(
      `insert into notifications(org_id,user_id,kind,message,entity_id,dedupe_key) values($1,$2,$3,$4,$5,$6) on conflict do nothing`,
      [org, user, kind, message, id, key],
    );
  const audit = async (
    client,
    org,
    user,
    action,
    id,
    details = {},
    department = null,
  ) =>
    client.query(
      "insert into workforce_audit(org_id,actor_id,action,entity_id,details,department) values($1,$2,$3,$4,$5::jsonb,$6)",
      [org, user, action, id, JSON.stringify(details), department],
    );
  const scheduleFor = async (client, org) =>
    (
      await client.query(
        "select revision,data from schedule_documents where org_id=$1",
        [org],
      )
    ).rows[0] || { revision: 0, data: emptySchedule() };
  const membersFor = async (client, org) =>
    (
      await client.query(
        "select m.user_id,u.name,u.email,m.role from memberships m join users u on u.id=m.user_id where org_id=$1",
        [org],
      )
    ).rows;
  const evaluate = async (client, org, state, wf) => {
    const issues = schedulingIssues(
      state,
      org.timezone,
      await context(client, org.id, state),
    );
    return issues.concat(credentialIssues(state.shifts, wf));
  };
  async function saveSchedule(client, orgId, stored, state) {
    await client.query(
      `insert into schedule_documents(org_id,revision,data) values($1,$2,$3::jsonb) on conflict(org_id) do update set revision=excluded.revision,data=excluded.data,updated_at=now()`,
      [orgId, stored.revision + 1, JSON.stringify(state)],
    );
  }
  async function publish(
    client,
    org,
    stored,
    state,
    wf,
    actor,
    changedIds,
    allowDraft = false,
  ) {
    if (!allowDraft)
      for (const id of changedIds) {
        const draft = stored.data.shifts.find((s) => s.id === id),
          published = stored.data.published.find((s) => s.id === id);
        if (
          draft &&
          published &&
          shiftFingerprint(draft) !== shiftFingerprint(published)
        )
          throw httpError(
            409,
            "This shift has unpublished manager changes. Publish or discard them before changing its live assignments.",
          );
      }
    const target = state.published.map(
      (s) =>
        state.shifts.find((d) => d.id === s.id && changedIds.has(s.id)) || s,
    );
    for (const s of state.shifts)
      if (changedIds.has(s.id) && !target.some((p) => p.id === s.id))
        target.push(s);
    const issues = await evaluate(
      client,
      org,
      { ...state, shifts: target },
      wf,
    );
    const relevant = issues.filter(
      (i) => i.code !== "COVERAGE" && changedIds.has(i.shiftId),
    );
    // Global changes can also violate an existing worker's rest/hour limits in another shift.
    if (issues.some((i) => i.code !== "COVERAGE"))
      throw httpError(
        409,
        (relevant.length ? relevant : issues)
          .slice(0, 4)
          .map((i) => i.message)
          .join(" "),
      );
    for (const s of target)
      if (changedIds.has(s.id)) {
        const old = state.published.find((p) => p.id === s.id);
        s.publicationVersion = stored.revision + 1;
        for (const id of new Set([
          ...(old?.assignments || []).map((a) => a.userId),
          ...s.assignments.map((a) => a.userId),
        ]))
          await notify(
            client,
            org.id,
            id,
            "ASSIGNMENT",
            s.assignments.some((a) => a.userId === id)
              ? `Assignment updated: ${s.title}, ${s.localStart.replace("T", " ")}. Please accept or decline.`
              : `You are no longer assigned to ${s.title}, ${s.localStart.replace("T", " ")}.`,
            s.id,
            `workforce:${s.id}:${s.publicationVersion}`,
          );
      }
    state.published = target;
    // Preserve unrelated manager drafts and synchronize only the changed assignments.
    state.shifts = state.shifts.map((s) =>
      changedIds.has(s.id)
        ? (({ publicationVersion, ...rest }) => rest)(
            target.find((p) => p.id === s.id),
          )
        : s,
    );
    await saveSchedule(client, org.id, stored, state);
    await audit(
      client,
      org.id,
      actor,
      "PUBLISH_ASSIGNMENTS",
      [...changedIds].join(","),
      { scheduleRevision: stored.revision + 1 },
    );
  }
  async function eligible(client, org, stored, wf, shift, replaceUser = null) {
    const members = await membersFor(client, org.id);
    const candidates = [];
    for (const m of members) {
      if (
        m.user_id === replaceUser ||
        shift.assignments.some((a) => a.userId === m.user_id)
      )
        continue;
      const proposed = structuredClone(stored.data);
      const target = proposed.published.find((s) => s.id === shift.id) || shift;
      const replacement = {
        ...target,
        assignments: target.assignments
          .filter((a) => a.userId !== replaceUser)
          .concat({ userId: m.user_id, breakMinutes: 0, breakStartMinutes: 0 }),
      };
      proposed.shifts = proposed.published.map((s) =>
        s.id === shift.id ? replacement : s,
      );
      const issues = await evaluate(client, org, proposed, wf);
      if (issues.some((i) => i.code !== "COVERAGE")) continue;
      candidates.push({ userId: m.user_id, name: m.name });
    }
    return candidates;
  }
  async function builder(
    client,
    org,
    state,
    wf,
    { allowUnknownAvailability = false } = {},
  ) {
    const result = structuredClone(state);
    const members = await membersFor(client, org.id);
    const explanation = [];
    const requests = (
      await client.query(
        "select user_id,date,type,status from requests where org_id=$1 and canceled_at is null",
        [org.id],
      )
    ).rows;
    for (const s of [...result.shifts]
      .filter(future)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))) {
      const reasons = [];
      while (s.assignments.length < s.requiredCount) {
        const ranked = members
          .filter((m) => !s.assignments.some((a) => a.userId === m.user_id))
          .map((m) => ({
            m,
            load: result.shifts.reduce(
              (n, shift) =>
                n +
                (shift.assignments.some((a) => a.userId === m.user_id)
                  ? shiftMinutes(shift)
                  : 0),
              0,
            ),
          }))
          .sort(
            (a, b) => a.load - b.load || a.m.user_id.localeCompare(b.m.user_id),
          );
        let chosen = null;
        for (const { m } of ranked) {
          const pref = wf.preferences.find((p) => p.userId === m.user_id);
          const coveredDays = coveredShiftDays(s);
          const preferenceConflict = coveredDays.some((day) =>
            pref?.unavailableWeekdays.includes(
              new Date(day + "T12:00Z").getUTCDay(),
            ),
          );
          if (
            preferenceConflict ||
            (pref?.avoidNights &&
              (localHour(s.startsAt, org.timezone) >= 22 ||
                localHour(s.startsAt, org.timezone) < 6 ||
                s.localEnd.slice(0, 10) !== s.localStart.slice(0, 10) ||
                localHour(s.endsAt, org.timezone) > 22))
          ) {
            reasons.push(`${m.name}: preference excludes this shift.`);
            continue;
          }
          const available = coveredDays.every((day) =>
            requests.some(
              (r) =>
                r.user_id === m.user_id &&
                r.date === day &&
                r.type === "WORK" &&
                r.status === "APPROVED",
            ),
          );
          if (!available && !allowUnknownAvailability) {
            reasons.push(`${m.name}: confirmed day availability is missing.`);
            continue;
          }
          s.assignments.push({
            userId: m.user_id,
            breakMinutes: 0,
            breakStartMinutes: 0,
          });
          const problems = (await evaluate(client, org, result, wf)).filter(
            (i) => i.code !== "COVERAGE",
          );
          if (problems.length) {
            s.assignments.pop();
            reasons.push(`${m.name}: ${problems[0].message}`);
            continue;
          }
          chosen = m;
          explanation.push({
            shiftId: s.id,
            userId: m.user_id,
            message: `${m.name}: eligible role and credentials; ${available ? "approved availability" : "availability unknown (explicitly allowed)"}; no blocking conflicts; lowest assigned minutes among feasible candidates.`,
          });
          break;
        }
        if (!chosen) {
          explanation.push({
            shiftId: s.id,
            userId: null,
            message: `Unable to fill ${s.title}: ${[...new Set(reasons)].slice(0, 8).join(" ") || "No current team members are eligible."}`,
          });
          break;
        }
      }
    }
    return {
      shifts: result.shifts,
      explanation,
      issues: await evaluate(client, org, result, wf),
    };
  }
  const managerData = (wf, a, user) => ({
    ...wf,
    settings: a.admin
      ? wf.settings
      : { ...wf.settings, credentialRules: wf.settings.credentialRules },
    preferences: wf.preferences.filter(
      (p) => p.userId === user || canUser(a, wf, p.userId),
    ),
    credentials: wf.credentials.filter(
      (c) => c.userId === user || canUser(a, wf, c.userId),
    ),
    vacancies: wf.vacancies
      .filter(
        (v) =>
          canManage(a, v.department) ||
          v.rounds.some((r) => r.candidates.includes(user)),
      )
      .map((v) =>
        canManage(a, v.department)
          ? v
          : {
              ...v,
              reason: undefined,
              absentUserId: undefined,
              rounds: v.rounds.map((r) => ({
                ...r,
                candidates: r.candidates.filter((id) => id === user),
                declined: r.declined.filter((id) => id === user),
              })),
            },
      ),
    swaps: wf.swaps.filter(
      (s) =>
        s.fromUserId === user ||
        s.toUserId === user ||
        canManage(a, s.department),
    ),
    timesheets: wf.timesheets.filter(
      (t) => t.userId === user || canManage(a, t.department),
    ),
    rates: wf.rates.filter((r) => r.userId === user || a.admin),
    access: a.admin ? wf.access : wf.access.filter((r) => r.userId === user),
    staffUnits: a.admin
      ? wf.staffUnits
      : wf.staffUnits.filter(
          (r) => r.userId === user || canUser(a, wf, r.userId),
        ),
    exceptions: wf.exceptions.filter(
      (e) => e.userId === user || canManage(a, e.department),
    ),
    imports: a.admin ? wf.imports : [],
  });
  async function beforePublish(client, orgId, state) {
    const wf = (await getWorkforce(client, orgId)).data;
    const problems = credentialIssues(state.shifts, wf);
    if (problems.length)
      throw httpError(
        409,
        problems
          .slice(0, 4)
          .map((i) => i.message)
          .join(" "),
      );
  }
  function register(app, { auth, member, asyncHandler }) {
    const base = "/orgs/:orgId/workforce";
    app.get(
      base,
      auth,
      member,
      asyncHandler(async (req, res) => {
        const stored = await getWorkforce(db.pool, req.orgId);
        const a = access(stored.data, req.userId, req.membership.role);
        const responses = (
          await db.pool.query(
            'select shift_id as "shiftId",publication_version as "publicationVersion",user_id as "userId",decision from assignment_responses where org_id=$1',
            [req.orgId],
          )
        ).rows;
        const draft = (
          await scheduleFor(db.pool, req.orgId)
        ).data.shifts.filter((s) => canManage(a, s.department));
        res.json({
          revision: stored.revision,
          ...managerData(stored.data, a, req.userId),
          departmentDrafts: draft,
          assignmentResponses: responses,
          permissions: a,
          independentVerificationConfigured: !!verifyCredential,
        });
      }),
    );
    app.post(
      base + "/preview",
      auth,
      member,
      asyncHandler(async (req, res) => {
        const result = await withScheduleLock(db, async (client) => {
          const wf = (await getWorkforce(client, req.orgId)).data;
          const a = access(wf, req.userId, req.membership.role);
          if (!a.admin)
            throw httpError(
              403,
              "Administrator access required for whole-workspace planning",
            );
          const org = (
            await client.query("select * from organizations where id=$1", [
              req.orgId,
            ])
          ).rows[0];
          const stored = await scheduleFor(client, req.orgId);
          const state = structuredClone(stored.data);
          if (req.body.kind === "BUILD")
            return {
              scheduleRevision: stored.revision,
              ...(await builder(client, org, state, wf, req.body)),
            };
          if (req.body.kind !== "WHAT_IF")
            throw httpError(400, "Choose BUILD or WHAT_IF");
          if (req.body.absentUserId) {
            const id = text(req.body.absentUserId, "staff member", 100);
            if (req.body.date && !isIsoDate(req.body.date))
              throw httpError(400, "Valid absence date required");
            state.shifts = state.published.map((s) => ({
              ...s,
              assignments:
                !req.body.date ||
                (s.localStart.slice(0, 10) <= req.body.date &&
                  s.localEnd > req.body.date + "T00:00")
                  ? s.assignments.filter((a) => a.userId !== id)
                  : s.assignments,
            }));
          }
          if (req.body.extraShift) {
            const members = await membersFor(client, req.orgId);
            state.shifts.push(
              await normalizeShift(
                client,
                req.body.extraShift,
                org.timezone,
                members,
                `preview-${randomUUID()}`,
              ),
            );
          }
          const estimate = (shifts) => {
            let known = 0,
              unknown = 0;
            for (const s of shifts)
              for (const a of s.assignments) {
                const rate = wf.rates.find((r) => r.userId === a.userId);
                if (!rate) unknown++;
                else
                  known += Math.round(
                    ((shiftMinutes(s) - a.breakMinutes) / 60) *
                      rate.hourlyCents,
                  );
              }
            return {
              knownBaseCostCents: known,
              totalBaseCostCents: unknown ? null : known,
              unknownRateAssignments: unknown,
              currency: wf.settings.currency,
            };
          };
          return {
            scheduleRevision: stored.revision,
            issues: await evaluate(client, org, state, wf),
            before: estimate(stored.data.published),
            after: estimate(state.shifts),
            committed: false,
          };
        });
        res.json(result);
      }),
    );
    app.post(
      base,
      auth,
      member,
      asyncHandler(async (req, res) => {
        const op = text(req.body.operationId, "operation ID", 100);
        const payloadHash = hash(req.body);
        const response = await withScheduleLock(db, async (client) => {
          await client.query("select set_config('pulseshift.actor',$1,true)", [
            req.userId,
          ]);
          const org = (
            await client.query(
              "select * from organizations where id=$1 for update",
              [req.orgId],
            )
          ).rows[0];
          const current = (
            await client.query(
              "select role from memberships where org_id=$1 and user_id=$2",
              [req.orgId, req.userId],
            )
          ).rows[0];
          if (!current) throw httpError(403, "Workspace access denied");
          const prior = (
            await client.query(
              "select payload_hash,result from workforce_operations where org_id=$1 and actor_id=$2 and operation_id=$3",
              [req.orgId, req.userId, op],
            )
          ).rows[0];
          if (prior) {
            if (prior.payload_hash !== payloadHash)
              throw httpError(409, "Operation ID already used");
            return { ...prior.result, replayed: true };
          }
          const stored = await getWorkforce(client, req.orgId);
          if (req.body.revision !== stored.revision)
            throw httpError(
              409,
              "Workforce records changed. Refresh before retrying.",
            );
          const wf = structuredClone(stored.data);
          const a = access(wf, req.userId, current.role);
          const schedule = await scheduleFor(client, req.orgId);
          const state = structuredClone(schedule.data);
          const action = req.body.action;
          let result = {};
          let entityId = null;
          let department = null;
          const admin = () => {
            if (!a.admin) throw httpError(403, "Administrator access required");
          };
          const memberId = (id) => {
            if (!members.some((m) => m.user_id === id))
              throw httpError(400, "Choose a current team member");
            return id;
          };
          const members = await membersFor(client, req.orgId);
          const shiftById = (id) => {
            const s = state.published.find((s) => s.id === id);
            if (!s) throw httpError(404, "Published shift not found");
            department = s.department;
            return s;
          };
          const requireSchedule = () => {
            if (req.body.scheduleRevision !== schedule.revision)
              throw httpError(
                409,
                "The schedule changed. Refresh before retrying.",
              );
          };
          if (action === "PREFERENCES") {
            const days = req.body.unavailableWeekdays;
            if (
              !Array.isArray(days) ||
              days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)
            )
              throw httpError(400, "Choose valid weekdays");
            wf.preferences = wf.preferences
              .filter((p) => p.userId !== req.userId)
              .concat({
                userId: req.userId,
                unavailableWeekdays: [...new Set(days)],
                avoidNights: req.body.avoidNights === true,
              });
          } else if (action === "SETTINGS") {
            admin();
            const s = req.body.settings;
            if (!s || s.currency !== "USD")
              throw httpError(400, "This release uses USD");
            const threshold =
              s.overtimeThresholdHours === null
                ? null
                : num(s.overtimeThresholdHours, "overtime threshold", 1, 168);
            const multiplier =
              s.overtimeMultiplier === null
                ? null
                : num(s.overtimeMultiplier, "overtime multiplier", 1, 5);
            if ((threshold === null) !== (multiplier === null))
              throw httpError(
                400,
                "Configure both overtime fields or leave both unknown",
              );
            if (
              !Array.isArray(s.credentialRules) ||
              s.credentialRules.length > 30
            )
              throw httpError(400, "Invalid credential rules");
            const rules = s.credentialRules.map((r) => ({
              role: text(r.role, "role", 80),
              types:
                Array.isArray(r.types) && r.types.length <= 10
                  ? r.types.map((t) => text(t, "credential type", 80))
                  : (() => {
                      throw httpError(400, "Invalid credential types");
                    })(),
            }));
            wf.settings = {
              currency: "USD",
              overtimeThresholdHours: threshold,
              overtimeMultiplier: multiplier,
              credentialRules: rules,
            };
            const issues = credentialIssues(state.published, wf);
            if (issues.length)
              throw httpError(
                409,
                "These requirements invalidate published assignments. Update those assignments first.",
              );
          } else if (action === "RATE") {
            admin();
            const userId = memberId(req.body.userId);
            const hourlyCents = integer(
              req.body.hourlyCents,
              "hourly rate in cents",
              0,
              10000000,
            );
            wf.rates = wf.rates
              .filter((r) => r.userId !== userId)
              .concat({ userId, hourlyCents });
            entityId = userId;
          } else if (action === "ACCESS") {
            admin();
            const userId = memberId(req.body.userId);
            if (
              !Array.isArray(req.body.departments) ||
              req.body.departments.length > 30
            )
              throw httpError(400, "Departments required");
            const departments = [
              ...new Set(
                req.body.departments.map((d) => text(d, "department", 80)),
              ),
            ];
            wf.access = wf.access
              .filter((r) => r.userId !== userId)
              .concat({ userId, departments });
            entityId = userId;
          } else if (action === "STAFF_UNITS") {
            admin();
            const userId = memberId(req.body.userId);
            if (
              !Array.isArray(req.body.departments) ||
              req.body.departments.length > 30
            )
              throw httpError(400, "Departments required");
            wf.staffUnits = wf.staffUnits
              .filter((u) => u.userId !== userId)
              .concat({
                userId,
                departments: req.body.departments.map((d) =>
                  text(d, "department", 80),
                ),
              });
            entityId = userId;
          } else if (action === "SITE") {
            admin();
            if (
              !Array.isArray(req.body.departments) ||
              req.body.departments.length > 30
            )
              throw httpError(400, "Choose up to 30 departments");
            const site = {
              id: req.body.id || randomUUID(),
              name: text(req.body.name, "site name", 80),
              departments: req.body.departments.map((d) =>
                text(d, "department", 80),
              ),
            };
            if (wf.sites.length >= 50 && !req.body.id)
              throw httpError(400, "Site limit reached");
            wf.sites = wf.sites.filter((s) => s.id !== site.id).concat(site);
            entityId = site.id;
          } else if (action === "CREDENTIAL") {
            const userId = req.body.userId || req.userId;
            if (userId !== req.userId && !canUser(a, wf, userId))
              throw httpError(403, "Credential access denied");
            memberId(userId);
            if (!isIsoDate(req.body.expiresOn))
              throw httpError(400, "Valid expiry date required");
            const fileId = req.body.fileId || null;
            if (
              fileId &&
              !(
                await client.query(
                  "select 1 from workforce_files where id=$1 and org_id=$2 and user_id=$3",
                  [fileId, req.orgId, userId],
                )
              ).rows.length
            )
              throw httpError(400, "Credential document not found");
            const c = {
              id: randomUUID(),
              userId,
              type: text(req.body.type, "credential type", 80),
              expiresOn: req.body.expiresOn,
              status: "UPLOADED",
              fileId,
              createdAt: new Date().toISOString(),
            };
            wf.credentials.push(c);
            entityId = c.id;
          } else if (action === "REVIEW_CREDENTIAL") {
            const c = wf.credentials.find(
              (c) => c.id === req.body.credentialId,
            );
            if (!c) throw httpError(404, "Credential not found");
            if (!canUser(a, wf, c.userId))
              throw httpError(403, "Credential reviewer access denied");
            if (c.userId === req.userId)
              throw httpError(
                403,
                "Another manager must review your credential",
              );
            c.status = "REVIEWED";
            c.reviewedBy = req.userId;
            c.reviewedAt = new Date().toISOString();
            entityId = c.id;
          } else if (action === "VERIFY_CREDENTIAL") {
            admin();
            if (!verifyCredential)
              throw httpError(
                503,
                "Independent credential verification is not configured",
              );
            throw httpError(
              503,
              "Run the configured credential verifier outside a scheduling transaction",
            );
          } else if (action === "APPLY_BUILD") {
            admin();
            requireSchedule();
            const preview = await builder(client, org, state, wf, req.body);
            state.shifts = preview.shifts;
            await saveSchedule(client, req.orgId, schedule, state);
            result = {
              explanation: preview.explanation,
              issues: preview.issues,
              scheduleRevision: schedule.revision + 1,
            };
          } else if (action === "DEPARTMENT_ASSIGN") {
            requireSchedule();
            const s = state.shifts.find((s) => s.id === req.body.shiftId);
            if (!s) throw httpError(404, "Draft shift not found");
            assertManage(a, s.department);
            department = s.department;
            if (!future(s))
              throw httpError(400, "Historical assignments are read-only");
            const users = req.body.userIds;
            if (!Array.isArray(users) || new Set(users).size !== users.length)
              throw httpError(400, "Distinct staff IDs required");
            s.assignments = users.map(
              (id) =>
                s.assignments.find((a) => a.userId === id) || {
                  userId: memberId(id),
                  breakMinutes: 0,
                  breakStartMinutes: 0,
                },
            );
            await saveSchedule(client, req.orgId, schedule, state);
            result = { scheduleRevision: schedule.revision + 1 };
          } else if (action === "DEPARTMENT_PUBLISH") {
            requireSchedule();
            department = text(req.body.department, "department", 80);
            assertManage(a, department);
            const ids = new Set(
              state.shifts
                .filter(
                  (s) =>
                    s.department === department &&
                    future(s) &&
                    !state.published.some(
                      (p) =>
                        p.id === s.id &&
                        shiftFingerprint(p) === shiftFingerprint(s),
                    ),
                )
                .map((s) => s.id),
            );
            if (!ids.size)
              throw httpError(400, "No draft shifts in this department");
            await publish(
              client,
              org,
              schedule,
              state,
              wf,
              req.userId,
              ids,
              true,
            );
            result = { scheduleRevision: schedule.revision + 1 };
          } else if (action === "RESPOND_ASSIGNMENT") {
            requireSchedule();
            const s = shiftById(req.body.shiftId);
            if (
              !future(s) ||
              !s.assignments.some((x) => x.userId === req.userId)
            )
              throw httpError(403, "Current assignment required");
            if (s.publicationVersion !== req.body.publicationVersion)
              throw httpError(409, "Assignment changed. Review it again.");
            if (!["ACCEPT", "DECLINE"].includes(req.body.decision))
              throw httpError(400, "Accept or decline required");
            await client.query(
              "insert into assignment_responses(org_id,shift_id,publication_version,user_id,decision) values($1,$2,$3,$4,$5) on conflict(org_id,shift_id,publication_version,user_id) do update set decision=excluded.decision,responded_at=now()",
              [
                req.orgId,
                s.id,
                s.publicationVersion,
                req.userId,
                req.body.decision,
              ],
            );
            if (req.body.decision === "ACCEPT") {
              for (const m of members.filter(
                (m) =>
                  m.role === "ADMIN" ||
                  wf.access.some(
                    (x) =>
                      x.userId === m.user_id &&
                      x.departments.includes(s.department),
                  ),
              ))
                await notify(
                  client,
                  req.orgId,
                  m.user_id,
                  "ASSIGNMENT_RESPONSE",
                  `${req.user.name} accepted ${s.title}.`,
                  s.id,
                  `accepted:${s.id}:${s.publicationVersion}:${req.userId}`,
                );

              await client.query(
                "insert into shift_acknowledgements(org_id,shift_id,publication_version,user_id) values($1,$2,$3,$4) on conflict do nothing",
                [req.orgId, s.id, s.publicationVersion, req.userId],
              );
            } else {
              const vacancy = {
                id: randomUUID(),
                shiftId: s.id,
                department: s.department,
                absentUserId: req.userId,
                status: "OPEN",
                rounds: [],
                createdAt: new Date().toISOString(),
                reason:
                  text(req.body.reason, "decline reason", 300, true) ||
                  "Assignment declined",
              };
              wf.vacancies.push(vacancy);
              s.assignments = s.assignments.filter(
                (x) => x.userId !== req.userId,
              );
              const draft = state.shifts.find((d) => d.id === s.id);
              if (draft)
                draft.assignments = draft.assignments.filter(
                  (x) => x.userId !== req.userId,
                );
              s.publicationVersion = schedule.revision + 1;
              await saveSchedule(client, req.orgId, schedule, state);
              entityId = vacancy.id;
              for (const m of members.filter(
                (m) =>
                  m.role === "ADMIN" ||
                  wf.access.some(
                    (x) =>
                      x.userId === m.user_id &&
                      x.departments.includes(s.department),
                  ),
              ))
                await notify(
                  client,
                  req.orgId,
                  m.user_id,
                  "VACANCY",
                  `An assignment was declined for ${s.title}. Review the replacement desk.`,
                  vacancy.id,
                  `vacancy:${vacancy.id}`,
                );
            }
          } else if (action === "OPEN_VACANCY") {
            requireSchedule();
            const s = shiftById(req.body.shiftId);
            assertManage(a, s.department);
            if (!future(s)) throw httpError(400, "Shift has ended");
            if (
              wf.vacancies.some(
                (v) => v.shiftId === s.id && v.status === "OPEN",
              )
            )
              throw httpError(
                409,
                "This shift already has an open replacement search",
              );
            const absent = req.body.absentUserId || null;
            if (absent) {
              if (!s.assignments.some((a) => a.userId === absent))
                throw httpError(400, "Absent member is not assigned");
              s.assignments = s.assignments.filter((a) => a.userId !== absent);
              const draft = state.shifts.find((d) => d.id === s.id);
              if (draft)
                draft.assignments = draft.assignments.filter(
                  (a) => a.userId !== absent,
                );
              s.publicationVersion = schedule.revision + 1;
              await saveSchedule(client, req.orgId, schedule, state);
            } else if (s.assignments.length >= s.requiredCount)
              throw httpError(400, "No unfilled headcount slot");
            const v = {
              id: randomUUID(),
              shiftId: s.id,
              department: s.department,
              absentUserId: absent,
              status: "OPEN",
              rounds: [],
              createdAt: new Date().toISOString(),
              reason:
                text(req.body.reason, "reason", 300, true) || "Coverage needed",
            };
            wf.vacancies.push(v);
            entityId = v.id;
          } else if (action === "CONTACT_ROUND") {
            const v = wf.vacancies.find(
              (v) => v.id === req.body.vacancyId && v.status === "OPEN",
            );
            if (!v) throw httpError(404, "Open vacancy not found");
            const s = shiftById(v.shiftId);
            assertManage(a, s.department);
            if (!future(s)) throw httpError(400, "Shift has ended");
            if (
              v.rounds.some(
                (r) =>
                  Date.parse(r.expiresAt) > Date.now() &&
                  r.candidates.some((id) => !r.declined.includes(id)),
              )
            )
              throw httpError(
                409,
                "Wait for the current contact round to finish",
              );
            const candidates = await eligible(
              client,
              org,
              schedule,
              wf,
              s,
              v.absentUserId,
            );
            const attempted = new Set(v.rounds.flatMap((r) => r.candidates));
            const next = candidates
              .filter((c) => !attempted.has(c.userId))
              .slice(0, integer(req.body.batchSize || 3, "round size", 1, 5));
            if (!next.length)
              throw httpError(
                409,
                "No uncontacted eligible staff are available",
              );
            const round = {
              id: randomUUID(),
              candidates: next.map((c) => c.userId),
              declined: [],
              expiresAt: new Date(
                Date.now() +
                  integer(req.body.minutes || 15, "round duration", 1, 120) *
                    60000,
              ).toISOString(),
            };
            v.rounds.push(round);
            for (const c of next)
              await notify(
                client,
                req.orgId,
                c.userId,
                "OPEN_SHIFT",
                `Can you cover ${s.title}, ${s.localStart.replace("T", " ")}? Respond in the replacement desk before ${round.expiresAt}.`,
                v.id,
                `round:${round.id}`,
              );
            entityId = v.id;
          } else if (action === "VACANCY_RESPONSE") {
            requireSchedule();
            const v = wf.vacancies.find(
              (v) => v.id === req.body.vacancyId && v.status === "OPEN",
            );
            if (!v) throw httpError(409, "This vacancy is no longer open");
            const round = v.rounds.findLast(
              (r) =>
                r.candidates.includes(req.userId) &&
                !r.declined.includes(req.userId) &&
                Date.parse(r.expiresAt) > Date.now(),
            );
            if (!round) throw httpError(403, "No active invitation for you");
            if (req.body.decision === "DECLINE")
              round.declined.push(req.userId);
            else if (req.body.decision === "ACCEPT") {
              const s = shiftById(v.shiftId);
              if (!future(s)) throw httpError(409, "Shift has ended");
              if (
                !(
                  await eligible(client, org, schedule, wf, s, v.absentUserId)
                ).some((c) => c.userId === req.userId)
              )
                throw httpError(
                  409,
                  "Your eligibility changed. Refresh before accepting.",
                );
              if (s.assignments.length >= s.requiredCount)
                throw httpError(409, "This shift is already filled");
              const changed = {
                ...s,
                assignments: s.assignments.concat({
                  userId: req.userId,
                  breakMinutes: 0,
                  breakStartMinutes: 0,
                }),
              };
              state.shifts = state.shifts
                .filter((x) => x.id !== s.id)
                .concat(changed);
              await publish(
                client,
                org,
                schedule,
                state,
                wf,
                req.userId,
                new Set([s.id]),
              );
              v.status = "FILLED";
              v.filledBy = req.userId;
              v.filledAt = new Date().toISOString();
            } else throw httpError(400, "Accept or decline required");
            entityId = v.id;
          } else if (action === "REQUEST_SWAP") {
            const from = shiftById(req.body.shiftId);
            if (
              !from.assignments.some((a) => a.userId === req.userId) ||
              !future(from)
            )
              throw httpError(403, "Upcoming assignment required");
            const toUserId = memberId(req.body.toUserId);
            if (toUserId === req.userId)
              throw httpError(400, "Choose a different colleague");
            if (
              wf.swaps.some(
                (s) =>
                  s.shiftId === from.id &&
                  s.fromUserId === req.userId &&
                  ["PENDING", "ACCEPTED"].includes(s.status),
              )
            )
              throw httpError(409, "An active swap already exists");
            const other = req.body.tradeShiftId
              ? shiftById(req.body.tradeShiftId)
              : null;
            if (
              other &&
              (!other.assignments.some((a) => a.userId === toUserId) ||
                other.department !== from.department)
            )
              throw httpError(
                400,
                "Choose a colleague’s shift in the same department",
              );
            const swap = {
              id: randomUUID(),
              shiftId: from.id,
              department: from.department,
              fromUserId: req.userId,
              toUserId,
              tradeShiftId: other?.id || null,
              fromVersion: from.publicationVersion,
              tradeVersion: other?.publicationVersion || null,
              status: "PENDING",
              createdAt: new Date().toISOString(),
            };
            wf.swaps.push(swap);
            await notify(
              client,
              req.orgId,
              toUserId,
              "SWAP",
              `A colleague offered you ${from.title}. Review and accept or decline the proposed swap.`,
              swap.id,
              `swap:${swap.id}`,
            );
            entityId = swap.id;
          } else if (action === "RESPOND_SWAP") {
            const s = wf.swaps.find((s) => s.id === req.body.swapId);
            if (!s || s.toUserId !== req.userId || s.status !== "PENDING")
              throw httpError(403, "Pending swap invitation required");
            if (!["ACCEPT", "DECLINE"].includes(req.body.decision))
              throw httpError(400, "Accept or decline required");
            s.status = req.body.decision === "ACCEPT" ? "ACCEPTED" : "DECLINED";
            entityId = s.id;
          } else if (action === "APPROVE_SWAP") {
            requireSchedule();
            const swap = wf.swaps.find(
              (s) => s.id === req.body.swapId && s.status === "ACCEPTED",
            );
            if (!swap)
              throw httpError(409, "The colleague must accept this swap first");
            const from = shiftById(swap.shiftId);
            assertManage(a, from.department);
            if (swap.fromUserId === req.userId || swap.toUserId === req.userId)
              throw httpError(
                403,
                "A different manager must approve your swap",
              );
            if (
              !future(from) ||
              from.publicationVersion !== swap.fromVersion ||
              !from.assignments.some((a) => a.userId === swap.fromUserId)
            )
              throw httpError(
                409,
                "Original assignment changed. Request a new swap",
              );
            const changes = [
              {
                ...from,
                assignments: from.assignments
                  .filter((a) => a.userId !== swap.fromUserId)
                  .concat({
                    userId: swap.toUserId,
                    breakMinutes: 0,
                    breakStartMinutes: 0,
                  }),
              },
            ];
            if (swap.tradeShiftId) {
              const other = shiftById(swap.tradeShiftId);
              assertManage(a, other.department);
              if (
                !future(other) ||
                other.publicationVersion !== swap.tradeVersion
              )
                throw httpError(409, "Trade assignment changed");
              changes.push({
                ...other,
                assignments: other.assignments
                  .filter((a) => a.userId !== swap.toUserId)
                  .concat({
                    userId: swap.fromUserId,
                    breakMinutes: 0,
                    breakStartMinutes: 0,
                  }),
              });
            }
            state.shifts = state.shifts
              .filter((s) => !changes.some((c) => c.id === s.id))
              .concat(changes);
            await publish(
              client,
              org,
              schedule,
              state,
              wf,
              req.userId,
              new Set(changes.map((s) => s.id)),
            );
            swap.status = "APPROVED";
            swap.approvedBy = req.userId;
            entityId = swap.id;
          } else if (action === "CLOCK_IN") {
            const s = shiftById(req.body.shiftId);
            if (!s.assignments.some((a) => a.userId === req.userId))
              throw httpError(403, "You are not assigned to this shift");
            const now = Date.now();
            if (
              now < Date.parse(s.startsAt) - 3600000 ||
              now > Date.parse(s.endsAt)
            )
              throw httpError(
                400,
                "Clock in from one hour before the shift starts until it ends",
              );
            const docs = (
              await client.query("select data from workforce_state")
            ).rows;
            if (
              docs.some((d) =>
                d.data.timesheets.some(
                  (t) => t.userId === req.userId && !t.clockOut,
                ),
              )
            )
              throw httpError(409, "Clock out of your active timesheet first");
            const t = {
              id: randomUUID(),
              userId: req.userId,
              shiftId: s.id,
              department: s.department,
              location: s.location,
              timezone: org.timezone,
              clockIn: new Date().toISOString(),
              clockOut: null,
              breaks: [],
              status: "OPEN",
              version: 1,
            };
            wf.timesheets.push(t);
            entityId = t.id;
          } else if (
            [
              "START_BREAK",
              "END_BREAK",
              "CLOCK_OUT",
              "CORRECT_TIME",
              "APPROVE_TIME",
              "REJECT_TIME",
            ].includes(action)
          ) {
            const t = wf.timesheets.find((t) => t.id === req.body.timesheetId);
            if (!t) throw httpError(404, "Timesheet not found");
            department = t.department;
            entityId = t.id;
            if (t.version !== req.body.version)
              throw httpError(409, "Timesheet changed. Refresh before editing");
            if (["APPROVE_TIME", "REJECT_TIME"].includes(action)) {
              assertManage(a, t.department);
              if (t.userId === req.userId)
                throw httpError(403, "Another manager must approve your time");
              if (!t.clockOut || (!t.correction && t.status !== "PENDING"))
                throw httpError(409, "No time submission awaiting review");
              if (action === "APPROVE_TIME") {
                if (t.correction) {
                  t.clockIn = t.correction.clockIn;
                  t.clockOut = t.correction.clockOut;
                  t.breaks = t.correction.breaks;
                  t.correction = null;
                }
                t.status = "APPROVED";
                t.approvedBy = req.userId;
                t.approvedAt = new Date().toISOString();
                const rate = wf.rates.find((r) => r.userId === t.userId);
                t.paySnapshot = {
                  hourlyCents: rate?.hourlyCents ?? null,
                  policy: structuredClone(wf.settings),
                };
              } else {
                if (t.correction) t.correction = null;
                else t.status = "REJECTED";
                t.reviewNote = text(req.body.note, "review note", 300, true);
              }
            } else {
              if (t.userId !== req.userId)
                throw httpError(
                  403,
                  "Only the owner may record or correct their time",
                );
              const now = new Date().toISOString();
              if (action === "CORRECT_TIME") {
                if (!t.clockOut)
                  throw httpError(
                    409,
                    "Clock out before requesting a correction",
                  );
                const start = req.body.localClockIn
                    ? await resolveLocal(
                        client,
                        req.body.localClockIn,
                        org.timezone,
                      )
                    : iso(req.body.clockIn, "clock-in"),
                  end = req.body.localClockOut
                    ? await resolveLocal(
                        client,
                        req.body.localClockOut,
                        org.timezone,
                      )
                    : iso(req.body.clockOut, "clock-out");
                const breakMinutes = integer(
                  req.body.breakMinutes || 0,
                  "break minutes",
                  0,
                  1440,
                );
                if (
                  minutes(start, end) <= breakMinutes ||
                  minutes(start, end) > 24 * 60 ||
                  Date.parse(end) > Date.now()
                )
                  throw httpError(
                    400,
                    "Corrected time must be in the past, positive and at most 24 hours",
                  );
                const docs = (
                  await client.query("select data from workforce_state")
                ).rows;
                if (
                  docs.some((d) =>
                    d.data.timesheets.some(
                      (o) =>
                        o.id !== t.id &&
                        o.userId === t.userId &&
                        o.clockOut &&
                        Date.parse(o.clockIn) < Date.parse(end) &&
                        Date.parse(o.clockOut) > Date.parse(start),
                    ),
                  )
                )
                  throw httpError(409, "Correction overlaps another timesheet");
                t.correction = {
                  clockIn: start,
                  clockOut: end,
                  breaks: breakMinutes
                    ? [
                        {
                          start,
                          end: new Date(
                            Date.parse(start) + breakMinutes * 60000,
                          ).toISOString(),
                        },
                      ]
                    : [],
                  reason: text(req.body.reason, "correction reason", 300),
                  requestedAt: now,
                };
              } else {
                if (t.clockOut)
                  throw httpError(409, "Timesheet is already closed");
                const open = t.breaks.find((b) => !b.end);
                if (action === "START_BREAK") {
                  if (open) throw httpError(409, "Break already started");
                  t.breaks.push({ start: now, end: null });
                }
                if (action === "END_BREAK") {
                  if (!open) throw httpError(409, "No active break");
                  open.end = now;
                }
                if (action === "CLOCK_OUT") {
                  if (open) open.end = now;
                  t.clockOut = now;
                  t.status = "PENDING";
                }
              }
            }
            t.version++;
          } else if (action === "FAIRNESS_EXCEPTION") {
            department = text(req.body.department, "department", 80);
            assertManage(a, department);
            const userId = memberId(req.body.userId);
            const e = {
              id: randomUUID(),
              userId,
              department,
              note: text(req.body.note, "exception explanation", 500),
              createdBy: req.userId,
              createdAt: new Date().toISOString(),
            };
            wf.exceptions.push(e);
            entityId = e.id;
          } else if (action === "IMPORT") {
            admin();
            requireSchedule();
            const kind = req.body.kind;
            const rows = parseCSV(req.body.csv);
            const errors = [];
            const valid = [];
            for (const row of rows) {
              try {
                if (row.error) throw new Error(row.error);
                if (kind === "STAFF") {
                  const email = text(
                    row.values.email,
                    "email",
                    254,
                  ).toLowerCase();
                  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
                    throw new Error("Invalid email");
                  if (members.some((m) => m.email === email))
                    throw new Error("Already a team member");
                  if (valid.some((v) => v.email === email))
                    throw new Error("Duplicate email");
                  valid.push({
                    email,
                    name: text(row.values.name, "name", 100),
                  });
                } else if (kind === "SHIFTS") {
                  const v = row.values;
                  const emails = (v.emails || "").split(";").filter(Boolean);
                  const assignments = emails.map((email) => {
                    const m = members.find(
                      (m) => m.email === email.toLowerCase(),
                    );
                    if (!m) throw new Error(`Unknown staff email: ${email}`);
                    return {
                      userId: m.user_id,
                      breakMinutes: 0,
                      breakStartMinutes: 0,
                    };
                  });
                  valid.push(
                    await normalizeShift(
                      client,
                      {
                        ...v,
                        requiredCount: Number(v.requiredCount),
                        assignments,
                      },
                      org.timezone,
                      members,
                      `shift-${randomUUID()}`,
                    ),
                  );
                } else throw new Error("Choose STAFF or SHIFTS");
              } catch (error) {
                errors.push({ row: row.row, message: error.message });
              }
            }
            if (req.body.commit !== true)
              return {
                preview: true,
                validRows: valid,
                errors,
                fingerprint: hash({ kind, csv: req.body.csv }),
              };
            if (
              errors.length ||
              req.body.fingerprint !== hash({ kind, csv: req.body.csv })
            )
              throw httpError(
                400,
                "Fix import errors and confirm the current preview before importing",
              );
            if (kind === "SHIFTS") {
              if (state.shifts.length + valid.length > 1000)
                throw httpError(400, "Shift capacity exceeded");
              state.shifts.push(...valid);
              await saveSchedule(client, req.orgId, schedule, state);
            } else {
              const reserved = (
                await client.query(
                  "select count(*)::int n from invitations where org_id=$1 and accepted_at is null and revoked_at is null and expires_at>now()",
                  [req.orgId],
                )
              ).rows[0].n;
              if (members.length + reserved + valid.length > org.seats_total)
                throw httpError(409, "Not enough seats for this staff import");
              const invites = [];
              for (const v of valid) {
                const token = randomBytes(32).toString("hex");
                await client.query(
                  "select pulse_create_invitation($1,$2,$3,$4,'NURSE',$5)",
                  [
                    randomUUID(),
                    req.orgId,
                    req.userId,
                    v.email,
                    hashInvite(token),
                  ],
                );
                invites.push({ email: v.email, token });
              }
              result = { invitations: invites };
            }
            wf.imports.push({
              id: randomUUID(),
              kind,
              count: valid.length,
              createdAt: new Date().toISOString(),
            });
          } else throw httpError(400, "Unknown workforce action");
          if (
            wf.credentials.length > 2000 ||
            wf.timesheets.length > 10000 ||
            wf.vacancies.length > 1000 ||
            wf.swaps.length > 1000
          )
            throw httpError(
              400,
              "Workspace record capacity reached; export and archive before continuing",
            );
          await client.query(
            `insert into workforce_state(org_id,revision,data) values($1,$2,$3::jsonb) on conflict(org_id) do update set revision=excluded.revision,data=excluded.data,updated_at=now()`,
            [req.orgId, stored.revision + 1, JSON.stringify(wf)],
          );
          await audit(
            client,
            req.orgId,
            req.userId,
            action,
            entityId,
            { workforceRevision: stored.revision + 1 },
            department,
          );
          const output = { ...result, revision: stored.revision + 1 };
          await client.query(
            "insert into workforce_operations(org_id,actor_id,operation_id,payload_hash,result) values($1,$2,$3,$4,$5::jsonb)",
            [req.orgId, req.userId, op, payloadHash, JSON.stringify(output)],
          );
          return output;
        });
        res.json(response);
      }),
    );
    app.get(
      base + "/reports",
      auth,
      member,
      asyncHandler(async (req, res) => {
        const wf = (await getWorkforce(db.pool, req.orgId)).data;
        const a = access(wf, req.userId, req.membership.role);
        if (!a.admin && !a.departments.length)
          throw httpError(403, "Manager access required");
        const org = (
          await db.pool.query("select * from organizations where id=$1", [
            req.orgId,
          ])
        ).rows[0];
        const state = (await scheduleFor(db.pool, req.orgId)).data;
        const start = text(req.query.start, "start date", 10),
          end = text(req.query.end, "end date", 10);
        if (
          !isIsoDate(start) ||
          !isIsoDate(end) ||
          end < start ||
          minutes(start, end) > 366 * 1440
        )
          throw httpError(400, "Choose a date range up to one year");
        const bounds = (
          await db.pool.query(
            "select $1::date::timestamp at time zone $3 as starts, ($2::date+1)::timestamp at time zone $3 as ends",
            [start, end, org.timezone],
          )
        ).rows[0];
        const from = Date.parse(bounds.starts),
          to = Date.parse(bounds.ends);
        const shifts = state.published.filter(
          (s) =>
            Date.parse(s.startsAt) < to &&
            Date.parse(s.endsAt) > from &&
            canManage(a, s.department),
        );
        const members = await membersFor(db.pool, req.orgId);
        const allowedEntries = new Set(
          wf.timesheets
            .filter((t) => canManage(a, t.department))
            .map((t) => t.id),
        );
        const pay = payrollRows(wf.timesheets, wf.settings, wf.rates).filter(
          (r) =>
            allowedEntries.has(r.entryId) && r.day >= start && r.day <= end,
        );
        const accepted = (
          await db.pool.query(
            "select shift_id,user_id,publication_version from assignment_responses where org_id=$1 and decision='ACCEPT'",
            [req.orgId],
          )
        ).rows;
        const assignedMinutes = (s, a) =>
          clippedWorkMinutes(
            s.startsAt,
            s.endsAt,
            a.breakMinutes
              ? [
                  {
                    start: new Date(
                      Date.parse(s.startsAt) + a.breakStartMinutes * 60000,
                    ).toISOString(),
                    end: new Date(
                      Date.parse(s.startsAt) +
                        (a.breakStartMinutes + a.breakMinutes) * 60000,
                    ).toISOString(),
                  },
                ]
              : [],
            from,
            to,
          );
        const plannedMinutes = shifts.reduce(
          (sum, s) =>
            sum + s.assignments.reduce((n, a) => n + assignedMinutes(s, a), 0),
          0,
        );
        const confirmedMinutes = shifts.reduce(
          (sum, s) =>
            sum +
            s.assignments
              .filter((a) =>
                accepted.some(
                  (x) =>
                    x.shift_id === s.id &&
                    x.user_id === a.userId &&
                    x.publication_version === s.publicationVersion,
                ),
              )
              .reduce((n, a) => n + assignedMinutes(s, a), 0),
          0,
        );
        const gaps = await evaluate(db.pool, org, { ...state, shifts }, wf);
        const vacancies = wf.vacancies.filter(
          (v) =>
            canManage(a, v.department) &&
            v.createdAt.slice(0, 10) >= start &&
            v.createdAt.slice(0, 10) <= end,
        );
        res.json({
          plannedMinutes,
          confirmedMinutes,
          approvedWorkedMinutes: pay.reduce(
            (sum, r) => sum + r.workedMinutes,
            0,
          ),
          payroll: pay,
          coverageGaps: gaps.filter((i) => i.code === "COVERAGE").length,
          blockingConflicts: gaps.filter((i) => i.code !== "COVERAGE").length,
          openVacancies: vacancies.filter((v) => v.status === "OPEN").length,
          filledVacancies: vacancies.filter((v) => v.status === "FILLED")
            .length,
          averageFillMinutes: vacancies.some((v) => v.filledAt)
            ? vacancies
                .filter((v) => v.filledAt)
                .reduce((sum, v) => sum + minutes(v.createdAt, v.filledAt), 0) /
              vacancies.filter((v) => v.filledAt).length
            : null,
          fairness: fairness(
            state.published,
            members,
            wf.settings,
            org.timezone,
            { from, to, departments: a.admin ? null : a.departments },
          ),
          unknownRateEntries: pay.filter((r) => r.hourlyCents === null).length,
          unknownPolicyEntries: pay.filter((r) => !r.overtimePolicyConfigured)
            .length,
          estimatedGrossCents: pay.some((r) => r.estimatedGrossCents === null)
            ? null
            : pay.reduce((sum, r) => sum + r.estimatedGrossCents, 0),
          currency: wf.settings.currency,
          definitions: {
            night:
              "Worked/planned minutes between 22:00 and 06:00 in workspace timezone",
            weekend: "Saturday and Sunday in workspace timezone",
            confirmed:
              "Assigned staff accepted the current published assignment",
            worked: "Approved recorded time less actual breaks",
            pay: "Gross estimate only; no tax, withholding or payment processing",
          },
        });
      }),
    );
    app.get(
      base + "/audit",
      auth,
      member,
      asyncHandler(async (req, res) => {
        const wf = (await getWorkforce(db.pool, req.orgId)).data;
        const a = access(wf, req.userId, req.membership.role);
        if (!a.admin && !a.departments.length)
          throw httpError(403, "Manager access required");
        const query = String(req.query.q || "").slice(0, 100);
        const rows = (
          await db.pool.query(
            `select id::text,actor_id as "actorId",action,entity_id as "entityId",department,details,created_at as "createdAt" from workforce_audit where org_id=$1 and ($2='' or action ilike '%'||$2||'%' or coalesce(entity_id,'') ilike '%'||$2||'%') and ($3::boolean or department=any($4::text[])) order by id desc limit 200`,
            [req.orgId, query, a.admin, a.departments],
          )
        ).rows;
        res.json({ events: rows });
      }),
    );
    app.get(
      base + "/calendar",
      auth,
      member,
      asyncHandler(async (req, res) => {
        const state = (await scheduleFor(db.pool, req.orgId)).data;
        const escape = (v) =>
          String(v)
            .replaceAll("\r", "")
            .replaceAll("\\", "\\\\")
            .replaceAll("\n", "\\n")
            .replaceAll(",", "\\,")
            .replaceAll(";", "\\;");
        const date = (v) =>
          new Date(v)
            .toISOString()
            .replaceAll("-", "")
            .replaceAll(":", "")
            .replace(".000", "");
        const lines = [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//PulseShift//Schedule//EN",
          "CALSCALE:GREGORIAN",
        ];
        for (const s of state.published.filter((s) =>
          s.assignments.some((a) => a.userId === req.userId),
        ))
          lines.push(
            "BEGIN:VEVENT",
            `UID:${escape(s.id)}@pulseshift`,
            `DTSTAMP:${date(Date.now())}`,
            `DTSTART:${date(s.startsAt)}`,
            `DTEND:${date(s.endsAt)}`,
            `SUMMARY:${escape(s.title)}`,
            `LOCATION:${escape(s.location)}`,
            `SEQUENCE:${s.publicationVersion || 1}`,
            "END:VEVENT",
          );
        lines.push("END:VCALENDAR");
        res
          .type("text/calendar")
          .attachment("pulseshift.ics")
          .send(lines.join("\r\n") + "\r\n");
      }),
    );
    app.get(
      base + "/payroll.csv",
      auth,
      member,
      asyncHandler(async (req, res) => {
        const wf = (await getWorkforce(db.pool, req.orgId)).data;
        if (req.membership.role !== "ADMIN")
          throw httpError(403, "Administrator access required");
        const start = String(req.query.start || ""),
          end = String(req.query.end || "");
        if (!isIsoDate(start) || !isIsoDate(end) || end < start)
          throw httpError(400, "Valid payroll range required");
        const rows = payrollRows(wf.timesheets, wf.settings, wf.rates).filter(
          (r) => r.day >= start && r.day <= end,
        );
        const columns = [
          "id",
          "userId",
          "day",
          "workedMinutes",
          "overtimeMinutes",
          "hourlyCents",
          "estimatedGrossCents",
          "currency",
          "overtimePolicyConfigured",
        ];
        res
          .type("text/csv")
          .attachment("pulseshift-payroll.csv")
          .send(
            [
              columns.join(","),
              ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(",")),
            ].join("\r\n"),
          );
      }),
    );
    app.post(
      base + "/files",
      auth,
      member,
      asyncHandler(async (req, res) => {
        const name = text(req.body.name, "file name", 150);
        const type = req.body.contentType;
        if (!["application/pdf", "image/png", "image/jpeg"].includes(type))
          throw httpError(400, "Upload a PDF, PNG or JPEG");
        if (
          typeof req.body.base64 !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(req.body.base64)
        )
          throw httpError(400, "Invalid file encoding");
        const content = Buffer.from(req.body.base64, "base64");
        if (!content.length || content.length > 3 * 1024 * 1024)
          throw httpError(400, "Document must be 1 byte to 3 MB");
        const valid =
          type === "application/pdf"
            ? content.subarray(0, 5).toString() === "%PDF-"
            : type === "image/png"
              ? content
                  .subarray(0, 8)
                  .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
              : content[0] === 255 && content[1] === 216 && content[2] === 255;
        if (!valid)
          throw httpError(
            400,
            "Document contents do not match its declared format",
          );
        const count = (
          await db.pool.query(
            "select count(*)::int n from workforce_files where org_id=$1",
            [req.orgId],
          )
        ).rows[0].n;
        if (count >= 2000) throw httpError(400, "Document capacity reached");
        const id = randomUUID();
        await db.pool.query(
          "insert into workforce_files(id,org_id,user_id,name,content_type,content,sha256) values($1,$2,$3,$4,$5,$6,$7)",
          [
            id,
            req.orgId,
            req.userId,
            name,
            type,
            content,
            hash(req.body.base64),
          ],
        );
        res.status(201).json({ id });
      }),
    );
    app.get(
      base + "/files/:fileId",
      auth,
      member,
      asyncHandler(async (req, res) => {
        const row = (
          await db.pool.query(
            "select * from workforce_files where org_id=$1 and id=$2",
            [req.orgId, req.params.fileId],
          )
        ).rows[0];
        if (!row) throw httpError(404, "Document not found");
        const wf = (await getWorkforce(db.pool, req.orgId)).data;
        if (
          row.user_id !== req.userId &&
          !canUser(access(wf, req.userId, req.membership.role), wf, row.user_id)
        )
          throw httpError(403, "Document access denied");
        res
          .set("Content-Security-Policy", "default-src 'none'; sandbox")
          .type(row.content_type)
          .attachment(row.name)
          .send(row.content);
      }),
    );
  }
  const issues = async (client, orgId, state) =>
    credentialIssues(state.shifts, (await getWorkforce(client, orgId)).data);
  const credentialReminders = async (client, orgId, userId) => {
    const wf = (await getWorkforce(client, orgId)).data;
    const org = (
      await client.query("select timezone from organizations where id=$1", [
        orgId,
      ])
    ).rows[0];
    const soon = localDay(Date.now() + 30 * 86400000, org.timezone);
    for (const c of wf.credentials.filter(
      (c) => c.userId === userId && c.expiresOn <= soon,
    ))
      await notify(
        client,
        orgId,
        userId,
        "CREDENTIAL",
        `${c.type} expires on ${c.expiresOn}. Review your credential record.`,
        c.id,
        `credential-expiry:${c.id}:${c.expiresOn}`,
      );
  };
  return {
    register,
    beforePublish,
    evaluate,
    builder,
    access,
    issues,
    credentialReminders,
  };
}
