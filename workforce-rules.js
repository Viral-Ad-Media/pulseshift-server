import { createHash } from "node:crypto";
import { httpError } from "./security.js";
export const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const blankWorkforce = () => ({
  preferences: [],
  credentials: [],
  vacancies: [],
  swaps: [],
  timesheets: [],
  rates: [],
  access: [],
  staffUnits: [],
  exceptions: [],
  sites: [],
  imports: [],
  settings: {
    currency: "USD",
    overtimeThresholdHours: null,
    overtimeMultiplier: null,
    credentialRules: [],
  },
});
export const minutes = (start, end) =>
  (Date.parse(end) - Date.parse(start)) / 60000;
const dateFormats = new Map(),
  hourFormats = new Map();
export function localDay(time, zone) {
  if (!dateFormats.has(zone))
    dateFormats.set(
      zone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }),
    );
  return dateFormats.get(zone).format(new Date(time));
}
export function localHour(time, zone) {
  if (!hourFormats.has(zone))
    hourFormats.set(
      zone,
      new Intl.DateTimeFormat("en-GB", {
        timeZone: zone,
        hour: "2-digit",
        hourCycle: "h23",
      }),
    );
  return Number(hourFormats.get(zone).format(new Date(time)));
}
export const weekKey = (time, zone) => {
  const d = new Date(localDay(time, zone) + "T12:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
export function actualMinutes(entry) {
  if (!entry.clockOut) return null;
  return Math.max(
    0,
    minutes(entry.clockIn, entry.clockOut) -
      (entry.breaks || []).reduce(
        (sum, b) => sum + (b.end ? minutes(b.start, b.end) : 0),
        0,
      ),
  );
}
export function coveredShiftDays(shift) {
  const start = shift.localStart.slice(0, 10);
  let last = shift.localEnd.slice(0, 10);
  if (shift.localEnd.slice(11) === "00:00")
    last = new Date(Date.parse(last + "T12:00Z") - 86400000)
      .toISOString()
      .slice(0, 10);
  const result = [];
  for (
    let day = start;
    day <= last;
    day = new Date(Date.parse(day + "T12:00Z") + 86400000)
      .toISOString()
      .slice(0, 10)
  )
    result.push(day);
  return result;
}
export function credentialIssues(shifts, wf, now = Date.now()) {
  const issues = [];
  for (const shift of shifts) {
    if (Date.parse(shift.endsAt) <= now) continue;
    const types = wf.settings.credentialRules
      .filter((r) => r.role.toLowerCase() === shift.role.toLowerCase())
      .flatMap((r) => r.types);
    for (const a of shift.assignments)
      for (const type of types) {
        const valid = wf.credentials.some(
          (c) =>
            c.userId === a.userId &&
            c.type.toLowerCase() === type.toLowerCase() &&
            ["REVIEWED", "VERIFIED"].includes(c.status) &&
            c.expiresOn &&
            c.expiresOn >= coveredShiftDays(shift).at(-1),
        );
        if (!valid)
          issues.push({
            shiftId: shift.id,
            code: "CREDENTIAL",
            message: `${shift.title}: an assigned staff member needs a reviewed, unexpired ${type} credential covering the shift.`,
          });
      }
  }
  return issues;
}
export function parseCSV(source) {
  if (typeof source !== "string" || source.length > 200000)
    throw httpError(400, "CSV must be text under 200 KB");
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  const input = source.replace(/^\uFEFF/, "");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      if (cell) throw httpError(400, "Malformed CSV quote");
      quoted = true;
    } else if (ch === ",") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (quoted) throw httpError(400, "Unclosed CSV quote");
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2 || rows.length > 201)
    throw httpError(400, "Provide a header and 1–200 data rows");
  const header = rows.shift();
  if (new Set(header).size !== header.length)
    throw httpError(400, "CSV headers must be unique");
  return rows.map((values, index) => ({
    row: index + 2,
    values: Object.fromEntries(header.map((key, i) => [key, values[i] || ""])),
    error:
      values.length !== header.length
        ? "Column count does not match the header"
        : null,
  }));
}
export const csvCell = (value) => {
  const s = String(value ?? "");
  return (
    '"' +
    (/^[\s]*[=+\-@\t\r]/.test(s) ? "'" + s : s).replaceAll('"', '""') +
    '"'
  );
};
export function clippedWorkMinutes(start, end, breaks, from, to) {
  const left = Math.max(Date.parse(start), from),
    right = Math.min(Date.parse(end), to);
  if (right <= left) return 0;
  return (
    Math.max(
      0,
      right -
        left -
        (breaks || []).reduce(
          (sum, b) =>
            sum +
            (b.end
              ? Math.max(
                  0,
                  Math.min(right, Date.parse(b.end)) -
                    Math.max(left, Date.parse(b.start)),
                )
              : 0),
          0,
        ),
    ) / 60000
  );
}
export function payrollRows(entries, settings, rates) {
  const weekly = new Map(),
    output = [];
  for (const e of entries
    .filter((e) => e.status === "APPROVED" && e.clockOut)
    .sort((a, b) => a.clockIn.localeCompare(b.clockIn))) {
    const snapshot = e.paySnapshot,
      rate = snapshot
        ? snapshot.hourlyCents
        : (rates.find((r) => r.userId === e.userId)?.hourlyCents ?? null);
    const policy = snapshot?.policy || settings,
      zone = e.timezone || "UTC";
    const configured =
      policy.overtimeThresholdHours !== null &&
      policy.overtimeMultiplier !== null;
    const threshold = configured ? policy.overtimeThresholdHours * 60 : null;
    const days = new Map();
    const end = Date.parse(e.clockOut);
    for (let time = Date.parse(e.clockIn); time < end;) {
      const right = Math.min(Math.floor(time / 60000) * 60000 + 60000, end);
      let worked = (right - time) / 60000;
      for (const b of e.breaks || [])
        if (b.end)
          worked -=
            Math.max(
              0,
              Math.min(right, Date.parse(b.end)) -
                Math.max(time, Date.parse(b.start)),
            ) / 60000;
      if (worked > 0) {
        const week = e.userId + ":" + weekKey(time, zone),
          used = weekly.get(week) || 0;
        const overtime =
          threshold === null
            ? null
            : Math.max(0, used + worked - threshold) -
              Math.max(0, used - threshold);
        weekly.set(week, used + worked);
        const day = localDay(time, zone),
          row = days.get(day) || {
            id: e.id + ":" + day,
            entryId: e.id,
            userId: e.userId,
            shiftId: e.shiftId,
            day,
            workedMinutes: 0,
            overtimeMinutes: configured ? 0 : null,
            hourlyCents: rate,
            currency: policy.currency || settings.currency,
            estimateOnly: true,
            overtimePolicyConfigured: configured,
          };
        row.workedMinutes += worked;
        if (configured) row.overtimeMinutes += overtime;
        days.set(day, row);
      }
      time = right;
    }
    for (const row of days.values()) {
      row.knownBaseCents =
        rate === null ? null : Math.round((rate * row.workedMinutes) / 60);
      row.estimatedGrossCents =
        rate === null || !configured
          ? null
          : Math.round(
              (rate *
                (row.workedMinutes +
                  row.overtimeMinutes * (policy.overtimeMultiplier - 1))) /
                60,
            );
      output.push(row);
    }
  }
  return output;
}
export function fairness(
  shifts,
  members,
  settings,
  zone,
  { from = -Infinity, to = Infinity, departments = null } = {},
) {
  return members.map((member) => {
    let plannedMinutes = 0,
      nightMinutes = 0,
      weekendMinutes = 0,
      unpopularShifts = 0,
      plannedOvertimeMinutes =
        settings.overtimeThresholdHours === null ? null : 0;
    const weeks = new Map();
    for (const s of [...shifts].sort((a, b) =>
      a.startsAt.localeCompare(b.startsAt),
    )) {
      const a = s.assignments.find((a) => a.userId === member.user_id);
      if (!a) continue;
      const start = Date.parse(s.startsAt),
        end = Date.parse(s.endsAt);
      let unpopular = false;
      for (let t = start; t < end; t += 60000) {
        const offset = (t - start) / 60000;
        if (
          a.breakMinutes &&
          offset >= a.breakStartMinutes &&
          offset < a.breakStartMinutes + a.breakMinutes
        )
          continue;
        const step = Math.min(60000, end - t) / 60000,
          w = weekKey(t, zone),
          used = weeks.get(w) || 0;
        weeks.set(w, used + step);
        if (
          t < from ||
          t >= to ||
          (departments && !departments.includes(s.department))
        )
          continue;
        plannedMinutes += step;
        const hour = localHour(t, zone),
          day = new Date(localDay(t, zone) + "T12:00Z").getUTCDay();
        if (hour >= 22 || hour < 6) {
          nightMinutes += step;
          unpopular = true;
        }
        if (day === 0 || day === 6) {
          weekendMinutes += step;
          unpopular = true;
        }
        if (plannedOvertimeMinutes !== null) {
          const limit = settings.overtimeThresholdHours * 60;
          plannedOvertimeMinutes +=
            Math.max(0, used + step - limit) - Math.max(0, used - limit);
        }
      }
      if (unpopular) unpopularShifts++;
    }
    return {
      userId: member.user_id,
      name: member.name,
      plannedMinutes,
      nightMinutes,
      weekendMinutes,
      unpopularShifts,
      plannedOvertimeMinutes,
    };
  });
}
