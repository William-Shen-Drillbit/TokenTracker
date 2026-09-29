"use strict";
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const registry = require('../src/lib/team-registry');
const team = require('../src/lib/team-store');
const { syncTeam } = require('../src/commands/team');
const fixture = { version:1, personId:'alice', personName:'Alice', machineId:'machine', machineName:'Mac', collectedAt:'2026-09-28T15:00:00Z', rows:[], accounts:[], billing:[], findings:[] };

test('Registry publishes complete validated rosters, retains cache offline, and never mixes GitHub copies', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'registry-team-'));
  try {
    await team.save(path.join(dir,'config.json'),{backend:'registry'});
    await team.save(path.join(dir,'remote-index.json'),{'old-github-copy':'missing'});
    await registry.sync({},dir,null,async()=>({uploaded:true,snapshots:[fixture],errors:[]}));
    assert.equal((await team.loadSnapshots(dir)).length,1);
    const index=await fs.readFile(path.join(dir,'registry-index.json'),'utf8');
    const bad=structuredClone(fixture);bad.personId='../invalid';
    await assert.rejects(registry.sync({},dir,null,async()=>({uploaded:true,snapshots:[fixture,bad],errors:[]})),/identifier/);
    assert.equal(await fs.readFile(path.join(dir,'registry-index.json'),'utf8'),index);
    const result=await registry.sync({},dir,null,async()=>({uploaded:false,snapshots:null,errors:['offline']}));
    assert.equal(result.downloaded,false);
    assert.equal((await team.loadSnapshots(dir)).length,1);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('Registry failure never falls back to GitHub, and retries preserve the snapshot', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'registry-offline-'));
  try {
    await team.save(path.join(dir,'config.json'),{backend:'registry'});
    await team.save(path.join(dir,'snapshot.json'),fixture);
    const state=await syncTeam(dir,{collect:false});
    assert.match(state.errors[0],/Registry setup/);
    assert.equal(state.consecutiveFailures,1);
    assert.ok(Date.parse(state.retryAt)>Date.now());
    assert.equal((await team.loadSnapshots(dir))[0].personId,'alice');
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
