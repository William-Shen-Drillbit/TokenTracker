"use strict";
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const readline = require("node:readline");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { listClaudeProjectFiles, normalizeClaudeUsage, claudeMessageDedupKey, normalizeModelInput, toUtcHalfHourStart } = require("./rollout");
const COUNTERS = ["input_tokens", "cached_input_tokens", "cache_creation_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const hash = v => crypto.createHash("sha256").update(v).digest("hex").slice(0, 24);
const zero = () => Object.fromEntries(COUNTERS.map(k => [k, 0]));
const add = (a, b) => { for (const k of COUNTERS) a[k] += b[k] || 0; };

// Reconstruct identity only. Queue counts remain authoritative: a bucket must
// reconcile exactly before it can be split. Never infer a workspace from dates,
// cwd, the current login, or text in a conversation.
async function attributeClaudeRows(rows, accounts, { home = os.homedir(), roots } = {}) {
  if (!rows.some(r => r.source === "claude" && !r.account_id && r.total_tokens)) return { rows, findings: [] };
  const findings = new Set(), owners = new Map(), messages = new Map();
  const accountIds = new Set(accounts.filter(a => a.provider === "anthropic").map(a => a.id));
  const ownerId = (user, org) => UUID.test(user || "") && UUID.test(org || "") ? hash(`anthropic:${user}:${org}`) : null;
  const link = (session, id) => {
    if (!UUID.test(session || "") || !id) return;
    if (!owners.has(session)) owners.set(session, new Set());
    owners.get(session).add(id);
  };
  const entries = async p => {
    try { return await fs.readdir(p, { withFileTypes: true }); }
    catch (e) { if (e.code !== "ENOENT") findings.add("Some session ownership metadata could not be read; attribution is partial."); return []; }
  };
  const desktop = path.join(home, "Library/Application Support/Claude");
  for (const product of ["claude-code-sessions", "local-agent-mode-sessions"]) {
    for (const user of await entries(path.join(desktop, product))) {
      if (!user.isDirectory() || !UUID.test(user.name)) continue;
      for (const org of await entries(path.join(desktop, product, user.name))) {
        if (!org.isDirectory() || !UUID.test(org.name)) continue;
        const dir = path.join(desktop, product, user.name, org.name);
        for (const file of await entries(dir)) {
          if (!file.isFile() || !/^local_.*\.json$/.test(file.name)) continue;
          try {
            const data = JSON.parse(await fs.readFile(path.join(dir, file.name), "utf8"));
            link(data.cliSessionId, ownerId(user.name, org.name));
          } catch { findings.add("Some session ownership metadata could not be read; attribution is partial."); }
        }
      }
    }
  }
  const wanted = new Set(rows.filter(r => r.source === "claude" && !r.account_id).map(r => `${r.hour_start}|${r.model}`));
  const files = new Set();
  for (const root of roots || (await require("./team-account-inventory").profileRoots(home)).claude) {
    for (const file of await listClaudeProjectFiles(path.join(root, "projects"))) files.add(file);
  }
  // ponytail: full metadata scan during explicit collection; add a size/mtime
  // cache only if measured collection latency requires it.
  for (const file of [...files].sort((a, b) => a.localeCompare(b))) {
    const parent = path.basename(path.dirname(file)) === "subagents" ? path.basename(path.dirname(path.dirname(file))) : null;
    const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.includes('"usage"') && !line.includes('"bridge-session"')) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (event.type === "bridge-session") link(event.sessionId, ownerId(event.ownerAccountUuid, event.ownerOrganizationUuid));
        const usage = event.message?.usage || event.usage;
        if (!usage || typeof usage !== "object") continue;
        const hour = toUtcHalfHourStart(event.timestamp), model = normalizeModelInput(event.message?.model || event.model) || "unknown";
        const bucket = `${hour}|${model}`;
        if (!hour || !wanted.has(bucket)) continue;
        const totals = normalizeClaudeUsage(usage);
        if (!totals.total_tokens) continue;
        // The production parser's message identity and first-observation count
        // rule apply across mirrored files. Conflicting identity stays unknown.
        const key = claudeMessageDedupKey(event) || `${file}:${messages.size}`;
        const old = messages.get(key);
        const sessions = [event.sessionId, parent].filter(s => UUID.test(s || ""));
        if (old) {
          sessions.forEach(s => old.sessions.add(s));
          if (old.bucket !== bucket || COUNTERS.some(k => old.totals[k] !== totals[k])) old.conflict = true;
        } else messages.set(key, { bucket, totals, sessions: new Set(sessions) });
      }
    } catch { findings.add("Some original usage logs could not be read; unmatched buckets remain unallocated."); }
    finally { lines.close(); }
  }
  const buckets = new Map();
  for (const event of messages.values()) {
    const candidates = new Set([...event.sessions].flatMap(s => [...(owners.get(s) || [])]));
    const id = !event.conflict && candidates.size === 1 && accountIds.has([...candidates][0]) ? [...candidates][0] : null;
    if (!buckets.has(event.bucket)) buckets.set(event.bucket, new Map());
    const groups = buckets.get(event.bucket);
    if (!groups.has(id)) groups.set(id, zero());
    add(groups.get(id), event.totals);
  }
  let attributed = 0, mismatches = 0;
  const result = rows.flatMap(row => {
    if (row.source !== "claude" || row.account_id || !row.total_tokens) return [row];
    const groups = buckets.get(`${row.hour_start}|${row.model}`);
    if (!groups) return [row];
    const sum = zero(); for (const value of groups.values()) add(sum, value);
    // Older queues kept thinking inside output. Preserve that representation
    // exactly instead of treating the later parser's split as extra tokens.
    if (!row.reasoning_output_tokens && row.output_tokens === sum.output_tokens + sum.reasoning_output_tokens) {
      for (const value of groups.values()) { value.output_tokens += value.reasoning_output_tokens; value.reasoning_output_tokens = 0; }
      sum.output_tokens += sum.reasoning_output_tokens; sum.reasoning_output_tokens = 0;
    }
    if (COUNTERS.some(k => sum[k] !== (row[k] || 0))) { mismatches++; return [row]; }
    return [...groups].map(([account_id, totals]) => {
      if (account_id) attributed += totals.total_tokens;
      return { ...row, ...totals, account_id };
    });
  });
  findings.add(`Claude workspace attribution recovered ${attributed} tokens from explicit session ownership; unmatched usage remains unallocated.`);
  if (mismatches) findings.add(`${mismatches} Claude buckets did not exactly reconcile to retained logs; their counts were preserved without guessing account attribution.`);
  return { rows: result, findings: [...findings] };
}
module.exports = { attributeClaudeRows };
