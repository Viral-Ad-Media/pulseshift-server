import { createHash } from "node:crypto";

export const PLAN_LIMITS = {
  ESSENTIALS: { requestLimit: 40, aiCredits: 0 },
  TEAM: { requestLimit: 120, aiCredits: 80 },
  BUSINESS: { requestLimit: 500, aiCredits: 200 },
};
export const REQUEST_TYPES = new Set(["WORK", "PTO", "SICK"]);
export const httpError = (status, message) =>
  Object.assign(new Error(message), { status });
export function validateSecret(secret) {
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    /dev-secret|replace|example|changeme|password/i.test(secret) ||
    new Set(secret).size < 12
  ) {
    throw new Error(
      "JWT_SECRET must be a unique random secret of at least 32 characters. Generate one with: openssl rand -hex 32",
    );
  }
  return secret;
}
export function text(value, field, max = 400, optional = false) {
  if (
    optional &&
    (value === undefined ||
      value === null ||
      (typeof value === "string" && !value.trim()))
  )
    return null;
  if (typeof value !== "string" || !value.trim() || value.trim().length > max)
    throw httpError(400, `Invalid ${field}`);
  return value.trim();
}
export function email(value) {
  const result = text(value, "email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result))
    throw httpError(400, "Invalid email");
  return result;
}
export function password(value, strong = false) {
  if (
    typeof value !== "string" ||
    !value ||
    Buffer.byteLength(value, "utf8") > 72 ||
    (strong && value.length < 12)
  )
    throw httpError(400, "Password must be 12–72 bytes for new accounts");
  return value;
}
export function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value.slice(0, 4) !== "0000"
  );
}
export function timezone(value = "America/Chicago") {
  const zone = text(value, "timezone", 80);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format();
  } catch {
    throw httpError(400, "Invalid timezone");
  }
  return zone;
}
export function expectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw httpError(400, "The current request version is required");
  return value;
}
export const hashInvite = (token) =>
  createHash("sha256").update(token).digest("hex");
export function effectiveOrg(row, now = Date.now()) {
  const expires =
    row.trial_expires_at ||
    (row.trial_ends_on ? `${row.trial_ends_on}T23:59:59.999Z` : null);
  const days = expires
    ? Math.max(0, Math.ceil((new Date(expires).getTime() - now) / 86400000))
    : undefined;
  const expired = expires && new Date(expires).getTime() <= now;
  const plan = expired ? "ESSENTIALS" : row.plan;
  return {
    ...row,
    plan,
    request_limit: expired
      ? PLAN_LIMITS.ESSENTIALS.requestLimit
      : row.request_limit,
    ai_credits: expired ? 0 : row.ai_credits,
    trialStatus: expires ? (expired ? "EXPIRED" : "ACTIVE") : "NONE",
    trialDaysRemaining: days,
  };
}
export function rateLimit({
  windowMs = 60000,
  max = 20,
  maxKeys = 10000,
  keyFor = (req) => req.ip,
} = {}) {
  const entries = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = keyFor(req);
    if (entries.size >= maxKeys)
      for (const [k, v] of entries) if (v.until <= now) entries.delete(k);
    let entry = entries.get(key);
    if (!entry || entry.until <= now) {
      if (!entry && entries.size >= maxKeys)
        return res
          .status(429)
          .json({ error: "Too many requests. Try again later." });
      entry = { count: 0, until: now + windowMs };
      entries.set(key, entry);
    }
    if (++entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.until - now) / 1000)));
      return res
        .status(429)
        .json({ error: "Too many requests. Try again later." });
    }
    return next();
  };
}
