"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { readJsonStrict, writeFileAtomic, openLock } = require("./fs");

const MAX_OBSERVATIONS = 2000;
const MAX_BYTES = 1_000_000;
const RETENTION_MS = 90 * 86400_000;
const GAPS = Object.freeze({
  coverage: "Quota history contains successful observations only; usage and resets between reads may be missed.",
  backfill: "Historical quota backfill is unavailable; quota history begins with retained observations.",
  identity: "Claude quota responses do not identify the account or workspace; those observations remain unassigned.",
  codexIdentity: "A Codex quota response lacks an account identity; that observation remains unassigned.",
  units: "Claude extra-usage values retain provider-reported units; no conversion to billed USD is assumed.",
  truncated: "Quota history was truncated by its 90-day, 2000-observation or 1 MB retention limit.",
  invalid: "Some quota observations were invalid and omitted; quota coverage is incomplete.",
  missing: "No retained quota history is available on this machine.",
  unreadable: "Quota history could not be read; quota coverage is incomplete.",
  busy: "Quota history was not updated because another writer holds its lock.",
  write: "Quota history could not be saved; the previous history was retained.",
  claudePolling: "Claude live quota observation requires existing TokenTracker authenticated polling; the unattended sampler does not open Keychain.",
  codexUnavailable: "No live Codex quota observation was available; existing authentication may be absent, expired or temporarily unavailable.",
});
const knownGaps = new Set(Object.values(GAPS));
const hash = value => crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
const text = value => typeof value === "string" && value.trim() && value.length <= 160 && !/[\x00-\x1f]/.test(value) ? value.trim() : null;
const amount = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const stamp = value => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const ms = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 && ms <= 8640000000000000 ? new Date(ms).toISOString() : null;
};
const digest = value => typeof value === "string" && /^[a-f0-9]{24}$/.test(value) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const KINDS = new Set(["five_hour", "seven_day", "seven_day_opus", "weekly_scoped", "primary_window", "secondary_window", "spark_primary_window", "spark_secondary_window"]);

function normalizeObservation(raw) {
  if (!["anthropic", "openai"].includes(raw?.provider) || raw.source !== "provider-api" || !stamp(raw.observedAt)) return null;
  const windows = (Array.isArray(raw.windows) ? raw.windows : []).slice(0, 16).flatMap(w => {
    if (!KINDS.has(w?.kind)) return [];
    const usedPercent = amount(w.usedPercent), resetAt = stamp(w.resetAt);
    if (usedPercent === null && !resetAt) return [];
    return [{ kind: w.kind, scope: w.kind === "weekly_scoped" ? text(w.scope) : null, usedPercent, resetAt, windowSeconds: amount(w.windowSeconds) }];
  });
  const c = raw.creditWindow;
  const creditWindow = c && typeof c === "object" ? {
    unit: "provider_credits", source: "openai-wham-spend-control",
    limitCredits: amount(c.limitCredits), usedCredits: amount(c.usedCredits), remainingCredits: amount(c.remainingCredits), resetAt: stamp(c.resetAt),
  } : null;
  const r = raw.resetCredits;
  const resetCredits = r && typeof r === "object" ? {
    availableCount: count(r.availableCount), totalEarnedCount: count(r.totalEarnedCount),
    credits: (Array.isArray(r.credits) ? r.credits : []).slice(0, 50).flatMap(x => stamp(x?.expiresAt) ? [{ expiresAt: stamp(x.expiresAt), grantedAt: stamp(x.grantedAt) }] : []),
  } : null;
  const monetary = (Array.isArray(raw.monetary) ? raw.monetary : []).slice(0, 2).flatMap(m => {
    if (!["extra_usage_limit", "extra_usage_used"].includes(m?.kind) || amount(m.value) === null) return [];
    return [{ kind: m.kind, value: m.value, unit: "provider_reported_units", currency: /^[A-Z]{3}$/.test(m.currency) ? m.currency : null, source: "anthropic-oauth-extra-usage", billedCharge: false }];
  });
  if (!windows.length && !creditWindow && !resetCredits && !monetary.length) return null;
  const observation = {
    provider: raw.provider, accountId: digest(raw.accountId), identityId: digest(raw.identityId), organizationId: digest(raw.organizationId),
    observedAt: stamp(raw.observedAt), source: "provider-api", plan: text(raw.plan), planTier: text(raw.planTier),
    windows, creditWindow, resetCredits, monetary,
    findings: [...new Set((Array.isArray(raw.findings) ? raw.findings : []).filter(f => knownGaps.has(f)))],
  };
  const { plan, planTier, findings, ...measurement } = observation;
  return { id: hash(JSON.stringify(measurement)), ...observation };
}

function normalizeQuotaHistory(raw = {}, { now } = {}) {
  const findings = new Set([GAPS.coverage, GAPS.backfill, ...(Array.isArray(raw.findings) ? raw.findings.filter(f => knownGaps.has(f)) : [])]);
  const records = Array.isArray(raw.observations) ? raw.observations : [];
  const nowMs = now == null ? null : Date.parse(now);
  if (now != null && !Number.isFinite(nowMs)) throw new Error("Invalid quota retention timestamp");
  const byId = new Map();
  for (const row of records) {
    const normalized = normalizeObservation(row);
    if (!normalized) { findings.add(GAPS.invalid); continue; }
    const observedMs = Date.parse(normalized.observedAt);
    if (nowMs !== null && observedMs > nowMs + 60_000) { findings.add(GAPS.invalid); continue; }
    if (nowMs !== null && observedMs < nowMs - RETENTION_MS) { findings.add(GAPS.truncated); continue; }
    const old = byId.get(normalized.id);
    byId.set(normalized.id, old ? { ...normalized, plan: normalized.plan || old.plan, planTier: normalized.planTier || old.planTier, findings: [...new Set([...old.findings, ...normalized.findings])] } : normalized);
  }
  const sorted = [...byId.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.id.localeCompare(b.id));
  const retained = [], streams = new Map();
  for (const observation of sorted) {
    const { id, observedAt, ...measurement } = observation;
    const signature = JSON.stringify(measurement);
    const stream = `${observation.provider}:${observation.accountId || "unassigned"}`;
    const previous = streams.get(stream);
    // Keep first and last reads of an unchanged run, including through restart.
    if (previous?.signature === signature && previous.first !== previous.last) retained[previous.last] = null;
    const index = retained.push(observation) - 1;
    streams.set(stream, { signature, first: previous?.signature === signature ? previous.first : index, last: index });
  }
  let observations = retained.filter(Boolean);
  if (observations.length > MAX_OBSERVATIONS) { observations = observations.slice(-MAX_OBSERVATIONS); findings.add(GAPS.truncated); }
  // Reserve space for findings and wrapper before taking the newest records.
  let bytes = 4096, start = observations.length;
  while (start > 0) {
    const size = Buffer.byteLength(JSON.stringify(observations[start - 1])) + 1;
    if (bytes + size > MAX_BYTES) break;
    bytes += size; start--;
  }
  if (start > 0) { observations = observations.slice(start); findings.add(GAPS.truncated); }
  return { version: 1, observations, findings: [...findings] };
}

async function readQuotaHistory({ home = os.homedir(), dir = path.join(home, ".tokentracker", "team"), now } = {}) {
  const file = path.join(dir, "quota-history.json");
  try {
    if ((await fs.stat(file)).size > MAX_BYTES) return normalizeQuotaHistory({ findings: [GAPS.unreadable] }, { now });
    const read = await readJsonStrict(file);
    if (read.status !== "ok" || read.value?.version !== 1) return normalizeQuotaHistory({ findings: [GAPS.unreadable] }, { now });
    return normalizeQuotaHistory(read.value, { now });
  } catch (error) {
    return normalizeQuotaHistory({ findings: [error.code === "ENOENT" ? GAPS.missing : GAPS.unreadable] }, { now });
  }
}

function observationFromLimits(provider, value, { accountId, plan, planTier, observedAt }) {
  if (!value?.configured || value.error || value.stale === true) return null;
  const windows = [];
  for (const kind of KINDS) {
    const values = kind === "weekly_scoped" ? value[kind] : [value[kind]];
    for (const w of Array.isArray(values) ? values : []) {
      if (!w) continue;
      windows.push({ kind, scope: w.label, usedPercent: w.utilization ?? w.used_percent, resetAt: w.resets_at ?? w.reset_at, windowSeconds: w.limit_window_seconds ?? (kind === "five_hour" ? 18000 : kind.startsWith("seven_day") || kind === "weekly_scoped" ? 604800 : null) });
    }
  }
  const c = value.credit_window, r = value.reset_credits, extra = value.extra_usage;
  const identityId = provider === "openai" && text(accountId) ? hash(`openai:${accountId}`) : null;
  const monetary = extra ? [["extra_usage_limit", extra.monthly_limit], ["extra_usage_used", extra.used_credits]].filter(([, v]) => amount(v) !== null).map(([kind, v]) => ({ kind, value: v, currency: extra.currency })) : [];
  return normalizeObservation({ provider, accountId: identityId, identityId, organizationId: null, observedAt, source: "provider-api", plan, planTier, windows,
    creditWindow: c ? { limitCredits: c.limit_credits, usedCredits: c.used_credits, remainingCredits: c.remaining_credits, resetAt: c.reset_at } : null,
    resetCredits: r ? { availableCount: r.available_count, totalEarnedCount: r.total_earned_count, credits: r.credits?.map(x => ({ expiresAt: x.expires_at, grantedAt: x.granted_at })) } : null,
    monetary, findings: [...(!identityId ? [provider === "anthropic" ? GAPS.identity : GAPS.codexIdentity] : []), ...(monetary.length ? [GAPS.units] : [])],
  });
}

// Called only with successful live reads. Cached responses never become new observations.
async function captureQuotaHistory({ home = os.homedir(), dir = path.join(home, ".tokentracker", "team"), claude, codex, codexAccountId, claudePlan, claudeTier, now = new Date().toISOString() } = {}) {
  const config = await readJsonStrict(path.join(dir, "config.json"));
  if (config.status !== "ok" || !text(config.value?.personId) || !text(config.value?.machineId)) return { status: "not-enrolled", findings: [] };
  const observations = [
    observationFromLimits("anthropic", claude, { plan: claudePlan, planTier: claudeTier, observedAt: claude?.cached_at || now }),
    observationFromLimits("openai", codex, { accountId: codexAccountId, plan: codex?.plan_type, observedAt: codex?.cached_at || now }),
  ].filter(Boolean);
  if (!observations.length) return { status: "no-live-observation", findings: [] };
  let lock;
  try {
    lock = await openLock(path.join(dir, "quota-history.lock"), { quietIfLocked: true });
    if (!lock) return { status: "busy", findings: [GAPS.busy] };
    const previous = await readQuotaHistory({ dir, now });
    if (previous.findings.includes(GAPS.unreadable)) return { status: "failed", findings: [GAPS.unreadable] };
    const history = normalizeQuotaHistory({ observations: [...previous.observations, ...observations], findings: previous.findings.filter(f => f !== GAPS.missing) }, { now });
    await writeFileAtomic(path.join(dir, "quota-history.json"), JSON.stringify(history) + "\n", { mode: 0o600 });
    return { status: "captured", findings: [...new Set(observations.flatMap(o => o.findings))] };
  } catch { return { status: "failed", findings: [GAPS.write] }; }
  finally { await lock?.release(); }
}

// This unattended path deliberately avoids the all-provider dashboard probe and Keychain.
// Existing Claude cache reads retain their original observation time and deduplicate.
async function refreshQuotaHistory({ home = os.homedir(), dir = path.join(home, ".tokentracker", "team"), env = home === os.homedir() ? process.env : {}, now = new Date().toISOString(), fetchImpl, providerTimeoutMs = 10_000 } = {}) {
  const config = await readJsonStrict(path.join(dir, "config.json"));
  if (config.status !== "ok" || !text(config.value?.personId) || !text(config.value?.machineId)) return { ...normalizeQuotaHistory({}, { now }), status: "not-enrolled" };
  const { readFreshClaudeLimitsCache, fetchCodexUsageLimits } = require("./usage-limits");
  const claude = readFreshClaudeLimitsCache({ home, nowMs: Date.parse(now) });
  const findings = [GAPS.claudePolling];
  let codex = null, accountId = null;
  try {
    const auth = await require("./subscriptions").readCodexAuthBundle({ home, env });
    if (auth?.accessToken) {
      const result = await fetchCodexUsageLimits(auth.accessToken, { accountId: auth.accountId, fetchImpl, providerTimeoutMs });
      if (result.upstream_status === 200) {
        accountId = auth.accountId;
        codex = { ...result, configured: true, stale: false, plan_type: auth.planType, cached_at: now };
      }
    }
  } catch { /* A failed quota read must not block token collection. */ }
  if (!codex) findings.push(GAPS.codexUnavailable);
  const captured = await captureQuotaHistory({ home, dir, now, claude, codex, codexAccountId: accountId }).catch(() => ({ status: "failed", findings: [GAPS.write] }));
  const history = await readQuotaHistory({ home, dir, now });
  return { ...history, findings: [...new Set([...history.findings, ...findings, ...captured.findings])], status: captured.status };
}

module.exports = { normalizeQuotaHistory, readQuotaHistory, captureQuotaHistory, refreshQuotaHistory, MAX_OBSERVATIONS, MAX_BYTES };
