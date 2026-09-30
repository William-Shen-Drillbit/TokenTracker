"use strict";
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const readline = require("node:readline");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { readJsonStrict } = require("./fs");
const hash = value => crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
const clean = value => typeof value === "string" && value.trim() && value.length <= 160 && !/[\x00-\x1f]/.test(value) ? value.trim() : null;
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
async function entries(dir, findings) {
  try { return await fs.readdir(dir, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== "ENOENT" && findings) findings.add("Some local account sources could not be read; account coverage is incomplete.");
    return [];
  }
}
// Share these native roots between identity discovery and log collection.
async function profileRoots(home = os.homedir(), env = process.env) {
  const roots = { claude: [path.join(home, ".claude")], codex: [path.join(home, ".codex")] };
  for (const entry of await entries(home)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    for (const provider of Object.keys(roots)) if (new RegExp(`^\\.${provider}(?:$|[-_])`).test(entry.name)) roots[provider].push(path.join(home, entry.name));
  }
  if (env.CLAUDE_CONFIG_DIR) roots.claude.push(path.resolve(env.CLAUDE_CONFIG_DIR));
  if (env.CODEX_HOME) roots.codex.push(path.resolve(env.CODEX_HOME));
  for (const provider of Object.keys(roots)) roots[provider] = [...new Set(await Promise.all(roots[provider].map(p => fs.realpath(p).catch(() => p))))];
  return roots;
}
async function discoverInventory({ home = os.homedir(), env = process.env, now = new Date().toISOString(), previous = {}, subscriptionDetails } = {}) {
  const findings = new Set(), accounts = new Map(), observations = new Map();
  const roots = await profileRoots(home, env);
  const metadata = async file => {
    const result = await readJsonStrict(file);
    if (!["ok", "missing"].includes(result.status)) findings.add("Some local account metadata is unreadable or invalid; account coverage is incomplete.");
    return result.value;
  };
  const observe = ({ provider, plan, planTier, accountId = null, at = now, evidence }) => {
    plan = clean(plan); planTier = clean(planTier);
    if ((!plan && !planTier) || !Number.isFinite(Date.parse(at))) return;
    const key = [provider, accountId, plan, planTier, evidence].join("|");
    const old = observations.get(key);
    observations.set(key, { provider, accountId, plan, planTier, evidence, firstSeen: old && old.firstSeen < at ? old.firstSeen : at, lastSeen: old && old.lastSeen > at ? old.lastSeen : at });
  };
  const add = ({ provider, identity, organization, email, plan, planTier, at = now, evidence, status = "observed" }) => {
    identity = clean(identity) || clean(email); organization = clean(organization);
    if (!identity) return null;
    const identityId = hash(`${provider}:${identity}`);
    const id = organization ? hash(`${provider}:${identity}:${organization}`) : identityId;
    const old = accounts.get(id);
    const account = { id, identityId, organizationId: organization ? hash(`${provider}:${organization}`) : null, provider,
      email: clean(email) || old?.email || null, plan: clean(plan) || old?.plan || null, planTier: clean(planTier) || old?.planTier || null,
      ownership: old?.ownership || "unknown", observedAt: at, evidence, status };
    // Directory presence cannot replace a current sign-in observation.
    accounts.set(id, old?.status === "current" && status !== "current" ? old : account);
    observe({ provider, accountId: id, plan, planTier, at, evidence });
    return id;
  };
  const claudeMetadata = async (file, status) => {
    const a = (await metadata(file))?.oauthAccount;
    if (!a) return null;
    const at = status === "current" ? now : (await fs.stat(file)).mtime.toISOString();
    const id = add({ provider: "anthropic", identity: a.accountUuid, organization: a.organizationUuid, email: a.emailAddress,
      plan: a.subscriptionType, planTier: a.rateLimitTier, at, evidence: status === "current" ? "claude-profile" : "claude-profile-backup", status });
    return { ...a, id };
  };
  for (const root of roots.claude) {
    const metadata = [path.join(root, ".claude.json")];
    if (root === path.join(home, ".claude")) metadata.push(path.join(home, ".claude.json"));
    for (const file of metadata) await claudeMetadata(file, "current");
    for (const entry of await entries(path.join(root, "backups"), findings)) {
      if (entry.isFile() && /^\.claude\.json\.backup(?:\.|$)/.test(entry.name)) await claudeMetadata(path.join(root, "backups", entry.name), "historical");
    }
  }
  await claudeMetadata(path.join(home, ".claude.json.backup"), "historical");
  const currentClaude = await claudeMetadata(path.join(home, ".claude.json"), "current");
  const details = subscriptionDetails === undefined ? require("./subscriptions").detectClaudeCodeSubscriptionDetails({ home, env }) : subscriptionDetails;
  if (currentClaude?.id && details) {
    const a = accounts.get(currentClaude.id);
    a.plan = clean(details.planType) || a.plan; a.planTier = clean(details.rateLimitTier) || a.planTier;
    observe({ provider: "anthropic", accountId: a.id, plan: a.plan, planTier: a.planTier, evidence: "claude-subscription-metadata" });
  }
  // Desktop retains account/workspace identity outside the active CLI profile.
  // Directory names suffice; conversation contents are never read here.
  const desktop = path.join(home, "Library", "Application Support", "Claude");
  for (const product of ["claude-code-sessions", "local-agent-mode-sessions"]) {
    for (const user of await entries(path.join(desktop, product), findings)) {
      if (!user.isDirectory() || !UUID.test(user.name)) continue;
      for (const org of await entries(path.join(desktop, product, user.name), findings)) {
        if (!org.isDirectory() || !UUID.test(org.name)) continue;
        const at = (await fs.stat(path.join(desktop, product, user.name, org.name))).mtime.toISOString();
        add({ provider: "anthropic", identity: user.name, organization: org.name, email: user.name === currentClaude?.accountUuid ? currentClaude.emailAddress : null,
          at, evidence: "claude-desktop-workspace", status: "observed" });
      }
    }
  }
  for (const root of roots.codex) {
    const auth = await metadata(path.join(root, "auth.json"));
    try {
      const claims = JSON.parse(Buffer.from(auth.tokens.id_token.split(".")[1], "base64url").toString("utf8"));
      const ns = claims["https://api.openai.com/auth"] || {};
      add({ provider: "openai", identity: auth.tokens.account_id || ns.chatgpt_account_id, email: claims.email, plan: ns.chatgpt_plan_type, evidence: "codex-profile", status: "current" });
    } catch { if (auth?.tokens) findings.add("A retained Codex profile has no readable account identity; its plan is unknown."); }
    const { listRolloutFilesDeep } = require("./rollout");
    for (const folder of ["sessions", "archived_sessions"]) {
      for (const file of await listRolloutFilesDeep(path.join(root, folder))) {
        const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (!line.includes('"plan_type"')) continue;
            let event; try { event = JSON.parse(line); } catch { continue; }
            if (event.type !== "event_msg" || event.payload?.type !== "token_count") continue;
            const plan = clean(event.payload.rate_limits?.plan_type);
            if (plan) observe({ provider: "openai", plan, at: event.timestamp, evidence: "codex-usage-metadata" });
          }
        } catch { findings.add("Some retained Codex plan history could not be read; coverage is incomplete."); }
        finally { lines.close(); }
      }
    }
  }
  // A later sign-out must not erase previously discovered subscriptions.
  for (const a of previous.accounts || []) {
    observe({ provider: a.provider, plan: a.plan, planTier: a.planTier, accountId: accounts.has(a.id) ? a.id : null, at: a.observedAt, evidence: "previous-snapshot" });
    if (accounts.has(a.id)) {
      const current = accounts.get(a.id);
      current.ownership = a.ownership || current.ownership;
      current.allowanceWeeklyUsd = a.allowanceWeeklyUsd ?? current.allowanceWeeklyUsd;
      continue;
    }
    const matches = [...accounts.values()].filter(x => x.identityId === a.id);
    if (matches.length) continue;
    accounts.set(a.id, { ...a, status: "historical", evidence: "previous-snapshot" });
  }
  for (const o of previous.planObservations || []) { observe({ ...o, at: o.firstSeen }); observe({ ...o, at: o.lastSeen }); }
  const knownPlans = new Set([...accounts.values()].map(a => `${a.provider}:${a.plan}`));
  if ([...observations.values()].some(o => !o.accountId && !knownPlans.has(`${o.provider}:${o.plan}`))) findings.add("Additional historical plans were observed without account identity; the current plan cannot represent all historical usage.");
  if ([...accounts.values()].some(a => !a.plan)) findings.add("Additional workspaces were discovered but their subscription plans are unknown. They are included in the inventory, not treated as free or zero usage.");
  findings.add("Discovery covers retained supported profiles, Claude Desktop workspaces, profile backups and Codex plan history. Deleted accounts, inaccessible profiles, browser-only activity and unobserved plan changes remain unknown.");
  return { accounts: [...accounts.values()], planObservations: [...observations.values()], findings: [...findings], roots };
}
module.exports = { profileRoots, discoverInventory };
