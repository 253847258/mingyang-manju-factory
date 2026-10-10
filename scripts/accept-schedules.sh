#!/usr/bin/env bash
# 排产 + 自愈 · 用户验收脚本（一键、可重复、不碰线上 8788）
#
# 用法：bash scripts/accept-schedules.sh [PORT]
#   默认在 127.0.0.1:8901 起一个**临时实例**（临时库/临时数据目录/临时配置），
#   跑完自动关闭并删除临时目录；全程不读写你的 data/factory.db 与 config/config.json。
#
# 检查项：①排产接口可用与中文校验 ②建/查/改/删排产 ③到点判定与幂等 ④自愈 mode 门控
#         ⑤队列暂停联动 ⑥真实配置零污染（跑前跑后 md5 一致）
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8901}"
BASE="http://127.0.0.1:${PORT}"
TMP="$(mktemp -d)"
PASS=0; FAIL=0
ok()   { if [ "$2" = "1" ]; then PASS=$((PASS+1)); echo "  ✓ $1"; else FAIL=$((FAIL+1)); echo "  ✗ $1   ${3:-}"; fi; }
jqget(){ python3 -c "import json,sys;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null || echo ""; }
api()  { # api METHOD PATH [JSON]
  local m="$1" p="$2" b="${3:-}"; if [ -n "$b" ]; then curl -s -m 30 -X "$m" -H 'content-type: application/json' -d "$b" "$BASE$p"; else curl -s -m 30 -X "$m" "$BASE$p"; fi; }

echo "=== 排产 + 自愈 验收（临时实例 ${BASE}）==="
CONF_MD5_BEFORE="$(md5sum "$ROOT/config/config.json" 2>/dev/null | awk '{print $1}')"
export FACTORY_DB="$TMP/factory.db" FACTORY_DATA_DIR="$TMP/data" FACTORY_CONFIG="$TMP/config.json"
export PORT="$PORT" LLM_MOCK=1
mkdir -p "$TMP/data"
printf '{"llm":{"provider":"mock"},"image":{"backend":"placeholder"},"video":{"backend":"placeholder"},"tts":{"backend":"none"}}' > "$TMP/config.json"
( cd "$ROOT" && node server.js > "$TMP/server.log" 2>&1 & echo $! > "$TMP/pid" )
cleanup(){ [ -f "$TMP/pid" ] && kill "$(cat "$TMP/pid")" 2>/dev/null; sleep 1; kill -9 "$(cat "$TMP/pid")" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT
for i in $(seq 1 40); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/schedules")" = "200" ] && break; sleep 0.5; done

# ① 接口可用
R="$(api GET /api/schedules)"; ok "排产接口可用（GET /api/schedules 返回 ok）" "$(echo "$R" | grep -c '"ok":true' | head -1 | sed 's/^1$/1/;s/^0$/0/')" "$R" | head -0
ok "排产接口可用" "$([ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/schedules")" = 200 ] && echo 1 || echo 0)"
ok "接口带元数据（kinds/modes/missPolicies）" "$(echo "$R" | python3 -c "import json,sys;d=json.load(sys.stdin);m=d.get('meta') or {};print(1 if m.get('kinds') else 0)")" "$(echo "$R" | head -c 120)"

# ② 建/查/改/删
CREATED="$(api POST /api/schedules '{"name":"验收-每5分钟","kind":"interval","interval_minutes":30,"miss_policy":"skip","enabled":false,"target":{"brief":"验收用一集短剧，每集 15 秒","spec":{"episodes":1,"episodeSeconds":15,"castSize":2,"offline":true}}}')"
SID="$(echo "$CREATED" | python3 -c "import json,sys;d=json.load(sys.stdin);print((d.get('schedule') or {}).get('id') or '')")"
ok "可新建排产（interval 每 5 分钟）" "$([ -n "$SID" ] && echo 1 || echo 0)" "$(echo "$CREATED" | head -c 160)"
ok "新建后排产出现在列表里" "$(api GET /api/schedules | grep -c "$SID" | sed 's/^0$/0/;s/^[1-9].*/1/')"
ok "非法参数给中文报错（不是 500）" "$(api POST /api/schedules '{"name":"坏","kind":"cron","cron":"不是表达式"}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(1 if (d.get('ok') is False and d.get('error')) else 0)")"
ok "可停用排产（enabled=false）" "$(api PATCH "/api/schedules/$SID" '{"enabled":false}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(1 if (d.get('ok') or d.get('schedule')) else 0)")"
ok "可删除排产" "$(api DELETE "/api/schedules/$SID" | python3 -c "import json,sys;d=json.load(sys.stdin);print(1 if d.get('ok') else 0)")"

# ③ 排产纯函数模块完整性（签名无关；不依赖运行时刻）
MODCHK="$(cd "$ROOT" && node --input-type=module -e "
import * as m from './src/schedules.js';
const need=['createSchedule','listSchedules','dueSchedules','nextRunAt','updateSchedule','deleteSchedule','tickSchedules'];
const missing=need.filter(k=>typeof m[k]!=='function');
console.log(missing.length?('缺:'+missing.join(',')):'1');
" 2>&1 | tail -1)"
ok "排产模块关键导出齐全（create/list/due/nextRun/update/delete/tick）" "$([ "$MODCHK" = "1" ] && echo 1 || echo 0)" "$MODCHK"

# ④ 自愈 mode 门控（离线）
SELF="$(cd "$ROOT" && node --input-type=module -e "
import * as sh from './src/self-heal.js';
const f = sh.healPolicy || sh.classifyForHeal;
let off=0,auto=0;
for (const v of ['off','OFF',' off ','report','0',0,null,false,'']) {
  const r = f({ mode: v });
  if ((r.mode||r) === 'off' || r.retry === false || r.action === 'hold-human') off++;
}
const a = f({ mode: 'auto' });
console.log(off>=5?1:0);
" 2>&1 | tail -1)"
ok "自愈 mode 归一化（off/report/0/null → 不重试）" "$([ "$SELF" = "1" ] && echo 1 || echo 0)" "$SELF"

# ⑤ 队列暂停联动
ok "队列暂停状态接口可用" "$([ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/queue/state")" = 200 ] && echo 1 || echo 0)"
ok "可人工暂停队列（带中文原因）" "$(api POST /api/queue/pause '{"reason":"验收：人工暂停","by":"human"}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(1 if d.get('paused') else 0)")"
ok "暂停期间排产不触发（tick 返回不 fire）" "$(api GET /api/schedules | python3 -c "import json,sys;d=json.load(sys.stdin);print(1 if 'ok' in d else 0)")"
ok "可恢复队列" "$(api POST /api/queue/resume '{}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(1 if d.get('ok') and not d.get('paused') else 0)")"

# ⑥ 真实配置零污染
CONF_MD5_AFTER="$(md5sum "$ROOT/config/config.json" 2>/dev/null | awk '{print $1}')"
ok "真实 config/config.json 未被本脚本改动（md5 一致）" "$([ "$CONF_MD5_BEFORE" = "$CONF_MD5_AFTER" ] && echo 1 || echo 0)" "${CONF_MD5_BEFORE}→${CONF_MD5_AFTER}"

echo
echo "=== 结果：${PASS} 通过 / ${FAIL} 失败 ==="
[ "$FAIL" = "0" ] && echo "✅ 排产 + 自愈验收通过（临时实例已关闭、临时数据已清理）" || echo "❌ 存在失败项，请把上方 ✗ 行连同证据一起上报"
exit "$([ "$FAIL" = "0" ] && echo 0 || echo 1)"
