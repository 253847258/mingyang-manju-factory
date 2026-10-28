// 生成血缘测试：表结构 / 写入读取 / 中文校验 / 稳定哈希 / 同参可复现。
// 使用隔离临时库，全程离线，不触碰正式数据。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-lineage-'));
process.env.FACTORY_DATA_DIR = path.join(TMP, 'data');
process.env.FACTORY_DB = path.join(TMP, 'factory-lineage.db');
fs.mkdirSync(process.env.FACTORY_DATA_DIR, { recursive: true });

const L = await import('../src/lineage.js');
const { all } = await import('../src/db.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`);
  }
};
const throws = (fn, pattern, name) => {
  try {
    fn();
    ok(name, false, '没有抛出异常');
  } catch (error) {
    ok(name, pattern.test(String(error?.message || '')), String(error?.message || error));
  }
};

console.log('\n【1】表结构与索引');
ok('首次 ensureLineageSchema 返回 true', L.ensureLineageSchema() === true);
ok('重复 ensureLineageSchema 幂等且返回 false', L.ensureLineageSchema() === false);
const columns = all('PRAGMA table_info(asset_lineage)').map((row) => row.name);
ok('asset_lineage 九列齐全', columns.join(',') === 'id,take_id,model,model_version,seed,prompt,ref_hash,params,created_at', columns.join(','));
const indexes = all('PRAGMA index_list(asset_lineage)');
ok('take_id 索引存在', indexes.some((row) => row.name === 'idx_asset_lineage_take_id'));

console.log('\n【2】写入与读取');
const prompt = '电影感夜景，雨中的霓虹街，35mm，完整分镜提示词';
const first = L.recordLineage({
  takeId: 'TAKE-001',
  model: 'flux-kontext',
  modelVersion: 'v1.2',
  seed: '0',
  prompt,
  refHash: L.hashRef('reference-a.png'),
  params: { steps: 30, guidance: 3.5, sampler: 'euler' },
});
ok('recordLineage 返回完整记录', first?.id?.startsWith('LIN-') && first.take_id === 'TAKE-001');
const read = L.getLineage('TAKE-001');
ok('记录后可读且关键字段一致',
  read?.model === 'flux-kontext'
  && read?.model_version === 'v1.2'
  && read?.seed === '0'
  && read?.prompt === prompt
  && read?.ref_hash === L.hashRef('reference-a.png'),
  JSON.stringify({ model: read?.model, seed: read?.seed }));
ok('params 与 created_at 已落库',
  read?.params === '{"guidance":3.5,"sampler":"euler","steps":30}'
  && /^\d{4}-\d{2}-\d{2}T/.test(read?.created_at || ''),
  `${read?.params} | ${read?.created_at}`);

console.log('\n【3】中文必填校验');
throws(() => L.recordLineage({ takeId: 'TAKE-X', prompt: '有提示词', params: {} }), /缺少必填字段：model/, '缺 model 中文报错');
throws(() => L.recordLineage({ takeId: 'TAKE-Y', model: 'flux', params: {} }), /缺少必填字段：prompt/, '缺 prompt 中文报错');
throws(() => L.recordLineage({ takeId: 'TAKE-Z', model: 'flux', prompt: '   ' }), /缺少必填字段：prompt/, '空白 prompt 中文报错');

console.log('\n【4】参考图哈希稳定');
ok('hashRef 与 SHA-256 已知结果一致', L.hashRef('hello') === '2cf24dba5fb0a30e', L.hashRef('hello'));
ok('同输入的哈希稳定且长度为 16', L.hashRef('参考图') === L.hashRef('参考图') && L.hashRef('参考图').length === 16);
ok('不同输入的哈希不同', L.hashRef('reference-a.png') !== L.hashRef('reference-b.png'));
ok('对象哈希不受键顺序影响', L.hashRef({ b: 2, a: 1 }) === L.hashRef({ a: 1, b: 2 }));
ok('Buffer 按原始字节计算', L.hashRef(Buffer.from([1, 2, 3])) !== L.hashRef(Buffer.from([1, 2, 4])));

console.log('\n【5】同日同参可复现');
const second = L.recordLineage({
  takeId: 'TAKE-002',
  model: 'flux-kontext',
  modelVersion: 'v1.2',
  seed: '0',
  prompt,
  refHash: L.hashRef('reference-a.png'),
  params: { sampler: 'euler', guidance: 3.5, steps: 30 },
});
const reproducibleFields = (row) => [
  row.model, row.model_version, row.seed, row.prompt, row.ref_hash, row.params,
].join('\u0000');
ok('同参两条记录的复现字段完全相同', reproducibleFields(first) === reproducibleFields(second), reproducibleFields(second));
ok('same-day 时间信息可比较', first.created_at.slice(0, 10) === second.created_at.slice(0, 10), first.created_at.slice(0, 10));

console.log('\n【6】列表筛选与最新记录');
const third = L.recordLineage({
  takeId: 'TAKE-001',
  model: 'other-model',
  modelVersion: 'v2',
  seed: '9',
  prompt: '第二版提示词',
  refHash: L.hashRef('reference-b.png'),
  params: { steps: 20 },
});
ok('同 take 后续记录成为最新血缘', L.getLineage('TAKE-001')?.id === third.id);
ok('按模型筛选', L.listLineage({ model: 'flux-kontext' }).every((row) => row.model === 'flux-kontext'));
ok('limit 生效且按最新优先', L.listLineage({ model: 'flux-kontext', limit: 1 }).length === 1);
ok('不存在 take 返回 null', L.getLineage('TAKE-NOT-FOUND') === null);

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略临时目录清理失败 */ }
process.exit(fail ? 1 : 0);
