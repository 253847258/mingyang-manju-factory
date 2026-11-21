#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP=fs.mkdtempSync(path.join(os.tmpdir(),'execute-gate-'));
process.env.FACTORY_DB=path.join(TMP,'gate.db'); process.env.FACTORY_DATA_DIR=path.join(TMP,'data'); process.env.FACTORY_CONFIG=path.join(TMP,'config.json');
fs.mkdirSync(process.env.FACTORY_DATA_DIR,{recursive:true}); fs.writeFileSync(process.env.FACTORY_CONFIG,JSON.stringify({llm:{provider:'mock'},image:{backend:'placeholder'},video:{backend:'placeholder'},tts:{backend:'none'}}));
const { migrate,get }=await import('../src/db.js'); const { createExecutionPlan,approveExecutionPlan,executeApprovedPlan,isDirectCanvasExecution,isLegacyPlanExecution }=await import('../src/execute-gate.js'); const A=await import('../src/modules/actors.js');
migrate(); A.createAsset({canvas_id:'CV-MAIN',kind:'image',title:'Gate Test Image',x:0,y:0,data:{prompt:'gate test',status:'draft'}}); let pass=0,fail=0; const check=(n,f)=>{try{const d=f();pass++;console.log(`  PASS ${n}${d?' -> '+d:''}`)}catch(e){fail++;console.error(`  FAIL ${n} -> ${e.message}`)}};
check('创建执行计划',()=>{const r=createExecutionPlan({canvasId:'CV-MAIN',title:'Gate 测试计划',operator:'tester'});assert.equal(r.ok,true);globalThis.PLAN={id:r.plan.id||r.plan.plan_id};return PLAN.id});
check('旧画布执行入口全部识别为旁路',()=>{assert.equal(isDirectCanvasExecution('/api/canvas/run'),true);assert.equal(isDirectCanvasExecution('/api/canvas/run-node'),true);assert.equal(isLegacyPlanExecution('/api/canvas/plans/PL-1/run'),true);assert.equal(isLegacyPlanExecution('/api/execute/run'),false);return 'direct + legacy plan run blocked'});
check('人工批准后确认码存在',()=>{const r=approveExecutionPlan(PLAN.id,{operator:'human'});const row=get('SELECT * FROM canvas_plans WHERE id=?',PLAN.id);assert.equal(row.status,'approved');assert.match(row.confirm_code,/^.{4,}$/);return row.status});
check('确认码执行创建任务',()=>{const row=get('SELECT * FROM canvas_plans WHERE id=?',PLAN.id);const r=executeApprovedPlan({planId:PLAN.id,confirmCode:row.confirm_code});assert.equal(r.ok,true);const jid=r.jobId||r.job_id||r.job?.id;assert.ok(jid);globalThis.FIRST_JOB=jid;return jid});
check('确认码只能消费一次',()=>{const row=get('SELECT * FROM canvas_plans WHERE id=?',PLAN.id);assert.throws(()=>executeApprovedPlan({planId:PLAN.id,confirmCode:row.confirm_code}),/消费|状态|不存在|已执行/);return 'replay denied'});
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`); fs.rmSync(TMP,{recursive:true,force:true}); if(fail)process.exitCode=1;
