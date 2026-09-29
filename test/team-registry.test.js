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

test('setup migrates local identity once, preserves history, and refuses a changed Registry owner', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'registry-migration-'));
  const identity={personId:'11111111-1111-4111-8111-111111111111',machineId:'22222222-2222-4222-8222-222222222222',workspaceId:'33333333-3333-4333-8333-333333333333',attributeTypeId:'44444444-4444-4444-8444-444444444444',personName:'Alice',machineName:'Mac'};
  const bridge=path.join(dir,'bridge.js');
  const writeBridge=()=>fs.writeFile(bridge,`process.stdin.resume();process.stdin.on('end',()=>console.log(${JSON.stringify(JSON.stringify(identity))}));`);
  try {
    const old={personId:'alice',machineId:'machine',personName:'Alice',repo:'owner/data',port:7682,reportOwner:true};
    await team.save(path.join(dir,'config.json'),old);
    await team.save(path.join(dir,'snapshot.json'),fixture);
    await writeBridge();
    const setup=()=>require('../src/commands/team').cmdTeam(['setup','--dir',dir,'--registry-bridge',bridge,'--registry-python',process.execPath]);
    await setup();await setup();
    const config=JSON.parse(await fs.readFile(path.join(dir,'config.json'),'utf8'));
    assert.equal(config.backend,'registry');assert.equal(config.repo,undefined);assert.equal(config.reportOwner,true);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'pre-registry-config.json'),'utf8')),old);
    assert.equal((await team.loadSnapshots(dir))[0].personId,identity.personId);
    identity.personId='55555555-5555-4555-8555-555555555555';await writeBridge();
    await assert.rejects(setup(),/different person/);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'config.json'),'utf8')),config);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
