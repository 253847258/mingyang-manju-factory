#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'governance-')); process.env.FACTORY_DB=path.join(TMP,'gov.db'); process.env.FACTORY_DATA_DIR=path.join(TMP,'data'); process.env.FACTORY_CONFIG=path.join(TMP,'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR,{recursive:true}); fs.writeFileSync(process.env.FACTORY_CONFIG,JSON.stringify({llm:{provider:'mock'},image:{backend:'placeholder'},video:{backend:'placeholder'},tts:{backend:'none'}}));
const { migrate,get,run }=await import('../src/db.js'); const St=await import('../src/studio.js'); const G=await import('../src/governance-writer.js');
migrate(); St.ensureStudioSchema(); let pass=0,fail=0; async function check(n,f){try{const d=await f();pass++;console.log(`  PASS ${n}${d?' -> '+d:''}`)}catch(e){fail++;console.error(`  FAIL ${n} -> ${e.message}`)}}
let proj;
await check('创建并执行离线 brief 阶段',async()=>{proj=await St.createProduction({brief:'拍一部一集悬疑短剧，每集20秒',offline:true});await St.runStage(proj.id,'brief',{offline:true});return proj.id});
await check('自动回写成本/血缘/订单/事件',async()=>{const r=await G.writebackProductionStage({productionId:proj.id,stage:'brief',jobId:'JOB-GOV-1'});assert.ok(r.result.orderId&&r.result.costId&&r.result.lineageId);return JSON.stringify(r.result)});
await check('重复回写幂等',async()=>{const r=await G.writebackProductionStage({productionId:proj.id,stage:'brief',jobId:'JOB-GOV-1'});assert.equal(r.skipped,true);assert.equal(get('SELECT COUNT(*) n FROM cost_ledger WHERE project_id=?',proj.id).n,1);return 'skipped'});
await check('未完成阶段拒绝回写（防止等待审批被误记完成）',async()=>{
  run("UPDATE production_stages SET status='awaiting_approval' WHERE production_id=? AND stage='brief'",proj.id);
  const costs=get('SELECT COUNT(*) n FROM cost_ledger WHERE project_id=?',proj.id).n;
  const lineages=get('SELECT COUNT(*) n FROM asset_lineage').n;
  const r=await G.writebackProductionStage({productionId:proj.id,stage:'brief',jobId:'JOB-GOV-AWAIT'});
  assert.equal(r.skipped,true); assert.match(r.reason,/只有已完成阶段/);
  assert.equal(get('SELECT COUNT(*) n FROM cost_ledger WHERE project_id=?',proj.id).n,costs);
  assert.equal(get('SELECT COUNT(*) n FROM asset_lineage').n,lineages);
  return r.reason;
});
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`); fs.rmSync(TMP,{recursive:true,force:true}); if(fail)process.exitCode=1;
