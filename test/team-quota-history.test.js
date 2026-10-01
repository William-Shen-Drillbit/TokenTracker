"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { captureQuotaHistory, readQuotaHistory, normalizeQuotaHistory, refreshQuotaHistory, MAX_OBSERVATIONS, MAX_BYTES } = require("../src/lib/team-quota-history");
const { openLock } = require("../src/lib/fs");
const now = "2026-10-01T15:00:00.000Z";
const hash = value => crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
const codex = { configured: true, stale: false, plan_type: "pro", cached_at: now,
  primary_window: { used_percent: 41, reset_at: Date.parse(now) / 1000 + 3600, limit_window_seconds: 18000, access_token: "do-not-store" },
  credit_window: { limit_credits: 100, used_credits: 30, remaining_credits: 70 },
  reset_credits: { available_count: 2, total_earned_count: 5, credits: [{ status: "available", expires_at: "2026-10-07T15:00:00Z", granted_at: now, id: "private-reset-id" }] },
  prompt: "do-not-store", access_token: "do-not-store",
};

test("quota capture is enrolled-only, allowlisted, account-bound and keeps original observations", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "team-quota-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, ".tokentracker", "team");
  assert.equal((await captureQuotaHistory({ home, codex, now })).status, "not-enrolled");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ personId: "person", machineId: "machine" }));
  const claude = { configured: true, cached_at: now, five_hour: { utilization: 60, resets_at: "2026-10-01T17:00:00Z" },
    weekly_scoped: [{ label: "Fable", utilization: 25, resets_at: "2026-10-07T15:00:00Z" }],
    extra_usage: { monthly_limit: 5000, used_credits: 250, currency: "USD", payment_card: "do-not-store" } };
  await captureQuotaHistory({ home, codex, codexAccountId: "exact-account", claude, claudePlan: "max", now });
  // The same cached measurement is not a second observation or relabeled with a new date.
  await captureQuotaHistory({ home, codex, codexAccountId: "exact-account", claude, now: "2026-10-01T15:05:00Z" });
  let history = await readQuotaHistory({ home, now });
  assert.equal(history.observations.length, 2);
  const openai = history.observations.find(o => o.provider === "openai");
  assert.equal(openai.accountId, hash("openai:exact-account"));
  assert.equal(openai.observedAt, now);
  assert.equal(openai.resetCredits.availableCount, 2);
  assert.equal(openai.creditWindow.unit, "provider_credits");
  const anthropic = history.observations.find(o => o.provider === "anthropic");
  assert.equal(anthropic.accountId, null);
  assert.equal(anthropic.plan, "max");
  assert.equal(anthropic.monetary[1].value, 250);
  assert.equal(anthropic.monetary[1].unit, "provider_reported_units");
  assert.equal(anthropic.monetary[1].billedCharge, false);
  assert.equal(anthropic.windows[1].scope, "Fable");
  assert.match(anthropic.findings.join(" "), /remain unassigned/);
  const disk = await fs.readFile(path.join(dir, "quota-history.json"), "utf8");
  assert.doesNotMatch(disk, /do-not-store|private-reset-id|exact-account|access_token|payment_card/);
  assert.equal((await fs.stat(path.join(dir, "quota-history.json"))).mode & 0o777, 0o600);
  // A stale read adds nothing; a real later quota drop remains visible for audit.
  await captureQuotaHistory({ home, codex: { ...codex, stale: true }, now });
  assert.equal((await readQuotaHistory({ home, now })).observations.length, 2);
  await captureQuotaHistory({ home, codex: { ...codex, cached_at: "2026-10-01T15:10:00Z", primary_window: { ...codex.primary_window, used_percent: 1 } }, codexAccountId: "exact-account", now: "2026-10-01T15:10:00Z" });
  history = await readQuotaHistory({ home, now: "2026-10-01T15:10:00Z" });
  assert.equal(history.observations.length, 3);
  const lock = await openLock(path.join(dir, "quota-history.lock"));
  try { assert.equal((await captureQuotaHistory({ home, codex, now })).status, "busy"); }
  finally { await lock.release(); }
  await fs.writeFile(path.join(dir, "quota-history.json"), "corrupt");
  assert.equal((await captureQuotaHistory({ home, codex, now })).status, "failed");
  assert.equal(await fs.readFile(path.join(dir, "quota-history.json"), "utf8"), "corrupt");
});

test("normalization bounds history deterministically and excludes invalid/arbitrary fields", () => {
  const base = { provider: "openai", source: "provider-api", accountId: hash("openai:a"), observedAt: now,
    windows: [{ kind: "primary_window", usedPercent: 10, resetAt: "2026-10-01T17:00:00Z", prompt: "do-not-store" }] };
  const observations = Array.from({ length: MAX_OBSERVATIONS + 1 }, (_, i) => ({ ...base, observedAt: new Date(Date.parse(now) - i * 60000).toISOString(), windows: [{ ...base.windows[0], usedPercent: i % 100 }] }));
  observations.push({ ...base, observedAt: "2025-01-01T00:00:00Z" }, { ...base, observedAt: "bad" });
  const normalized = normalizeQuotaHistory({ observations, findings: ["do-not-store"], secret: "do-not-store" }, { now });
  assert.equal(normalized.observations.length, MAX_OBSERVATIONS);
  assert.ok(Buffer.byteLength(JSON.stringify(normalized)) <= MAX_BYTES);
  assert.match(normalized.findings.join(" "), /truncated/);
  assert.match(normalized.findings.join(" "), /invalid/);
  assert.doesNotMatch(JSON.stringify(normalized), /do-not-store/);
  assert.deepEqual(normalizeQuotaHistory(normalized, { now }), normalized);
  const sameReads = Array.from({ length: 10 }, (_, i) => ({ ...base, observedAt: new Date(Date.parse(now) - i * 60000).toISOString() }));
  const coalesced = normalizeQuotaHistory({ observations: sameReads }, { now });
  assert.equal(coalesced.observations.length, 2);
  assert.equal(coalesced.observations[0].observedAt, sameReads[9].observedAt);
  assert.equal(coalesced.observations[1].observedAt, sameReads[0].observedAt);
});

test("unattended refresh only calls existing Codex endpoints and retains cached Claude timestamp", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "team-quota-scope-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, ".tokentracker", "team");
  let calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers["ChatGPT-Account-Id"], "exact-account");
    if (url.endsWith("/wham/usage")) return { status: 200, json: async () => ({ rate_limit: { primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_at: Date.parse(now) / 1000 + 3600 } } }) };
    assert.equal(url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
    return { ok: true, json: async () => ({ available_count: 1 }) };
  };
  assert.equal((await refreshQuotaHistory({ home, env: {}, now, fetchImpl })).status, "not-enrolled");
  assert.deepEqual(calls, []);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ personId: "person", machineId: "machine" }));
  await fs.mkdir(path.join(home, ".codex"));
  await fs.writeFile(path.join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { access_token: "fixture-token", account_id: "exact-account" } }));
  const cachedAt = "2026-10-01T14:55:00.000Z";
  await fs.mkdir(path.join(home, ".tokentracker", "tracker"));
  await fs.writeFile(path.join(home, ".tokentracker", "tracker", "claude-usage-limits-cache.json"), JSON.stringify({ claude: { cached_at: cachedAt, five_hour: { utilization: 30, resets_at: "2026-10-01T17:00:00Z" } } }));
  const result = await refreshQuotaHistory({ home, env: {}, now, fetchImpl });
  assert.equal(result.status, "captured");
  assert.equal(calls.length, 2);
  assert.equal(result.observations.find(o => o.provider === "anthropic").observedAt, cachedAt);
  assert.match(result.findings.join(" "), /does not open Keychain/);
  const failed = await refreshQuotaHistory({ home, env: {}, now, fetchImpl: async () => { throw new Error("do-not-store-provider-body"); } });
  assert.match(failed.findings.join(" "), /No live Codex quota observation/);
  assert.doesNotMatch(JSON.stringify(failed), /do-not-store-provider-body/);
  // The existing dashboard/native poll also persists fresh successful reads,
  // while an upstream failure serving its disk fallback does not append.
  const { getUsageLimits, resetUsageLimitsCache } = require("../src/lib/usage-limits");
  const inactiveRunner = () => ({ status: 1, stdout: "", stderr: "" });
  resetUsageLimitsCache();
  const native = await getUsageLimits({ home, env: {}, platform: "linux", commandRunner: inactiveRunner, securityRunner: inactiveRunner, fetchImpl });
  assert.equal(native.team_quota_capture.status, "captured");
  const nativeHistory = await readQuotaHistory({ home });
  assert.ok(nativeHistory.observations.some(o => o.provider === "openai" && o.observedAt === native.codex.cached_at));
  resetUsageLimitsCache();
  const fallback = await getUsageLimits({ home, env: {}, platform: "linux", commandRunner: inactiveRunner, securityRunner: inactiveRunner, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal(fallback.team_quota_capture.status, "no-live-observation");
  assert.deepEqual((await readQuotaHistory({ home })).observations, nativeHistory.observations);
  resetUsageLimitsCache();
});
