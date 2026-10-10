#!/usr/bin/env bash
# 看门狗：实例挂了就自动拉回来（本机会话里 8788 曾两次莫名停止，其中一次伴随系统清空 /tmp）
#
# 为什么需要：
#   2026-09-30/10-03 期间，常驻实例在没人动它的情况下停止过（`ps` 里没有 node server.js、
#   `/api/health` 连不上），而用户正在用它出图 —— 停了没人知道，等用户发现时已经浪费了时间。
#   这个脚本每 CHECK_INTERVAL 秒探一次健康；确认「没有实例在跑」才用 ./start.sh 拉起来，
#   并把启动输出写进仓库内的 `strategist/runs/logs/`（**不要写 /tmp**：这台机器的 /tmp 会被清空，
#   放在那里的日志/证据会凭空消失，本会话已经踩过）。
#
# 用法：
#   ./scripts/watchdog.sh                 # 前台常驻（Ctrl-C 退出）
#   ./scripts/watchdog.sh --once          # 只查一次：健康就退出 0，不健康则尝试拉起
#   nohup ./scripts/watchdog.sh >/dev/null 2>&1 &     # 后台常驻
#   touch strategist/runs/logs/.watchdog-off          # 临时停用（做维护/故意停服时用），删掉即恢复
#
# 行为边界（刻意保守）：
#   · **只在「没有任何 node server.js 进程」时才拉起**；进程在但健康检查失败时只告警，
#     不重复启动（避免把「正在启动中」误判成「挂了」而连开多个实例）。
#   · 拉起走 `./start.sh`（它自带单实例守卫）；拉起后 10 秒复检健康，失败则打印启动日志尾部。
#   · **不会**去杀进程、**不会**用 pkill 模式匹配，也不碰队列里正在跑的任务。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

BASE="${BASE:-http://127.0.0.1:8788}"
INTERVAL="${CHECK_INTERVAL:-30}"
LOGDIR="${WATCHDOG_LOGDIR:-strategist/runs/logs}"
OFF_FLAG="$LOGDIR/.watchdog-off"
ONCE=0
FAILS=0
FAIL_LIMIT="${FAIL_LIMIT:-3}"   # 连续失败多少次才判定卡死并拉起
for arg in "$@"; do
  case "$arg" in
    --once) ONCE=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "未知参数：$arg（可用：--once / --help）" >&2; exit 2 ;;
  esac
done

mkdir -p "$LOGDIR"
say() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }
pids() { ps -eo pid,args | awk '$2=="node" && $3=="server.js" {print $1}'; }
health() { curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/api/health" 2>/dev/null || echo 000; }

port_listening() { ss -ltn 2>/dev/null | grep -q ":$PORT "; }

check_once() {
  if [ -f "$OFF_FLAG" ]; then say "看门狗已停用（存在 $OFF_FLAG），本次不处理"; return 0; fi
  local code p
  code="$(health)"; p="$(pids | tr '\n' ' ')"
  if [ "$code" = "200" ]; then
    FAILS=0
    return 0
  fi
  # 进程在、但健康检查连续失败：可能是「正在启动中」，也可能是**卡死**。
  # 2026-10-05 实测踩过一次：另一个隔离实例（别的 PORT + 别的配置）在跑，而老版 start.sh 的
  # 单实例守卫「只要看到 node server.js 就拒绝启动」→ 主实例一直起不来，看门狗却因为「进程存在」
  # 只告警不处理。现在两头都修好了：start.sh 按「端口/同配置」判定；看门狗这边加**连续失败计数**，
  # 连续 FAIL_LIMIT 次（默认 3 次）仍不健康且**端口没在监听** → 判定为卡死，直接拉起。
  FAILS=$(( FAILS + 1 ))
  if [ -n "${p// /}" ] && [ "$FAILS" -lt "$FAIL_LIMIT" ]; then
    say "⚠ /api/health=$code 但实例进程还在（PID ${p}）→ 观察中（连续失败 ${FAILS}/${FAIL_LIMIT}；可能在启动中/正在处理请求）"
    return 1
  fi
  if [ -n "${p// /}" ] && port_listening; then
    say "⚠ /api/health=$code，端口 $PORT 在监听但接口不响应（连续失败 ${FAILS} 次）→ 判定为**卡死**，按精确 PID 停止后拉起"
    for pid in $p; do kill "$pid" 2>/dev/null || true; done
    sleep 3
  elif [ -n "${p// /}" ]; then
    say "⚠ 有 node server.js 进程（PID ${p}）但端口 $PORT 没在监听（连续失败 ${FAILS} 次）→ 视为无效实例，直接拉起"
  else
    say "✗ 健康检查 $code，且没有任何 node server.js 进程（连续失败 ${FAILS} 次）"
  fi
  local log="$LOGDIR/watchdog-restart-$(date +%H%M%S).log"
  (setsid ./start.sh > "$log" 2>&1 < /dev/null &)
  sleep 10
  code="$(health)"
  if [ "$code" = "200" ]; then
    FAILS=0
    say "✅ 已拉起（PID $(pids | tr '\n' ' ')），健康 200，启动日志 $log"
    return 0
  fi
  say "✗ 拉起后健康仍为 $code，日志尾部："
  tail -15 "$log" 2>/dev/null | sed 's/^/    /'
  return 1
}

if [ "$ONCE" = "1" ]; then
  check_once
  exit $?
fi

say "看门狗启动：每 ${INTERVAL}s 探测 $BASE/api/health（停用开关：$OFF_FLAG）"
while true; do
  check_once || true
  sleep "$INTERVAL"
done
