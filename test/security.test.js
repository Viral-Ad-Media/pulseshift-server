import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateSecret,
  isIsoDate,
  email,
  password,
  timezone,
  effectiveOrg,
} from "../security.js";
test("signing secrets reject defaults, placeholders and repetition", () => {
  for (const value of [
    undefined,
    "dev-secret",
    "replace-this-for-local-development",
    "a".repeat(64),
  ])
    assert.throws(() => validateSecret(value));
  assert.equal(
    validateSecret("f93ce57ab62980147d60285fac17d473"),
    "f93ce57ab62980147d60285fac17d473",
  );
});
test("date, timezone, email and password validation rejects wrong types and invalid fields", () => {
  for (const date of [
    "2026-02-30",
    "2025-02-29",
    "0000-01-01",
    "2026-13-01",
    {},
    null,
  ])
    assert.equal(isIsoDate(date), false);
  assert.equal(isIsoDate("2024-02-29"), true);
  assert.throws(() => timezone("bad-zone"));
  assert.throws(() => email("x"));
  assert.throws(() => password("short", true));
  assert.throws(() => password("é".repeat(37), true));
  assert.equal(email(" USER@EXAMPLE.COM "), "user@example.com");
});
test("expired trial projection matches server entitlement policy", () => {
  const org = effectiveOrg(
    {
      plan: "TEAM",
      request_limit: 120,
      ai_credits: 80,
      trial_expires_at: "2026-01-01T00:00:00Z",
    },
    Date.parse("2026-01-01T00:00:00Z"),
  );
  assert.equal(org.plan, "ESSENTIALS");
  assert.equal(org.request_limit, 40);
  assert.equal(org.ai_credits, 0);
  assert.equal(org.trialStatus, "EXPIRED");
});
