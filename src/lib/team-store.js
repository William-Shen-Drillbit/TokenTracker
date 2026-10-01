"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { writeFileAtomic, readJson, openLock } = require("./fs");
const { getOrCreateMachineId } = require("./machine-id");
const { computeRowCost, getRowPricing, getPricingRevision, SOURCES_WITH_AUTHORITATIVE_COST } = require("./pricing");
const { normalizeQuotaHistory, readQuotaHistory, refreshQuotaHistory } = require("./team-quota-history");

const runFile = promisify(execFile);
const TEAM_DIR = path.join(os.homedir(), ".tokentracker", "team");
const COUNTERS = ["input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
const PRICE_COMPONENTS = COUNTERS.filter(k => k !== "total_tokens");
const PRICE_COUNTERS = ["long_context_", "priority_", "priority_long_context_"].flatMap(prefix => PRICE_COMPONENTS.map(k => prefix + k));
const PRICE_RATES = ["input", "cache_read", "cache_write", "output", "priority_multiplier"];
const MAX_BYTES = 900_000;
const MAX_EXPANDED_BYTES = 25_000_000;
const ID = /^[A-Za-z0-9_.-]{1,128}$/;

function text(value, max = 160) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error("Invalid metadata text");
  return value;
}
function identifier(value) { if (!ID.test(text(value, 128))) throw new Error("Invalid identifier"); return value; }
function number(value) { if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) throw new Error("Invalid usage amount"); return value; }
function timestamp(value) { if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error("Invalid timestamp"); return new Date(value).toISOString(); }
function hash(value) { return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24); }
async function save(file, value) { await writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 }); }

function authoritativeCost(row) {
  return SOURCES_WITH_AUTHORITATIVE_COST.has(row.source) && row.total_cost_usd != null
    ? { total_cost_usd: number(row.total_cost_usd) } : {};
}

function pricingCounters(row) {
  return Object.fromEntries(PRICE_COUNTERS.filter(k => row[k] != null).map(k => {
    const base = k.replace(/^(priority_long_context_|long_context_|priority_)/, "");
    const value = number(row[k]);
    const maximum = k.startsWith("priority_long_context_")
      ? Math.min(number(row[base] ?? 0), number(row["priority_" + base] ?? 0), number(row["long_context_" + base] ?? 0))
      : number(row[base] ?? 0);
    if (value > maximum) throw new Error("Pricing subset exceeds token count");
    return [k, value];
  }));
}

// Allowlist both outbound and inbound fields. Never transport source records,
// credentials, absolute paths, prompts, session titles, or arbitrary properties.
function normalizeSnapshot(raw) {
  if (raw?.version !== 1 || !Array.isArray(raw.rows) || raw.rows.length > 100_000 || !Array.isArray(raw.accounts) || raw.accounts.length > 200) throw new Error("Invalid team snapshot");
  const accounts = raw.accounts.map(a => ({
    id: identifier(a.id), provider: text(a.provider), email: a.email ? text(a.email) : null,
    plan: a.plan ? text(a.plan) : null, planTier: a.planTier ? text(a.planTier) : null,
    allowanceWeeklyUsd: a.allowanceWeeklyUsd == null ? null : number(a.allowanceWeeklyUsd), ownership: ["company", "personal", "unknown"].includes(a.ownership) ? a.ownership : "unknown",
    observedAt: timestamp(a.observedAt),
    identityId: a.identityId == null ? null : identifier(a.identityId),
    organizationId: a.organizationId == null ? null : identifier(a.organizationId),
    status: ["current", "historical", "observed"].includes(a.status) ? a.status : "observed",
    evidence: a.evidence ? text(a.evidence) : null,
  }));
  if (!Array.isArray(raw.planObservations || []) || (raw.planObservations || []).length > 2000) throw new Error("Too many plan observations");
  const planObservations = (raw.planObservations || []).map(o => ({
    provider: text(o.provider), accountId: o.accountId == null ? null : identifier(o.accountId),
    plan: o.plan ? text(o.plan) : null, planTier: o.planTier ? text(o.planTier) : null,
    evidence: text(o.evidence), firstSeen: timestamp(o.firstSeen), lastSeen: timestamp(o.lastSeen),
  }));
  const ids = new Set(accounts.map(a => a.id));
  const rows = raw.rows.map(r => {
    const accountId = r.accountId == null ? null : identifier(r.accountId);
    if (accountId && !ids.has(accountId)) throw new Error("Usage refers to an unenrolled account");
    return {
      source: text(r.source), model: text(r.model), hour_start: timestamp(r.hour_start), accountId,
      ...Object.fromEntries(COUNTERS.map(k => [k, number(r[k] ?? 0)])),
      ...pricingCounters(r), ...authoritativeCost(r),
      ...(r.priceRates ? { priceRates: Object.fromEntries(PRICE_RATES.filter(k => r.priceRates[k] != null).map(k => [k, number(r.priceRates[k])])) } : {}),
      estimatedUsd: r.estimatedUsd == null ? null : number(r.estimatedUsd),
    };
  });
  // Billing entries are account/cycle snapshots, never summed across devices.
  const billing = (raw.billing || []).map(b => {
    if (!ids.has(b.accountId)) throw new Error("Billing refers to an unenrolled account");
    const periodStart = timestamp(b.periodStart), periodEnd = timestamp(b.periodEnd);
    if (periodEnd <= periodStart || b.currency !== "USD") throw new Error("Invalid billing cycle or currency");
    return {
      accountId: b.accountId, periodStart, periodEnd, currency: "USD", observedAt: timestamp(b.observedAt),
      subscriptionUsd: b.subscriptionUsd == null ? null : number(b.subscriptionUsd),
      includedUsd: b.includedUsd == null ? null : number(b.includedUsd),
      overageUsd: b.overageUsd == null ? null : number(b.overageUsd),
      basis: b.basis === "invoice" ? "invoice" : "provider-reported", source: text(b.source),
    };
  });
  if (billing.length > 2400) throw new Error("Too many billing cycles");
  const quota = normalizeQuotaHistory({ version: 1, observations: raw.quotaObservations || [], findings: raw.quotaFindings || [] }, { now: raw.collectedAt });
  return {
    version: 1, personId: identifier(raw.personId), personName: text(raw.personName),
    machineId: identifier(raw.machineId), machineName: text(raw.machineName),
    collectedAt: timestamp(raw.collectedAt), pricingRevision: text(String(raw.pricingRevision || "unknown")),
    accounts, planObservations, billing, rows,
    quotaObservations: quota.observations, quotaFindings: quota.findings,
    findings: (raw.findings || []).slice(0, 100).map(f => text(f, 500)),
  };
}

function encodeSnapshot(snapshot) {
  const buffer = zlib.gzipSync(JSON.stringify(normalizeSnapshot(snapshot)));
  if (buffer.length > MAX_BYTES) throw new Error("Snapshot exceeds the pilot's 900 KB compressed limit; shorten the collection window");
  return buffer;
}
function decodeSnapshot(buffer) {
  if (buffer.length > MAX_BYTES) throw new Error("Oversized remote snapshot");
  return normalizeSnapshot(JSON.parse(zlib.gunzipSync(buffer, { maxOutputLength: MAX_EXPANDED_BYTES }).toString("utf8")));
}

async function ghApi(endpoint, body) {
  const args = ["api", endpoint, "--hostname", "github.com"];
  let stdin;
  if (body !== undefined) { args.push("--method", "PUT", "--input", "-"); stdin = JSON.stringify(body); }
  return new Promise((resolve, reject) => {
    const child = execFile("gh", args, { timeout: 45_000, maxBuffer: 4_000_000 }, (error, stdout, stderr) => {
      if (error) {
        const status = /HTTP (\d{3})/.exec(stderr || "");
        const e = new Error(`GitHub request failed${status ? ` (HTTP ${status[1]})` : "; check network and gh auth"}`);
        e.status = status ? Number(status[1]) : null;
        reject(e);
      } else {
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid GitHub API response")); }
      }
    });
    child.stdin.end(stdin);
  });
}

async function verifyRepository(repo, api = ghApi) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Expected owner/private-data-repo");
  const result = await api(`repos/${repo}`);
  if (result.private !== true) throw new Error("Team data repository must be private; sync refused");
  if (!result.permissions?.push) throw new Error("Write access to the private data repository is required");
  return result;
}

async function uploadSnapshot(repo, snapshot, api = ghApi) {
  await verifyRepository(repo, api);
  const safe = normalizeSnapshot(snapshot);
  const endpoint = `repos/${repo}/contents/snapshots/${safe.personId}/${safe.machineId}.json.gz`;
  const content = encodeSnapshot(safe).toString("base64");
  let previous;
  try { previous = await api(endpoint); } catch (e) { if (e.status !== 404) throw e; }
  // A timed-out PUT may already have committed. Compare bytes before retrying.
  if (previous?.content?.replace(/\s/g, "") === content) return { unchanged: true };
  await api(endpoint, { message: `Update usage snapshot for ${safe.personId}`, content, ...(previous?.sha ? { sha: previous.sha } : {}) });
  return { unchanged: false };
}

async function downloadSnapshots(repo, dir, api = ghApi) {
  const meta = await verifyRepository(repo, api);
  let tree;
  try { tree = await api(`repos/${repo}/git/trees/${encodeURIComponent(meta.default_branch || "main")}?recursive=1`); }
  catch (e) { if (e.status === 409) return []; throw e; }
  if (tree.truncated) throw new Error("GitHub tree truncated; refusing an incomplete team refresh");
  const files = tree.tree.filter(f => f.type === "blob" && /^snapshots\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.json\.gz$/.test(f.path));
  const previous = await readJson(path.join(dir, "remote-index.json")) || {};
  const next = {};
  for (const file of files) {
    if (file.size > MAX_BYTES) throw new Error("Oversized team snapshot in private repository");
    const cached = path.join(dir, "cache", `${hash(file.path)}-${file.sha}.json`);
    if (previous[file.path] !== file.sha || !(await readJson(cached))) {
      const blob = await api(`repos/${repo}/git/blobs/${file.sha}`);
      if (blob.encoding !== "base64") throw new Error("Unsupported GitHub blob encoding");
      const snapshot = decodeSnapshot(Buffer.from(blob.content, "base64"));
      if (file.path !== `snapshots/${snapshot.personId}/${snapshot.machineId}.json.gz`) throw new Error("Snapshot identity does not match its filename");
      await save(cached, snapshot);
    }
    next[file.path] = file.sha;
  }
  // Publish the index last; partial downloads keep the last complete roster.
  await save(path.join(dir, "remote-index.json"), next);
  await save(path.join(dir, "remote-status.json"), { refreshedAt: new Date().toISOString() });
  return files.map(f => f.path);
}

async function discoverAccounts(home = os.homedir(), now = new Date().toISOString()) {
  return (await require("./team-account-inventory").discoverInventory({ home, now })).accounts;
}

async function collectSnapshot(config, dir = TEAM_DIR, now = new Date().toISOString()) {
  const { readQueueData, resolveQueuePath } = require("./local-api");
  const queuePath = config.queuePath || resolveQueuePath();
  await fs.access(queuePath); // Missing source is not zero usage.
  const previous = await readJson(path.join(dir, "snapshot.json")) || {};
  // Quota sampling never uploads, creates schedules, or blocks token collection.
  const quota = config.collectionMode === "routine" && config.backend === "registry"
    ? await refreshQuotaHistory({ dir, now })
    : await readQuotaHistory({ dir, now });
  const inventory = await require("./team-account-inventory").discoverInventory({ now, previous });
  const accounts = inventory.accounts;
  const resolveAccount = id => {
    if (accounts.some(a => a.id === id)) return id;
    const matches = accounts.filter(a => a.identityId === id);
    return matches.length === 1 ? matches[0].id : null;
  };
  const enrolled = await readJson(path.join(dir, "accounts.json")) || [];
  for (const a of enrolled) {
    const resolved = resolveAccount(a.id);
    const index = accounts.findIndex(existing => existing.id === resolved);
    if (index >= 0) accounts[index] = { ...accounts[index], ...a, id: resolved, observedAt: now };
    else accounts.push({ ...a, observedAt: now });
  }
  const since = Date.parse(now) - (config.historyDays || 90) * 86_400_000;
  const rawRows = readQueueData(queuePath).filter(r => Date.parse(r.hour_start) >= since && Date.parse(r.hour_start) <= Date.parse(now));
  const attribution = await require("./team-claude-attribution").attributeClaudeRows(rawRows, accounts, { roots: inventory.roots.claude });
  const rows = attribution.rows.map(r => {
    const pricing = getRowPricing(r);
    const reportedCost = authoritativeCost(r);
    const priced = reportedCost.total_cost_usd > 0 || (pricing && Object.values(pricing).some(value => typeof value === "number" && value > 0));
    // Queue buckets do not retain provider-account identity. Never label old
    // usage with the account currently signed in. Explicit provenance wins.
    const accountId = r.account_id ? resolveAccount(r.account_id) : null;
    return { source: r.source || "unknown", model: r.model || "unknown", hour_start: r.hour_start,
      accountId, ...Object.fromEntries(COUNTERS.map(k => [k, r[k] || 0])), ...reportedCost,
      ...Object.fromEntries(PRICE_COUNTERS.filter(k => r[k] != null).map(k => [k, r[k]])),
      ...(priced ? { priceRates: Object.fromEntries(PRICE_RATES.filter(k => pricing[k] != null).map(k => [k, pricing[k]])) } : {}),
      estimatedUsd: priced ? computeRowCost(r) : null };
  });
  const billing = await readJson(path.join(dir, "billing.json")) || [];
  for (const b of billing) {
    const resolved = resolveAccount(b.accountId);
    if (resolved) b.accountId = resolved;
    else if (!accounts.some(a => a.id === b.accountId)) {
      const old = previous.accounts?.find(a => a.id === b.accountId);
      if (old) accounts.push({ ...old, status: "historical", evidence: "billing-legacy-identity" });
    }
  }
  return normalizeSnapshot({ version: 1, personId: config.personId, personName: config.personName,
    machineId: config.machineId, machineName: config.machineName, collectedAt: now, pricingRevision: getPricingRevision(),
    accounts, planObservations: inventory.planObservations, rows, billing,
    quotaObservations: quota.observations, quotaFindings: quota.findings, findings: [
      ...inventory.findings,
      ...attribution.findings,
      ...quota.findings,
      "Account inventory describes observed sign-ins; historical usage without account identity remains unassigned.",
      "API-equivalent value is an estimate, not charges or overage. Missing billing is unknown.",
      "Coverage is retained local logs from supported tools; browser-only usage and undiscovered account directories may be absent.",
      "Repeated uploads replace snapshots. Mirrored sessions across different machines may still overlap.",
      ...(rows.length ? [] : ["No usage rows found in the selected local collection window."]),
    ] });
}

async function loadSnapshots(dir = TEAM_DIR) {
  const config = await readJson(path.join(dir, "config.json"));
  const index = await readJson(path.join(dir, config?.backend === "registry" ? "registry-index.json" : "remote-index.json")) || {};
  const snapshots = new Map();
  for (const file of Object.keys(index)) {
    const raw = await readJson(path.join(dir, "cache", `${hash(file)}-${index[file]}.json`));
    if (!raw) throw new Error("Cached team snapshot is missing; run team sync");
    const s = normalizeSnapshot(raw);
    snapshots.set(`${s.personId}/${s.machineId}`, s);
  }
  const local = await readJson(path.join(dir, "snapshot.json"));
  if (local) { const s = normalizeSnapshot(local); snapshots.set(`${s.personId}/${s.machineId}`, s); }
  return [...snapshots.values()];
}

// Planning assumptions reused from the team's audit, not published entitlements.
// ponytail: fixed weekly model; replace with reset-window modeling when logs retain plan history.
function planAllowance(account) {
  if (account.allowanceWeeklyUsd != null) return { weeklyUsd: account.allowanceWeeklyUsd, low: account.allowanceWeeklyUsd, high: account.allowanceWeeklyUsd, basis: "Account override" };
  const plan = (account.plan || "").toLowerCase(), tier = (account.planTier || "").toLowerCase();
  let values;
  if (account.provider === "anthropic" && /max_5x|5x/.test(tier)) values = [400, 500, 800];
  if (account.provider === "openai" && plan === "pro") values = [1200, 1400, 2000];
  if (account.provider === "openai" && plan === "self_serve_business_prolite") values = [300, 350, 500];
  if (account.provider === "openai" && plan === "team") values = [60, 70, 100];
  return values ? { low: values[0], weeklyUsd: values[1], high: values[2], basis: "Team audit assumption (2026-09-21)" + (account.provider === "openai" && plan === "pro" ? "; Pro assumes 20x" : "") } : null;
}

function estimateExcess(accounts, details, start, end) {
  const weeks = (end - start) / (7 * 86_400_000);
  const results = accounts.map(a => ({ ...a, allowance: a.planAmbiguous ? null : planAllowance(a), usageUsd: 0, tokens: 0, assumedTokens: 0, unpricedTokens: 0 }));
  let unallocatedUsd = 0, unallocatedTokens = 0;
  for (const row of details) {
    const provider = { claude: "anthropic", codex: "openai" }[row.source];
    const candidates = results.filter(a => a.personId === row.personId && (row.accountId ? a.id === row.accountId : a.provider === provider));
    if (candidates.length !== 1) { unallocatedUsd += row.estimatedUsd || 0; unallocatedTokens += row.total_tokens; continue; }
    const account = candidates[0];
    account.tokens += row.total_tokens;
    if (row.estimatedUsd == null) account.unpricedTokens += row.total_tokens;
    else account.usageUsd += row.estimatedUsd;
    if (!row.accountId) account.assumedTokens += row.total_tokens;
  }
  for (const a of results) {
    // ponytail: unknown models use this account's observed blended token rate;
    // replace the proxy when model identity or a curated price becomes available.
    const pricedTokens = a.tokens - a.unpricedTokens;
    a.priceProxyUsd = a.unpricedTokens > 0 && pricedTokens > 0 && a.usageUsd > 0
      ? a.usageUsd / pricedTokens * a.unpricedTokens : null;
    if (a.priceProxyUsd != null) a.usageUsd += a.priceProxyUsd;
    const eligible = a.allowance && a.tokens > 0 && (a.unpricedTokens === 0 || a.priceProxyUsd != null);
    a.includedUsd = a.allowance ? a.allowance.weeklyUsd * weeks : null;
    a.estimatedExcessUsd = eligible ? Math.max(0, a.usageUsd - a.includedUsd) : null;
    a.excessLowUsd = eligible ? Math.max(0, a.usageUsd - a.allowance.high * weeks) : null;
    a.excessHighUsd = eligible ? Math.max(0, a.usageUsd - a.allowance.low * weeks) : null;
    a.pricingAssumption = a.priceProxyUsd != null ? "Unknown models priced using the observed blended rate for this account" : a.unpricedTokens ? "Unpriced usage: no observed rate available" : "Model API prices";
    a.assumption = a.planAmbiguous ? "Conflicting plan history or legacy workspace identity prevents reliable allowance attribution; allowance and excess remain unknown" : a.assumedTokens ? "Historical usage assigned to the sole observed provider account; assumes this plan throughout the selected period" : "Usage retains account identity";
  }
  const known = results.filter(a => a.estimatedExcessUsd != null);
  return { accounts: results, estimatedExcessUsd: known.length ? known.reduce((n, a) => n + a.estimatedExcessUsd, 0) : null,
    excessLowUsd: known.length ? known.reduce((n, a) => n + a.excessLowUsd, 0) : null,
    excessHighUsd: known.length ? known.reduce((n, a) => n + a.excessHighUsd, 0) : null,
    modeledAccounts: known.length, totalAccounts: results.length, unallocatedUsd, unallocatedTokens,
    partial: known.length !== results.length || unallocatedTokens > 0, weeks };
}

function aggregate(snapshots, { from, to, now = Date.now() } = {}) {
  const start = from ? Date.parse(from) : now - 30 * 86_400_000;
  const end = to ? Date.parse(to) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error("Invalid date range");
  const people = new Map(), details = [], accounts = new Map(), cycles = new Map(), observations = new Map(), quotas = new Map();
  for (const raw of snapshots) {
    const s = normalizeSnapshot(raw);
    let person = people.get(s.personId);
    if (!person) { person = { id: s.personId, name: s.personName, tokens: 0, estimatedUsd: 0, unpricedTokens: 0, unassignedTokens: 0, reportedOverageUsd: null, machines: [], findings: [] }; people.set(s.personId, person); }
    person.machines.push({ id: s.machineId, name: s.machineName, collectedAt: s.collectedAt, stale: now - Date.parse(s.collectedAt) > 26 * 3_600_000 });
    person.findings = [...new Set([...person.findings, ...s.findings, ...s.quotaFindings])];
    for (const a of s.accounts) {
      const key = `${s.personId}/${a.id}`;
      if (!accounts.has(key) || accounts.get(key).observedAt < a.observedAt) accounts.set(key, { ...a, personId: s.personId });
    }
    for (const o of s.planObservations) {
      const key = [s.personId, o.provider, o.accountId, o.plan, o.planTier, o.evidence].join("|");
      const old = observations.get(key);
      observations.set(key, { ...o, personId: s.personId,
        firstSeen: old && old.firstSeen < o.firstSeen ? old.firstSeen : o.firstSeen,
        lastSeen: old && old.lastSeen > o.lastSeen ? old.lastSeen : o.lastSeen });
    }
    for (const o of s.quotaObservations) {
      // Account-wide quota measurements are observations, not additive usage.
      const time = Date.parse(o.observedAt);
      if (time < start || time >= end) continue;
      quotas.set(`${s.personId}/${o.id}`, { ...o, personId: s.personId });
    }
    for (const b of s.billing) {
      // Cycle totals cannot be prorated into an arbitrary date filter.
      if (Date.parse(b.periodStart) >= end || Date.parse(b.periodEnd) <= start) continue;
      const key = `${s.personId}/${b.accountId}/${b.periodStart}/${b.periodEnd}`;
      if (!cycles.has(key) || cycles.get(key).observedAt < b.observedAt) cycles.set(key, { ...b, personId: s.personId });
    }
    for (const r of s.rows) {
      const time = Date.parse(r.hour_start);
      if (time < start || time >= end) continue;
      person.tokens += r.total_tokens;
      if (r.estimatedUsd == null) person.unpricedTokens += r.total_tokens; else person.estimatedUsd += r.estimatedUsd;
      if (!r.accountId) person.unassignedTokens += r.total_tokens;
      details.push({ ...r, personId: s.personId, personName: s.personName, machineId: s.machineId });
    }
  }
  for (const b of cycles.values()) if (b.overageUsd != null) { const p = people.get(b.personId); p.reportedOverageUsd = (p.reportedOverageUsd || 0) + b.overageUsd; }
  for (const a of accounts.values()) {
    a.planAmbiguous = [...accounts.values()].some(other => other.personId === a.personId && other.id !== a.id && other.identityId === a.id) || [...observations.values()].some(o => o.personId === a.personId && o.provider === a.provider && ((o.plan && a.plan && o.plan !== a.plan) || (o.planTier && a.planTier && o.planTier !== a.planTier)) && (!o.accountId || o.accountId === a.id) && Date.parse(o.lastSeen) >= start && Date.parse(o.firstSeen) < end);
  }
  const excess = estimateExcess([...accounts.values()], details, start, end);
  for (const p of people.values()) {
    const modeled = excess.accounts.filter(a => a.personId === p.id && a.estimatedExcessUsd != null);
    p.estimatedExcessUsd = modeled.length ? modeled.reduce((n, a) => n + a.estimatedExcessUsd, 0) : null;
  }
  const list = [...people.values()].sort((a, b) => (b.estimatedExcessUsd ?? -1) - (a.estimatedExcessUsd ?? -1));
  return { excess, from: new Date(start).toISOString(), to: new Date(end).toISOString(), people: list, accounts: [...accounts.values()], planObservations: [...observations.values()], billing: [...cycles.values()], quotaObservations: [...quotas.values()], details,
    totals: { people: list.length, tokens: list.reduce((n, p) => n + p.tokens, 0), estimatedUsd: list.reduce((n, p) => n + p.estimatedUsd, 0), reportedOverageUsd: list.some(p => p.reportedOverageUsd != null) ? list.reduce((n, p) => n + (p.reportedOverageUsd || 0), 0) : null },
    coverage: "Enrolled machines only. Billing totals cover the listed full cycles that overlap the date filter; estimates cover the selected timestamps. Unknown billing is not zero. Modeled allowances are prorated by the selected duration, not provider reset windows; unused allowance is not transferred across accounts." };
}

function centralDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}
function dueReport(now, sentDates = [], activatedOn) {
  const { date, hour } = centralDate(now);
  const latest = hour >= 10 ? date : new Date(Date.parse(date + "T12:00:00Z") - 86_400_000).toISOString().slice(0, 10);
  if (activatedOn && latest < activatedOn) return null;
  return sentDates.includes(latest) ? null : latest;
}
function renderReport(summary, date, dashboardUrl = "http://127.0.0.1:7682") {
  const money = n => n == null ? "unknown" : `$${n.toFixed(2)}`;
  const lines = [`AI usage report · ${date} · America/Chicago`, `Local team dashboard: ${dashboardUrl}`, `Enrolled people: ${summary.people.length}. ${summary.coverage}`, "", "Estimated excess above modeled plan allowance (not billed charges):"];
  for (const p of summary.people) {
    lines.push(`• ${p.name}: estimated excess ${money(p.estimatedExcessUsd)}; estimated API value ${money(p.estimatedUsd)}; ${p.tokens.toLocaleString("en-US")} tokens.`);
    if (p.unassignedTokens) lines.push(`  ${p.unassignedTokens.toLocaleString("en-US")} tokens lack account attribution.`);
    for (const m of p.machines) lines.push(`  ${m.name}: last collected ${m.collectedAt}${m.stale ? " (STALE)" : ""}.`);
    for (const a of summary.excess.accounts.filter(a => a.personId === p.id)) lines.push(`  ${a.provider} · ${a.email || a.id} · ${a.plan || "unknown"} ${a.planTier || ""}: excess ${money(a.estimatedExcessUsd)}, usage ${money(a.usageUsd)}, allowance ${money(a.includedUsd)}. ${a.assumption}. ${a.pricingAssumption}.`);
  }
  lines.push("", `Usage window: ${summary.from} to ${summary.to}. Billing: full cycles shown in dashboard. Unpriced models and missing accounts are not zero spend.`);
  return lines.join("\n");
}

module.exports = { TEAM_DIR, COUNTERS, PRICE_COUNTERS, save, ghApi, verifyRepository, uploadSnapshot, downloadSnapshots, discoverAccounts, collectSnapshot, loadSnapshots, aggregate, normalizeSnapshot, encodeSnapshot, decodeSnapshot, centralDate, dueReport, renderReport, planAllowance, estimateExcess, hash, runFile, getOrCreateMachineId, openLock };
