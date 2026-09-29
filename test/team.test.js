"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const t = require("../src/lib/team-store");
const { localRequest, prepareReport } = require("../src/commands/team");
const fixture = () => ({ version: 1, personId: "alice", personName: "Alice", machineId: "laptop1", machineName: "Laptop", collectedAt: "2026-09-28T15:00:00Z", pricingRevision: "test", accounts: [{ id: "a1", provider: "anthropic", email: "a@example.test", plan: "max", ownership: "personal", observedAt: "2026-09-28T15:00:00Z" }], billing: [], findings: [], rows: [{ source: "claude", model: "test", hour_start: "2026-09-27T12:00:00Z", input_tokens: 20, output_tokens: 10, total_tokens: 30, estimatedUsd: 1.5 }] });

test("transport allowlist drops secrets and rejects invalid amounts and compression bombs", () => {
  const s = fixture(); s.access_token = "SECRET"; s.rows[0].prompt = "PRIVATE"; s.accounts[0].refresh_token = "SECRET";
  const decoded = t.decodeSnapshot(t.encodeSnapshot(s));
  assert.equal(JSON.stringify(decoded).includes("SECRET"), false); assert.equal(JSON.stringify(decoded).includes("PRIVATE"), false);
  s.rows[0].input_tokens = -1; assert.throws(() => t.encodeSnapshot(s), /amount/);
  assert.throws(() => t.decodeSnapshot(Buffer.alloc(900001)), /Oversized/);
});

test("billing stays unknown, unassigned accounts stay explicit, snapshots aggregate across people", () => {
  const a = fixture(), b = fixture(); b.personId = "bob"; b.personName = "Bob";
  const out = t.aggregate([a, b], { from: "2026-09-27", to: "2026-09-28", now: Date.parse("2026-09-30") });
  assert.equal(out.totals.tokens, 60); assert.equal(out.totals.estimatedUsd, 3); assert.equal(out.totals.reportedOverageUsd, null);
  assert.equal(out.people[0].unassignedTokens, 30); assert.equal(out.people[0].machines[0].stale, true);
  a.rows[0].estimatedUsd = null;
  assert.equal(t.aggregate([a], { from: "2026-09-27", to: "2026-09-28" }).people[0].unpricedTokens, 30);
});

test("same account billing cycle observed on two machines is counted once, using newest evidence", () => {
  const a = fixture(); a.billing = [{ accountId: "a1", periodStart: "2026-09-01", periodEnd: "2026-10-01", currency: "USD", observedAt: "2026-09-27", overageUsd: 5, source: "Provider billing", basis: "provider-reported" }];
  const b = structuredClone(a); b.machineId = "laptop2"; b.billing[0].observedAt = "2026-09-28"; b.billing[0].overageUsd = 7;
  const out = t.aggregate([a, b], { from: "2026-09-27", to: "2026-09-28" });
  assert.equal(out.totals.reportedOverageUsd, 7); assert.equal(out.billing.length, 1);
});

test("upload retries are idempotent after a lost response; public repositories refuse before writing", async () => {
  let stored, writes = 0;
  const api = async (endpoint, body) => {
    if (endpoint === "repos/o/r") return { private: true, permissions: { push: true } };
    if (body) { stored = { sha: "sha", content: body.content }; writes++; throw new Error("connection lost after commit"); }
    if (stored) return stored; throw Object.assign(new Error("missing"), { status: 404 });
  };
  await assert.rejects(t.uploadSnapshot("o/r", fixture(), api), /connection lost/);
  assert.deepEqual(await t.uploadSnapshot("o/r", fixture(), api), { unchanged: true }); assert.equal(writes, 1);
  await assert.rejects(t.uploadSnapshot("o/r", fixture(), async () => ({ private: false })), /must be private/);
});

test("download retains usable cache on network failure and verifies payload identity", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "team-test-"));
  try {
    const s = fixture(), name = "snapshots/alice/laptop1.json.gz";
    const api = async e => {
      if (e === "repos/o/r") return { private: true, permissions: { push: true }, default_branch: "main" };
      if (e.includes("/trees/")) return { tree: [{ type: "blob", path: name, sha: "1", size: 500 }] };
      return { encoding: "base64", content: t.encodeSnapshot(s).toString("base64") };
    };
    await t.downloadSnapshots("o/r", dir, api); assert.equal((await t.loadSnapshots(dir)).length, 1);
    await assert.rejects(t.downloadSnapshots("o/r", dir, async () => { throw new Error("offline"); }), /offline/);
    assert.equal((await t.loadSnapshots(dir))[0].personName, "Alice");
    s.personId = "mallory";
    await fs.unlink(path.join(dir, "remote-index.json"));
    await assert.rejects(t.downloadSnapshots("o/r", dir, api), /identity/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("10am Central follows DST and catches up the previous report after an overnight outage", () => {
  assert.equal(t.dueReport(new Date("2026-09-28T14:59:00Z"), [], "2026-09-28"), null);
  assert.equal(t.dueReport(new Date("2026-09-28T15:00:00Z"), [], "2026-09-28"), "2026-09-28");
  assert.equal(t.dueReport(new Date("2026-12-01T15:59:00Z"), [], "2026-12-01"), null);
  assert.equal(t.dueReport(new Date("2026-12-01T16:00:00Z"), [], "2026-12-01"), "2026-12-01");
  assert.equal(t.dueReport(new Date("2026-09-29T13:00:00Z"), [], "2026-09-28"), "2026-09-28");
  assert.equal(t.dueReport(new Date("2026-09-29T13:00:00Z"), ["2026-09-28"], "2026-09-28"), null);
});

test("pending report is durable and is not regenerated or recreated after delivery", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "team-report-"));
  try {
    await t.save(path.join(dir, "config.json"), { reportOwner: true, activatedOn: "2026-09-28", port: 7682 });
    await t.save(path.join(dir, "snapshot.json"), fixture());
    const file = await prepareReport(dir, new Date("2026-09-28T15:00:00Z")); const first = await fs.readFile(file, "utf8");
    await prepareReport(dir, new Date("2026-09-28T16:00:00Z")); assert.equal(await fs.readFile(file, "utf8"), first);
    await t.save(path.join(dir, "sent.json"), { "2026-09-28": { messageUrl: "https://example.slack.com/archives/C1/p1" } });
    assert.equal(await prepareReport(dir, new Date("2026-09-28T17:00:00Z")), null);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("local dashboard rejects DNS rebinding, cross-site requests, and writes", () => {
  assert.equal(localRequest({ method: "GET", headers: { host: "127.0.0.1:7682" } }, 7682), true);
  assert.equal(localRequest({ method: "GET", headers: { host: "attacker.test:7682" } }, 7682), false);
  assert.equal(localRequest({ method: "GET", headers: { host: "localhost:7682", origin: "https://attacker.test" } }, 7682), false);
  assert.equal(localRequest({ method: "POST", headers: { host: "localhost:7682" } }, 7682), false);
});

test("estimated excess deducts a prorated allowance once per account across machines, without pooling", () => {
  const a = fixture(); a.accounts[0].allowanceWeeklyUsd = 100; a.rows[0].estimatedUsd = 130;
  const b = structuredClone(a); b.machineId = "laptop2"; b.rows[0].estimatedUsd = 20;
  const c = fixture(); c.personId = "bob"; c.accounts[0].allowanceWeeklyUsd = 100; c.rows[0].estimatedUsd = 10;
  const out = t.aggregate([a, b, c], { from: "2026-09-21", to: "2026-09-28" });
  assert.equal(out.excess.estimatedExcessUsd, 50);
  assert.equal(out.excess.accounts[0].includedUsd, 100);
  assert.equal(out.excess.accounts[0].assumedTokens, 60);
  assert.equal(out.people[0].estimatedExcessUsd, 50);
  const half = t.aggregate([a], { from: "2026-09-24T12:00:00Z", to: "2026-09-28" });
  assert.equal(half.excess.accounts[0].includedUsd, 50); assert.equal(half.excess.estimatedExcessUsd, 80);
});

test("excess model preserves unknown pricing, unsupported plans, and ambiguous account attribution", () => {
  const a = fixture(); a.accounts[0].planTier = "default_claude_max_5x"; a.rows[0].estimatedUsd = 600;
  let out = t.aggregate([a], { from: "2026-09-21", to: "2026-09-28" });
  assert.equal(out.excess.estimatedExcessUsd, 100); assert.equal(out.excess.excessLowUsd, 0); assert.equal(out.excess.excessHighUsd, 200);
  a.rows[0].estimatedUsd = null;
  assert.equal(t.aggregate([a], { from: "2026-09-21", to: "2026-09-28" }).excess.estimatedExcessUsd, null);
  a.rows[0].estimatedUsd = 600; a.accounts.push({ ...a.accounts[0], id: "a2" });
  out = t.aggregate([a], { from: "2026-09-21", to: "2026-09-28" });
  assert.equal(out.excess.estimatedExcessUsd, null); assert.equal(out.excess.unallocatedUsd, 600);
  a.rows[0].accountId = "a1";
  assert.equal(t.aggregate([a], { from: "2026-09-21", to: "2026-09-28" }).excess.estimatedExcessUsd, 100);
  assert.equal(t.planAllowance({ provider: "unknown", plan: "pro" }), null);
  assert.equal(t.planAllowance({ allowanceWeeklyUsd: 0 }).weeklyUsd, 0);
});


test("unknown model usage uses an explicit blended-rate estimate only when priced usage exists", () => {
  const a = fixture(); a.accounts[0].allowanceWeeklyUsd = 100; a.rows[0].estimatedUsd = 150;
  a.rows.push({ ...a.rows[0], estimatedUsd: null, total_tokens: 10 });
  const out = t.aggregate([a], { from: "2026-09-21", to: "2026-09-28" });
  assert.equal(out.excess.accounts[0].priceProxyUsd, 50);
  assert.equal(out.excess.accounts[0].usageUsd, 200);
  assert.equal(out.excess.estimatedExcessUsd, 100);
  assert.match(out.excess.accounts[0].pricingAssumption, /blended/);
});
