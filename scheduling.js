import { createHash, randomUUID } from "node:crypto";
import { httpError, isIsoDate, text, expectedVersion } from "./security.js";

const EMPTY = () => ({
  shifts: [],
  published: [],
  profiles: [],
  templates: [],
});
const MAX_SHIFTS = 1000;
const minute = 60000;
const stamp = (value) => new Date(value).getTime();
const integer = (value, label, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw httpError(
      400,
      `${label} must be a whole number between ${min} and ${max}`,
    );
  return value;
};
const localTime = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ||
    !isIsoDate(value.slice(0, 10)) ||
    Number(value.slice(11, 13)) > 23 ||
    Number(value.slice(14)) > 59
  )
    throw httpError(400, "Use a valid local date and time");
  return value;
};
export const intervalsOverlap = (a, b, c, d) => a < d && c < b;
export const shiftMinutes = (s) =>
  (stamp(s.endsAt) - stamp(s.startsAt)) / minute;
export function minimumCoverage(shift) {
  const duration = shiftMinutes(shift);
  const points = new Set([0, duration]);
  for (const a of shift.assignments)
    if (a.breakMinutes) {
      points.add(a.breakStartMinutes);
      points.add(a.breakStartMinutes + a.breakMinutes);
    }
  const times = [...points].sort((a, b) => a - b);
  let minimum = shift.assignments.length;
  for (let i = 0; i < times.length - 1; i++) {
    const mid = (times[i] + times[i + 1]) / 2;
    minimum = Math.min(
      minimum,
      shift.assignments.filter(
        (a) =>
          !a.breakMinutes ||
          mid < a.breakStartMinutes ||
          mid >= a.breakStartMinutes + a.breakMinutes,
      ).length,
    );
  }
  return minimum;
}
// Serializable writes span workspaces, so a shared staff member cannot be double-booked.
// Keep external I/O out of this short transaction.
export async function withScheduleLock(db, action) {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtext('pulseshift-scheduling'))",
    );
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
export async function resolveLocal(client, value, zone) {
  // Reject nonexistent AND ambiguous clock times rather than guessing at DST changes.
  const { rows } = await client.query(
    `
    select to_char($1::timestamp,'YYYY-MM-DD"T"HH24:MI') as local,
      $1::timestamp at time zone $2 as instant,
      to_char(($1::timestamp at time zone $2) at time zone $2,'YYYY-MM-DD"T"HH24:MI') as roundtrip,
      exists(select 1 from unnest(array[-120,-60,-30,30,60,120]) delta
        where (($1::timestamp at time zone $2)+delta*interval '1 minute') at time zone $2=$1::timestamp) as ambiguous`,
    [localTime(value), zone],
  );
  const r = rows[0];
  if (r.local !== r.roundtrip || r.ambiguous)
    throw httpError(
      400,
      "This local time is missing or ambiguous during a clock change. Choose an unambiguous time.",
    );
  return new Date(r.instant).toISOString();
}
export async function normalizeShift(client, input, zone, members, id) {
  if (!input || typeof input !== "object")
    throw httpError(400, "Shift details required");
  const startsAt = await resolveLocal(client, input.localStart, zone);
  const endsAt = await resolveLocal(client, input.localEnd, zone);
  const duration = (stamp(endsAt) - stamp(startsAt)) / minute;
  if (duration <= 0 || duration > 24 * 60)
    throw httpError(
      400,
      "A shift must end after it starts and last no more than 24 hours",
    );
  if (!Array.isArray(input.assignments) || input.assignments.length > 100)
    throw httpError(400, "Select up to 100 staff members");
  const seen = new Set();
  const assignments = input.assignments.map((a) => {
    if (
      !a ||
      !members.some((m) => m.user_id === a.userId) ||
      seen.has(a.userId)
    )
      throw httpError(
        400,
        "Assignments must contain distinct current team members",
      );
    seen.add(a.userId);
    const breakMinutes = integer(a.breakMinutes ?? 0, "Break minutes", 0, 240);
    const breakStartMinutes = integer(
      a.breakStartMinutes ?? 0,
      "Break starts after",
      0,
      1440,
    );
    if (
      breakMinutes &&
      (breakMinutes >= duration || breakStartMinutes + breakMinutes > duration)
    )
      throw httpError(
        400,
        "Each break must fit inside the shift and be shorter than the shift",
      );
    return {
      userId: a.userId,
      breakMinutes,
      breakStartMinutes: breakMinutes ? breakStartMinutes : 0,
    };
  });
  return {
    id,
    title: text(input.title, "shift title", 100),
    department: text(input.department, "department", 80),
    location: text(input.location, "location", 80),
    role: text(input.role, "required role", 80),
    requiredCount: integer(input.requiredCount, "Required staff", 1, 100),
    localStart: input.localStart,
    localEnd: input.localEnd,
    startsAt,
    endsAt,
    assignments,
    requiresAcknowledgement: input.requiresAcknowledgement !== false,
  };
}
export const shiftFingerprint = (s) =>
  JSON.stringify([
    s.title,
    s.department,
    s.location,
    s.role,
    s.requiredCount,
    s.localStart,
    s.localEnd,
    s.requiresAcknowledgement,
    [...s.assignments]
      .sort((a, b) => a.userId.localeCompare(b.userId))
      .map((a) => [a.userId, a.breakStartMinutes, a.breakMinutes]),
  ]);
const sameShift = (a, b) => shiftFingerprint(a) === shiftFingerprint(b);
const formatters = new Map();
function dateKey(date, zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatters.set(zone, formatter);
  }
  return formatter.format(date);
}
function monday(dateKeyValue) {
  const day = new Date(dateKeyValue + "T12:00:00Z");
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
}
export function findConflicts({
  shifts,
  publishedElsewhere = [],
  profiles,
  members,
  leave = [],
  zone,
  now = Date.now(),
  onlyUserIds = null,
}) {
  const issues = [];
  const name = (id) =>
    members.find((m) => m.user_id === id)?.name || "Staff member";
  const all = [...shifts, ...publishedElsewhere];
  const add = (shift, code, message) =>
    issues.push({ shiftId: shift.id, code, message });
  const weeklyMinutes = new Map();
  const limitedUsers = new Set(
    profiles.filter((p) => p.maxWeeklyHours).map((p) => p.userId),
  );
  // Split actual worked intervals at a local week boundary. A binary search handles
  // DST without iterating through every minute of every historical shift.
  const addWork = (userId, start, end) => {
    if (end <= start) return;
    const firstWeek = monday(dateKey(new Date(start), zone));
    const lastWeek = monday(dateKey(new Date(end - 1), zone));
    const add = (week, minutes) => {
      const key = userId + ":" + week;
      weeklyMinutes.set(key, (weeklyMinutes.get(key) || 0) + minutes);
    };
    if (firstWeek === lastWeek) {
      add(firstWeek, (end - start) / minute);
      return;
    }
    let low = 0,
      high = (end - start) / minute;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (monday(dateKey(new Date(start + mid * minute), zone)) === firstWeek)
        low = mid + 1;
      else high = mid;
    }
    add(firstWeek, low);
    add(lastWeek, (end - start) / minute - low);
  };
  for (const s of all) {
    const start = stamp(s.startsAt),
      end = stamp(s.endsAt);
    for (const a of s.assignments)
      if (limitedUsers.has(a.userId)) {
        if (!a.breakMinutes) addWork(a.userId, start, end);
        else {
          const breakStart = start + a.breakStartMinutes * minute;
          addWork(a.userId, start, breakStart);
          addWork(a.userId, breakStart + a.breakMinutes * minute, end);
        }
      }
  }
  for (const s of shifts) {
    const start = stamp(s.startsAt),
      end = stamp(s.endsAt);
    // Historical shifts retain the role/coverage facts that applied when published.
    if (end <= now) continue;
    const coverage = minimumCoverage(s);
    if (coverage < s.requiredCount)
      add(
        s,
        "COVERAGE",
        `${s.title}: minimum coverage ${coverage}/${s.requiredCount}${s.assignments.some((a) => a.breakMinutes) ? " including breaks" : ""}.`,
      );
    for (const a of s.assignments) {
      if (onlyUserIds && !onlyUserIds.has(a.userId)) continue;
      const profile = profiles.find((p) => p.userId === a.userId);
      if (!members.some((m) => m.user_id === a.userId))
        add(s, "MEMBER", `${name(a.userId)} is no longer in this team.`);
      if (!profile?.roles.some((r) => r.toLowerCase() === s.role.toLowerCase()))
        add(
          s,
          "ELIGIBILITY",
          `${name(a.userId)} is not marked eligible for ${s.role}.`,
        );
      if (
        leave.some(
          (r) =>
            r.user_id === a.userId &&
            intervalsOverlap(start, end, stamp(r.starts_at), stamp(r.ends_at)),
        )
      )
        add(
          s,
          "LEAVE",
          `${name(a.userId)} has approved leave during this assignment.`,
        );
      for (const other of all) {
        if (
          s.id === other.id ||
          !other.assignments.some((x) => x.userId === a.userId)
        )
          continue;
        const os = stamp(other.startsAt),
          oe = stamp(other.endsAt);
        if (intervalsOverlap(start, end, os, oe))
          add(
            s,
            "OVERLAP",
            `${name(a.userId)} has an overlapping assignment${other.external ? " in another workspace" : ""}.`,
          );
        else if (
          profile?.minRestHours &&
          Math.min(Math.abs(start - oe), Math.abs(os - end)) / 3600000 <
            profile.minRestHours
        )
          add(
            s,
            "REST",
            `${name(a.userId)} needs ${profile.minRestHours} hours between assignments.`,
          );
      }
      if (profile?.maxWeeklyHours) {
        const weeks = new Set([
          monday(dateKey(new Date(start), zone)),
          monday(dateKey(new Date(end - 1), zone)),
        ]);
        for (const week of weeks)
          if (
            (weeklyMinutes.get(a.userId + ":" + week) || 0) >
            profile.maxWeeklyHours * 60
          )
            add(
              s,
              "HOURS",
              `${name(a.userId)} exceeds the ${profile.maxWeeklyHours}-hour weekly limit in the week of ${week}.`,
            );
      }
    }
  }
  return issues.filter(
    (issue, i, items) =>
      items.findIndex(
        (x) =>
          x.shiftId === issue.shiftId &&
          x.code === issue.code &&
          x.message === issue.message,
      ) === i,
  );
}
export async function context(client, orgId, state) {
  const members = (
    await client.query(
      "select m.user_id,u.name from memberships m join users u on u.id=m.user_id where m.org_id=$1",
      [orgId],
    )
  ).rows;
  const ids = [
    ...new Set(state.shifts.flatMap((s) => s.assignments.map((a) => a.userId))),
  ];
  const documents = (
    await client.query(
      "select d.org_id,d.data,o.timezone from schedule_documents d join organizations o on o.id=d.org_id where d.org_id<>$1",
      [orgId],
    )
  ).rows;
  const elsewhere = documents.flatMap((r) =>
    r.data.published
      .filter((s) => s.assignments.some((a) => ids.includes(a.userId)))
      .map((s) => ({ ...s, external: true })),
  );
  const leave = (
    await client.query(
      `select r.user_id, r.date::timestamp at time zone o.timezone as starts_at,
    (r.date::date+1)::timestamp at time zone o.timezone as ends_at
    from requests r join organizations o on o.id=r.org_id
    where r.status='APPROVED' and r.type in ('PTO','SICK') and r.canceled_at is null and r.user_id=any($1::text[])`,
      [ids],
    )
  ).rows;
  return { members, publishedElsewhere: elsewhere, leave, documents };
}
export function schedulingIssues(state, zone, c) {
  const issues = findConflicts({
    ...c,
    shifts: state.shifts,
    profiles: state.profiles,
    zone,
  });
  const affected = new Set(
    state.shifts.flatMap((s) => s.assignments.map((a) => a.userId)),
  );
  for (const document of c.documents || []) {
    const shared = new Set(
      document.data.published.flatMap((s) =>
        s.assignments
          .filter((a) => affected.has(a.userId))
          .map((a) => a.userId),
      ),
    );
    if (!shared.size) continue;
    const candidates = document.data.published.filter((s) =>
      s.assignments.some((a) => shared.has(a.userId)),
    );
    const others = [
      ...state.shifts,
      ...c.documents
        .filter((d) => d.org_id !== document.org_id)
        .flatMap((d) => d.data.published),
    ]
      .filter((s) => s.assignments.some((a) => shared.has(a.userId)))
      .map((s) => ({ ...s, external: true }));
    const conflicts = findConflicts({
      shifts: candidates,
      publishedElsewhere: others,
      profiles: document.data.profiles,
      members: [...shared].map((id) => ({
        user_id: id,
        name: "Shared staff member",
      })),
      onlyUserIds: shared,
      zone: document.timezone,
    });
    if (conflicts.some((i) => ["REST", "HOURS"].includes(i.code)))
      issues.push({
        shiftId: state.shifts.find((s) =>
          s.assignments.some((a) => shared.has(a.userId)),
        ).id,
        code: "OTHER_WORKSPACE",
        message:
          "Shared staff assignments conflict with rest or weekly-hour limits in another workspace.",
      });
  }
  return issues;
}
async function notify(client, orgId, userId, kind, message, entityId, key) {
  await client.query(
    `insert into notifications(org_id,user_id,kind,message,entity_id,dedupe_key)
    values($1,$2,$3,$4,$5,$6) on conflict do nothing`,
    [orgId, userId, kind, message, entityId, key],
  );
}
export function registerSchedulingRoutes(
  app,
  { db, auth, member, admin, asyncHandler, extensions },
) {
  const base = "/orgs/:orgId";
  const stateFor = async (client, orgId) => {
    const result = await client.query(
      "select revision,data from schedule_documents where org_id=$1",
      [orgId],
    );
    return result.rows[0] || { revision: 0, data: EMPTY() };
  };
  app.get(
    base + "/schedule",
    auth,
    member,
    asyncHandler(async (req, res) => {
      const stored = await stateFor(db.pool, req.orgId);
      const org = (
        await db.pool.query("select timezone from organizations where id=$1", [
          req.orgId,
        ])
      ).rows[0];
      const isAdmin = req.membership.role === "ADMIN";
      const state = stored.data;
      const c = isAdmin ? await context(db.pool, req.orgId, state) : null;
      const acknowledgements = (
        await db.pool.query(
          `select shift_id as "shiftId",publication_version as "publicationVersion",user_id as "userId",acknowledged_at as "acknowledgedAt"
      from shift_acknowledgements where org_id=$1${isAdmin ? "" : " and user_id=$2"}`,
          isAdmin ? [req.orgId] : [req.orgId, req.userId],
        )
      ).rows;
      const extraIssues =
        isAdmin && extensions?.issues
          ? await extensions.issues(db.pool, req.orgId, state)
          : [];
      res.json({
        revision: stored.revision,
        timezone: org.timezone,
        shifts: isAdmin ? state.shifts : [],
        published: state.published,
        profiles: isAdmin
          ? state.profiles
          : state.profiles.filter((p) => p.userId === req.userId),
        templates: isAdmin ? state.templates : [],
        acknowledgements,
        issues: isAdmin
          ? [...schedulingIssues(state, org.timezone, c), ...extraIssues]
          : [],
      });
    }),
  );
  app.post(
    base + "/schedule",
    auth,
    member,
    admin,
    asyncHandler(async (req, res) => {
      const body = req.body;
      const operationId = text(body.operationId, "operation ID", 100);
      if (!/^[\w-]{10,100}$/.test(operationId))
        throw httpError(400, "Invalid operation ID");
      const revision = integer(
        body.revision,
        "Schedule revision",
        0,
        2147483646,
      );
      const hash = createHash("sha256")
        .update(JSON.stringify(body))
        .digest("hex");
      const result = await withScheduleLock(db, async (client) => {
        await client.query("select set_config('pulseshift.actor',$1,true)", [
          req.userId,
        ]);
        const org = (
          await client.query(
            "select * from organizations where id=$1 for update",
            [req.orgId],
          )
        ).rows[0];
        const membership = (
          await client.query(
            "select role from memberships where org_id=$1 and user_id=$2",
            [req.orgId, req.userId],
          )
        ).rows[0];
        if (membership?.role !== "ADMIN")
          throw httpError(403, "Admin access required");
        const previous = (
          await client.query(
            "select * from schedule_operations where org_id=$1 and actor_id=$2 and operation_id=$3",
            [req.orgId, req.userId, operationId],
          )
        ).rows[0];
        if (previous) {
          if (previous.payload_hash !== hash)
            throw httpError(
              409,
              "Operation ID already used for different changes",
            );
          return { revision: previous.revision, replayed: true };
        }
        const stored = await stateFor(client, req.orgId);
        if (stored.revision !== revision)
          throw httpError(
            409,
            "The schedule changed. Refresh before saving; your form has been kept.",
          );
        const state = structuredClone(stored.data);
        const members = (
          await client.query(
            "select user_id from memberships where org_id=$1",
            [req.orgId],
          )
        ).rows;
        const shiftId = body.shiftId;
        if (body.action === "SAVE_SHIFT") {
          if (shiftId && !state.shifts.some((s) => s.id === shiftId))
            throw httpError(404, "Draft shift not found");
          const shift = await normalizeShift(
            client,
            body.shift,
            org.timezone,
            members,
            shiftId || `shift-${randomUUID()}`,
          );
          const prior = state.published.find((s) => s.id === shift.id);
          if (
            stamp(shift.endsAt) <= Date.now() &&
            (!prior || !sameShift(prior, shift))
          )
            throw httpError(
              400,
              "New or changed assignments must end in the future. Historical published shifts are read-only.",
            );
          state.shifts = state.shifts
            .filter((s) => s.id !== shift.id)
            .concat(shift);
        } else if (body.action === "DELETE_SHIFT") {
          if (!state.shifts.some((s) => s.id === shiftId))
            throw httpError(404, "Draft shift not found");
          state.shifts = state.shifts.filter((s) => s.id !== shiftId);
        } else if (body.action === "DISCARD") {
          state.shifts = state.published.map(
            ({ publicationVersion, ...s }) => s,
          );
        } else if (body.action === "SAVE_PROFILE") {
          const p = body.profile;
          if (
            !p ||
            !members.some((m) => m.user_id === p.userId) ||
            !Array.isArray(p.roles) ||
            p.roles.length > 20
          )
            throw httpError(
              400,
              "Choose a current member and up to 20 eligible roles",
            );
          const profile = {
            userId: p.userId,
            roles: [
              ...new Set(p.roles.map((r) => text(r, "eligible role", 80))),
            ],
            minRestHours: integer(
              p.minRestHours ?? 0,
              "Minimum rest hours",
              0,
              72,
            ),
            maxWeeklyHours: integer(
              p.maxWeeklyHours ?? 0,
              "Weekly hour limit",
              0,
              168,
            ),
          };
          state.profiles = state.profiles
            .filter((x) => x.userId !== p.userId)
            .concat(profile);
          const c = await context(client, req.orgId, {
            ...state,
            shifts: state.published,
          });
          const conflicts = findConflicts({
            ...c,
            shifts: state.published,
            profiles: state.profiles,
            zone: org.timezone,
          }).filter((i) => i.code !== "COVERAGE");
          if (conflicts.length)
            throw httpError(
              409,
              "These settings conflict with published assignments. Update and publish those assignments first.",
            );
        } else if (body.action === "SAVE_TEMPLATE") {
          const start = body.startDate;
          if (!isIsoDate(start))
            throw httpError(400, "Valid template start date required");
          const end = new Date(start + "T12:00:00Z");
          end.setUTCDate(end.getUTCDate() + 7);
          const entries = state.shifts
            .filter(
              (s) =>
                s.localStart.slice(0, 10) >= start &&
                s.localStart.slice(0, 10) < end.toISOString().slice(0, 10),
            )
            .map((s) => ({
              dayOffset: Math.round(
                (Date.parse(s.localStart.slice(0, 10) + "T12:00:00Z") -
                  Date.parse(start + "T12:00:00Z")) /
                  86400000,
              ),
              endDayOffset: Math.round(
                (Date.parse(s.localEnd.slice(0, 10) + "T12:00:00Z") -
                  Date.parse(s.localStart.slice(0, 10) + "T12:00:00Z")) /
                  86400000,
              ),
              title: s.title,
              department: s.department,
              location: s.location,
              role: s.role,
              requiredCount: s.requiredCount,
              startTime: s.localStart.slice(11),
              endTime: s.localEnd.slice(11),
              requiresAcknowledgement: s.requiresAcknowledgement,
              assignments:
                body.includeAssignments === true ? s.assignments : [],
            }));
          if (!entries.length)
            throw httpError(400, "No draft shifts in the selected seven days");
          if (state.templates.length >= 50)
            throw httpError(
              400,
              "Remove a template before adding another (limit 50)",
            );
          state.templates.push({
            id: randomUUID(),
            name: text(body.name, "template name", 80),
            entries,
          });
        } else if (body.action === "DELETE_TEMPLATE") {
          state.templates = state.templates.filter(
            (t) => t.id !== body.templateId,
          );
        } else if (body.action === "APPLY_TEMPLATE") {
          const template = state.templates.find(
            (t) => t.id === body.templateId,
          );
          if (!template) throw httpError(404, "Template not found");
          if (!isIsoDate(body.startDate))
            throw httpError(400, "Valid template start date required");
          const weeks = integer(body.weeks ?? 1, "Repeat weeks", 1, 12);
          if (
            state.shifts.length + weeks * template.entries.length >
            MAX_SHIFTS
          )
            throw httpError(400, `Schedule limit is ${MAX_SHIFTS} shifts`);
          for (let week = 0; week < weeks; week++)
            for (const entry of template.entries) {
              const start = new Date(body.startDate + "T12:00:00Z");
              start.setUTCDate(start.getUTCDate() + entry.dayOffset + week * 7);
              const end = new Date(start);
              end.setUTCDate(end.getUTCDate() + entry.endDayOffset);
              const generated = await normalizeShift(
                client,
                {
                  ...entry,
                  localStart:
                    start.toISOString().slice(0, 10) + "T" + entry.startTime,
                  localEnd:
                    end.toISOString().slice(0, 10) + "T" + entry.endTime,
                },
                org.timezone,
                members,
                `shift-${randomUUID()}`,
              );
              if (stamp(generated.endsAt) <= Date.now())
                throw httpError(400, "Repeated shifts must end in the future");
              state.shifts.push(generated);
            }
        } else if (body.action === "PUBLISH") {
          await extensions?.beforePublish(client, req.orgId, state);
          const c = await context(client, req.orgId, state);
          const issues = schedulingIssues(state, org.timezone, c);
          if (issues.some((i) => i.code !== "COVERAGE"))
            throw httpError(
              409,
              issues
                .filter((i) => i.code !== "COVERAGE")
                .slice(0, 4)
                .map((i) => i.message)
                .join(" "),
            );
          if (issues.length && body.allowGaps !== true)
            throw httpError(
              409,
              "Coverage gaps remain. Fill them or explicitly publish with gaps.",
            );
          for (const shift of state.shifts) {
            const old = state.published.find((s) => s.id === shift.id);
            const changed = !old || !sameShift(old, shift);
            shift.publicationVersion = changed
              ? stored.revision + 1
              : old.publicationVersion;
            if (changed)
              for (const userId of new Set([
                ...shift.assignments.map((a) => a.userId),
                ...(old?.assignments.map((a) => a.userId) || []),
              ])) {
                const assigned = shift.assignments.some(
                  (a) => a.userId === userId,
                );
                await notify(
                  client,
                  req.orgId,
                  userId,
                  "SCHEDULE",
                  assigned
                    ? `${old ? "Updated" : "New"} assignment: ${shift.title}, ${shift.localStart.replace("T", " ")} (${org.timezone}).${shift.requiresAcknowledgement ? " Review and accept or decline on your dashboard." : ""}`
                    : `You were removed from ${shift.title}, ${old.localStart.replace("T", " ")} (${org.timezone}).`,
                  shift.id,
                  `publish:${shift.id}:${shift.publicationVersion}`,
                );
              }
          }
          for (const removed of state.published.filter(
            (s) => !state.shifts.some((d) => d.id === s.id),
          ))
            for (const a of removed.assignments)
              await notify(
                client,
                req.orgId,
                a.userId,
                "SCHEDULE",
                `Assignment cancelled: ${removed.title}, ${removed.localStart.replace("T", " ")} (${org.timezone}).`,
                removed.id,
                `cancel:${removed.id}:${stored.revision + 1}`,
              );
          state.published = structuredClone(state.shifts);
          state.shifts = state.shifts.map(({ publicationVersion, ...s }) => s);
        } else throw httpError(400, "Unknown schedule action");
        if (state.shifts.length > MAX_SHIFTS)
          throw httpError(
            400,
            `Schedule limit is ${MAX_SHIFTS} shifts. Remove older draft shifts before adding more.`,
          );
        await client.query(
          `insert into schedule_documents(org_id,revision,data) values($1,$2,$3::jsonb)
        on conflict(org_id) do update set revision=excluded.revision,data=excluded.data,updated_at=now()`,
          [req.orgId, revision + 1, JSON.stringify(state)],
        );
        await client.query(
          "insert into schedule_operations(org_id,actor_id,operation_id,payload_hash,revision) values($1,$2,$3,$4,$5)",
          [req.orgId, req.userId, operationId, hash, revision + 1],
        );
        return { revision: revision + 1 };
      });
      res.json(result);
    }),
  );
  app.post(
    base + "/schedule/:shiftId/acknowledge",
    auth,
    member,
    asyncHandler(async (req, res) => {
      await withScheduleLock(db, async (client) => {
        await client.query(
          "select id from organizations where id=$1 for update",
          [req.orgId],
        );
        const member = (
          await client.query(
            "select 1 from memberships where org_id=$1 and user_id=$2",
            [req.orgId, req.userId],
          )
        ).rows[0];
        if (!member) throw httpError(403, "Workspace access denied");
        const state = (await stateFor(client, req.orgId)).data;
        const shift = state.published.find(
          (s) =>
            s.id === req.params.shiftId &&
            s.assignments.some((a) => a.userId === req.userId),
        );
        if (!shift) throw httpError(404, "Published assignment not found");
        if (
          expectedVersion(req.body.publicationVersion) !==
          shift.publicationVersion
        )
          throw httpError(
            409,
            "The assignment changed. Refresh before acknowledging.",
          );
        await client.query(
          `insert into shift_acknowledgements(org_id,shift_id,publication_version,user_id)
        values($1,$2,$3,$4) on conflict do nothing`,
          [req.orgId, shift.id, shift.publicationVersion, req.userId],
        );
      });
      res.json({ ok: true });
    }),
  );
  app.get(
    base + "/notifications",
    auth,
    member,
    asyncHandler(async (req, res) => {
      const state = (await stateFor(db.pool, req.orgId)).data;
      await extensions?.credentialReminders(db.pool, req.orgId, req.userId);
      // Reminders are persisted lazily on inbox refresh; this is in-app delivery, not a background email job.
      for (const s of state.published)
        if (
          s.assignments.some((a) => a.userId === req.userId) &&
          stamp(s.startsAt) > Date.now() &&
          stamp(s.startsAt) <= Date.now() + 86400000
        )
          await notify(
            db.pool,
            req.orgId,
            req.userId,
            "REMINDER",
            `Upcoming assignment: ${s.title}, ${s.localStart.replace("T", " ")}.`,
            s.id,
            `reminder:${s.id}:${s.publicationVersion}`,
          );
      const result = await db.pool.query(
        `select id::text,kind,message,entity_id as "entityId",created_at as "createdAt",read_at as "readAt"
      from notifications where org_id=$1 and user_id=$2 order by created_at desc,id desc limit 100`,
        [req.orgId, req.userId],
      );
      const unread = (
        await db.pool.query(
          "select count(*)::int as count from notifications where org_id=$1 and user_id=$2 and read_at is null",
          [req.orgId, req.userId],
        )
      ).rows[0].count;
      res.json({ notifications: result.rows, unread });
    }),
  );
  app.put(
    base + "/notifications/read",
    auth,
    member,
    asyncHandler(async (req, res) => {
      if (req.body.id !== undefined && !/^\d+$/.test(String(req.body.id)))
        throw httpError(400, "Invalid notification");
      await db.pool.query(
        `update notifications set read_at=coalesce(read_at,now()) where org_id=$1 and user_id=$2${req.body.id !== undefined ? " and id=$3" : ""}`,
        req.body.id !== undefined
          ? [req.orgId, req.userId, req.body.id]
          : [req.orgId, req.userId],
      );
      res.json({ ok: true });
    }),
  );
  app.get(
    base + "/request-history",
    auth,
    member,
    asyncHandler(async (req, res) => {
      const isAdmin = req.membership.role === "ADMIN";
      const result = await db.pool.query(
        `select r.id,r.user_id as "userId",r.user_name as "userName",r.date,r.type,
      case when r.canceled_at is not null then 'CANCELLED' else r.status end as status,
      r.version,r.notes,r.admin_response as "adminResponse",r.created_at as "createdAt",r.canceled_at as "cancelledAt"
      from requests r where r.org_id=$1${isAdmin ? "" : " and r.user_id=$2"} order by r.created_at desc limit 200`,
        isAdmin ? [req.orgId] : [req.orgId, req.userId],
      );
      const events = (
        await db.pool.query(
          `select e.id::text,e.request_id as "requestId",u.name as "actorName",e.action,
      e.old_status as "oldStatus",e.new_status as "newStatus",e.created_at as "createdAt"
      from request_events e join users u on u.id=e.actor_id join requests r on r.id=e.request_id
      where e.org_id=$1 and e.request_id=any($2::text[])${isAdmin ? "" : " and r.user_id=$3"} order by e.created_at,e.id`,
          isAdmin
            ? [req.orgId, result.rows.map((r) => r.id)]
            : [req.orgId, result.rows.map((r) => r.id), req.userId],
        )
      ).rows;
      res.json({ requests: result.rows, events });
    }),
  );
}
