#!/usr/bin/env bash
# 全量交付自检（35 个阶段）：引擎 → 模块1 → 模块2 → 模块3 → 模块4 → 画布资产桥 → ComfyUI视频引擎
#   → 厂商协议适配器（出图/视频/配音假服务端）→ 生产守护 → 生产看板 → 任务队列与取消语义
#   → Agent 接口与审核闸门（P4）→ 画布 DAG 执行引擎（P3）→ 自动化制片 Agent（一句话需求 → 10 阶段流水线）→ 时间线·多轨·音频·续写
#   → 规模压测 → 交付包 → 成片质检 → 配音链路 → 出海物料 → 全模块端到端模拟 → 前端冒烟 → 全模块UI模拟 → 满配前端 → 无限画布一致性审计
#   → 定时排产 → 阶段失败自愈 → 画布筛选与多选批处理 → 字幕智能断行 → 画布性能（26~34 为离线纯 Node，末尾追加：
#     第 4 波 26~30，第 5 波 31~34 = 视觉质检 / 按角色模型矩阵 / 时间线双向交换 / 角色接线，
#     第 6 波 35 = 墙钟非单调加固（插入序判序 / 耗时不为负））
# 最近一次全量结果：35/35 阶段通过，3519 项断言 / 0 失败，exit=0（留痕 strategist/runs/VERIFY-40.json；
#   自本轮起自检日志写进仓库 strategist/runs/logs/，不再写 /tmp —— 本机 /tmp 会被系统清空）
# 配置守卫：跑前对真实 config/config.json 取 md5 + mtime 双快照（cp -p 保留 mtime），跑后双比对
#   ① 内容变了（md5 不同）→ 打印差异摘要并用跑前快照字节还原；
#   ② md5 相同但 mtime 变了（同字节重写：写盘路径写了同样的值，历史门禁只比 md5 发现不了）→
#      打印跑前/跑后 mtime 摘要并用 touch -r 还原 mtime；
#   两种情形都只告警、不让全量自检变红（保持既有门禁语义）；只有「还原失败」才计入失败（FAILED=1）。
#   （历史缺陷 RK-L6-06 / R-W3-05：阶段 23 经设置页「保存出图配置」把 image.concurrency 3 改写成 2）
# 用法：./scripts/verify-all.sh [baseUrl]
set -u
cd "$(dirname "$0")/.."
BASE="${1:-http://127.0.0.1:8788}"
PWLIBS="${PWLIBS:-/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu}"
FAILED=0

# ---- 配置守卫 · 跑前快照（md5 + mtime 双基线；cp -p 保证快照自带原始 mtime，供 touch -r 还原）----
CONFIG_FILE="config/config.json"
CONFIG_SNAP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/verify-all-config.XXXXXX")"
CONFIG_SNAP="$CONFIG_SNAP_DIR/config.json"
CONFIG_MD5_BEFORE=""
CONFIG_MTIME_BEFORE=""

config_md5() { md5sum "$CONFIG_FILE" 2>/dev/null | awk '{print $1}'; }
config_mtime() { stat -c %y "$CONFIG_FILE" 2>/dev/null || echo "（无法读取）"; }

if [ -f "$CONFIG_FILE" ]; then
  cp -p "$CONFIG_FILE" "$CONFIG_SNAP"
  CONFIG_MD5_BEFORE="$(config_md5)"
  CONFIG_MTIME_BEFORE="$(config_mtime)"
  echo "【配置守卫】跑前快照：$CONFIG_FILE md5=$CONFIG_MD5_BEFORE（$(wc -c < "$CONFIG_FILE") 字节，副本 $CONFIG_SNAP）"
  echo "【配置守卫】跑前 mtime：$CONFIG_MTIME_BEFORE"
else
  echo "【配置守卫】警告：未找到 $CONFIG_FILE，本轮不做配置守卫（既有阶段判定不变）"
fi

# 判定「相对跑前基线变了什么」：输出 md5 | mtime | ""（三种情形互斥，md5 优先）
config_drift_kind() {
  local md5_now mtime_now
  [ -n "$CONFIG_MD5_BEFORE" ] && [ -f "$CONFIG_FILE" ] || { echo ""; return 0; }
  md5_now="$(config_md5)"
  mtime_now="$(config_mtime)"
  if [ "$md5_now" != "$CONFIG_MD5_BEFORE" ]; then echo "md5"; return 0; fi
  if [ "$mtime_now" != "$CONFIG_MTIME_BEFORE" ]; then echo "mtime"; return 0; fi
  echo ""
}

# 还原为跑前基线：内容用快照字节回写，mtime 用 touch -r 对齐快照（快照由 cp -p 保留了原始 mtime）。
# 还原成功回 0；只要 md5 或 mtime 与基线仍有偏差就回 1（调用方据此把门禁判红）。
config_restore() {
  cp "$CONFIG_SNAP" "$CONFIG_FILE" 2>/dev/null || return 1
  touch -r "$CONFIG_SNAP" "$CONFIG_FILE" 2>/dev/null || true
  if [ "$(config_md5)" = "$CONFIG_MD5_BEFORE" ] && [ "$(config_mtime)" = "$CONFIG_MTIME_BEFORE" ]; then
    return 0
  fi
  return 1
}

# 中断/异常退出兜底：脚本被 Ctrl-C 或某个阶段把脚本带崩时，同样用跑前快照还原（不改变退出码）
guard_restore_on_exit() {
  local kind
  kind="$(config_drift_kind)"
  if [ -n "$kind" ]; then
    config_restore
    echo "【配置守卫】脚本中途退出且配置已改写（漂移类型：$kind）→ 已用跑前快照还原（md5=$CONFIG_MD5_BEFORE，mtime=$CONFIG_MTIME_BEFORE）"
  fi
  [ -d "${CONFIG_SNAP_DIR:-}" ] && rm -rf "$CONFIG_SNAP_DIR"
  return 0
}
trap guard_restore_on_exit EXIT

# 每阶段守卫：阶段刚结束时比对一次；一旦被本阶段改写（内容或仅 mtime），立刻打印摘要并还原，
# 同时点名阶段（便于落实返工卡）。告警不计入失败门禁，除非还原失败。
CONFIG_GUARD_HITS=""
config_guard_stage() {
  local name="$1" kind md5_now
  kind="$(config_drift_kind)"
  [ -n "$kind" ] || return 0
  if [ "$kind" = "md5" ]; then
    md5_now="$(config_md5)"
    echo "【配置守卫】⚠ 阶段「$name」改写了真实配置 $CONFIG_FILE（md5 $CONFIG_MD5_BEFORE → $md5_now），差异摘要（最多 20 行）："
    diff -u "$CONFIG_SNAP" "$CONFIG_FILE" | head -20
  else
    echo "【配置守卫】⚠ 阶段「$name」同字节重写了真实配置 $CONFIG_FILE（md5 未变 = $CONFIG_MD5_BEFORE，但 mtime 变了）"
    echo "【配置守卫】   mtime 跑前：$CONFIG_MTIME_BEFORE"
    echo "【配置守卫】   mtime 跑后：$(config_mtime)"
    echo "【配置守卫】   内容摘要：md5 与跑前逐字节一致 → 属于「写了同样的值」的零字节副作用，但写盘行为本身仍是红线（md5 级门禁发现不了，故本次升级为双比对）"
  fi
  if config_restore; then
    echo "【配置守卫】↩ 已还原为跑前状态：md5=$(config_md5)，mtime=$(config_mtime)"
  else
    echo "【配置守卫】❌ 阶段「$name」的自动还原失败：md5=$(config_md5)（期望 $CONFIG_MD5_BEFORE），mtime=$(config_mtime)（期望 $CONFIG_MTIME_BEFORE）"
    echo "【配置守卫】   请手工执行：cp $CONFIG_SNAP $CONFIG_FILE && touch -r $CONFIG_SNAP $CONFIG_FILE"
    FAILED=1
  fi
  CONFIG_GUARD_HITS="${CONFIG_GUARD_HITS}${name}(${kind})；"
}

run() {
  local name="$1"; shift
  echo ""
  echo "════════ $name ════════"
  if "$@"; then
    echo "── $name：通过"
  else
    echo "── $name：失败(exit=$?)"
    FAILED=1
  fi
  config_guard_stage "$name"
}

# ---- 第 0 关（不计入 35 个阶段，但同样会让本轮判失败）：测试花费哨兵 ----
# 为什么要有它：2026-09-30 发现 tests/test-adapters.js 里一句「只为断言返回 Promise」的写法
# （typeof llmMod.chat({prompt:'x'}).then）**每次跑套件都真发一次 DeepSeek 付费请求**，而
# app_config['usage:monthly'] 台账只统计 images/videos/ttsChars —— **LLM token 根本不进台账**，
# 所以这笔钱长期没人发现；同一轮还查出 tests/test-novel.js 第 4 节每次真花 1 次调用。
# 这里只做「轻量哨兵」：盯住已知会打真实厂商的 3 个套件（<10s），一旦出现**未登记**的非回环调用
# 就判本轮失败。全量扫描（约 160s，覆盖 tests/ 与 scripts/ 全部目标）请手动跑：
#     node scripts/check-test-spend.js          # 退出码 0=干净或全登记 / 1=有未登记
# 注意：verify-all 默认口径下，门禁本身**仍会**真跑 3 次 DeepSeek 小调用（test-script 2 次 +
# test-novel 1 次，属刻意的连通性验证）；想彻底零调用就 `SKIP_REAL_LLM=1 ./scripts/verify-all.sh`。
echo ""
echo "════════ 第 0 关 测试花费哨兵（未登记的真实外网调用会让本轮失败） ════════"
if node scripts/check-test-spend.js --only=test-script --only=test-novel --only=test-adapters --quiet; then
  echo "── 第 0 关 测试花费哨兵：通过"
else
  echo "── 第 0 关 测试花费哨兵：失败(exit=$?)—— 上面表格里「未登记」的条目就是偷跑的付费/外网调用，先修掉或显式登记"
  FAILED=1
fi

run "1/35 引擎自检（字典/提示词/出图/视频/队列）" node tests/selfcheck.js
run "2/35 模块1 演员矩阵 API" node tests/test-actors.js
[ -f tests/test-novel.js ] && run "3/35 模块2 小说工坊 API" node tests/test-novel.js || echo "（跳过模块2测试：文件缺失）"
[ -f tests/test-script.js ] && run "4/35 模块3 剧本工厂 API" node tests/test-script.js || echo "（跳过模块3测试：文件缺失）"
[ -f tests/test-render.js ] && run "5/35 模块4 制作台（关键帧/视频/成片）API" node tests/test-render.js || echo "（跳过模块4测试：文件缺失）"

[ -f tests/test-bridge.js ] && run "6/35 画布资产桥（资产包/绑定/分镜增强/参考图）" node tests/test-bridge.js || echo "（跳过画布资产桥测试：文件缺失）"
[ -f tests/test-comfy.js ] && run "7/35 ComfyUI H3 视频引擎（离线假实例：预检/模板/光栅化/取回）" node tests/test-comfy.js || echo "（跳过 ComfyUI 引擎测试：文件缺失）"
[ -f tests/test-adapters.js ] && run "8/35 厂商协议适配器（出图/视频/配音 假服务端：模板/轮询/参考图/异常）" node tests/test-adapters.js || echo "（跳过适配器测试：文件缺失）"
[ -f tests/test-guard.js ] && run "9/35 生产守护（用量台账/预算闸门/磁盘保护/失败镜头归类与重试）" node tests/test-guard.js || echo "（跳过守护测试：文件缺失）"
[ -f tests/test-stats.js ] && run "10/35 生产看板（任务耗时与失败率/渲染成功率/失败原因 Top/产出趋势/ETA）" node tests/test-stats.js || echo "（跳过生产看板测试：文件缺失）"
[ -f tests/test-jobs.js ] && run "11/35 任务队列与取消语义（并发上限/进度/取消不覆写终态/启动自愈/事件流）" node tests/test-jobs.js || echo "（跳过任务队列测试：文件缺失）"
[ -f tests/test-mcp.js ] && run "12/35 Agent 接口与人类审核闸门（P4：41 个工具/计划 dry-run/审批/确认码/审计/未审批零调用）" node tests/test-mcp.js || echo "（跳过 Agent 接口测试：文件缺失）"
[ -f tests/test-graph.js ] && run "13/35 画布 DAG 执行引擎（P3：拓扑与环检测/端口装配/指纹增量/计划 dry-run/首尾帧语义/失败传播/重试/取消）" node tests/test-graph.js || echo "（跳过 DAG 引擎测试：文件缺失）"
[ -f tests/test-studio.js ] && run "14/35 自动化制片 Agent（一句话需求/阶段依赖与幂等/免费阶段自动跑/付费阶段人工闸门与确认码/回写镜头记录/交付包）" node tests/test-studio.js || echo "（跳过制片 Agent 测试：文件缺失）"
[ -f tests/test-timeline.js ] && run "15/35 时间线·多轨·音频·续写（clip1..N 主轨/ov1..4 画中画与字幕轨/配音与背景乐混音/首尾帧/视频续写）" node tests/test-timeline.js || echo "（跳过成片时间线测试：文件缺失）"
[ -f tests/test-scale.js ] && run "16/35 规模压测（200 演员 / 100 集 / 单集 200 镜 / 200 章：接口耗时与正确性）" node tests/test-scale.js || echo "（跳过规模压测：文件缺失）"
[ -f tests/test-deliver.js ] && run "17/35 交付包（ZIP/成片/字幕/分镜表/素材清单/生产报告/EDL 时间线）" node tests/test-deliver.js || echo "（跳过交付包测试：文件缺失）"
[ -f tests/test-qc.js ] && run "18/35 成片质检（黑帧/静音/响度/流缺失/时长口径 + 交付包内置报告）" node tests/test-qc.js || echo "（跳过质检测试：文件缺失）"
[ -f tests/test-dub.js ] && run "19/35 配音链路（按角色音色/时长自适应/合成缓存/配音+背景乐避让）" node tests/test-dub.js || echo "（跳过配音链路测试：文件缺失）"
[ -f tests/test-publish.js ] && run "20/35 出海物料（SRT 解析/多语言翻译/缓存回退/封面截帧/发布元数据）" node tests/test-publish.js || echo "（跳过出海物料测试：文件缺失）"
[ -f scripts/simulate-all.js ] && run "21/35 全模块端到端模拟（演员→小说→剧本→关键帧→视频→成片，离线零成本）" node scripts/simulate-all.js || echo "（跳过全模块模拟：文件缺失）"

if curl -sf -o /dev/null "$BASE/api/health"; then
  run "22/35 前端端到端冒烟（$BASE）" python3 tests/ui-smoke.py "$BASE"
  if [ -f tests/ui-simulate.py ]; then
    run "23/35 全模块 UI 模拟（5 个页面，含状态还原校验）" env LD_LIBRARY_PATH="$PWLIBS" python3 tests/ui-simulate.py "$BASE"
  else
    echo "（跳过全模块 UI 模拟：tests/ui-simulate.py 缺失）"
  fi
  if [ -f tests/ui-scale.py ]; then
    run "24/35 满配前端（200 演员 / 100 集 / 单集 200 镜，独立临时实例）" env LD_LIBRARY_PATH="$PWLIBS" python3 tests/ui-scale.py
  else
    echo "（跳过满配前端检查：tests/ui-scale.py 缺失）"
  fi
  run "25/35 无限画布功能一致性审计（$BASE）" python3 tests/canvas-audit.py "$BASE"
else
  echo ""
  echo "（跳过前端冒烟：$BASE 未启动。可先执行 node server.js）"
fi

# ---- 第 4 波新增阶段（26/35 ~ 30/35）：全部离线纯 Node，不依赖 $BASE；按「末尾追加」接入，上面 25 个阶段一字未改（仅分母 25→30）----
[ -f tests/test-schedules.js ] && run "26/35 定时排产（下一次触发/时区与 cron/宽限与补跑策略/暂停联动/幂等去重/预算闸门中文报错）" node tests/test-schedules.js || echo "（跳过定时排产测试：文件缺失）"
[ -f tests/test-selfheal.js ] && run "27/35 阶段失败自愈（错误分类与可自愈判定/单向降级链/审核与配额不换后端/中文告知/假执行器端到端）" node tests/test-selfheal.js || echo "（跳过阶段自愈测试：文件缺失）"
[ -f tests/canvas-select.test.mjs ] && run "28/35 画布筛选与多选批处理（谓词组合/危险动作确认闸门/计划与选区同源/中文文案/幂等一致）" node tests/canvas-select.test.mjs || echo "（跳过画布选区测试：文件缺失）"
[ -f tests/test-subtitle-wrap.js ] && run "29/35 字幕智能断行与安全区联动（标点禁则/数字英文不拆/与既有 buildSRT 逐字节同源/平台预设安全区）" node tests/test-subtitle-wrap.js || echo "（跳过字幕断行测试：文件缺失）"
[ -f tests/canvas-perf.test.mjs ] && run "30/35 画布性能（视口裁剪/LOD 分级/批量几何/单帧预算与 z 序稳定）" node tests/canvas-perf.test.mjs || echo "（跳过画布性能测试：文件缺失）"
# ---- 第 5 波新增阶段（31/35 ~ 34/35）：全部离线纯 Node（不依赖 $BASE、不联网、零付费），同「末尾追加」，上面 30 个阶段一字未改（仅分母 30→34）----
[ -f tests/test-vision-qc.js ] && run "31/35 视觉质检（多模态请求构造/结论解析/离群判定/代理指标边界/整集质检接入）" node tests/test-vision-qc.js || echo "（跳过视觉质检测试：文件缺失）"
[ -f tests/test-model-registry.js ] && run "32/35 按角色模型矩阵（4 级优先级/9 厂商/3 档配置/校验与非法补丁整体拒收）" node tests/test-model-registry.js || echo "（跳过模型矩阵测试：文件缺失）"
[ -f tests/test-interchange-import.js ] && run "33/35 时间线双向交换（FCP7 XML / OTIO 解析 → 画布 clips 计划与中文报错）" node tests/test-interchange-import.js || echo "（跳过时间线导入测试：文件缺失）"
[ -f tests/test-role-wiring.js ] && run "34/35 角色接线（12 角色 → 制片各阶段真实取模/缺 Key 与降级口径）" node tests/test-role-wiring.js || echo "（跳过角色接线测试：文件缺失）"

# ---- 第 6 波新增阶段（35/35）：墙钟非单调加固回归（离线纯 Node + 临时库，零付费；见 strategist/runs/E-101.json）----
[ -f tests/test-clock-skew.js ] && run "35/35 墙钟非单调加固（回拨/前拨下仍取后插入行/未来时间戳不顶序/rowid 复用/DAG lastRun 不取旧 run/耗时永不为负/静态护栏）" node tests/test-clock-skew.js || echo "（跳过墙钟加固测试：文件缺失）"


# ---- 配置守卫 · 跑后比对 + 自动还原（告警不计入失败门禁，但属于「自检零改写用户配置」红线；
#      只有「还原失败」才计入失败，避免用户配置停在半写状态）----
if [ -n "$CONFIG_MD5_BEFORE" ]; then
  if [ -f "$CONFIG_FILE" ]; then
    CONFIG_MD5_AFTER="$(config_md5)"
    CONFIG_MTIME_AFTER="$(config_mtime)"
    echo "【配置守卫】跑后比对：md5=$CONFIG_MD5_AFTER（跑前 $CONFIG_MD5_BEFORE）"
    echo "【配置守卫】跑后 mtime：$CONFIG_MTIME_AFTER（跑前 $CONFIG_MTIME_BEFORE）"
    if [ "$CONFIG_MD5_AFTER" = "$CONFIG_MD5_BEFORE" ] && [ "$CONFIG_MTIME_AFTER" = "$CONFIG_MTIME_BEFORE" ]; then
      echo "【配置守卫】✅ 跑前跑后 md5 与 mtime 双一致（逐字节且未被重写），无需还原"
      if [ -n "$CONFIG_GUARD_HITS" ]; then
        echo "【配置守卫】本轮曾改写并已逐次还原的阶段：${CONFIG_GUARD_HITS}（成因需返工对应测试，勿改门禁）"
      fi
    else
      if [ "$CONFIG_MD5_AFTER" != "$CONFIG_MD5_BEFORE" ]; then
        echo "【配置守卫】⚠ 警告：本次自检改写了真实配置 $CONFIG_FILE，差异摘要（最多 40 行）："
        diff -u "$CONFIG_SNAP" "$CONFIG_FILE" | head -40
      else
        echo "【配置守卫】⚠ 警告：本次自检同字节重写了真实配置 $CONFIG_FILE（md5 未变 = $CONFIG_MD5_AFTER，mtime 由 $CONFIG_MTIME_BEFORE 变为 $CONFIG_MTIME_AFTER）"
      fi
      if config_restore; then
        echo "【配置守卫】↩ 已用跑前快照自动还原：md5=$(config_md5)，mtime=$(config_mtime)（与跑前一致）"
      else
        echo "【配置守卫】❌ 自动还原失败：md5=$(config_md5)（期望 $CONFIG_MD5_BEFORE），mtime=$(config_mtime)（期望 $CONFIG_MTIME_BEFORE）"
        echo "【配置守卫】   请手工执行：cp $CONFIG_SNAP $CONFIG_FILE && touch -r $CONFIG_SNAP $CONFIG_FILE"
        FAILED=1
      fi
      echo "【配置守卫】说明：改写告警本身是红线违规提醒（不计入失败门禁）——请修测试而非改门禁；跑前快照见 $CONFIG_SNAP"
    fi
  else
    echo "【配置守卫】⚠ 警告：跑后 $CONFIG_FILE 不存在（跑前存在），疑似被删除，请用快照 $CONFIG_SNAP 恢复"
  fi
  rm -rf "$CONFIG_SNAP_DIR"
else
  rm -rf "$CONFIG_SNAP_DIR"
fi

echo ""
if [ "$FAILED" = "0" ]; then
  echo "✅ 全部自检通过"
else
  echo "❌ 存在失败项，请查看上方输出"
fi
exit $FAILED
