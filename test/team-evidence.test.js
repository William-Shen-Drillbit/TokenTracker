"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const team = require("../src/lib/team-store");
const { computeRowCost } = require("../src/lib/pricing");
const { serveTeam } = require("../src/commands/team");

test("team transport preserves reproducible premium pricing and quota evidence without adding tokens or charges", () => {
  const row = { source: "codex", model: "gpt-6-astra", hour_start: "2026-09-30T16:00:00Z", input_tokens: 400000,
    cached_input_tokens: 50000, output_tokens: 5000, reasoning_output_tokens: 1000, total_tokens: 455000,
    long_context_input_tokens: 300000, long_context_cached_input_tokens: 30000, long_context_output_tokens: 2000,
    priority_input_tokens: 350000, priority_output_tokens: 4000,
    priority_long_context_input_tokens: 250000, priority_long_context_output_tokens: 1000,
    priceRates: { input: 10, cache_read: 1, cache_write: 12.5, output: 50, priority_multiplier: 2, secret: "PRIVATE" } };
  row.estimatedUsd = computeRowCost(row);
  const q = { provider: "openai", accountId: "a".repeat(24), observedAt: "2026-09-30T16:00:00Z", source: "provider-api",
    windows: [{ kind: "primary_window", usedPercent: 90, resetAt: "2026-09-30T17:00:00Z", windowSeconds: 18000 }],
    resetCredits: { availableCount: 3 }, secret: "PRIVATE" };
  const raw = { version: 1, personId: "person", personName: "Person", machineId: "machine", machineName: "Machine",
    collectedAt: "2026-09-30T17:00:00Z", accounts: [], rows: [row], quotaObservations: [q, q, { provider: "invalid" }] };
  const decoded = team.decodeSnapshot(team.encodeSnapshot(raw));
  assert.equal(computeRowCost(decoded.rows[0]), row.estimatedUsd);
  assert.equal(decoded.rows[0].total_tokens, 455000);
  assert.equal(decoded.quotaObservations.length, 1);
  assert.equal(JSON.stringify(decoded).includes("PRIVATE"), false);
  const out = team.aggregate([decoded], { from: "2026-09-30", to: "2026-10-01" });
  assert.equal(out.quotaObservations.length, 1);
  assert.equal(out.totals.tokens, 455000);
  assert.equal(out.totals.reportedOverageUsd, null);
  assert.match(out.people[0].findings.join(" "), /quota observations were invalid and omitted/);
  raw.rows[0].priority_input_tokens = 400001;
  assert.throws(() => team.normalizeSnapshot(raw), /subset exceeds/);
});

test("existing routine-mode service samples quota without uploading or generating a report", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "team-quota-service-"));
  let service, calls = 0;
  try {
    await team.save(path.join(dir, "config.json"), { backend: "registry", collectionMode: "routine", personId: "test", machineId: "test", port: 0 });
    service = await serveTeam(dir, { worker: false, sampleQuota: async ({ dir: target }) => { assert.equal(target, dir); calls++; } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    await service.tick();
    assert.equal(calls, 1);
    await service.tick(Date.now() + 5 * 60_000 + 1000);
    assert.equal(calls, 2);
    for (const name of ["snapshot.json", "status.json", "reports"]) assert.equal(await fs.stat(path.join(dir, name)).catch(() => null), null);
  } finally { service?.stop(); await fs.rm(dir, { recursive: true, force: true }); }
});


test("team transport preserves authoritative source costs without treating them as billed overages", () => {
  const raw = { version: 1, personId: "person", personName: "Person", machineId: "machine", machineName: "Machine",
    collectedAt: "2026-09-30T17:00:00Z", accounts: [], rows: ["grok", "cline"].map(source => ({ source,
      model: "unlisted-model", hour_start: "2026-09-30T16:00:00Z", input_tokens: 100,
      total_tokens: 100, total_cost_usd: 1.23, estimatedUsd: 1.23 })) };
  const decoded = team.decodeSnapshot(team.encodeSnapshot(raw));
  for (const row of decoded.rows) assert.equal(computeRowCost(row), row.estimatedUsd);
  assert.equal(team.aggregate([decoded], { from: "2026-09-30", to: "2026-10-01" }).totals.reportedOverageUsd, null);
  raw.rows[0].total_cost_usd = -1;
  assert.throws(() => team.normalizeSnapshot(raw), /Invalid usage amount/);
  raw.rows[0].source = "codex";
  assert.equal(team.normalizeSnapshot(raw).rows[0].total_cost_usd, undefined);
});
