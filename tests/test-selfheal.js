// 阶段失败自愈（src/self-heal.js）测试：错误分类 / 单向降级链 / 决策 / 中文告知 / 端到端假执行器。
//
// 口径依据：strategist/reports/T-102-selfheal-spec.md（函数名与行为以契约 + 源码为准）与 strategist/tasks/T-204.yaml。
// 全程离线：不联网、不建真库、不起服务、不跑 verify-all.sh；生成调用一律用**假执行器计数**证伪「静默换后端」。
// 确定性：固定时间戳（FIXED_AT）+ 固定事件号（EVT），不依赖运行时刻；临时目录走 mkdtemp，跑完自清理。
// 用法：node tests/test-selfheal.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- 临时库 / 临时目录（对齐同目录既有测试的约定） ----------
const ROOT_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-selfheal-'));
const DATA_TMP = path.join(ROOT_TMP, 'data');
const DB = path.join(ROOT_TMP, 'factory-selfheal.db');
const CFG = path.join(ROOT_TMP, 'factory-selfheal-config.json');
process.env.FACTORY_DATA_DIR = DATA_TMP;
process.env.FACTORY_DB = DB;
process.env.FACTORY_CONFIG = CFG;
fs.mkdirSync(DATA_TMP, { recursive: true });

const SH = await import('../src/self-heal.js');
const { ERROR_KINDS } = await import('../src/retry.js');

const FIXED_AT = '2025-01-01T00:00:00.000Z';   // 固定时间戳：断言 at/created_at 不随运行时刻变化
const fixedNow = () => FIXED_AT;
const EVT = 'SH-TEST-000001';                  // 固定事件号：告知文案与落账记录可逐字比对

let pass = 0, fail = 0, skipped = 0;
/** 中文断言：cond 为真记通过，否则记失败（不抛错，跑完全部用例） */
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? `  ${extra}` : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  ${extra}` : ''}`); }
};
const need = (cond, msg) => { if (!cond) throw new Error(msg); };
const skip = (name, why = '') => { skipped++; console.log(`  ⤼ [跳过] ${name}${why ? `  ${why}` : ''}`); };
const eqJSON = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** 是否含中文（中文报错/中文告知的通用校验） */
const hasCN = (s) => /[\u4e00-\u9fa5]/.test(String(s ?? ''));

/** 假执行器：errors 为「按调用顺序抛出的错误序列」；记录每次调用的后端与入参（零外网、零真实计费） */
const makeFake = (errors = []) => {
  const calls = [];
  const order = [];
  const run = async (backend, info = {}) => {
    calls.push({ backend, info });
    order.push(`run:${backend}`);
    const e = errors.shift();
    if (e) throw e;
    return { backend, ok: true, at: FIXED_AT };
  };
  return { calls, order, run };
};
/** 假执行器（持续失败版）：每次调用都抛新错误，用于验证「反复触发不会越跑越多降级」 */
const makeFakeAlways = (errFn) => {
  const calls = [];
  const order = [];
  const run = async (backend, info = {}) => {
    calls.push({ backend, info });
    order.push(`run:${backend}`);
    throw errFn();
  };
  return { calls, order, run };
};
/** 假账本：behavior = ok | throw | empty，用来验证 I1（写不进账本就不许换后端） */
const makeLedger = (order = [], behavior = 'ok') => {
  const events = [];
  const record = async (ev) => {
    order.push('record');
    events.push(ev);
    if (behavior === 'throw') throw new Error('账本表被锁');
    if (behavior === 'empty') return null;
    return ev.id;
  };
  return { events, record };
};
const E = (m) => new Error(m);
const E500 = () => E('视频接口 500: internal server error');
const ENET = () => E('网络异常：ECONNRESET');
const 呼叫后端 = (f) => f.calls.map((c) => c.backend).join('→');

console.log('\n【1】常量与策略归一化（单向链 / 免费付费划分 / 非法配置回落）');
ok('降级链（DEGRADE_CHAIN）只有 comfyui-h3 → generic-http → placeholder 一条单向链',
  eqJSON(SH.DEGRADE_CHAIN, { 'comfyui-h3': ['generic-http', 'placeholder'], 'generic-http': ['placeholder'], 'placeholder': [] }),
  JSON.stringify(SH.DEGRADE_CHAIN));
ok('免费/付费后端划分正确（placeholder 免费，comfyui-h3 与 generic-http 付费）',
  SH.isFreeBackend('placeholder') === true && SH.isPaidBackend('placeholder') === false
  && SH.isPaidBackend('comfyui-h3') === true && SH.isPaidBackend('generic-http') === true
  && eqJSON(SH.FREE_BACKENDS, ['placeholder']) && eqJSON(SH.PAID_BACKENDS, ['comfyui-h3', 'generic-http']));
ok('上限常量与契约一致（同后端重试 1 次 / 每 scope 换 1 次 / 单镜 3 次调用 / 熔断 3）',
  SH.MAX_SAME_BACKEND_RETRY === 1 && SH.MAX_SWITCHES_PER_SCOPE === 1
  && SH.MAX_GENERATE_CALLS_PER_SHOT === 3 && SH.DEGRADE_TRIP_THRESHOLD === 3);
const p非法 = SH.healPolicy({ mode: '乱写的模式', maxSwitchesPerScope: -1, maxGenerateCallsPerShot: 'NaN', requireRecord: 'yes' });
ok('策略归一化：非法 mode 回落默认 auto-free，非法次数回落默认值（配置写错不会把系统跑死）',
  p非法.mode === 'auto-free' && p非法.maxSwitchesPerScope === 1 && p非法.maxGenerateCallsPerShot === 3 && p非法.requireRecord === false,
  JSON.stringify(p非法));
ok('默认策略：只允许免费回落、付费跳需人工批准、一集一致性锁定开启',
  SH.DEFAULT_HEAL_POLICY.allowFreeFallback === true && SH.DEFAULT_HEAL_POLICY.allowPaidSwitch === false
  && SH.DEFAULT_HEAL_POLICY.lockEpisodeBackend === true && SH.DEFAULT_HEAL_POLICY.mode === 'auto-free');
ok('降级链跳数：跳 1 = 1、跳 2 = 2、反向（placeholder → comfyui-h3）记 0 跳',
  SH.chainIndexOf('comfyui-h3', 'generic-http') === 1 && SH.chainIndexOf('comfyui-h3', 'placeholder') === 2
  && SH.chainIndexOf('placeholder', 'comfyui-h3') === 0);

console.log('\n【2】错误分类：11 类错误 → 故障归属 / 是否可自愈 / 动作（契约 §2.2 主表）');
// [kind, fault, healable, switchAllowed, action]
const 主表 = [
  ['rate', 'instance', true, true, 'retry-same'],
  ['server', 'instance', true, true, 'retry-same'],
  ['network', 'instance', true, true, 'retry-same'],
  ['timeout', 'instance', true, true, 'degrade'],
  ['auth', 'account', false, false, 'hold-human'],
  ['quota', 'account', false, false, 'hold-human'],
  ['moderation', 'content', false, false, 'hold-human'],
  ['client', 'params', false, false, 'hold-human'],
  ['format', 'local-config', false, false, 'hold-human'],
  ['config', 'local-config', false, false, 'hold-human'],
  ['unknown', 'unknown', false, false, 'hold-human'],
];
for (const [kind, fault, healable, switchAllowed, action] of 主表) {
  const p = SH.classifyForHeal({ errorKind: kind });
  ok(`错误分类：${kind}（${ERROR_KINDS[kind].label}）→ ${fault} / 可自愈=${healable} / 换后端=${switchAllowed} / ${action}`,
    p.errorKind === kind && p.fault === fault && p.healable === healable && p.switchAllowed === switchAllowed && p.action === action,
    `实得 ${p.fault}/${p.healable}/${p.switchAllowed}/${p.action}`);
}
ok('错误分类：中文标签与 retry.js 的 ERROR_KINDS 完全一致（不改既有归类口径）',
  Object.keys(ERROR_KINDS).every((k) => SH.classifyForHeal({ errorKind: k }).errorLabel === ERROR_KINDS[k].label)
  && SH.classifyForHeal({ errorKind: 'server' }).retryable === true);

console.log('\n【3】错误分类反例：源码原文样例 → kind（契约 §2.4 速查表）');
const 样例表 = [
  ['ComfyUI 视频生成超时（等待 900000ms 仍未完成）', 'timeout'],
  ['视频接口 429: rate limit exceeded', 'rate'],
  ['视频接口 500: internal server error', 'server'],
  ['网络异常：ECONNRESET', 'network'],
  ['未配置通用视频接口 URL（设置 → 视频后端）', 'config'],
  ['视频响应里找不到字段「data.0.url」：{}', 'format'],
  ['内容审核不通过：sensitive content', 'moderation'],
  ['insufficient balance：余额不足', 'quota'],
  ['401 unauthorized: invalid api key', 'auth'],
  ['ComfyUI 执行失败：{"status_str":"error"}', 'unknown'],
];
for (const [原文, kind] of 样例表) {
  const p = SH.classifyForHeal({ message: 原文 });
  ok(`原文归类：「${原文.slice(0, 28)}…」→ ${kind}（期望动作 ${SH.classifyForHeal({ errorKind: kind }).action}）`,
    p.errorKind === kind, `实得 ${p.errorKind}`);
}
ok('报错原文不被吞：errorExcerpt 保留厂商原文前缀（不翻译、不截断关键信息）',
  SH.classifyForHeal({ message: '视频接口 500: internal server error' }).errorExcerpt.includes('视频接口 500')
  && SH.errorExcerptOf(E('x'.repeat(500))).length <= 201,
  `摘要长度 ${SH.errorExcerptOf(E('x'.repeat(500))).length}`);

console.log('\n【4】I4 红线与超时阶梯（配置改不了的红线 / 探测决定是否可换）');
ok('审核类红线：moderation 即使显式要求有条件换后端也仍是 hold-human + 不可换（任何配置改不了）',
  (() => { const p = SH.classifyForHeal({ errorKind: 'moderation', allowLimitedSwitch: true });
    return p.action === 'hold-human' && p.healable === false && p.switchAllowed === false && p.fault === 'content'; })());
ok('超时阶梯①：探测到原实例仍在线 → hold-human、不许换后端（可能只是排队/慢镜，且可能已计费）',
  (() => { const p = SH.classifyForHeal({ errorKind: 'timeout', probeOk: true });
    return p.action === 'hold-human' && p.switchAllowed === false && p.requiresProbe === true; })());
ok('超时阶梯②：探测失败（容器已释放）→ 可沿降级链换后端',
  (() => { const p = SH.classifyForHeal({ errorKind: 'timeout', probeOk: false });
    return p.action === 'degrade' && p.healable === true && p.switchAllowed === true; })());
ok('受限类：config/format 默认不换后端，只有显式 allowLimitedSwitch 才允许降级',
  SH.classifyForHeal({ errorKind: 'config' }).switchAllowed === false
  && SH.classifyForHeal({ errorKind: 'format' }).switchAllowed === false
  && SH.classifyForHeal({ errorKind: 'config', allowLimitedSwitch: true }).action === 'degrade');

console.log('\n【5】单向降级链：nextBackend / fallbackChain（禁止反向升级）');
ok('降级链下一跳（默认策略只放行免费回落）：comfyui-h3 直连 placeholder，generic-http → placeholder，链尾 null',
  SH.nextBackend({ from: 'comfyui-h3' }) === 'placeholder'
  && SH.nextBackend({ from: 'generic-http' }) === 'placeholder'
  && SH.nextBackend({ from: 'placeholder' }) === null,
  `${SH.nextBackend({ from: 'comfyui-h3' })} / ${SH.nextBackend({ from: 'generic-http' })} / ${SH.nextBackend({ from: 'placeholder' })}`);
ok('降级链顺序：显式放开付费白名单后 comfyui-h3 的第一跳才是 generic-http（跳 1 默认关，付费跳须人工批准）',
  SH.nextBackend({ from: 'comfyui-h3', allow: SH.PAID_BACKENDS.concat(SH.FREE_BACKENDS) }) === 'generic-http'
  && eqJSON(SH.fallbackChain({ from: 'comfyui-h3', allow: SH.PAID_BACKENDS.concat(SH.FREE_BACKENDS) }), ['generic-http', 'placeholder']));
ok('反例：不允许反向升级（placeholder 即便把 comfyui-h3 放进白名单也拿不到候选）',
  SH.nextBackend({ from: 'placeholder', allow: ['comfyui-h3'] }) === null
  && SH.fallbackChain({ from: 'placeholder', allow: SH.PAID_BACKENDS.concat(SH.FREE_BACKENDS) }).length === 0);
ok('C1：探测不通过的目标被跳过，链上剩下的候选照旧可用（有探测证据才拦）',
  eqJSON(SH.fallbackChain({ from: 'comfyui-h3', allow: ['generic-http', 'placeholder'], probes: { placeholder: { ok: false } } }), ['generic-http'])
  && eqJSON(SH.fallbackChain({ from: 'comfyui-h3', allow: ['generic-http', 'placeholder'], probes: { 'generic-http': { ok: false }, placeholder: { ok: false } } }), []));
ok('C1：未注入任何探测证据时按「未验证即放行」处理（严格模式由调用方 requireProbe 打开）',
  eqJSON(SH.fallbackChain({ from: 'comfyui-h3', allow: ['generic-http', 'placeholder'] }), ['generic-http', 'placeholder']));

console.log('\n【6】C2 能力校验：canDegradeTo（缺关键帧/首帧/真实视频都不许换）');
ok('C2：占位后端必须已有可用关键帧，否则换过去必然再失败（missing 给中文能力名）',
  SH.canDegradeTo({ to: 'placeholder', need: { hasKeyframe: false } }).ok === false
  && SH.canDegradeTo({ to: 'placeholder', need: { hasKeyframe: false } }).missing.some((m) => m.includes('关键帧')));
ok('C2：目标模板不支持首帧输入 → 不满足（避免「以为换了支持首帧、实际产出文生视频」）',
  SH.canDegradeTo({ to: 'generic-http', facts: { supportsFirstFrame: false }, need: { needFirstFrame: true } }).ok === false);
ok('C2：需要真实视频生成时不接受 placeholder（它只是「有运动的关键帧」）',
  SH.canDegradeTo({ to: 'placeholder', need: { needRealVideo: true } }).ok === false
  && SH.canDegradeTo({ to: 'placeholder', need: { needRealVideo: true } }).missing.some((m) => m.includes('真实视频生成')));
ok('C2：能力够用时 ok=true 且 missing 为空、reason 为中文',
  SH.canDegradeTo({ to: 'placeholder' }).ok === true
  && SH.canDegradeTo({ to: 'placeholder' }).missing.length === 0
  && hasCN(SH.canDegradeTo({ to: 'placeholder' }).reason));
ok('能力损失/保留/费用口径：付费真实视频 → 免费运镜，损失含真实视频与自带音轨、费用记为免费',
  (() => { const d = SH.degradationOf({ from: 'comfyui-h3', to: 'placeholder' });
    return d.lostCapabilities.includes('真实视频生成（物理运动）') && d.lostCapabilities.includes('自带音轨')
      && d.keptCapabilities.some((k) => k.includes('交叉溶解'))
      && d.costImpact.from === 'paid' && d.costImpact.to === 'free' && d.costImpact.usageRecorded === false
      && hasCN(d.costImpact.note); })());

console.log('\n【7】纯函数决策：planSelfHeal（正常路径 / 边界 / 反例 / 幂等）');
const 计划 = (o) => SH.planSelfHeal({ from: 'comfyui-h3', stage: 'video', scopeId: 'SHOT-001', ...o });
ok('正常路径①：可退避类错误第 1 次调用失败 → 同后端重试一次（retry-same，不换后端）',
  (() => { const p = 计划({ errorKind: 'server', attempts: 1 });
    return p.action === 'retry-same' && p.to === null && p.requiresApproval === false; })());
ok('正常路径②：重试后仍失败（attempts=2）→ 沿降级链自动换到免费后端 placeholder（degrade，跳 2）',
  (() => { const p = 计划({ errorKind: 'server', attempts: 2, probes: { placeholder: { ok: true } } });
    return p.action === 'degrade' && p.to === 'placeholder' && p.chainIndex === 2 && p.requiresApproval === false && p.degraded === true; })());
ok('反例①：内容审核类 → hold-human，且给出中文建议（禁止换后端绕过审核）',
  (() => { const p = 计划({ errorKind: 'moderation', attempts: 1 });
    return p.action === 'hold-human' && p.to === null && hasCN(p.advice); })());
ok('反例②：账号类（auth）不可自愈 → hold-human，不生成任何降级目标',
  (() => { const p = 计划({ errorKind: 'auth', attempts: 1 });
    return p.action === 'hold-human' && p.to === null && p.advice.includes('Key'); })());
ok('边界①：达到单镜调用上限（attempts=3）→ stop，中文原因写明「首发 + 重试一次 + 换后端一次」',
  (() => { const p = 计划({ errorKind: 'server', attempts: 3 });
    return p.action === 'stop' && p.reason.includes('达到单镜上限 3'); })());
ok('边界②：链尾（from=placeholder）没有下一跳 → hold-human（blockedBy=C1，附中文建议）',
  (() => { const p = SH.planSelfHeal({ errorKind: 'server', from: 'placeholder', attempts: 2 });
    return p.action === 'hold-human' && p.blockedBy === 'C1' && hasCN(p.advice) && p.to === null; })());
ok('边界③：严格 C1（requireProbe=true 且未注入探测）→ 不许换，hold-human + blockedBy=C1',
  (() => { const p = 计划({ errorKind: 'server', attempts: 2, requireProbe: true });
    return p.action === 'hold-human' && p.blockedBy === 'C1'; })());
ok('边界④：注入的探测结果为不通过 → 无候选可换，hold-human + blockedBy=C1',
  (() => { const p = 计划({ errorKind: 'server', attempts: 2, probes: { placeholder: { ok: false } } });
    return p.action === 'hold-human' && p.blockedBy === 'C1'; })());
ok('边界⑤：能力不满足（本集需要真实视频）→ hold-human + blockedBy=C2，missing 给中文能力名',
  (() => { const p = 计划({ errorKind: 'server', attempts: 2, need: { needRealVideo: true } });
    return p.action === 'hold-human' && p.blockedBy === 'C2' && eqJSON(p.checks[0].missing, ['真实视频生成（该后端只是关键帧运镜）']); })());
ok('边界⑥：超时但原实例仍在线 → hold-human（不换后端，reason 说明可能只是排队/慢镜）',
  (() => { const p = 计划({ errorKind: 'timeout', attempts: 1, probes: { 'comfyui-h3': { ok: true } } });
    return p.action === 'hold-human' && p.to === null; })());
ok('幂等①：同一 (scope/scopeId/stage/from) 已降级过 1 次 → hold-human，中文原因写明事件号',
  (() => { const p = 计划({ errorKind: 'server', attempts: 2, switches: 1, lastEventId: 'SH-PREV-9' });
    return p.action === 'hold-human' && p.reason.includes('已自动降级过 1 次') && p.reason.includes('SH-PREV-9')
      && p.advice.includes('只允许换一次后端'); })());
ok('幂等②：同一入参连续调用两次结果逐字一致（纯函数，无隐藏状态）',
  (() => { const 入参 = { errorKind: 'server', from: 'comfyui-h3', attempts: 2, probes: { placeholder: { ok: true } } };
    return eqJSON(计划(入参), 计划(入参)); })());
ok('C3 闸门：队列暂停中 → stop + blockedBy=C3（不换后端、不提交任务，任务保留）',
  (() => { const p = 计划({ errorKind: 'server', attempts: 1, paused: true });
    return p.action === 'stop' && p.blockedBy === 'C3' && p.reason.includes('暂停'); })());
ok('C3 闸门：外部闸门未放行（gate.ok=false）→ stop，沿用闸门给的中文原因',
  (() => { const p = 计划({ errorKind: 'server', attempts: 1, gate: { ok: false, reason: '月度预算已超支' } });
    return p.action === 'stop' && p.reason.includes('月度预算已超支'); })());
ok('策略模式：off 与 report 都只硬停不换后端（report 会给出中文说明）',
  (() => { const off = 计划({ errorKind: 'server', attempts: 1, policy: { mode: 'off' } });
    const rep = 计划({ errorKind: 'server', attempts: 1, policy: { mode: 'report' } });
    return off.action === 'stop' && rep.action === 'stop' && hasCN(rep.reason); })());
ok('熔断：同阶段连续 3 个同类可自愈错误触发阶段级降级，2 个不触发',
  SH.shouldTripStageDegrade({ consecutive: 3 }) === true && SH.shouldTripStageDegrade({ consecutive: 2 }) === false
  && SH.shouldTripStageDegrade({ consecutive: 2, threshold: 2 }) === true);

console.log('\n【8】中文告知：degradeNotice / describeHeal（任何输入都必须非空，禁止静默）');
const 告知降级 = SH.describeHeal({
  degraded: true, errorKind: 'server', errorLabel: ERROR_KINDS.server.label, from: 'comfyui-h3', to: 'placeholder',
  retryTimes: 1, lostCapabilities: ['真实视频生成（物理运动）'], keptCapabilities: ['关键帧一致性'],
  costImpact: { note: '本条由付费后端降级为本地免费运镜' }, consistency: { note: '本集自第 7 镜起改用 placeholder' },
  eventId: EVT,
});
ok('已降级告知：把「换了什么/损失/保留/费用/一致性/事件号」讲全（中文，含 ⚠️ 与非空事件号）',
  hasCN(告知降级) && 告知降级.includes('⚠️ 已自动降级后端：comfyui-h3 → placeholder')
  && 告知降级.includes('损失：') && 告知降级.includes('保留：') && 告知降级.includes('费用：')
  && 告知降级.includes('一致性：') && 告知降级.includes('请人工复看后再交付') && 告知降级.includes(EVT), 告知降级.split('\n')[0]);
const 告知待批 = SH.describeHeal({
  errorKind: 'network', errorLabel: ERROR_KINDS.network.label, from: 'comfyui-h3', to: 'generic-http',
  retryTimes: 1, requiresApproval: true, eventId: EVT,
});
ok('待人工批准告知：写明「只备好方案、不会自动执行、需人工批准」（付费后端不自动切换）',
  hasCN(告知待批) && 告知待批.includes('已备好降级方案') && 告知待批.includes('不会自动执行') && 告知待批.includes('人工批准'), 告知待批.split('\n')[0]);
const 告知未降级 = SH.describeHeal({ errorKind: 'moderation', from: 'comfyui-h3', reason: '内容侧红线', advice: '请改提示词' });
ok('未自愈告知：给出中文原因 + 可执行建议，且审核类额外标注内容侧红线',
  hasCN(告知未降级) && 告知未降级.includes('未自动降级') && 告知未降级.includes('内容侧红线')
  && 告知未降级.includes('原因：') && 告知未降级.includes('建议：请改提示词'), 告知未降级.split('\n')[0]);
ok('告知兜底：任何输入（含空对象/null/undefined）都返回非空字符串（I1：没有告知就不许换后端）',
  [ {}, null, undefined, { degraded: true }, { requiresApproval: true, from: 'a', to: 'b' } ]
    .every((rec) => { const n = SH.describeHeal(rec); return typeof n === 'string' && n.trim().length > 0; }));
ok('汇总 degradeSummary：统计次数/降级对数/告知条数/事件号，并置 needsHumanReview=true（降级产物必须人工复看）',
  (() => { const s = SH.degradeSummary([
    { degraded: true, from: 'comfyui-h3', to: 'placeholder', notice: 'n1', eventId: 'SH-1' },
    { action: 'hold-human', from: 'comfyui-h3', notice: 'n2' },
    { healed: true, from: 'generic-http', to: 'placeholder', notice: 'n1', id: 'SH-2' },
  ]);
    return s.count === 3 && s.healed === 2 && s.switched === 2
      && eqJSON(s.pairs, ['comfyui-h3→placeholder', 'generic-http→placeholder'])
      && eqJSON(s.eventIds, ['SH-1', 'SH-2']) && s.needsHumanReview === true; })());
ok('汇总 degradeSummary：空列表也给出结构完整的零值（不抛错）',
  (() => { const s = SH.degradeSummary([]);
    return s.count === 0 && s.healed === 0 && s.pairs.length === 0 && s.needsHumanReview === false; })());

console.log('\n【9】端到端（假执行器计数）：正常路径 / 重试 / 降级；账本先写后生成');
{
  const f = makeFake([]);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, stage: 'video', scope: 'shot', scopeId: 'SHOT-001', now: fixedNow });
  ok('端到端·首发成功：只调用 1 次生成、不发生降级、不需要人工复看',
    f.calls.length === 1 && 呼叫后端(f) === 'comfyui-h3' && r.ok === true && r.degraded === false
    && r.healed === false && r.needsHumanReview === false && r.calls === 1 && r.attempts === 1,
    `调用 ${f.calls.length} 次 / ok=${r.ok}`);
  ok('端到端·首发成功：结果字段完整（from/attempts/notice/policyMode/at 等权威字段都在，at 用注入的固定时间戳）',
    ['ok', 'action', 'degraded', 'healed', 'from', 'to', 'backend', 'errorKind', 'errorLabel', 'errorExcerpt', 'fault',
      'attempts', 'calls', 'switches', 'retried', 'chainIndex', 'blockedBy', 'requiresApproval', 'needsHumanReview',
      'eventId', 'reason', 'advice', 'notice', 'lostCapabilities', 'keptCapabilities', 'costImpact', 'consistency',
      'at', 'policyMode'].every((k) => k in r) && r.at === FIXED_AT && r.policyMode === 'auto-free');
}
{
  const f = makeFake([E500()]);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, stage: 'video', scopeId: 'SHOT-002', now: fixedNow });
  ok('端到端·同后端重试一次成功：2 次调用都在原后端、不降级、结果 retried=1',
    f.calls.length === 2 && 呼叫后端(f) === 'comfyui-h3→comfyui-h3' && r.ok === true && r.degraded === false
    && r.retried === 1 && r.needsHumanReview === false, 呼叫后端(f));
  ok('端到端·重试那次调用显式关掉既有退避（retries=0 / only=[]，避免与 withRetry 叠加）',
    f.calls[1].info.retries === 0 && Array.isArray(f.calls[1].info.only) && f.calls[1].info.only.length === 0);
}
{
  const f = makeFake([E500(), E500()]);
  const led = makeLedger(f.order);
  const r = await SH.runWithHeal({
    backend: 'comfyui-h3', run: f.run, stage: 'video', scope: 'shot', scopeId: 'SHOT-003',
    record: led.record, eventId: EVT, now: fixedNow,
  });
  ok('端到端·成功自愈：顺序为 原后端首发 → 原后端重试 → 写账本 → 新后端生成（先落账再执行，禁止静默换后端）',
    eqJSON(f.order, ['run:comfyui-h3', 'run:comfyui-h3', 'record', 'run:placeholder']) && 呼叫后端(f) === 'comfyui-h3→comfyui-h3→placeholder',
     f.order.join(' | '));
  ok('端到端·成功自愈：结果里明确写清换了什么（healed/to/from/chainIndex/损失/费用/一致性）',
    r.ok === true && r.healed === true && r.degraded === true && r.from === 'comfyui-h3' && r.to === 'placeholder'
    && r.chainIndex === 2 && r.lostCapabilities.includes('真实视频生成（物理运动）') && r.lostCapabilities.includes('自带音轨')
    && r.costImpact.from === 'paid' && r.costImpact.to === 'free' && r.costImpact.usageRecorded === false
    && r.consistency.locked === true && r.eventId === EVT, JSON.stringify({ to: r.to, lost: r.lostCapabilities }));
  ok('端到端·成功自愈：告知非空且逐项讲全（中文 + 换向箭头 + 事件号 + 人工复看），needsHumanReview=true',
    r.notice.includes('⚠️ 已自动降级后端：comfyui-h3 → placeholder') && r.notice.includes('损失：')
    && r.notice.includes('保留：') && r.notice.includes('费用：') && r.notice.includes('一致性：')
    && r.notice.includes(EVT) && r.needsHumanReview === true && hasCN(r.notice));
  ok('端到端·成功自愈：新后端那次调用带 retries=0 / only=[] / degraded=true 与同一事件号（一次性、不叠加退避）',
    f.calls[2].info.retries === 0 && eqJSON(f.calls[2].info.only, []) && f.calls[2].info.degraded === true && f.calls[2].info.eventId === EVT);
  ok('端到端·账本落账字段完整：id/scope/scope_id/stage/error_kind/from_backend/to_backend/action/notify/created_at',
    led.events.length === 1 && led.events[0].id === EVT && led.events[0].scope === 'shot' && led.events[0].scope_id === 'SHOT-003'
    && led.events[0].stage === 'video' && led.events[0].action === 'degrade' && led.events[0].from_backend === 'comfyui-h3'
    && led.events[0].to_backend === 'placeholder' && led.events[0].error_kind === 'server'
    && led.events[0].notify.trim().length > 0 && led.events[0].created_at === FIXED_AT);
}
{
  const f = makeFake([E500(), E500()]);
  const led = makeLedger(f.order, 'throw');
  let 抛错 = null;
  try { await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, stage: 'video', scopeId: 'SHOT-004', record: led.record, now: fixedNow }); }
  catch (e) { 抛错 = e; }
  ok('I1 反例·账本写不进：抛中文错误（含「未能写入降级告知记录」「禁止静默换后端」）',
    抛错 instanceof Error && 抛错.message.includes('未能写入降级告知记录') && 抛错.message.includes('禁止静默换后端') && hasCN(抛错.message),
    抛错 ? 抛错.message : '未抛错');
  ok('I1 反例·账本写不进：放弃切换后端，切换后的那次生成调用为 0（账本没记录 = 生成不可能发生）',
    f.calls.length === 2 && 呼叫后端(f) === 'comfyui-h3→comfyui-h3' && !f.calls.some((c) => c.backend === 'placeholder'),
    呼叫后端(f));
}
{
  const f = makeFake([E500(), E500()]);
  const led = makeLedger(f.order, 'empty');
  let 抛错 = null;
  try { await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, scopeId: 'SHOT-005', record: led.record, now: fixedNow }); }
  catch (e) { 抛错 = e; }
  ok('I1 反例·账本未返回事件 id：同样抛中文错误且零额外生成调用（fail-closed）',
    抛错 instanceof Error && 抛错.message.includes('账本未返回事件 id') && f.calls.length === 2);
}
{
  const f = makeFake([E500(), E500()]);
  let 抛错 = null;
  try {
    await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, scopeId: 'SHOT-006', policy: { requireRecord: true }, now: fixedNow });
  } catch (e) { 抛错 = e; }
  ok('I1 反例·策略要求落账但没注入写入函数：抛中文错误，不静默换后端',
    抛错 instanceof Error && 抛错.message.includes('requireRecord') && 抛错.message.includes('禁止静默换后端') && f.calls.length === 2);
}

console.log('\n【10】端到端反例：不可自愈不换后端 / 链尾耗尽 / 付费跳需批准');
{
  const f = makeFake([E('内容审核不通过：sensitive content')]);
  const led = makeLedger(f.order);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, stage: 'video', scopeId: 'SHOT-007', record: led.record, now: fixedNow });
  ok('反例·审核类永不换后端：只发生 1 次生成调用、无降级、无误写账本（I4 红线）',
    f.calls.length === 1 && 呼叫后端(f) === 'comfyui-h3' && r.action === 'hold-human' && r.to === null
    && r.degraded === false && led.events.length === 0, 呼叫后端(f));
  ok('反例·审核类：结果带中文告知与中文建议（禁止换后端绕过审核 + 改提示词/人工复核）',
    r.notice.includes('内容侧红线') && r.notice.includes('禁止换后端绕过审核') && hasCN(r.advice));
}
{
  const f = makeFake([ENET(), ENET()]);
  const r = await SH.runWithHeal({ backend: 'placeholder', run: f.run, stage: 'video', scopeId: 'SHOT-008', now: fixedNow });
  ok('反例·降级链耗尽：链尾（placeholder）重试后仍失败 → hold-human、blockedBy=C1、不再多打一次生成',
    f.calls.length === 2 && r.action === 'hold-human' && r.blockedBy === 'C1' && r.degraded === false && r.to === null, 呼叫后端(f));
  ok('反例·降级链耗尽：给中文说明与建议（说明链上没有可用后端 + 探测证据 + 交人处理）',
    r.reason.includes('没有可用的降级目标') && r.notice.includes('建议：') && hasCN(r.notice));
}
{
  const f = makeFake([E500(), E500()]);
  const r = await SH.runWithHeal({
    backend: 'comfyui-h3', run: f.run, stage: 'video', scopeId: 'SHOT-009',
    policy: { mode: 'allow-paid', allowPaidSwitch: true }, now: fixedNow,
  });
  ok('I3·付费跳未获人工批准：只给方案不执行（无第 3 次生成调用、requiresApproval=true、degraded=false）',
    f.calls.length === 2 && r.action === 'hold-human' && r.to === 'generic-http' && r.requiresApproval === true
    && r.degraded === false && r.healed === false, `to=${r.to} req=${r.requiresApproval}`);
  ok('I3·付费跳：告知写明「换供应商会再次计费、不会自动执行、需人工批准」',
    r.notice.includes('已备好降级方案：comfyui-h3 → generic-http') && r.notice.includes('再次计费')
    && r.notice.includes('不会自动执行') && r.notice.includes('人工批准'));
}
{
  const f = makeFake([E500(), E500()]);
  const led = makeLedger(f.order);
  const r = await SH.runWithHeal({
    backend: 'comfyui-h3', run: f.run, stage: 'video', scopeId: 'SHOT-010', approved: true,
    policy: { mode: 'allow-paid', allowPaidSwitch: true }, record: led.record, now: fixedNow,
  });
  ok('I3·付费跳已获人工批准：才允许换到 generic-http，且结果仍标 requiresApproval=true + 付费费用口径',
    f.calls.length === 3 && 呼叫后端(f) === 'comfyui-h3→comfyui-h3→generic-http'
    && r.healed === true && r.to === 'generic-http' && r.requiresApproval === true
    && r.costImpact.from === 'paid' && r.costImpact.to === 'paid', 呼叫后端(f));
}

console.log('\n【11】端到端幂等与边界：已降级过不再换 / 上限 / 暂停 / 严格探测 / 换后端后仍失败');
{
  const f = makeFakeAlways(E500);
  const 入参 = {
    backend: 'comfyui-h3', run: f.run, stage: 'video', scope: 'shot', scopeId: 'SHOT-011',
    switches: 1, lastEventId: 'SH-PREV-7', now: fixedNow,
  };
  const r1 = await SH.runWithHeal(入参);
  const 第一次调用数 = f.calls.length;
  const r2 = await SH.runWithHeal(入参);
  ok('幂等·同一 (scope/scopeId/stage/from) 已降级过 1 次：第二次触发不再换后端（每次只 2 次生成调用）',
    第一次调用数 === 2 && r1.action === 'hold-human' && r1.to === null && r1.degraded === false
    && r1.reason.includes('已自动降级过 1 次') && r1.reason.includes('SH-PREV-7') && f.calls.length === 4, 呼叫后端(f));
  ok('幂等·重复触发结果稳定：两次结果的中文原因与建议逐字一致（不会越跑越多降级）',
    r2.action === r1.action && r2.reason === r1.reason && r2.advice === r1.advice && r2.notice === r1.notice);
}
{
  const f = makeFake([]);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, stage: 'video', scopeId: 'SHOT-012', attempts: 3, now: fixedNow });
  ok('边界·起点就已达单镜调用上限（attempts=3）→ 0 次生成调用、stop、中文原因写明上限',
    f.calls.length === 0 && r.action === 'stop' && r.reason.includes('达到单镜上限 3') && r.ok === false, `调用 ${f.calls.length} 次`);
}
{
  const f = makeFake([E500()]);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, stage: 'video', scopeId: 'SHOT-013', attempts: 1, now: fixedNow });
  ok('边界·跨重启 attempts 已累计 1 次：不再重复同后端重试，直接走降级链（首发 + 换后端 = 2 次调用）',
    f.calls.length === 2 && 呼叫后端(f) === 'comfyui-h3→placeholder' && r.attempts === 3, 呼叫后端(f));
}
{
  const f = makeFake([E500()]);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, paused: true, scopeId: 'SHOT-014', now: fixedNow });
  ok('边界·C3 暂停闸门：不重试不换后端（切到暂停态只发生首发那 1 次调用），stop + blockedBy=C3',
    f.calls.length === 1 && r.action === 'stop' && r.blockedBy === 'C3' && r.degraded === false);
}
// ★ W3 验收 R-W3-03 修复后口径变更（**期望变严，不是放宽**）：旧断言写的是「只首发 1 次调用」，
//   那正是被验收判为缺陷的行为（文案承诺「不重试」，实测仍执行一次同后端重跑并建 job）。
//   修后要求：off/report 下 runWithHeal **一次生成调用都不发起**（calls=0），故此处由 1 改为 0。
//   判别力对照见下方 auto-free 用例（同造景下确实会动手）。
for (const mode of ['off', 'report']) {
  const f = makeFake([E500()]);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, policy: { mode }, scopeId: 'SHOT-015', now: fixedNow });
  ok(`边界·策略 ${mode}：不重试不换后端**且零生成调用**（mode 判定前移到首发之前），并给出中文原因`,
    f.calls.length === 0 && r.calls === 0 && r.action === 'stop' && r.degraded === false && r.attempted === false
    && r.selfHealSkipped === true && hasCN(r.reason) && r.reason.includes('不发起任何生成调用'), r.reason);
}
{
  // 判别力对照（同一造景、同一假执行器）：auto-free 下**确实**会动手 —— 证明上面的 0 次调用来自门控，而不是「把自愈关死」
  const f = makeFake([E500(), E500()]);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, policy: { mode: 'auto-free' }, scopeId: 'SHOT-015A', now: fixedNow });
  ok('门控·auto-free 对照（判别力）：同一造景下照样动手（≥1 次生成调用、attempted≠false、无 healSkipped 标记）',
    f.calls.length >= 1 && r.attempted !== false && r.selfHealSkipped !== true && r.action !== null, `calls=${f.calls.length} action=${r.action}`);
}
{
  // 唯一例外：显式允许（opts.allowHeal=true）才可越过 off/report —— 「明示同意」才允许重试/降级
  const f = makeFake([E500(), E500()]);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, policy: { mode: 'off' }, allowHeal: true, scopeId: 'SHOT-015B', now: fixedNow });
  ok('门控·显式允许是唯一例外：mode=off + allowHeal=true 时才动手（≥1 次生成调用），默认不传则一动不动',
    f.calls.length >= 1 && r.selfHealSkipped !== true, `calls=${f.calls.length} mode=${r.policyMode}`);
}
{
  const f = makeFake([E500(), E500()]);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, requireProbe: true, scopeId: 'SHOT-016', now: fixedNow });
  ok('边界·严格 C1（requireProbe=true 且未注入目标探测）：放弃切换，hold-human + blockedBy=C1',
    f.calls.length === 2 && r.action === 'hold-human' && r.blockedBy === 'C1' && !f.calls.some((c) => c.backend === 'placeholder'));
}
{
  const f = makeFake([E500(), E500()]);
  const r = await SH.runWithHeal({
    backend: 'comfyui-h3', run: f.run, scopeId: 'SHOT-017', now: fixedNow,
    probeOf: async () => { throw new Error('探测通道故障'); },
  });
  ok('反例·目标探测抛异常：按「探测未通过」处理（不换后端），hold-human + blockedBy=C1',
    f.calls.length === 2 && r.action === 'hold-human' && r.blockedBy === 'C1' && r.degraded === false);
}
{
  const f = makeFake([E500(), E500()]);
  const r = await SH.runWithHeal({
    backend: 'comfyui-h3', run: f.run, scopeId: 'SHOT-018', now: fixedNow, need: { needRealVideo: true },
  });
  ok('反例·C2 能力不足：不降到只会关键帧运镜的后端，hold-human + blockedBy=C2 + missing 中文能力名',
    f.calls.length === 2 && r.action === 'hold-human' && r.blockedBy === 'C2'
    && r.matched[0].missing.some((m) => m.includes('真实视频生成')));
}
{
  const f = makeFake([E500(), E500(), E500()]);
  const led = makeLedger(f.order);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, stage: 'video', scopeId: 'SHOT-019', record: led.record, now: fixedNow });
  ok('反例·换后端后仍失败：如实失败不静默（ok=false），但降级事实与账本必须保留（healed=true + 已落账）',
    f.calls.length === 3 && r.ok === false && r.degraded === true && r.healed === true && led.events.length === 1
    && r.advice.includes('只允许一次'));
  ok('反例·换后端后仍失败：告知在原告知后追加中文失败说明（不吞掉原告知）',
    r.notice.includes('⚠️ 已自动降级后端：comfyui-h3 → placeholder') && r.notice.includes('换后端后仍失败'));
}
{
  let 抛错1 = null, 抛错2 = null;
  try { await SH.runWithHeal({ backend: 'comfyui-h3', now: fixedNow }); } catch (e) { 抛错1 = e; }
  try { await SH.runWithHeal({ run: async () => 1, now: fixedNow }); } catch (e) { 抛错2 = e; }
  ok('参数守卫·未注入 run：抛中文错误说明本模块不直接发起生成调用',
    抛错1 instanceof Error && 抛错1.message.includes('需要注入 run') && hasCN(抛错1.message), 抛错1?.message);
  ok('参数守卫·未给起始后端：抛中文错误说明 backend 不能为空',
    抛错2 instanceof Error && 抛错2.message.includes('缺少 backend') && hasCN(抛错2.message), 抛错2?.message);
}
{
  const f = makeFake([E('ComfyUI 视频生成超时（等待 900000ms 仍未完成）')]);
  const r = await SH.runWithHeal({
    backend: 'comfyui-h3', run: f.run, scopeId: 'SHOT-020', now: fixedNow,
    probeOf: async (b) => (b === 'comfyui-h3' ? { ok: true, detail: '实例仍在线' } : { ok: true, detail: '可用' }),
  });
  ok('端到端·超时阶梯（原实例在线）：不换后端，只 1 次生成调用（避免丢掉已跑完并计费的计算）',
    f.calls.length === 1 && r.action === 'hold-human' && r.errorKind === 'timeout' && r.probe.from.ok === true);
}
{
  const f = makeFake([E('ComfyUI 视频生成超时（等待 900000ms 仍未完成）')]);
  const led = makeLedger(f.order);
  const r = await SH.runWithHeal({
    backend: 'comfyui-h3', run: f.run, scopeId: 'SHOT-021', now: fixedNow, record: led.record,
    probeOf: async (b) => (b === 'comfyui-h3' ? { ok: false, detail: '容器已被回收' } : { ok: true, detail: '可用' }),
  });
  ok('端到端·超时阶梯（原实例已不可用）：才允许沿链换后端，探测证据写进结果 probe',
    f.calls.length === 2 && 呼叫后端(f) === 'comfyui-h3→placeholder' && r.healed === true && r.to === 'placeholder'
    && r.probe.from.ok === false && led.events.length === 1, 呼叫后端(f));
}

console.log('\n【12】阶段级熔断与降级比例告警（W2 接线：采样 → 阈值比较 → 动作；本段为追加断言，未改上面任何既有期望）');

// ---------- 12.1 纯函数：连续失败采样（跨重启的持久化位由集成侧写 app_config） ----------
ok('熔断采样位键规则 selfheal:trip:<productionId>:<stage>（与 jobs:paused 同库不同键，不写进 config/config.json）',
  SH.TRIP_KEY_PREFIX === 'selfheal:trip:'
  && SH.tripKeyOf({ productionId: 'PROD-1', stage: 'video' }) === 'selfheal:trip:PROD-1:video'
  && SH.tripKeyOf({}) === 'selfheal:trip:unknown:unknown'
  && SH.tripKeyOf({ productionId: 'PROD-1', stage: 'keyframe' }) !== SH.tripKeyOf({ productionId: 'PROD-1', stage: 'video' }));
ok('采样·成功清零：ok=true → consecutive 归零、errorKind 清空、tripped=false，但 trips 累计保留',
  (() => {
    const s = SH.nextTripState({ prev: { consecutive: 2, errorKind: 'server', tripped: false, trips: 1, firstAt: FIXED_AT }, errorKind: 'server', ok: true, at: FIXED_AT });
    return s.consecutive === 0 && s.errorKind === null && s.tripped === false && s.trips === 1;
  })());
ok('采样·连续同类失败累加：server 连续 3 次 → consecutive=3、tripped=true（阈值 3）',
  (() => {
    const s1 = SH.nextTripState({ prev: null, errorKind: 'server', at: FIXED_AT });
    const s2 = SH.nextTripState({ prev: s1, errorKind: 'server', at: FIXED_AT });
    const s3 = SH.nextTripState({ prev: s2, errorKind: 'server', at: FIXED_AT });
    return s1.consecutive === 1 && s2.consecutive === 2 && s3.consecutive === 3 && s3.tripped === true && s3.trips === 1;
  })());
ok('采样·换类别重置：server → network → consecutive=1（不同类故障不合并计数）',
  (() => {
    const a = SH.nextTripState({ prev: { consecutive: 2, errorKind: 'server' }, errorKind: 'server', at: FIXED_AT });
    const b = SH.nextTripState({ prev: a, errorKind: 'network', at: FIXED_AT });
    return a.consecutive === 3 && b.consecutive === 1 && b.tripped === false && b.trips === 1;
  })());
ok('采样·不可自愈类别不计入：healable=false 原样返回（审核/配额只交人，I4 红线的延伸）',
  (() => {
    const s = SH.nextTripState({ prev: { consecutive: 2, errorKind: 'server', tripped: false, trips: 0 }, errorKind: 'moderation', healable: false, at: FIXED_AT });
    return s.consecutive === 2 && s.errorKind === 'server' && s.tripped === false && s.trips === 0;
  })());
ok('采样·阈值边界：threshold=2 时 consecutive=2 → tripped=true、1 → false（阈值取自 policy.tripThreshold）',
  (() => {
    const a = SH.nextTripState({ prev: { consecutive: 1, errorKind: 'server' }, errorKind: 'server', threshold: 2, at: FIXED_AT });
    const b = SH.nextTripState({ prev: null, errorKind: 'server', threshold: 2, at: FIXED_AT });
    return a.tripped === true && a.threshold === 2 && b.tripped === false && b.consecutive === 1;
  })());
ok('采样·trips 不重复计数：跨过阈值只 +1、持续熔断不再 +1、恢复后再次跨过才 +2',
  (() => {
    let s = SH.nextTripState({ prev: null, errorKind: 'server', at: FIXED_AT });
    s = SH.nextTripState({ prev: s, errorKind: 'server', at: FIXED_AT });
    const 跨阈值 = SH.nextTripState({ prev: s, errorKind: 'server', at: FIXED_AT });
    const 仍熔断 = SH.nextTripState({ prev: 跨阈值, errorKind: 'server', at: FIXED_AT });
    let r = SH.nextTripState({ prev: 仍熔断, ok: true, at: FIXED_AT });
    r = SH.nextTripState({ prev: r, errorKind: 'server', at: FIXED_AT });
    r = SH.nextTripState({ prev: r, errorKind: 'server', at: FIXED_AT });
    const 第二次跨阈值 = SH.nextTripState({ prev: r, errorKind: 'server', at: FIXED_AT });
    return 跨阈值.trips === 1 && 仍熔断.trips === 1 && 第二次跨阈值.trips === 2;
  })());
ok('采样·损坏/缺失的采样值不抛错（坏 KV 不该把阶段卡死：一律按「没采过样」处理）',
  [null, undefined, 'x', 3, {}, { consecutive: 'NaN', trips: -5 }].every((prev) => {
    const s = SH.nextTripState({ prev, errorKind: 'server', at: FIXED_AT });
    return s.consecutive === 1 && s.trips === 0 && s.threshold === SH.DEGRADE_TRIP_THRESHOLD;
  }));

// ---------- 12.2 纯函数：降级比例告警 ----------
ok('比例·分母为 0 → ratio=0（绝不是 NaN）、不告警、不抛错（与 cullStats 的 ratio 口径一致）',
  (() => {
    const s = SH.degradeRatioState({ degraded: 0, total: 0 });
    return s.ratio === 0 && Number.isNaN(s.ratio) === false && s.alert === false && s.total === 0;
  })());
ok('比例·比例分支边界：3/11（27.3%，降级数 <5）→ 不告警；4/13（30.8%）→ 告警',
  SH.degradeRatioState({ degraded: 3, total: 11 }).alert === false
  && SH.degradeRatioState({ degraded: 4, total: 13 }).alert === true);
ok('比例·降级数分支：5/50（10%，比例不足）→ 仍告警（大集里 30% 门槛过高的兜底，契约「≥30% 或 ≥5 镜」）',
  SH.degradeRatioState({ degraded: 5, total: 50 }).alert === true
  && SH.degradeRatioState({ degraded: 5, total: 50 }).minCount === SH.DEGRADE_RATIO_MIN_COUNT
  && SH.degradeRatioState({ degraded: 4, total: 50 }).alert === false);
ok('比例·中文理由：告警时含「降级 N/M」「阈值」与「恢复队列」（暂停是持久化的，重启不会自动恢复）',
  (() => {
    const on = SH.degradeRatioState({ degraded: 3, total: 10, threshold: 0.3 });
    const off = SH.degradeRatioState({ degraded: 1, total: 10, threshold: 0.3 });
    return on.alert === true && hasCN(on.reason) && on.reason.includes('3/10') && on.reason.includes('30%')
      && on.reason.includes('恢复') && on.reason.includes('重启不会自动恢复')
      && off.alert === false && hasCN(off.reason) && off.reason.includes('未超过降级比例阈值');
  })());
ok('告知·trip 模板：中文、含阶段名/连续次数/阈值/「熔断」，且写明本次零生成调用',
  (() => {
    const n = SH.tripNotice({ kind: 'trip', stage: 'video', consecutive: 3, threshold: 3, errorKind: 'server', errorLabel: '服务端错误（5xx）' });
    return hasCN(n) && n.includes('阶段级熔断') && n.includes('video') && n.includes('连续 3 次')
      && n.includes('阈值 3') && n.includes('零生成调用') && n.length > 40;
  })());
ok('告知·ratio 模板：中文、含降级数量与百分比、含「人工复看」（两种模板共用同一实现，不在别处再写文案）',
  (() => {
    const n = SH.tripNotice({ kind: 'ratio', stage: 'video', ratioState: SH.degradeRatioState({ degraded: 3, total: 10 }), from: 'comfyui-h3', to: 'placeholder' });
    return hasCN(n) && n.includes('降级比例告警') && n.includes('3/10') && n.includes('comfyui-h3 → placeholder') && n.includes('人工复看');
  })());
ok('告知·缺字段兜底：未知阶段 / 空 ratioState 也返回非空中文（不抛错）',
  [SH.tripNotice({}), SH.tripNotice({ kind: 'ratio' }), SH.tripNotice({ kind: 'trip', stage: '', errorKind: 'unknown' })]
    .every((n) => typeof n === 'string' && n.trim().length > 0 && hasCN(n)));

// ---------- 12.3 触发点①：阶段级熔断（真跑 src/studio.js 的阶段自愈路径；熔断分支零生成调用 → 可离线证伪） ----------
const DB2 = await import('../src/db.js');
// 起始后端用付费的 comfyui-h3：证明熔断发生在「动手换后端之前」（否则会真花钱）
fs.writeFileSync(CFG, JSON.stringify({ llm: { provider: 'mock' }, video: { backend: 'comfyui-h3' } }), 'utf8');
const St = await import('../src/studio.js');
const J = await import('../src/jobs.js');
DB2.migrate();
St.ensureStudioSchema();

const PID = 'PROD-TRIP-001';
const CID = 'CV-TRIP-001';
const ERR = '视频接口 500: internal server error';           // kind=server（可自愈类别）
const 预置采样 = { consecutive: 2, errorKind: 'server', threshold: 3, tripped: false, trips: 0, firstAt: FIXED_AT, lastAt: FIXED_AT };
DB2.run('INSERT OR REPLACE INTO productions(id, title, brief, spec, status, canvas_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
  PID, '熔断联调项目', '测试', JSON.stringify({}), 'error', CID, FIXED_AT, FIXED_AT);
DB2.run('INSERT OR REPLACE INTO production_stages(id, production_id, stage, seq, status, artifact, error, updated_at) VALUES(?,?,?,?,?,?,?,?)',
  'PS-TRIP-001', PID, 'video', 6, 'error', JSON.stringify({ nodeIds: ['N1', 'N2'] }), ERR, FIXED_AT);
for (const [i, st] of [['N1', 'error'], ['N2', 'error'], ['N3', 'done']]) {
  DB2.run('INSERT OR REPLACE INTO canvas_nodes(id, canvas_id, actor_id, kind, title, data) VALUES(?,?,?,?,?,?)',
    i, CID, 'ACT-TEST', 'video', `镜头${i}`, JSON.stringify(st === 'error' ? { status: 'error', lastError: ERR } : { status: 'done' }));
}
const TKEY = SH.tripKeyOf({ productionId: PID, stage: 'video' });
DB2.setConfigValue(TKEY, 预置采样);
const jobsBefore = Number(DB2.get('SELECT COUNT(*) AS n FROM jobs')?.n) || 0;
const 日志 = [];
const heal1 = await St.healVideoStage(PID, { onLog: (m) => 日志.push(String(m)) });
ok('触发点①熔断·第 3 次同类失败即熔断：healVideoStage 返回 tripped=true + hold-human + **零生成调用**（熔断在动手之前）',
  heal1.tripped === true && heal1.action === 'hold-human' && heal1.calls === 0 && heal1.ok === false && heal1.skipped === true,
  JSON.stringify({ tripped: heal1.tripped, calls: heal1.calls, action: heal1.action }));
ok('触发点①熔断·如实失败 + 中文说明：reason/notice/advice 均为中文且写明连续次数与阈值',
  hasCN(heal1.reason) && hasCN(heal1.notice) && hasCN(heal1.advice)
  && heal1.reason.includes('阶段级熔断') && heal1.reason.includes('连续 3 次') && heal1.reason.includes('阈值 3')
  && heal1.notice.includes('零生成调用'), heal1.reason);
ok('触发点①熔断·零生成调用落到实处：没有新增 jobs 行、账本里也没有降级记录（不花钱、不换后端）',
  (Number(DB2.get('SELECT COUNT(*) AS n FROM jobs')?.n) || 0) === jobsBefore
  && (Number(DB2.get('SELECT COUNT(*) AS n FROM selfheal_events WHERE scope_id = ?', PID)?.n) || 0) === 0
  && 日志.some((l) => l.includes('阶段级熔断')));
ok('触发点①熔断·采样位跨进程落库：app_config[selfheal:trip:<id>:video] → consecutive=3 / tripped=true / trips=1',
  (() => {
    const s = DB2.getConfigValue(TKEY, null);
    return s && s.consecutive === 3 && s.tripped === true && s.trips === 1 && s.errorKind === 'server' && s.threshold === 3;
  })(), JSON.stringify(DB2.getConfigValue(TKEY, null)));
ok('触发点①熔断·阶段如实标 error，且熔断事实写进 artifact.selfHeal（路由/时间线可直接只读消费）',
  (() => {
    const row = DB2.get('SELECT status, error, artifact FROM production_stages WHERE production_id = ? AND stage = ?', PID, 'video');
    const art = JSON.parse(row?.artifact || '{}');
    return row?.status === 'error' && String(row?.error || '').includes('阶段级熔断')
      && art.selfHeal?.tripped === true && art.selfHeal?.consecutive === 3 && art.selfHeal?.trips === 1
      && art.selfHeal?.tripKey === TKEY && typeof art.selfHeal?.notice === 'string' && art.selfHeal.notice.length > 0;
  })());
const heal2 = await St.healVideoStage(PID, { onLog: () => {} });
ok('触发点①熔断·持续熔断：再次触发仍 hold-human、仍零生成调用，trips 不重复计数（仍为 1）',
  heal2.tripped === true && heal2.calls === 0 && heal2.action === 'hold-human'
  && DB2.getConfigValue(TKEY, null).trips === 1 && (Number(DB2.get('SELECT COUNT(*) AS n FROM jobs')?.n) || 0) === jobsBefore);
// 把失败原因换成「审核不通过」：不可自愈类别，必须只交人、且**不得**计入熔断采样（I4 红线的延伸）
for (const id of ['N1', 'N2']) {
  DB2.run('UPDATE canvas_nodes SET data = ? WHERE id = ?', JSON.stringify({ status: 'error', lastError: '内容审核不通过：sensitive content' }), id);
}
const 审核前采样 = DB2.getConfigValue(TKEY, null);
const heal3 = await St.healVideoStage(PID, { onLog: () => {} });
ok('触发点①熔断·审核类只交人：不换后端、不新增熔断计数（healable=false 时采样器原样返回 prev）',
  heal3.healable === false && heal3.skipped === true && heal3.degraded === false
  && String(heal3.notice || '').includes('内容侧红线')
  && eqJSON(DB2.getConfigValue(TKEY, null), 审核前采样) && 审核前采样.trips === 1,
  JSON.stringify({ healable: heal3.healable, 前后: [审核前采样.consecutive, DB2.getConfigValue(TKEY, null).consecutive] }));

// ---------- 12.4 触发点②：降级比例告警 → pauseQueues(by:'system') + 中文理由 ----------
if (J.pauseState().paused) J.resumeQueues({ by: 'test' });
const 反例 = await St.applyDegradedRatioAlert({ stage: 'video', degraded: 1, total: 10, threshold: 0.3 });
ok('触发点②比例告警·反例：1/10（10%，未达 30% 也未达 5 个）→ 不告警、不暂停队列',
 反例.alert === false && 反例.paused === false && J.pauseState().paused === false && 反例.ratioState.ratio === 0.1);
const 正例 = await St.applyDegradedRatioAlert({ stage: 'video', degraded: 3, total: 10, threshold: 0.3, from: 'comfyui-h3', to: 'placeholder' });
ok('触发点②比例告警·正例：3/10（30% ≥ 阈值）→ 真调 pauseQueues（队列确实被暂停）',
 正例.alert === true && 正例.paused === true && J.pauseState().paused === true && 正例.pauseInfo?.by === 'system');
ok('触发点②比例告警·中文理由写进暂停记录：含「降级」「30%」与恢复方式（不暗示重启即恢复）',
 (() => {
   const st = J.pauseState();
   return hasCN(st.reason) && st.reason.includes('降级') && st.reason.includes('30%')
     && st.reason.includes('恢复') && st.reason.includes('重启不会自动恢复') && st.by === 'system';
 })(), J.pauseState().reason?.slice(0, 60));
ok('触发点②比例告警·暂停历史恰好 1 条 by=system；重复触发不重复写历史（pauseQueues 自身幂等）',
 (() => {
   const 一次 = J.pauseHistory().filter((h) => h.action === 'pause' && h.by === 'system').length;
   return 一次 === 1;
 })());
const 正例2 = await St.applyDegradedRatioAlert({ stage: 'video', degraded: 4, total: 10, threshold: 0.3, from: 'comfyui-h3', to: 'placeholder' });
ok('触发点②比例告警·重复告警：仍暂停且历史条数保持 1（不刷屏、不重复记录）',
 正例2.alert === true && J.pauseHistory().filter((h) => h.action === 'pause' && h.by === 'system').length === 1);
const 零分母 = await St.applyDegradedRatioAlert({ stage: 'video', degraded: 0, total: 0, threshold: 0.3 });
ok('触发点②比例告警·没有节点时（0/0）不告警也不暂停（ratio=0，不出现 NaN）',
 零分母.alert === false && 零分母.ratioState.ratio === 0 && Number.isNaN(零分母.ratioState.ratio) === false);
J.resumeQueues({ by: 'human' });   // 收尾：把队列恢复，避免留下持久化暂停状态

// ---------- 12.5 mode 门控三态（W3 验收 R-W3-03 修复）：off/report **零生成调用**、auto 才是对照 ----------
// 缺陷原文：`video.selfHeal.mode=off/report` 时告知写「不重试」，实测仍执行一次同后端重跑并建 job
//（artifact.calls=1、jobs+2）；根因是 self-heal.js 的「① 首发」在 mode 判定之前。
// 本节真跑 studio.healVideoStage / studio.runStage（真临时库 + 真 jobs 计数），逐态取证：
//   off/report → 0 次生成调用、0 建 job、0 账本写入，且 artifact 写明「为何没自愈」（中文）；
//   auto-free  → 同一造景下确实动手（artifact.calls≥1、新建 job≥1）= 判据仍有判别力。
const CFGAPI = await import('../src/config.js');
const 写配置 = (mode) => {
  fs.writeFileSync(CFG, JSON.stringify({ llm: { provider: 'mock' }, video: { backend: 'placeholder', selfHeal: { mode } } }), 'utf8');
  CFGAPI.loadConfig({ reload: true });   // 配置有进程内缓存：真跑前必须重载，否则三态会都读到第一次的 mode
};
const PID3 = 'PROD-MODE-001';
const CID3 = 'CV-MODE-001';
const ERR3 = '视频接口 500: internal server error';   // kind=server（可自愈类别），确保门控不是被「不可自愈」拦下
const TKEY3 = SH.tripKeyOf({ productionId: PID3, stage: 'video' });
const 造景 = () => {
  DB2.run('DELETE FROM jobs');
  DB2.run('DELETE FROM selfheal_events');
  DB2.run('INSERT OR REPLACE INTO productions(id, title, brief, spec, status, canvas_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
    PID3, 'mode 门控项目', '测试', JSON.stringify({ title: '门控' }), 'error', CID3, FIXED_AT, FIXED_AT);
  for (const id of ['NM-1', 'NM-2']) {
    DB2.run('INSERT OR REPLACE INTO canvas_nodes(id, canvas_id, actor_id, kind, title, data) VALUES(?,?,?,?,?,?)',
      id, CID3, 'ACT-MODE', 'video', `镜头${id}`, JSON.stringify({ status: 'error', lastError: ERR3 }));
  }
  DB2.run('INSERT OR REPLACE INTO production_stages(id, production_id, stage, seq, status, artifact, error, updated_at) VALUES(?,?,?,?,?,?,?,?)',
    `PS-${PID3}-video`, PID3, 'video', 6, 'error', JSON.stringify({}), ERR3, FIXED_AT);
  DB2.setConfigValue(TKEY3, { consecutive: 0, errorKind: null, threshold: 3, tripped: false, trips: 0 });   // 未熔断：门控若是被熔断拦下，下面的正向对照会拆穿
};
const 造景前 = (mode) => { 写配置(mode); 造景(); return { jobs: 数行('SELECT COUNT(*) AS n FROM jobs'), ev: 数行('SELECT COUNT(*) AS n FROM selfheal_events WHERE scope_id = ?', PID3) }; };
function 数行(sql, ...args) { return Number(DB2.get(sql, ...args)?.n) || 0; }
const 阶段行 = () => DB2.get('SELECT status, error, artifact FROM production_stages WHERE production_id = ? AND stage = ?', PID3, 'video');
const 阶段art3 = () => { const a = JSON.parse(阶段行()?.artifact || '{}'); return { ...a, selfHeal: a.selfHeal || {} }; };
const 节点数据 = () => String(DB2.get('SELECT data FROM canvas_nodes WHERE id = ?', 'NM-1')?.data || '');

ok('门控·纯函数三态（唯一判定源 healModeGate）：auto-free/allow-paid 允许动手；off/report 一律不允许且 blocked=true',
  (() => {
    const a = SH.healModeGate({ mode: 'auto-free' }); const b = SH.healModeGate({ mode: 'allow-paid' });
    const o = SH.healModeGate({ mode: 'off' }); const rp = SH.healModeGate({ mode: 'report' });
    return a.allowed === true && b.allowed === true && a.blocked === false
      && o.allowed === false && o.blocked === true && rp.allowed === false && rp.blocked === true
      && hasCN(o.reason) && o.reason.includes('不发起任何生成调用') && hasCN(rp.reason) && rp.reason.includes('不发起任何生成调用');
  })());
ok('门控·显式允许是唯一例外，且默认关闭：explicitlyAllowed=true / allowWhenDisabled=true 才放行（字符串 "true" 不算）',
  SH.healModeGate({ mode: 'off' }, { explicitlyAllowed: true }).allowed === true
  && SH.healModeGate({ mode: 'report' }).allowed === false
  && SH.healModeGate({ mode: 'off', allowWhenDisabled: true }).allowed === true
  && SH.healModeGate({ mode: 'off', allowWhenDisabled: 'true' }).allowed === false
  && SH.DEFAULT_HEAL_POLICY.allowWhenDisabled === false);
ok('门控·非法 mode 回落 auto-free（配置写错不会把自愈永久锁死），判定层同口径（off/report → stop + to=null）',
  SH.healModeGate({ mode: '乱写' }).allowed === true
  && ['off', 'report'].every((mode) => {
    const d = SH.decideHeal({ profile: SH.classifyForHeal({ error: ERR3 }), from: 'comfyui-h3', policy: { mode } });
    return d.action === 'stop' && d.to === null && d.degraded !== true;
  }));

for (const mode of ['off', 'report']) {
  const 前 = 造景前(mode);
  const r = await St.healVideoStage(PID3, { force: true, error: ERR3, onLog: () => {} });
  const art = 阶段art3().selfHeal;
  const jobs后 = 数行('SELECT COUNT(*) AS n FROM jobs');
  const ev后 = 数行('SELECT COUNT(*) AS n FROM selfheal_events WHERE scope_id = ?', PID3);
  ok(`门控·studio ${mode}：**零生成调用**（calls=0）+ 零建 job + 零账本写入 + 未换后端`,
    r.calls === 0 && r.healSkipped === true && r.action === 'stop' && r.to === null && r.degraded === false
    && jobs后 - 前.jobs === 0 && ev后 - 前.ev === 0,
    `calls=${r.calls} jobs+${jobs后 - 前.jobs} events+${ev后 - 前.ev} to=${r.to}`);
  ok(`门控·studio ${mode}：artifact 写明「为何没自愈」（中文、含 mode 与「不发起任何生成调用」、attempted=false）`,
    art.mode === mode && art.allowed === false && art.attempted === false && art.healSkipped === true && art.calls === 0
    && hasCN(art.reason) && art.reason.includes(`mode=${mode}`) && art.reason.includes('不发起任何生成调用')
    && hasCN(art.notice) && String(art.notice).includes('未自动降级'),
    String(art.reason).slice(0, 90));
  ok(`门控·studio ${mode}：如实失败（阶段标 error + 中文原因），且不碰失败节点、不写熔断采样位`,
    (() => {
      const row = 阶段行();
      const trip = DB2.getConfigValue(TKEY3, null);
      return row?.status === 'error' && String(row?.error || '').includes(`mode=${mode}`)
        && 节点数据() === JSON.stringify({ status: 'error', lastError: ERR3 })
        && trip?.consecutive === 0 && trip?.tripped === false;
    })(), String(阶段行()?.error || '').slice(0, 70));
}
{
  // 正向对照：同一造景下 auto-free 确实动手 —— 证明上面的 0 是门控造成的，不是造景失效
  const 前 = 造景前('auto-free');
  const r = await St.healVideoStage(PID3, { force: true, error: ERR3, onLog: () => {} });
  const art = 阶段art3().selfHeal;
  const jobs后 = 数行('SELECT COUNT(*) AS n FROM jobs');
  ok('门控·studio auto-free 对照（判别力）：同一造景下真的发起重跑（artifact.calls≥1、新建 job≥1、无 healSkipped 标记）',
    Number(art.calls) >= 1 && jobs后 - 前.jobs >= 1 && art.healSkipped !== true && art.attempted === undefined,
    `artifact.calls=${art.calls} jobs+${jobs后 - 前.jobs} action=${r.action}`);
}
{
  // 调用点短路（src/studio.js:890 一带）：mode=off 时**不调用** healVideoStage，走「建计划 → 等人工批准」，
  // 计划 artifact 之后「为何没自愈」仍在（不被覆盖）
  写配置('off');
  DB2.run('INSERT OR REPLACE INTO production_stages(id, production_id, stage, seq, status, artifact, error, updated_at) VALUES(?,?,?,?,?,?,?,?)',
    `PS-${PID3}-keyframe`, PID3, 'keyframe', 5, 'done', JSON.stringify({}), null, FIXED_AT);
  造景();
  const jobs0 = 数行('SELECT COUNT(*) AS n FROM jobs');
  const rs = await St.runStage(PID3, 'video', { onLog: () => {} });
  const art = 阶段art3();
  ok('门控·runStage 调用点短路：mode=off 时不调 healVideoStage（零生成调用、零建 job），结果带 selfHealSkipped + 中文原因',
    rs.selfHealSkipped === true && rs.mode === 'off' && 数行('SELECT COUNT(*) AS n FROM jobs') - jobs0 === 0
    && hasCN(rs.reason) && String(rs.reason).includes('不发起任何生成调用'),
    `mode=${rs.mode} jobs+${数行('SELECT COUNT(*) AS n FROM jobs') - jobs0}`);
  ok('门控·runStage 调用点短路：「为何没自愈」在计划 artifact 之后仍保留（不被覆盖），且人工批准闸门未被替人放行',
    art.selfHeal?.healSkipped === true && art.selfHeal?.mode === 'off' && art.selfHeal?.calls === 0
    && hasCN(art.selfHeal?.reason) && Boolean(art.plan_id) && 阶段行()?.status === 'awaiting_approval',
    `status=${阶段行()?.status} plan=${art.plan_id}`);
}
{
  // 正常态（无失败节点）：mode=off 也不打扰 —— 不改阶段、不写 artifact、不建 job、不打日志（改动前行为零变化）
  写配置('off');
  const 前at = 阶段art3().selfHeal?.at || null;
  DB2.run("UPDATE canvas_nodes SET data = ? WHERE id IN ('NM-1','NM-2')", JSON.stringify({ status: 'done' }));
  DB2.run("UPDATE production_stages SET status = 'done', error = NULL WHERE production_id = ? AND stage = 'video'", PID3);
  const jobs0 = 数行('SELECT COUNT(*) AS n FROM jobs');
  const 日志3 = [];
  const r = await St.healVideoStage(PID3, { onLog: (m) => 日志3.push(String(m)) });
  ok('门控·正常态（无失败节点）：mode=off 也不打扰 —— 不写 artifact、不建 job、不打日志，如实说明「无需自愈」',
    r.skipped === true && r.healSkipped !== true && !r.notice && (阶段art3().selfHeal?.at || null) === 前at
    && 数行('SELECT COUNT(*) AS n FROM jobs') - jobs0 === 0 && 日志3.length === 0 && hasCN(r.reason) && r.reason.includes('无需自愈'),
    r.reason);
}
// ---------- 12.6 mode 归一化（W4 验收 R-W4-03 修复）：大小写/空白归一，0/false/null 一律视为 off ----------
// 缺陷原文（W4-acceptance R-W4-03，中低 · fail-open）：旧实现只认**严格小写且无空白**的字面值，
//   `'OFF'` / `' off '` / `0` / `null` 一律回落 `auto-free` —— 用户写「关掉自愈」时，
//   系统反而**静默开启**自动重试与换后端（实测 mode=' off ' → 归一化 auto-free、calls=3）。
// 修后口径见 src/self-heal.js 的 normalizeHealMode：归一化后命中合法枚举即采用；
//   0/false/null/空串等「明确的假值」一律按关闭（off，最严方向）；只有未提供才用默认 auto-free。
console.log('\n【12.6】mode 归一化（R-W4-03）：大小写/空白归一 + 假值视为 off（不再静默回落 auto-free）');
{
  // 归一化真值表：这些字面值在旧实现下全部回落 auto-free（fail-open），修后必须落到 off / 对应枚举
  const 表 = [
    [' off ', 'off'], ['OFF', 'off'], ['Off', 'off'], ['   OFF   ', 'off'],
    [0, 'off'], [false, 'off'], [null, 'off'], ['', 'off'], ['   ', 'off'],
    ['0', 'off'], ['false', 'off'], ['null', 'off'], ['none', 'off'], ['no', 'off'], ['关闭', 'off'],
    ['Report', 'report'], [' AUTO-FREE ', 'auto-free'], ['Allow-Paid', 'allow-paid'],
    [undefined, 'auto-free'],   // 缺省 ≠ 关闭：未提供时仍用默认 auto-free（既有行为不变）
  ];
  const 不符 = 表.filter(([raw, want]) => SH.normalizeHealMode(raw) !== want || SH.healPolicy({ mode: raw }).mode !== want)
    .map(([raw, want]) => `${JSON.stringify(raw)} => ${SH.healPolicy({ mode: raw }).mode}（期望 ${want}）`);
  ok('归一化·大小写与空白归一、0/false/null/空串视为 off（不再静默回落 auto-free），未提供才回落默认 auto-free',
    不符.length === 0, 不符.length ? 不符.join('；') : `${表.length} 组字面值全部符合`);
}
{
  // 判定层同口径：归一化后的 off 必须走 healModeGate 的「零生成调用」分支，且中文原因一致
  const 判定 = ['OFF', ' off ', 0, false, null, ''].map((raw) => ({
    raw,
    g: SH.healModeGate({ mode: raw }),
    d: SH.decideHeal({ profile: SH.classifyForHeal({ error: ERR3 }), from: 'comfyui-h3', policy: { mode: raw } }),
  }));
  ok('门控·归一化后的 off 走「零生成调用」分支：blocked=true / allowed=false / mode=off，decideHeal 一律 stop 且不换后端',
    SH.normalizeHealMode('OFF') === 'off'
    && 判定.every(({ g, d }) => g.allowed === false && g.blocked === true && g.mode === 'off'
      && hasCN(g.reason) && g.reason.includes('不发起任何生成调用')
      && d.action === 'stop' && d.to === null && d.degraded !== true),
    JSON.stringify(判定.map(({ raw, g }) => `${JSON.stringify(raw)}=>${g.mode}/${g.allowed}`)));
}
{
  // 端到端真跑（模块层）：报告里的 4 个缺陷变体逐个用假执行器计数 —— 修后必须 0 次生成调用
  for (const raw of ['OFF', ' off ', 0, null]) {
    const f = makeFake([E500()]);
    const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, policy: { mode: raw }, scopeId: `SHOT-RW403-${String(raw).replace(/\s/g, '_')}`, now: fixedNow });
    ok(`归一化·runWithHeal 真跑 mode=${JSON.stringify(raw)}：归一回 off → **零生成调用**（旧实现 calls=3，静默开启自愈）`,
      f.calls.length === 0 && r.calls === 0 && r.mode === 'off' && r.attempted === false && r.selfHealSkipped === true && hasCN(r.reason),
      `calls=${f.calls.length} mode=${r.mode} reason=${String(r.reason).slice(0, 40)}`);
  }
  // 判别力对照：同一造景下 auto-free（大小写/空白变体）照样动手 —— 证明上面的 0 来自归一化后的 off，不是把自愈关死
  const f = makeFake([E500(), E500()]);
  const r = await SH.runWithHeal({ backend: 'comfyui-h3', run: f.run, policy: { mode: ' AUTO-FREE ' }, scopeId: 'SHOT-RW403-CTRL', now: fixedNow });
  ok('归一化·判别力对照：mode=" AUTO-FREE " 归一回 auto-free，同一造景下照样动手（≥1 次生成调用、无 healSkipped 标记）',
    f.calls.length >= 1 && r.policyMode === 'auto-free' && r.selfHealSkipped !== true, `calls=${f.calls.length} policyMode=${r.policyMode}`);
}
{
  // 端到端真跑（studio 层，真临时库 + 真 jobs 计数）：配置里写 ' off '（最像手滑的写法）也必须一次调用都不发起
  const 前 = 造景前(' off ');
  const r = await St.healVideoStage(PID3, { force: true, error: ERR3, onLog: () => {} });
  const art = 阶段art3().selfHeal;
  const jobs后 = 数行('SELECT COUNT(*) AS n FROM jobs');
  ok('归一化·studio 配置写 video.selfHeal.mode=" off "：归一回 off → 零生成调用 + 零建 job + artifact.mode=off（旧实现会真跑起来）',
    r.calls === 0 && r.mode === 'off' && r.healSkipped === true && jobs后 - 前.jobs === 0
    && art.mode === 'off' && art.calls === 0 && hasCN(art.reason) && art.reason.includes('不发起任何生成调用'),
    `calls=${r.calls} mode=${r.mode} jobs+${jobs后 - 前.jobs} artifact.calls=${art.calls}`);
}

// ---------- 12.7 顺序复核（W7 收尾卡 第 2 轮②）：mode 判定必须早于「① 首发」，且最恶劣造景下仍零调用/零 job ----------
// 派单问题：源码里「首次判定（原 :865 附近）」是否仍排在「mode 判定（原 :495 附近）」之前？
// 复核结论：**顺序正确**（mode 门控在 src/self-heal.js 的 runWithHeal 内位于「① 首发」之前；
// studio 侧调用点在 runStage 里先做 healModeGate 再决定是否调 healVideoStage），本节用两类证据钉死它：
//   ① 结构证据：直接读源码，断言「最早的生成调用点」在「mode 门控」之后；
//   ② 行为证据：把重试/降级/探测/账本/事件回调全部打开的最恶劣造景下跑 off/report，仍必须零调用、零 job、零账本。
console.log('\n【12.7】顺序复核（W7 ②）：mode 判定在「① 首发」之前 + 最恶劣造景下 off/report 零调用零建 job');
{
  const SRC = fs.readFileSync(new URL('../src/self-heal.js', import.meta.url), 'utf8');
  // 交付仓里的 src/self-heal.js 是**混淆产物**（单行），源码级结构断言在混淆版上无从匹配。
  // 这里按"是否提供可读源码"决定跑还是跳过；行为证据（下面 off/report 零调用零建 job）始终照跑。
  const READABLE = SRC.split('\n').length > 3;
  if (!READABLE) {
    skip('源码结构断言：mode 门控位于「① 首发」之前（3 条）', '（交付版 src/self-heal.js 为混淆单行产物，未随包提供可读源码）');
  } else {
  const gateIdx = SRC.indexOf('const modeGate = healModeGate(policy, { explicitlyAllowed: opts.allowHeal === true });');
  const firstCallIdx = SRC.indexOf('// ① 首发：以原后端调用一次');
  const firstInvokeIdx = SRC.indexOf('await invoke(from, { firstCall: true');
  const legacyStopIdx = SRC.indexOf("if (policy.mode === 'off' || policy.mode === 'report' ||");
  ok('顺序·源码结构断言：runWithHeal 里 mode 门控（healModeGate）确实位于「① 首发」与首次 invoke(from) 之前',
    gateIdx > 0 && firstCallIdx > gateIdx && firstInvokeIdx > gateIdx,
    `gateIdx=${gateIdx} 首发Idx=${firstCallIdx} 首次invokeIdx=${firstInvokeIdx}`);
  ok('顺序·源码结构断言：门控块内不含任何 invoke( 调用（mode=off/report 时不发起任何生成调用，只有一处判定源）',
    gateIdx > 0 && SRC.slice(gateIdx, firstCallIdx).includes('invoke(') === false
    && SRC.slice(gateIdx, firstCallIdx).includes('selfHealSkipped: true'),
    `门控块长度=${firstCallIdx - gateIdx} 字`);
  ok('顺序·源码结构断言：末端的「策略硬停（off/report）」分支已退化为兜底（位于首发之后），不再是唯一判定点',
    legacyStopIdx > firstCallIdx, `兜底分支Idx=${legacyStopIdx} 首发Idx=${firstCallIdx}`);
  }
}
for (const mode of ['off', 'report']) {
  // 最恶劣造景：首发若执行必失败（可自愈的错误类别）+ 重试/降级额度全开 + 原后端探测失败（降级条件也成立）
  // + 目标探测通过 + 能力需求满足 + 账本回调与事件回调都注入（旧实现会在这里真跑起来并建 job）
  const f = makeFake([E500(), E500(), E500()]);
  const 账本 = [];
  const 事件 = [];
  const r = await SH.runWithHeal({
    backend: 'comfyui-h3', run: f.run, stage: 'video', scope: 'shot', scopeId: `SHOT-W7-${mode}`,
    now: fixedNow, policy: { mode, maxSameBackendRetry: 3, maxSwitchesPerScope: 3, maxGenerateCallsPerShot: 3 },
    attempts: 0, retried: 0, switches: 0, probeFrom: { ok: false, detail: `W7 最恶劣造景：${mode} 下原后端不可用` },
    probeOf: async () => ({ ok: true, detail: '目标后端可用' }), facts: { hasKeyframe: true },
    need: { needRealVideo: true }, requireProbe: false, record: async (ev) => { 账本.push(ev); return 'SH-W7'; },
    onEvent: (ev) => 事件.push(ev),
  });
  ok(`顺序·最恶劣造景 ${mode}：**零生成调用**（旧实现会首发 1 次 + 同后端重试 + 换后端）、未换后端、未建/未改账本`,
    f.calls.length === 0 && r.calls === 0 && r.attempted === false && r.selfHealSkipped === true
    && r.action === 'stop' && r.degraded === false && r.to === null && 账本.length === 0,
    `调用=${f.calls.length} 账本=${账本.length} action=${r.action} to=${r.to} calls=${r.calls}`);
  ok(`顺序·最恶劣造景 ${mode}：只落 1 条 selfheal 观测事件（可审计「为何没自愈」），中文原因含「不发起任何生成调用」`,
    事件.length === 1 && 事件[0]?.type === 'selfheal' && 事件[0]?.selfHealSkipped === true
    && r.mode === mode && hasCN(r.reason) && String(r.reason).includes('不发起任何生成调用'),
    `事件=${事件.length} 首事件type=${事件[0]?.type} reason=${String(r.reason).slice(0, 60)}`);
  ok(`顺序·最恶劣造景 ${mode}：策略口径回显为 policyMode=${mode}（归一化后）且 notice 写明「未自动降级」`,
    r.policyMode === mode && hasCN(r.notice) && String(r.notice).includes('未自动降级'),
    `policyMode=${r.policyMode}`);
}
{
  // studio 侧调用点对 report 的短路（12.5 只覆盖了 off）：report 与 off 同为「只看不做」，必须同样零建 job
  写配置('report');
  DB2.run('INSERT OR REPLACE INTO production_stages(id, production_id, stage, seq, status, artifact, error, updated_at) VALUES(?,?,?,?,?,?,?,?)',
    `PS-${PID3}-keyframe`, PID3, 'keyframe', 5, 'done', JSON.stringify({}), null, FIXED_AT);
  造景();
  const jobs0 = 数行('SELECT COUNT(*) AS n FROM jobs');
  const rs = await St.runStage(PID3, 'video', { onLog: () => {} });
  const art = 阶段art3();
  ok('顺序·runStage 调用点短路 mode=report：不调 healVideoStage（零生成调用、零建 job），并保留「为何没自愈」+ 停在人工批准闸门',
    rs.selfHealSkipped === true && rs.mode === 'report' && 数行('SELECT COUNT(*) AS n FROM jobs') - jobs0 === 0
    && art.selfHeal?.healSkipped === true && art.selfHeal?.mode === 'report' && art.selfHeal?.calls === 0
    && hasCN(rs.reason) && String(rs.reason).includes('不发起任何生成调用') && 阶段行()?.status === 'awaiting_approval',
    `mode=${rs.mode} jobs+${数行('SELECT COUNT(*) AS n FROM jobs') - jobs0} status=${阶段行()?.status}`);
}

// ---------- 13. SELFHEAL-MODEL：model 故障档案（只增不改：本节全部为**追加断言**） ----------
// 背景（上一轮验收留下的残余）：src/retry.js 已把「模型不存在/未开通/已下线」归为**不可重试**的 model 类
// （model_not_found / InvalidEndpointOrModel / ModelNotOpen / UnsupportedModel），但 src/self-heal.js 的
// HEAL_BY_KIND 里**没有 model 档** → model 类一直落到 HEAL_BY_KIND.unknown 兜底（switchAllowed=false），
// 表现为「静默按未知处理」：既没有「这是模型问题」的中文告知，也没有可执行的排查动作。
// 本节钉死新档的三条语义：① 不换后端（换后端救不了「模型不存在/未开通」）；② 不重试（retry:false，同参数必同样失败）；
// ③ 中文告知 + 可执行建议（模型名/开通状态）。并给出 quota 核对与 rate/server/network 对照，防止补档时改坏既有策略。
console.log('\n【13】SELFHEAL-MODEL：model 故障档案（不换后端 / 不重试 / 中文告知 + 可执行建议）');
{
  const 模型档 = SH.classifyForHeal({ errorKind: 'model' });
  const 未知档 = SH.classifyForHeal({ errorKind: 'unknown' });
  ok('新档·model 已有独立档案（不再落 unknown 兜底）：hold-human / 不换后端 / 不重试，故障归属也不再是 unknown',
    模型档.errorKind === 'model' && 模型档.action === 'hold-human' && 模型档.healable === false
    && 模型档.switchAllowed === false && 模型档.retry === false && 模型档.retryable === false
    && 模型档.fault !== 'unknown' && 模型档.advice !== 未知档.advice && 未知档.action === 'hold-human',
    `model=${模型档.fault}/${模型档.action}/switch=${模型档.switchAllowed}/retry=${模型档.retry}；unknown 档文案前缀「${未知档.advice.slice(0, 10)}…」`);

  const 模型族原文 = ['model_not_found: the model does not exist', 'ModelNotOpen: 该模型未开通', 'InvalidEndpointOrModel', 'UnsupportedModel'];
  const 模型族 = 模型族原文.map((原文) => SH.classifyForHeal({ message: 原文 }));
  ok('原文归类·model 族四条（model_not_found / ModelNotOpen / InvalidEndpointOrModel / UnsupportedModel）全部归 model，且一律不换后端、不重试',
    模型族.every((p) => p.errorKind === 'model' && p.action === 'hold-human' && p.switchAllowed === false && p.retry === false),
    `实得 ${模型族.map((p) => p.errorKind).join('/')}`);

  const 模型计划 = SH.planSelfHeal({ error: 'model_not_found：中转服务把「模型不存在」包成 503', from: 'comfyui-h3', attempts: 1, scopeId: 'SHOT-MODEL-1' });
  const 模型告知 = String(模型计划.notice || '');
  ok('判定·planSelfHeal 对 model 类：hold-human + to=null + 非 degraded（不换后端），且不落入重试路径',
    模型计划.action === 'hold-human' && 模型计划.action !== 'retry-same' && 模型计划.to === null
    && 模型计划.degraded !== true && 模型计划.chainIndex === 0 && 模型计划.requiresApproval === false,
    `action=${模型计划.action} to=${模型计划.to} chainIndex=${模型计划.chainIndex}`);

  ok('告知·model 类中文告知含「模型」+「不…重试」+「不…切换后端」语义（断言关键中文片段，不断言整句）',
    hasCN(模型告知) && 模型告知.includes('模型') && /不会自动重试/.test(模型告知) && /不会切换后端/.test(模型告知)
    && 模型告知.includes('未自动降级'),
    `首行：${模型告知.split('\n')[0]}`);

  ok('建议·model 类给出可执行排查动作：指向 docs/模型对接参考.md + node scripts/check-backends.js + 控制台开通状态',
    String(模型计划.advice).includes('docs/模型对接参考.md') && String(模型计划.advice).includes('scripts/check-backends.js')
    && 模型计划.advice.includes('node ') && /开通/.test(模型计划.advice),
    `建议长度 ${String(模型计划.advice).length} 字`);

  const 模型决策 = SH.decideHeal({
    profile: 模型档, from: 'comfyui-h3', stage: 'video', scope: 'shot', scopeId: 'SHOT-MODEL-2',
    attempts: 1, retried: 0, switches: 0, candidates: ['placeholder'],
    checks: [{ to: 'placeholder', ok: true, reason: '能力满足（placeholder）' }],
    evidence: { probes: { placeholder: { ok: true } } },
  });
  ok('判定·decideHeal 对 model 类：即便降级链上有「探测通过且能力满足」的候选，也一律 hold-human（to=null、chainIndex=0），绝不返回 retry-same',
    模型决策.action === 'hold-human' && 模型决策.to === null && 模型决策.chainIndex === 0
    && 模型决策.degraded !== true && String(模型决策.notice).includes('模型'),
    `action=${模型决策.action} to=${模型决策.to}`);

  const 假执行器 = makeFake([E('model_not_found: the model does not exist')]);
  const 模型账本 = [];
  const 模型跑 = await SH.runWithHeal({
    backend: 'comfyui-h3', run: 假执行器.run, stage: 'video', scope: 'shot', scopeId: 'SHOT-MODEL-3', now: fixedNow,
    policy: { mode: 'auto-free', maxSameBackendRetry: 3, maxSwitchesPerScope: 3, maxGenerateCallsPerShot: 3 },
    attempts: 0, retried: 0, switches: 0, probeOf: async () => ({ ok: true, detail: '目标后端可用' }),
    facts: { hasKeyframe: true }, need: { needRealVideo: true },
    record: async (ev) => { 模型账本.push(ev); return 'SH-MODEL'; },
  });
  ok('端到端·model 类真跑（假执行器计数）：只首发 1 次 → **零重试、零换后端**（calls=1 / 无降级账本 / hold-human / 中文告知）',
    假执行器.calls.length === 1 && 模型跑.calls === 1 && 模型跑.attempts === 1 && 模型跑.errorKind === 'model'
    && 模型跑.action === 'hold-human' && 模型跑.degraded === false && 模型跑.to === null && 模型账本.length === 0
    && hasCN(模型跑.notice) && String(模型跑.notice).includes('模型'),
    `调用=${假执行器.calls.length} action=${模型跑.action} to=${模型跑.to} 降级账本=${模型账本.length}`);
}
{
  // quota 核对（本轮只核对，不重复造档）：与 model 同属「换后端救不了、重试必然同样失败」，但**指引不同**（充值/提额 vs 模型名/开通）
  const 额度档 = SH.classifyForHeal({ errorKind: 'quota' });
  const 模型档 = SH.classifyForHeal({ errorKind: 'model' });
  ok('核对·quota 档同样「不换后端 + 不重试」：switchAllowed=false / retry=false / hold-human，且与 model 档不是同一个兜底建议',
    额度档.switchAllowed === false && 额度档.retry === false && 额度档.healable === false
    && 额度档.action === 'hold-human' && 额度档.fault === 'account' && 额度档.advice !== 模型档.advice,
    `quota=${额度档.fault}/${额度档.action}/switch=${额度档.switchAllowed}/retry=${额度档.retry}`);

  const 额度计划 = SH.planSelfHeal({ error: 'insufficient balance：余额不足，请充值', from: 'comfyui-h3', attempts: 1, scopeId: 'SHOT-QUOTA-1' });
  const 额度告知 = String(额度计划.notice || '');
  ok('核对·quota 类中文告知含「充值/提额」语义，并指向 node scripts/check-backends.js 核对余额（可执行建议）',
    /充值|提额/.test(额度告知) && /充值|提额/.test(String(额度计划.advice))
    && String(额度计划.advice).includes('scripts/check-backends.js')
    && 额度计划.action === 'hold-human' && 额度计划.to === null && 额度告知.includes('未自动降级'),
    `首行：${额度告知.split('\n')[0]}`);

  const 额度执行器 = makeFake([E('402 余额不足：quota exceeded')]);
  const 额度跑 = await SH.runWithHeal({
    backend: 'comfyui-h3', run: 额度执行器.run, stage: 'video', scope: 'shot', scopeId: 'SHOT-QUOTA-2', now: fixedNow,
    policy: { mode: 'auto-free', maxSameBackendRetry: 3, maxGenerateCallsPerShot: 3 },
    attempts: 0, retried: 0, probeOf: async () => ({ ok: true, detail: '目标后端可用' }),
  });
  ok('核对·quota 类端到端真跑：只首发 1 次 → 零重试、零换后端（calls=1 / degraded=false / to=null）',
    额度执行器.calls.length === 1 && 额度跑.calls === 1 && 额度跑.errorKind === 'quota'
    && 额度跑.action === 'hold-human' && 额度跑.degraded === false && 额度跑.to === null,
    `调用=${额度执行器.calls.length} action=${额度跑.action} to=${额度跑.to}`);
}
{
  // 对照（防回归）：补 model 档不许把既有「可自愈类别」改坏 —— rate/server/network 仍可重试、仍可沿单向链降级
  const 可自愈 = ['rate', 'server', 'network'].map((k) => SH.classifyForHeal({ errorKind: k }));
  ok('对照·rate/server/network 仍按既有策略：可自愈 / 可重试（retry=true、action=retry-same、healableByRetry=true）/ 可换后端',
    可自愈.every((p) => p.healable === true && p.retry === true && p.action === 'retry-same'
      && p.switchAllowed === true && p.healableByRetry === true),
    JSON.stringify(可自愈.map((p) => `${p.errorKind}:${p.action}/retry=${p.retry}`)));

  const 重试计划 = SH.planSelfHeal({ error: '视频接口 429: rate limit exceeded', from: 'comfyui-h3', attempts: 1, retried: 0 });
  const 降级计划 = SH.planSelfHeal({
    error: E500(), from: 'comfyui-h3', attempts: 2, retried: 1, switches: 0, probes: { placeholder: { ok: true } },
  });
  ok('对照·rate 仍先同后端重试一次（attempts=1/retried=0 → retry-same）；server 在重试用尽后仍可沿链降级到 placeholder（degrade）',
    重试计划.action === 'retry-same' && 重试计划.to === null && 重试计划.degraded !== true
    && 降级计划.action === 'degrade' && 降级计划.to === 'placeholder' && 降级计划.degraded === true,
    `rate=${重试计划.action}；server=${降级计划.action}→${降级计划.to}`);

  const 超时计划 = SH.planSelfHeal({ error: 'ComfyUI 视频生成超时（等待 900000ms 仍未完成）', from: 'comfyui-h3', attempts: 1, probeOk: false, probes: { placeholder: { ok: true } } });
  ok('对照·timeout 梯度不变：探测失败（实例已释放）时仍可换后端；model 档不参与该梯度（其 retry=false 且 switchAllowed=false）',
    超时计划.action === 'degrade' && SH.classifyForHeal({ errorKind: 'model', probeOk: false }).switchAllowed === false
    && SH.classifyForHeal({ errorKind: 'model', probeOk: false }).action === 'hold-human',
    `timeout=${超时计划.action}`);
}

写配置('auto-free');   // 收尾：恢复默认自愈模式，避免影响后续（若有）用例
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败${skipped ? ` / 跳过 ${skipped}` : ''} ===`);

// 清理临时库 / 临时目录（失败也不影响退出码语义）
try {
  for (const p of [DB, `${DB}-wal`, `${DB}-shm`, CFG]) {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  fs.rmSync(ROOT_TMP, { recursive: true, force: true });
} catch { /* 忽略清理失败 */ }
process.exit(fail ? 1 : 0);
