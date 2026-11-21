#!/usr/bin/env node
// P4 · MCP stdio 入口：零依赖，可被 Claude Code / Codex / DSH 作为 stdio server 拉起
// 用法：
//   node scripts/mcp.js                 # stdio 模式（默认；stdio 只输出 JSON-RPC，日志走 stderr）
//   node scripts/mcp.js --http          # 另起一个 HTTP 审批/工具服务（默认随机端口，绝不占用 8788）
//   node scripts/mcp.js --http --port 8799
//   node scripts/mcp.js --catalog       # 打印工具目录（人类查看 Agent 能做什么）
//   node scripts/mcp.js --help
//
// 客户端配置（Claude Code / Codex / DSH 的 MCP 配置片段）：
//   { "mcpServers": { "ai-video-factory": {
//       "command": "node",
//       "args": ["/home/linsheng/Desktop/ai-video-factory/scripts/mcp.js"],
//       "env": { "FACTORY_DATA_DIR": "/home/linsheng/Desktop/ai-video-factory/data" } } } }
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ★ 关键一：MCP 的 stdout 只允许 JSON-RPC 帧。既有模块里有大量 console.log，
//   在这里统一改道 stderr，无需改动任何既有模块。
console.log = (...a) => console.error(...a);
// ★ 关键二：未捕获异常绝不能写 stdout（否则客户端直接解析失败）
process.on('uncaughtException', (e) => { console.error('[mcp] 未捕获异常：', e?.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[mcp] 未处理的 Promise 拒绝：', e?.stack || e); });

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f, def = null) => {
  const i = argv.indexOf(f);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : def;
};

if (has('--help') || has('-h')) {
  console.error([
    '铭扬漫剧自动化工厂 · MCP 入口（P4 Agent 接口 + 人类审核闸门）',
    '',
    '  node scripts/mcp.js                  stdio 模式（MCP 客户端用）',
    '  node scripts/mcp.js --http           HTTP 模式（人工审批界面 + Agent HTTP 桥）',
    '  node scripts/mcp.js --http --port N  指定端口（默认 0 = 随机端口）',
    '  node scripts/mcp.js --catalog        打印工具目录',
    '  node scripts/mcp.js --selftest       跑一次进程内冒烟（plan → 拦住未审批的执行）',
    '',
    '环境变量：FACTORY_DATA_DIR / FACTORY_DB / FACTORY_CONFIG（用于隔离数据，测试/多实例）',
    '',
    '闸门说明：Agent 只能提交计划（canvas_plan 干跑）。生成必须由人在审批界面批准，',
    '          并由人把服务端日志里的 6 位确认码交给 Agent，才能执行（canvas_run）。',
  ].join('\n'));
  process.exit(0);
}

// 数据库迁移 + P4 幂等建表（canvas_plans / canvas_plan_audits）
const { migrate } = await import('../src/db.js');
migrate();
const tools = await import('../src/mcp-tools.js');
tools.ensureMcpSchema();

const mode = has('--catalog') ? 'catalog' : (has('--http') ? 'http' : (has('--selftest') ? 'selftest' : 'stdio'));

if (mode === 'catalog') {
  const s = tools.toolsSummary();
  console.error(`工具共 ${s.total} 个；按级别：${JSON.stringify(s.by_level)}；花钱工具：${s.paying.join('、')}；走闸门：${s.gated.join('、')}`);
  process.stderr.write(`${JSON.stringify(tools.toolCatalog(), null, 2)}\n`);
  process.exit(0);
}

if (mode === 'selftest') {
  // 只读 + 干跑冒烟：验证闸门拦住了「未审批的执行」，且不产生任何生成调用
  const { callTool, toolCatalog, toolsSummary } = tools;
  const canvasId = valueOf('--canvas', 'CV-MAIN');
  const summary = toolsSummary();
  console.error(`[selftest] 工具面：${summary.total} 个（只读 ${summary.by_level.read}｜计划 ${summary.by_level.plan}｜执行 ${summary.by_level.exec}｜改画布 ${summary.by_level.canvas}）；花钱工具：${summary.paying.join('、')}`);
  console.error(`[selftest] 工具目录可序列化：${JSON.stringify(toolCatalog()).length > 200}`);
  try {
    const nodes = await callTool('canvas_list_nodes', { canvas_id: canvasId });
    console.error(`[selftest] 画布 ${canvasId} 节点数：${nodes.count}`);
    if (!nodes.count) {
      console.error('[selftest] 画布为空 → 跳过闸门冒烟（干跑需要至少 1 个可执行节点；请先在界面上搭一张图）');
      process.exit(0);
    }
    const plan = await callTool('canvas_plan', { canvas_id: canvasId });
    console.error(`[selftest] 干跑计划 ${plan.plan_id}：待执行 ${plan.node_count} 个节点，成本级 ${plan.cost_level}；响应中无完整确认码：${plan.confirm_code === undefined}`);
    if (!plan.node_count) {
      console.error('[selftest] 所有节点都已生成（无待执行节点），闸门冒烟跳过；可用 overwrite=true 强制重算');
      process.exit(0);
    }
    const denied = await callTool('canvas_run', { plan_id: plan.plan_id, confirm_code: '000000' }).then(() => null, (e) => e.message);
    console.error(`[selftest] 未经审批即执行 → 已被拦截：${denied}`);
    if (!denied || !/尚未经人工审批|已执行过|已过期|已被人工拒绝/.test(denied)) {
      console.error('[selftest] 失败：闸门未生效（未审批的执行没有被拦住）');
      process.exit(1);
    }
    console.error('[selftest] 通过：闸门生效，未发生任何出图/视频调用');
  } catch (e) {
    console.error(`[selftest] 失败：${e.message}`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode || 0);
}

if (mode === 'http') {
  const { startHttpServer } = await import('../src/mcp-server.js');
  const port = Number(valueOf('--port', '0')) || 0;
  const host = valueOf('--host', '127.0.0.1');
  const { url, close } = await startHttpServer({ port, host, onLog: (m) => console.error(m) });
  console.error(`[mcp] 审批/工具 HTTP 服务：${url}（GET ${url}/api/canvas/plans 看待审批计划）`);
  const shutdown = async () => { console.error('[mcp] 关闭 HTTP 服务'); await close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} else {
  const { startStdioServer } = await import('../src/mcp-server.js');
  startStdioServer();
}

// 供测试/诊断引用（正常路径不会用到）
export const ENTRY_FILE = fileURLToPath(import.meta.url);
export const ENTRY_DIR = path.dirname(ENTRY_FILE);
