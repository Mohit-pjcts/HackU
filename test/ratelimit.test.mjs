import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp, resetLimits, takeCall } from "../lib/ratelimit.js";

const cfg = { ratePerMinute: 3, maxCallsPerSession: 5, globalPerHour: 100 };

test("per-visitor limit refuses the 4th call in a minute, then recovers", () => {
  resetLimits();
  const t = 1_000_000;
  for (let i = 0; i < 3; i += 1) assert.ok(takeCall({ ip: "a", sessionId: `s${i}xxxxxx`, cfg, now: t + i }).ok);
  const r = takeCall({ ip: "a", sessionId: "s9xxxxxx", cfg, now: t + 10 });
  assert.equal(r.ok, false);
  assert.equal(r.code, "RATE_LIMITED");
  assert.ok(r.retryAfterSec >= 1 && r.retryAfterSec <= 60);
  assert.ok(takeCall({ ip: "b", sessionId: "s9xxxxxx", cfg, now: t + 10 }).ok, "other visitors are not affected");
  assert.ok(takeCall({ ip: "a", sessionId: "s9xxxxxx", cfg, now: t + 61_000 }).ok, "window slides");
});

test("per-session cap", () => {
  resetLimits();
  let now = 0;
  for (let i = 0; i < 5; i += 1) {
    const r = takeCall({ ip: `ip${i}`, sessionId: "same-session", cfg, now: (now += 1) });
    assert.ok(r.ok);
    assert.equal(r.callsLeft, 4 - i);
  }
  assert.equal(takeCall({ ip: "new", sessionId: "same-session", cfg, now: (now += 1) }).code, "SESSION_CAP");
});

test("global hourly cap", () => {
  resetLimits();
  const small = { ...cfg, globalPerHour: 2, ratePerMinute: 100 };
  assert.ok(takeCall({ ip: "a", sessionId: "s1xxxxxx", cfg: small, now: 1 }).ok);
  assert.ok(takeCall({ ip: "b", sessionId: "s2xxxxxx", cfg: small, now: 2 }).ok);
  assert.equal(takeCall({ ip: "c", sessionId: "s3xxxxxx", cfg: small, now: 3 }).code, "GLOBAL_CAP");
});

test("client IP comes from the first x-forwarded-for entry", () => {
  assert.equal(clientIp({ headers: { "x-forwarded-for": "198.51.100.1, 10.0.0.1" } }), "198.51.100.1");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "::1" } }), "::1");
});
