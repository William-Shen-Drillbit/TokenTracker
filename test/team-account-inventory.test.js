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
