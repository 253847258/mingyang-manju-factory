#!/usr/bin/env bash
# 安全重启：先确认队列连续空闲，再按「精确 PID」重启 8788 实例。
#
# 为什么要这个脚本（2026-09-30 事故留痕）：
#   为让源码改动生效直接 kill 实例，把用户正在跑的 job 打断了（落「服务重启导致任务中断」）。
#   规则改为：**重启前必须确认队列空闲**，且空闲要连续确认多次（避免刚好卡在两批任务之间）。
#   另外禁止 `pkill -f "node server.js"` 这类模式匹配（会误杀同机其它实例，也匹配到自己的命令行）。
#
# 用法：
#   ./scripts/safe-restart.sh              # 只体检，不重启（默认）
#   ./scripts/safe-restart.sh --yes        # 连续 N 次探测都空闲后重启
#   ./scripts/safe-restart.sh --yes --force  # 队列有人也重启（会打印正在跑的任务，需自己确认）
#   BASE=http://127.0.0.1:8788 ./scripts/safe-restart.sh --yes
#
# 退出码：0 = 已重启或体检通过；1 = 队列忙/实例异常而未重启；2 = 用法错误
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8788}"
PROBES="${PROBES:-3}"          # 需要连续空闲的次数
INTERVAL="${INTERVAL:-10}"     # 每次间隔秒数
DO_RESTART=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --yes) DO_RESTART=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（可用：--yes / --force / --help）" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.." || exit 1

pids_of() { ps -eo pid,args | awk '$2=="node" && $3=="server.js" {print $1}'; }

busy_count() {
  curl -s -m 5 "$BASE/api/jobs" 2>/dev/null | python3 -c '
import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    print(-1); raise SystemExit
js = d.get("jobs") or []
print(len([j for j in js if j.get("status") in ("running", "queued")]))
' 2>/dev/null || echo -1
}

busy_list() {
  curl -s -m 5 "$BASE/api/jobs" 2>/dev/null | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit
for j in (d.get("jobs") or []):
    if j.get("status") in ("running", "queued"):
        print("  · {} | {} | {} | {}/{}".format(j.get("type"), j.get("title"), j.get("status"), j.get("done"), j.get("total")))
' 2>/dev/null
}

echo "== 实例体检 =="
PIDS="$(pids_of | tr '\n' ' ')"
echo "  运行中的 node server.js PID：${PIDS:-（无）}"
INSTANCES=$(pids_of | wc -l)
if [ "$INSTANCES" -gt 1 ]; then
  echo "  ✗ 检测到多个实例（$INSTANCES 个）—— 先人工确认哪个是你要的，再手动处理，脚本不自动杀" >&2
  exit 1
fi
echo "  /api/health = $(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/api/health")"

echo "== 队列探测（需连续 $PROBES 次空闲，间隔 ${INTERVAL}s）=="
IDLE=0
for i in $(seq 1 "$PROBES"); do
  N="$(busy_count)"
  if [ "$N" = "-1" ]; then
    echo "  第 $i 次：读不到 /api/jobs（实例没起来？）→ 视为不空闲"
    IDLE=0
  elif [ "$N" = "0" ]; then
    IDLE=$((IDLE + 1))
    echo "  第 $i 次：running/queued=0（连续空闲 $IDLE/$PROBES）"
  else
    IDLE=0
    echo "  第 $i 次：running/queued=$N（队列忙，重新计数）"
    busy_list
  fi
  [ "$i" -lt "$PROBES" ] && sleep "$INTERVAL"
done

if [ "$IDLE" -lt "$PROBES" ] && [ "$FORCE" != "1" ]; then
  echo ""
  echo "✗ 队列不空闲，且未加 --force → 不重启（避免打断正在跑的任务）。"
  echo "  提示：任务跑完再执行；确实要强断请加 --force（会丢正在跑的那几个镜头，未跑的不会扣费）。"
  exit 1
fi
if [ "$FORCE" = "1" ] && [ "$IDLE" -lt "$PROBES" ]; then
  echo ""
  echo "⚠ --force：队列仍在忙，仍按 --yes 要求重启（正在跑的任务会被标记为「服务重启导致任务中断」）"
fi

if [ "$DO_RESTART" != "1" ]; then
  echo ""
  echo "✅ 体检通过（未重启）。要真的重启请加 --yes。"
  exit 0
fi

if [ -z "${PIDS// /}" ]; then
  echo ""
  echo "（当前没有实例在跑，直接启动）"
else
  echo ""
  echo "== 重启：按精确 PID kill =="
  for pid in $PIDS; do
    echo "  kill $pid"
    kill "$pid"
  done
  for _ in $(seq 1 20); do
    [ -z "$(pids_of)" ] && break
    sleep 0.5
  done
  if [ -n "$(pids_of)" ]; then
    echo "  ✗ 旧实例仍在（$(pids_of | tr '\n' ' ')）—— 请人工确认后再处理，脚本不升级到 kill -9" >&2
    exit 1
  fi
fi

LOG="/tmp/server-safe-restart-$(date +%H%M%S).log"
(setsid ./start.sh > "$LOG" 2>&1 < /dev/null &)
sleep 10
NEW_PIDS="$(pids_of | tr '\n' ' ')"
CODE="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/api/health")"
echo "  新实例 PID：${NEW_PIDS:-（无）}｜/$BASE/api/health = $CODE｜启动日志 $LOG"
if [ "$CODE" = "200" ] && [ -n "${NEW_PIDS// /}" ]; then
  echo "✅ 重启完成"
  exit 0
fi
echo "✗ 重启后健康检查不是 200，请看 $LOG" >&2
tail -20 "$LOG" >&2 || true
exit 1
