"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { discoverInventory, profileRoots } = require("../src/lib/team-account-inventory");
const { aggregate, encodeSnapshot, decodeSnapshot } = require("../src/lib/team-store");

test("discover workspaces, alternate roots and historical plans without exporting source content or guessing attribution", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "plan-inventory-"));
  const now = "2026-09-30T20:00:00Z";
  const user = "11111111-1111-4111-8111-111111111111", work = "22222222-2222-4222-8222-222222222222", personal = "33333333-3333-4333-8333-333333333333";
  const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value)); };
  try {
    await write(path.join(home, ".claude.json"), { oauthAccount: { accountUuid: user, organizationUuid: work, emailAddress: "employee@example.test", subscriptionType: "team" } });
    await write(path.join(home, ".claude-personal", ".claude.json"), { oauthAccount: { accountUuid: user, organizationUuid: personal, emailAddress: "employee@example.test", subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } });
    await fs.mkdir(path.join(home, "Library/Application Support/Claude/claude-code-sessions", user, personal), { recursive: true });
    await write(path.join(home, ".claude-personal", "projects", "x", "session.jsonl"), 'PRIVATE_PROMPT');
    const custom = path.join(home, "custom-codex");
    const claims = { email: "personal@example.test", "https://api.openai.com/auth": { chatgpt_account_id: "personal-openai", chatgpt_plan_type: "plus" } };
    await write(path.join(custom, "auth.json"), { tokens: { id_token: "header." + Buffer.from(JSON.stringify(claims)).toString("base64url") + ".SECRET", refresh_token: "SECRET" } });
    const events = [
      { type: "event_msg", timestamp: "2026-09-15T10:00:00Z", payload: { type: "token_count", rate_limits: { plan_type: "pro" } } },
      { type: "event_msg", timestamp: "2026-09-16T10:00:00Z", payload: { type: "token_count", rate_limits: { plan_type: "plus" } } },
      { type: "event_msg", timestamp: now, payload: { type: "user_message", plan_type: "FAKE_PROMPT_PLAN", message: "PRIVATE_PROMPT" } },
    ];
    await write(path.join(custom, "archived_sessions", "rollout-test.jsonl"), events.map(e => JSON.stringify(e)).join("\n"));
    const options = { home, env: { CODEX_HOME: custom }, now, subscriptionDetails: { planType: "team", rateLimitTier: "default_claude_max_5x" } };
    const found = await discoverInventory(options);
    assert.equal(found.accounts.length, 3);
    const claude = found.accounts.filter(a => a.provider === "anthropic");
    assert.equal(new Set(claude.map(a => a.id)).size, 2);
    assert.equal(new Set(claude.map(a => a.identityId)).size, 1);
    assert.equal(claude.find(a => a.plan === "max").planTier, "default_claude_max_20x");
    assert.ok(found.planObservations.some(o => o.plan === "pro" && o.accountId === null));
    assert.ok(!(JSON.stringify(found.planObservations).includes("FAKE_PROMPT_PLAN")));
    const roots = await profileRoots(home, options.env);
    assert.ok(roots.codex.includes(await fs.realpath(custom))); assert.ok(roots.claude.includes(await fs.realpath(path.join(home, ".claude-personal"))));
    const snapshot = { version: 1, personId: "employee", personName: "Employee", machineId: "mac", machineName: "Mac", collectedAt: now, accounts: found.accounts, planObservations: found.planObservations, rows: [
      { source: "claude", model: "test", hour_start: "2026-09-20T10:00:00Z", total_tokens: 100, estimatedUsd: 100 },
      { source: "codex", model: "test", hour_start: "2026-09-20T10:00:00Z", total_tokens: 200, estimatedUsd: 200 },
    ] };
    const transported = decodeSnapshot(encodeSnapshot(snapshot));
    assert.ok(!JSON.stringify(transported).includes("SECRET")); assert.ok(!JSON.stringify(transported).includes("PRIVATE_PROMPT")); assert.ok(!JSON.stringify(transported).includes(home));
    const report = aggregate([transported], { from: "2026-09-01", to: "2026-10-01" });
    assert.equal(report.totals.tokens, 300); assert.equal(report.excess.unallocatedTokens, 100);
    assert.equal(report.excess.accounts.find(a => a.provider === "openai").planAmbiguous, true);
    assert.equal(report.excess.estimatedExcessUsd, null);
    await fs.unlink(path.join(custom, "auth.json"));
    const again = await discoverInventory({ ...options, previous: transported });
    assert.equal(again.accounts.length, 3); assert.equal(again.accounts.find(a => a.provider === "openai").status, "historical");
    assert.ok(again.planObservations.some(o => o.plan === "pro"));
    const repeat = await discoverInventory({ ...options, previous: again });
    assert.equal(repeat.accounts.length, again.accounts.length); assert.equal(repeat.planObservations.length, again.planObservations.length);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});

test("existing Codex metadata scan backfills sparse quota history without assigning today's account or inventing charges", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "quota-backfill-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dir = path.join(home, ".codex");
  await fs.mkdir(path.join(dir, "sessions"), { recursive: true });
  await fs.mkdir(path.join(dir, "archived_sessions"));
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "current-account", chatgpt_plan_type: "pro" } };
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.SECRET` } }));
  const event = (timestamp, used_percent, resets_at = 1791384102) => ({ type: "event_msg", timestamp,
    payload: { type: "token_count", rate_limits: { plan_type: "self_serve_business_prolite",
      primary: { used_percent, window_minutes: 10080, resets_at, arbitrary: "PRIVATE" }, secondary: null,
      credits: { has_credits: true, balance: "62500", unlimited: false }, account_id: "unverified-account", prompt: "PRIVATE" } } });
  const events = [event("2026-09-30T15:00:00Z", 40), event("2026-09-30T15:05:00Z", 40),
    event("2026-09-30T15:10:00Z", 40), event("2026-09-30T16:00:00Z", 1, 1791480582),
    event("2025-09-30T15:00:00Z", 80), event("bad", 99),
    { type: "event_msg", timestamp: "2026-09-30T15:00:00Z", payload: { type: "user_message", rate_limits: { plan_type: "PRIVATE" } } }];
  const log = events.map(e => JSON.stringify(e)).join("\n");
  // Mirrored rollout metadata must not duplicate quota history.
  await fs.writeFile(path.join(dir, "sessions", "rollout-test.jsonl"), log);
  await fs.writeFile(path.join(dir, "archived_sessions", "rollout-copy.jsonl"), log);
  const found = await discoverInventory({ home, env: {}, now: "2026-10-01T15:00:00Z", subscriptionDetails: null });
  assert.equal(found.accounts.length, 1);
  assert.equal(found.quotaObservations.length, 3); // first/last unchanged read, then observed drop
  assert.deepEqual(found.quotaObservations.map(o => o.windows[0].usedPercent), [40, 40, 1]);
  assert.equal(found.quotaObservations[0].windows[0].windowSeconds, 604800);
  assert.equal(found.quotaObservations[0].observedAt, "2026-09-30T15:00:00.000Z");
  for (const observation of found.quotaObservations) {
    assert.equal(observation.source, "retained-log");
    assert.equal(observation.accountId, null);
    assert.equal(observation.creditWindow, null);
    assert.equal(observation.resetCredits, null);
    assert.deepEqual(observation.monetary, []);
  }
  const snapshot = decodeSnapshot(encodeSnapshot({ version: 1, personId: "person", personName: "Person", machineId: "mac",
    machineName: "Mac", collectedAt: "2026-10-01T15:00:00Z", accounts: found.accounts, rows: [],
    quotaObservations: found.quotaObservations, quotaFindings: found.quotaFindings }));
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|SECRET|unverified-account|62500/);
  const report = aggregate([snapshot], { from: "2026-09-01", to: "2026-10-02" });
  assert.equal(report.quotaObservations.length, 3);
  assert.equal(report.totals.reportedOverageUsd, null);
  assert.match(report.people[0].findings.join(" "), /quota drops do not prove a manual or paid reset/);
  assert.doesNotMatch(report.people[0].findings.join(" "), /backfill is unavailable/);
});
