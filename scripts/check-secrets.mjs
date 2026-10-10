#!/usr/bin/env node
// 提交前密钥检查（开发评估 P0-3）
//
// 用法：
//   node scripts/check-secrets.mjs            # 扫 config/ + 根目录 *.json
//   node scripts/check-secrets.mjs --all      # 额外扫 scripts/ docs/ tests/ strategist/（审计模式）
//   node scripts/check-secrets.mjs --quiet    # 只输出一行结论
//
// 命中「非空」的 key/secret/token/password 字段即非零退出。
// 只打印 文件 + 字段名 + 值长度，**绝不打印值本身**。
//
// 注意：--all 会扫到 strategist/runs/*.json（历史运行日志，含掩码 Key 与 KeyId 片段）。
// 该目录已在 .gitignore 排除，所以「提交前检查」用默认模式即可保持绿灯，--all 只作人工审计。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const args = new Set(process.argv.slice(2));
const QUIET = args.has('--quiet');
const ALL = args.has('--all');

const SECRET_FIELD = /(?:key|secret|token|password|passwd|credential|apikey)/i;
const PLACEHOLDER = /^(?:|x+|xxx+|your[-_ ]?|test|demo|example|change[-_ ]?me|placeholder|none|null|undefined|\$\{[^}]*\})$/i;
const SKIP_DIR = new Set(['node_modules', 'data', '_archive', '.git', 'bin', 'outputs']);

const targets = [];
const pushFiles = (dir, filter) => {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIR.has(f)) continue;
      pushFiles(p, filter);
    } else if (filter(f)) targets.push(p);
  }
};

// config/ 递归（含 config.json.bak* 这类恢复快照）
pushFiles(path.join(ROOT, 'config'), (f) => f.endsWith('.json') || f.includes('.json.'));

// 根目录只扫「本层」的 *.json（不要递归整棵树：strategist/runs 是历史日志，
// 里面有掩码 Key 与 KeyId 片段，已 gitignore，不该让提交前检查永远红灯）
for (const f of fs.readdirSync(ROOT)) {
  const p = path.join(ROOT, f);
  if (!fs.statSync(p).isFile() || !f.endsWith('.json')) continue;
  targets.push(p);
}

if (ALL) {
  pushFiles(path.join(ROOT, 'scripts'), (f) => f.endsWith('.json'));
  pushFiles(path.join(ROOT, 'docs'), (f) => f.endsWith('.json'));
  pushFiles(path.join(ROOT, 'tests'), (f) => f.endsWith('.json'));
  pushFiles(path.join(ROOT, 'strategist'), (f) => f.endsWith('.json'));
}

const unique = [...new Set(targets)];
const hits = [];
let scannedFields = 0;

// 值像不像"真正的凭据"：真 Key 不含空格；命令/路径/说明一律排除
const looksLikeCredential = (v) => {
  const s = String(v || '').trim();
  if (s.length < 8) return false;
  if (/\s/.test(s)) return false;             // 含空格 → 命令或描述，不是 Key
  if (PLACEHOLDER.test(s)) return false;      // 占位符
  if (/^[\w./\\-]+\.(js|mjs|json|md|sh|cmd|exe)$/i.test(s)) return false; // 文件路径
  return true;
};

// JSON 优先：按真实结构遍历，避免 "check:secrets": "node ..." 这类字符串被误判
function walkJson(node, file, trail = '') {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((v, i) => walkJson(v, file, `${trail}[${i}]`)); return; }
  for (const [k, v] of Object.entries(node)) {
    const p = trail ? `${trail}.${k}` : k;
    if (typeof v === 'string') {
      if (SECRET_FIELD.test(k)) {
        scannedFields += 1;
        if (looksLikeCredential(v)) hits.push({ file, field: p, len: v.trim().length });
      }
    } else walkJson(v, file, p);
  }
}

for (const file of unique) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = null; }
  if (parsed !== null && typeof parsed === 'object') { walkJson(parsed, rel); continue; }
  // 非 JSON 兜底：必须整体带引号的 key，避免 :secrets" 这种半截匹配
  const re = /["']([A-Za-z_][A-Za-z0-9_.-]*)["']\s*[:=]\s*["']([^"'\n]*)["']/g;
  let m;
  while ((m = re.exec(text))) {
    if (!SECRET_FIELD.test(m[1])) continue;
    scannedFields += 1;
    const value = m[2] || '';
    if (looksLikeCredential(value)) hits.push({ file: rel, field: m[1], len: value.trim().length });
  }
}

if (hits.length) {
  if (!QUIET) {
    console.error('发现疑似明文密钥（仅显示字段与长度，不显示内容）：');
    for (const h of hits) console.error(`  ${h.file}  ${h.field}  len=${h.len}`);
  }
  console.error(`[check-secrets] 失败：${hits.length} 个疑似密钥。请改用环境变量或本地未入库配置。`);
  process.exit(1);
}

console.log(`[check-secrets] 通过：扫描 ${unique.length} 个文件，未发现非空密钥/口令字段。`);
