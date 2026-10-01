"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { attributeClaudeRows } = require("../src/lib/team-claude-attribution");
const { hash, COUNTERS } = require("../src/lib/team-store");
const { normalizeClaudeUsage } = require("../src/lib/rollout");

test("recover explicit workspace identity while conserving counts, rejecting conflicts and exporting no source content", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-attribution-"));
  const user = "11111111-1111-4111-8111-111111111111", work = "22222222-2222-4222-8222-222222222222", personal = "33333333-3333-4333-8333-333333333333";
  const session = "44444444-4444-4444-8444-444444444444", second = "55555555-5555-4555-8555-555555555555", unknown = "66666666-6666-4666-8666-666666666666";
  const roots = [path.join(home, ".claude")], project = path.join(roots[0], "projects", "test");
  const accounts = [work, personal].map(org => ({ provider: "anthropic", id: hash(`anthropic:${user}:${org}`) }));
  const write = async (p, data) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, data); };
  const usage = n => ({ input_tokens: n, output_tokens: n, cache_read_input_tokens: n, cache_creation_input_tokens: n, output_tokens_details: { thinking_tokens: n / 2 } });
  const event = (id, sid, n) => ({ type: "assistant", sessionId: sid, timestamp: "2026-09-20T10:05:00Z", message: { id, model: "claude-opus-5", usage: usage(n), content: "SECRET_PROMPT" } });
  const one = event("a", session, 10), two = event("b", second, 20), three = event("c", unknown, 30);
  const row = { source: "claude", model: "claude-opus-5", hour_start: "2026-09-20T10:00:00.000Z", ...normalizeClaudeUsage(usage(60)) };
  try {
    await write(path.join(home, "Library/Application Support/Claude/claude-code-sessions", user, personal, "local_example.json"), JSON.stringify({ cliSessionId: session, title: "SECRET_TITLE" }));
    await write(path.join(project, session + ".jsonl"), JSON.stringify(one));
    await write(path.join(project, second + ".jsonl"), [JSON.stringify(two), JSON.stringify({ type: "bridge-session", sessionId: second, ownerAccountUuid: user, ownerOrganizationUuid: work })].join("\n"));
    await write(path.join(project, unknown + ".jsonl"), JSON.stringify(three));
    await write(path.join(project, "mirror.jsonl"), JSON.stringify(one));
    const result = await attributeClaudeRows([row], accounts, { home, roots });
    assert.equal(result.rows.find(r => r.account_id === accounts[1].id).total_tokens, 40);
    assert.equal(result.rows.find(r => r.account_id === accounts[0].id).total_tokens, 80);
    assert.equal(result.rows.find(r => r.account_id === null).total_tokens, 120);
    for (const k of COUNTERS) assert.equal(result.rows.reduce((n, r) => n + r[k], 0), row[k]);
    assert.ok(!JSON.stringify(result).includes("SECRET")); assert.ok(!JSON.stringify(result).includes(home));
    const legacy = { ...row, output_tokens: row.output_tokens + row.reasoning_output_tokens, reasoning_output_tokens: 0 };
    const legacyResult = await attributeClaudeRows([legacy], accounts, { home, roots });
    assert.equal(legacyResult.rows.find(r => r.account_id === accounts[1].id).total_tokens, 40);
    for (const k of COUNTERS) assert.equal(legacyResult.rows.reduce((n, r) => n + r[k], 0), legacy[k]);
    const mismatch = { ...row, total_tokens: row.total_tokens + 1 };
    assert.deepEqual((await attributeClaudeRows([mismatch], accounts, { home, roots })).rows, [mismatch]);
    // Owner conflict invalidates both plausible assignments rather than picking one.
    await fs.appendFile(path.join(project, session + ".jsonl"), "\n" + JSON.stringify({ type: "bridge-session", sessionId: session, ownerAccountUuid: user, ownerOrganizationUuid: work }));
    const conflict = await attributeClaudeRows([row], accounts, { home, roots });
    assert.equal(conflict.rows.find(r => r.account_id === null).total_tokens, 160);
    const explicit = { ...row, account_id: accounts[0].id };
    assert.deepEqual((await attributeClaudeRows([explicit], accounts, { home, roots })).rows, [explicit]);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
