// Abuse limits for the public demo link.
//
// Honest limits of this design: the counters live in the memory of one serverless
// instance. They reset on a cold start and are not shared if the host runs several
// instances at once. They stop a casual flood or a runaway loop in our own page,
// not a determined attacker. The real backstop is the spend limit set in the
// Anthropic Console, plus JUDGE_ACCESS_CODE when the link is shared widely.

const MAX_KEYS = 5000;

class BoundedMap extends Map {
  set(key, value) {
    if (!this.has(key) && this.size >= MAX_KEYS) {
      // Drop the oldest entry (Map keeps insertion order).
      this.delete(this.keys().next().value);
    }
    return super.set(key, value);
  }
}

const perVisitor = new BoundedMap(); // ip -> array of timestamps (ms) in the last minute
const perSession = new BoundedMap(); // sessionId -> number of model calls
let globalWindow = []; // timestamps (ms) of all calls in the last hour

export function resetLimits() {
  perVisitor.clear();
  perSession.clear();
  globalWindow = [];
}

/**
 * Check every limit and, only if all pass, record the call.
 * Returns { ok: true, callsLeft } or { ok: false, code, retryAfterSec, message }.
 */
export function takeCall({ ip, sessionId, cfg, now = Date.now() }) {
  const minuteAgo = now - 60_000;
  const hourAgo = now - 3_600_000;

  const visitor = (perVisitor.get(ip) || []).filter((t) => t > minuteAgo);
  if (visitor.length >= cfg.ratePerMinute) {
    perVisitor.set(ip, visitor);
    return {
      ok: false,
      code: "RATE_LIMITED",
      retryAfterSec: Math.max(1, Math.ceil((visitor[0] + 60_000 - now) / 1000)),
      message: "Too many requests from this visitor. Wait a few seconds.",
    };
  }

  globalWindow = globalWindow.filter((t) => t > hourAgo);
  if (globalWindow.length >= cfg.globalPerHour) {
    return {
      ok: false,
      code: "GLOBAL_CAP",
      retryAfterSec: Math.max(1, Math.ceil((globalWindow[0] + 3_600_000 - now) / 1000)),
      message: "The demo has hit its hourly limit. Try again later.",
    };
  }

  const used = perSession.get(sessionId) || 0;
  if (used >= cfg.maxCallsPerSession) {
    return {
      ok: false,
      code: "SESSION_CAP",
      retryAfterSec: 0,
      message: "This session has used all its guidance calls. Reload the page to start a new task.",
    };
  }

  visitor.push(now);
  perVisitor.set(ip, visitor);
  globalWindow.push(now);
  perSession.set(sessionId, used + 1);
  return { ok: true, callsLeft: cfg.maxCallsPerSession - used - 1 };
}

/**
 * Best-effort client IP. Vercel sets x-vercel-forwarded-for / x-real-ip itself, so a
 * visitor cannot fake them there. On a host without such a proxy these headers can be
 * forged, which only weakens the per-visitor limit (the session and global caps remain).
 */
export function clientIp(req) {
  const h = req.headers || {};
  const first = (v) => (Array.isArray(v) ? v[0] : v);
  for (const name of ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]) {
    const v = first(h[name]);
    if (v) return String(v).split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}
