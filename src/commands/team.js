"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const { parseArgs } = require("node:util");
const { readJson } = require("../lib/fs");
const team = require("../lib/team-store");

const CLI = path.resolve(__dirname, "../../bin/tracker.js");
const PORT = 7682;
const LABEL = "com.tokentracker.team";
const INTERVAL = 15 * 60_000;

async function configAt(dir) {
  const config = await readJson(path.join(dir, "config.json"));
  if (!config) throw new Error("Run tokentracker team setup --repo owner/private-data-repo --name 'Your name' first");
  return config;
}

async function syncTeam(dir, { collect = true } = {}) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = await team.openLock(path.join(dir, "sync.lock"), { quietIfLocked: true });
  if (!lock) return { busy: true };
  try {
    const config = await configAt(dir);
    const state = await readJson(path.join(dir, "status.json")) || {};
    const errors = [];
    if (collect) {
      try {
        await team.runFile(process.execPath, [CLI, "sync", "--auto", "--background", "--all-local-sources", "--local-only", "--wait-for-lock"], { timeout: 10 * 60_000, maxBuffer: 2_000_000 });
        const snapshot = await team.collectSnapshot(config, dir);
        await team.save(path.join(dir, "snapshot.json"), snapshot);
        state.collectedAt = snapshot.collectedAt;
      } catch { errors.push("Local collection failed; the previous snapshot was retained. Run team collect for details."); }
    }
    const snapshot = await readJson(path.join(dir, "snapshot.json"));
    if (snapshot) {
      try { await team.uploadSnapshot(config.repo, snapshot); state.uploadedAt = new Date().toISOString(); }
      catch (e) { errors.push(e.message); }
    }
    try { await team.downloadSnapshots(config.repo, dir); state.downloadedAt = new Date().toISOString(); }
    catch (e) { errors.push(e.message); }
    state.errors = [...new Set(errors)];
    state.checkedAt = new Date().toISOString();
    state.consecutiveFailures = errors.length ? (state.consecutiveFailures || 0) + 1 : 0;
    const delay = errors.length ? Math.min(INTERVAL, 60_000 * 2 ** Math.min(state.consecutiveFailures - 1, 4)) : INTERVAL;
    state.retryAt = new Date(Date.now() + delay).toISOString();
    await team.save(path.join(dir, "status.json"), state);
    return state;
  } finally { await lock.release(); }
}

async function prepareReport(dir, now = new Date()) {
  const config = await configAt(dir);
  if (!config.reportOwner) return null;
  const sent = await readJson(path.join(dir, "sent.json")) || {};
  const date = team.dueReport(now, Object.keys(sent), config.activatedOn);
  if (!date) return null;
  const file = path.join(dir, "reports", `${date}.json`);
  if (await readJson(file)) return file;
  const snapshots = await team.loadSnapshots(dir);
  if (!snapshots.length) return null;
  const summary = team.aggregate(snapshots, { now: now.getTime() });
  await team.save(file, { date, createdAt: now.toISOString(), status: "pending", text: team.renderReport(summary, date, `http://127.0.0.1:${config.port}`), summary });
  return file;
}

function localRequest(req, port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(req.headers.host)) return false;
  if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  return req.method === "GET";
}

async function serveTeam(dir, { worker = true } = {}) {
  const config = await configAt(dir);
  const port = config.port || PORT;
  const html = await fs.readFile(path.join(__dirname, "../lib/team-dashboard.html"));
  const server = http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (!localRequest(req, port)) { res.writeHead(403); res.end("Local read-only dashboard"); return; }
    try {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname === "/") { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return; }
      if (url.pathname === "/api/team") {
        const summary = team.aggregate(await team.loadSnapshots(dir), { from: url.searchParams.get("from") || undefined, to: url.searchParams.get("to") || undefined });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ...summary, sync: await readJson(path.join(dir, "status.json")), repo: config.repo })); return;
      }
      res.writeHead(404); res.end("Not found");
    } catch { res.writeHead(500); res.end("Team data is unavailable. Run tokentracker team status."); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  console.log(`Team dashboard: http://127.0.0.1:${port}`);
  let timer, running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const status = await readJson(path.join(dir, "status.json"));
      if (!status?.retryAt || Date.parse(status.retryAt) <= Date.now()) await syncTeam(dir);
      await prepareReport(dir);
    } catch (e) { console.error(e.message); }
    finally { running = false; }
  };
  if (worker) { void tick(); timer = setInterval(tick, 60_000); }
  const stop = () => { clearInterval(timer); server.close(); };
  server.on("close", () => clearInterval(timer));
  return { server, stop, tick };
}

async function installService(dir) {
  if (process.platform !== "darwin") throw new Error("Automatic service installation currently supports macOS; run team serve on this platform");
  const xml = value => String(value).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
  const destination = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
  const args = [process.execPath, CLI, "team", "serve", "--dir", dir];
  const body = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${LABEL}</string><key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join("")}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>30</integer><key>WorkingDirectory</key><string>${xml(path.dirname(CLI))}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin")}</string></dict><key>StandardOutPath</key><string>${xml(path.join(dir, "service.log"))}</string><key>StandardErrorPath</key><string>${xml(path.join(dir, "service-error.log"))}</string></dict></plist>`;
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await team.save(path.join(dir, "service.json"), { label: LABEL, command: args });
  await require("../lib/fs").writeFileAtomic(destination, body, { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  await team.runFile("launchctl", ["bootout", `${domain}/${LABEL}`]).catch(() => {});
  await team.runFile("launchctl", ["bootstrap", domain, destination]);
  console.log(`Installed login service. Dashboard: http://127.0.0.1:${(await configAt(dir)).port}`);
}

async function cmdTeam(argv) {
  const { values: v, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: "boolean" }, repo: { type: "string" }, name: { type: "string" }, dir: { type: "string" }, port: { type: "string" },
    "report-owner": { type: "boolean" }, "no-worker": { type: "boolean" }, "no-collect": { type: "boolean" },
    from: { type: "string" }, to: { type: "string" }, date: { type: "string" }, account: { type: "string" }, "weekly-usd": { type: "string" }, "message-url": { type: "string" },
  } });
  const dir = path.resolve(v.dir || team.TEAM_DIR);
  const action = positionals[0];
  if (v.help || !action) { console.log("tokentracker team setup --repo owner/private-data-repo --name 'Your name' [--report-owner]\ntokentracker team collect | sync | status | serve | install-service | report\ntokentracker team allowance --account ACCOUNT_ID --weekly-usd AMOUNT\ntokentracker team report-sent --date YYYY-MM-DD --message-url https://...slack.com/archives/...\nOptional: --dir PATH; serve --no-worker; sync --no-collect; report --from ISO --to ISO\nRequires Node.js 20+, GitHub CLI signed in with access to the private data repository.\nPilot: macOS login service, metadata-only snapshots, account attribution and billing gaps remain explicit."); return; }
  if (action === "setup") {
    const previous = await readJson(path.join(dir, "config.json"));
    const repo = v.repo || previous?.repo;
    await team.verifyRepository(repo);
    const user = await team.ghApi("user");
    if (previous && previous.repo !== repo) throw new Error("Existing team configuration uses a different repository; use a different --dir");
    if (previous && previous.personId !== user.login) throw new Error("GitHub identity changed; sign in as the enrolled account before setup");
    const port = Number(v.port || previous?.port || PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid dashboard port");
    const queue = require("../lib/local-api").resolveQueuePath();
    const config = { ...previous, repo, personId: user.login, personName: v.name || previous?.personName || user.name || user.login,
      machineId: previous?.machineId || team.getOrCreateMachineId(queue), machineName: previous?.machineName || os.hostname(),
      port, reportOwner: v["report-owner"] || previous?.reportOwner || false, activatedOn: previous?.activatedOn || team.centralDate().date, historyDays: 90 };
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await team.save(path.join(dir, "config.json"), config);
    console.log(`Enrolled ${config.personName}. Team data: https://github.com/${repo}. Run team sync, then team install-service.`); return;
  }
  if (action === "allowance") {
    const amount = Number(v["weekly-usd"]);
    if (!v.account || v["weekly-usd"] === undefined || !Number.isFinite(amount) || amount < 0 || amount > Number.MAX_SAFE_INTEGER) throw new Error("Use team allowance --account ACCOUNT_ID --weekly-usd AMOUNT");
    const snapshot = await readJson(path.join(dir, "snapshot.json"));
    if (!snapshot?.accounts.some(a => a.id === v.account)) throw new Error("Account must exist in the local snapshot");
    const file = path.join(dir, "accounts.json"), overrides = await readJson(file) || [];
    const previous = overrides.find(a => a.id === v.account);
    if (previous) previous.allowanceWeeklyUsd = amount; else overrides.push({ id: v.account, allowanceWeeklyUsd: amount });
    await team.save(file, overrides);
    console.log("Weekly modeled allowance saved. Run team sync to update the dashboard and shared snapshot."); return;
  }
  if (action === "collect") {
    await team.runFile(process.execPath, [CLI, "sync", "--local-only", "--wait-for-lock"], { timeout: 20 * 60_000, maxBuffer: 2_000_000 });
    const snapshot = await team.collectSnapshot(await configAt(dir), dir);
    await team.save(path.join(dir, "snapshot.json"), snapshot);
    console.log(JSON.stringify({ collectedAt: snapshot.collectedAt, rows: snapshot.rows.length, accounts: snapshot.accounts.length, findings: snapshot.findings }, null, 2)); return;
  }
  if (action === "sync") { const status = await syncTeam(dir, { collect: !v["no-collect"] }); console.log(JSON.stringify(status, null, 2)); if (status.errors?.length) process.exitCode = 1; return; }
  if (action === "status") { console.log(JSON.stringify({ config: await configAt(dir), sync: await readJson(path.join(dir, "status.json")), machines: (await team.loadSnapshots(dir)).length }, null, 2)); return; }
  if (action === "serve") { const service = await serveTeam(dir, { worker: !v["no-worker"] }); process.once("SIGTERM", () => { service.stop(); process.exit(0); }); process.once("SIGINT", () => { service.stop(); process.exit(0); }); return; }
  if (action === "install-service") { await installService(dir); return; }
  if (action === "report") {
    const summary = team.aggregate(await team.loadSnapshots(dir), { from: v.from, to: v.to });
    console.log(team.renderReport(summary, team.centralDate().date, `http://127.0.0.1:${(await configAt(dir)).port}`)); return;
  }
  if (action === "report-sent") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date || "") || !/^https:\/\/[^/]+\.slack\.com\/archives\//.test(v["message-url"] || "")) throw new Error("A report date and verified Slack message URL are required");
    const lock = await team.openLock(path.join(dir, "delivery.lock"), { quietIfLocked: true });
    if (!lock) throw new Error("Another delivery receipt is being recorded; retry");
    try {
      const sent = await readJson(path.join(dir, "sent.json")) || {};
      if (!sent[v.date]) { sent[v.date] = { messageUrl: v["message-url"], recordedAt: new Date().toISOString() }; await team.save(path.join(dir, "sent.json"), sent); }
      console.log("Delivery receipt recorded.");
    } finally { await lock.release(); } return;
  }
  throw new Error(`Unknown team command: ${action}`);
}

module.exports = { cmdTeam, syncTeam, prepareReport, serveTeam, localRequest };
