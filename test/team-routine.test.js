'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const team=require('../src/lib/team-store');
const {runRoutine,serveTeam}=require('../src/commands/team');

test('every explicit routine invocation collects, including same-day and before scheduled time',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'team-routine-'));
 try {
  const config={backend:'registry',collectionMode:'routine',routineActivatedOn:'2026-03-08',personId:'alice',machineId:'mac',port:0};
  await team.save(path.join(dir,'config.json'),config);
  let calls=0;
  const sync=async()=>{calls++; return {collectedAt:'2026-03-08T15:00:01Z',uploadedAt:'2026-03-08T15:00:02Z',downloadedAt:'2026-03-08T15:00:03Z',errors:[]};};
  assert.equal((await runRoutine(dir,{now:new Date('2026-03-08T14:59:59Z'),sync})).completed,true);
  await fs.unlink(path.join(dir,'routine-completed.json'));
  const failed=await runRoutine(dir,{now:new Date('2026-03-08T15:00:00Z'),sync:async()=>({errors:['offline']})});
  assert.equal(failed.date,'2026-03-08');
  assert.equal(await fs.stat(path.join(dir,'routine-completed.json')).catch(()=>null),null);
  assert.equal((await runRoutine(dir,{now:new Date('2026-03-08T15:00:00Z'),sync})).completed,true);
  assert.equal((await runRoutine(dir,{now:new Date('2026-03-08T15:00:00Z'),sync})).completed,true);
  assert.equal(calls,3);
  assert.equal(team.dueReport(new Date('2026-11-01T15:59:59Z'),[],'2026-11-01'),null);
  assert.equal(team.dueReport(new Date('2026-11-01T16:00:00Z'),[],'2026-11-01'),'2026-11-01');
  assert.equal(team.dueReport(new Date('2026-03-10T02:00:00Z'),[],'2026-03-08'),'2026-03-09');
  const lock=await team.openLock(path.join(dir,'routine.lock'));
  assert.equal((await runRoutine(dir,{sync})).busy,true); await lock.release();
  await team.save(path.join(dir,'config.json'),{...config,personId:'bob'});
  await assert.rejects(runRoutine(dir,{sync}),/different enrollment/);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
