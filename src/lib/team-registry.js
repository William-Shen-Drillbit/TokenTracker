"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");
const team = require("./team-store");

function callBridge(config, input) {
  if (!path.isAbsolute(config.registryBridge || "") || !path.isAbsolute(config.registryPython || "")) throw new Error("Registry setup is incomplete; rerun the team installation");
  return new Promise((resolve, reject) => {
    const child = execFile(config.registryPython, [config.registryBridge], { timeout: 5 * 60_000, maxBuffer: 50_000_000 }, (error, stdout) => {
      let result;
      try { result = JSON.parse(stdout); } catch { /* Never expose raw output. */ }
      if (error || !result || result.error) reject(new Error("Registry access unavailable; check your personal key and network. Local data is retained."));
      else resolve(result);
    });
    child.stdin.on("error", () => {}); // A startup failure can close stdin before the snapshot finishes writing.
    child.stdin.end(JSON.stringify(input));
  });
}

async function sync(config, dir, snapshot, bridge = callBridge) {
  const result = await bridge(config, { action: "sync", config, snapshot: snapshot ? team.normalizeSnapshot(snapshot) : null });
  if (typeof result.uploaded !== "boolean" || !Array.isArray(result.errors) || result.errors.some(e => typeof e !== "string" || e.length > 500)) throw new Error("Invalid Registry sync response");
  if (result.snapshots !== null) {
    if (!Array.isArray(result.snapshots) || result.snapshots.length > 1000) throw new Error("Invalid Registry roster");
    const index = {}, identities = new Set();
    for (const raw of result.snapshots) {
      const safe = team.normalizeSnapshot(raw);
      const name = `registry/${safe.personId}/${safe.machineId}`;
      if (identities.has(name)) throw new Error("Duplicate Registry machine snapshot");
      identities.add(name);
      const revision = team.hash(JSON.stringify(safe));
      await team.save(path.join(dir, "cache", `${team.hash(name)}-${revision}.json`), safe);
      index[name] = revision;
    }
    // Publish only after the whole response passes validation; no partial roster.
    await team.save(path.join(dir, "registry-index.json"), index);
  }
  return { uploaded: result.uploaded, downloaded: result.snapshots !== null, errors: result.errors };
}

module.exports = { callBridge, sync };
