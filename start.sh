#!/usr/bin/env bash
# AI漫剧-电影视频工厂 一键启动
set -e
cd "$(dirname "$0")"
PORT="${PORT:-8788}"

# ── 单实例守卫（P0-ERR-INSTANCE）──────────────────────────────────────────────
# 为什么必须拦：同机跑两个 `node server.js` 时，两份 loadConfig 内存缓存会互相覆盖，
# 造成「设置页改完又被另一个实例写回」的配置漂移（本会话已实测两次）。
# 本脚本绝不 kill/pkill 任何进程：只做检测与提示，处置权交给人工按精确 PID 操作。
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=1 ;;
    -h|--help)
      echo "用法：bash start.sh [--force]"
      echo "  无参数   ：单实例守卫开启（端口已监听或已有 node server.js 时拒绝启动）"
      echo "  --force  ：明知已有实例仍要启动（会打印风险提示；极可能造成配置漂移）"
      exit 0 ;;
    *) echo "未知参数：$arg（可用：--force / --help）"; exit 2 ;;
  esac
done

# ① 端口占用检测：ss → lsof（都拿不到就退化为「只能靠进程检测」）
pids_on_port() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnpH "sport = :${PORT}" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | sort -u || true
  fi
}
# ② 进程检测：只看 `node ... server.js`（本脚本自身与 node 版本探测不会被误伤）
pids_server() {
  # 只匹配「本项目的 server.js」：同机可能有别的项目也在跑 node server.js，
  # 只看文件名会把它误判成同配置实例（macOS 无 /proc，无法再按 cwd 兜底）。
  local root
  root="$(pwd)"
  ps -eo pid=,args= 2>/dev/null | awk -v me="$$" -v target="$root/server.js" '
    $1 != me && $2 ~ /(^|\/)node$/ && index($0, target) > 0 { print $1 }
  ' | sort -u || true
}

PORT_PIDS="$(pids_on_port)"
SRV_PIDS="$(pids_server)"

# ③ 同一份配置才算真冲突（2026-10-05 修）：原先「只要有 node server.js 就拒绝」——
#    但排查/测试经常另起一个隔离实例（不同 PORT + 不同 FACTORY_CONFIG），结果它会把主实例挡在门外，
#    表现为「服务莫名起不来，日志里只有一行拒绝启动」。现在：
#      · 端口被占 → 硬冲突，直接拒绝（这个端口只能有一个）；
#      · 同名的 node server.js → 只有在**解析到同一份配置文件**时才算冲突（配置漂移的真正原因）；
#        解析不出配置（读不到 /proc/<pid>/environ）时保守起见仍按冲突处理，并提示可用 --force。
same_config_pids() {
  local mine_pids="" mine_cfg=""
  mine_cfg="${FACTORY_CONFIG:-$(cd "$(dirname "$0")" && pwd)/config/config.json}"
  for p in $1; do
    p="${p//[!0-9]/}"
    [ -n "$p" ] || continue
    local cfg=""
    if [ -r "/proc/$p/environ" ]; then
      cfg="$(tr '\0' '\n' < "/proc/$p/environ" 2>/dev/null | awk -F= '$1=="FACTORY_CONFIG"{print $2; exit}')"
      local pcwd=""
      pcwd="$(readlink -f "/proc/$p/cwd" 2>/dev/null || true)"
      [ -n "$cfg" ] || cfg="${pcwd:+$pcwd/config/config.json}"
    fi
    if [ -z "$cfg" ] || [ "$cfg" = "$mine_cfg" ]; then
      mine_pids="$mine_pids $p"
    fi
  done
  printf '%s' "$mine_pids" | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
}
CONFLICT_PIDS="$(printf '%s\n%s\n' "$PORT_PIDS" "$(same_config_pids "$SRV_PIDS")" | grep -E '^[0-9]+$' | sort -u || true)"
N_CONFLICT="$(printf '%s\n' "$CONFLICT_PIDS" | grep -cE '^[0-9]+$' || true)"
N_OTHER="$(printf '%s\n' "$SRV_PIDS" | grep -cE '^[0-9]+$' || true)"

# 只是「别的隔离实例」在跑：放行，但如实提示（不阻塞启动）
if [ "${N_CONFLICT}" = "0" ] && [ "${N_OTHER}" -gt 0 ]; then
  echo "ℹ️  检测到同机还有别的隔离实例在跑（PID：$(printf '%s' "$SRV_PIDS")），但端口 ${PORT} 空闲、配置也不是同一份 → 放行启动。"
  echo "ℹ️  提示：多个实例请务必各自使用不同的 PORT 与 FACTORY_CONFIG/FACTORY_DATA_DIR，否则会出现配置漂移。"
fi

if [ "${N_CONFLICT}" -gt 0 ]; then
  if [ "$FORCE" = "1" ]; then
    echo "⚠️  --force：已跳过单实例守卫（检测到 ${N_CONFLICT} 个真冲突实例）"
    echo "⚠️  风险：两个实例共用同一份 data/factory.db 与配置文件，两份 loadConfig 内存缓存会互相覆盖"
    echo "⚠️        → 设置页改完又被写回（配置漂移）；生成任务也可能互相抢同一批镜头。"
    echo "⚠️  建议：先 kill 下面的 PID 再启动；若只是临时排查，请另用 PORT / FACTORY_DATA_DIR 隔离。"
  else
    echo "✗ 拒绝启动：端口 ${PORT} 被占，或已存在**使用同一份配置**的实例（本脚本不会替你 kill 任何进程）"
    echo "  端口 ${PORT} 占用者 PID：$(printf '%s' "${PORT_PIDS:-无}")"
    echo "  同配置实例 PID：$(printf '%s' "$(same_config_pids "$SRV_PIDS")" | tr '\n' ' ')"
    echo "  原因：同一份配置被两个实例同时读写，会让两份 loadConfig 缓存互相覆盖 → 配置漂移（已实测两次）。"
    echo "  请先精确停止上面的进程，再重新执行 bash start.sh（可直接复制）："
    for p in $CONFLICT_PIDS; do
      echo "      kill $p          # 目标 PID $p（$(ps -p "$p" -o args= 2>/dev/null | head -c 60)）"
    done
    echo "      # 若 kill 后仍存活（卡死）：kill -9 <上面的 PID>"
    echo "      # 确认端口已释放：ss -ltnp | grep \":${PORT}\""
    echo "      bash start.sh"
    echo "  确实要并存（不推荐，配置会漂移）：bash start.sh --force"
    exit 1
  fi
fi
# ─────────────────────────────────────────────────────────────────────────────

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 node，请先安装 Node.js ≥ 22（本机检测到：无）"; exit 1
fi
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node 版本过低（当前 $(node -v)），需要 ≥ 22（内置 node:sqlite）"; exit 1
fi
echo "启动 AI漫剧-电影视频工厂 → http://127.0.0.1:${PORT}/"

# 启动后自检（子进程，exec 后仍存活）：真正确认健康检查通过后再打印 PID/端口；
# 若发现多实例并存，额外告警。只读 GET /api/health，不产生任何调用费用。
(
  node -e '
    const [port, pid, root] = process.argv.slice(1);
    const t0 = Date.now();
    const ping = () => fetch(`http://127.0.0.1:${port}/api/health`).then((r) => r.ok).catch(() => false);
    (async () => {
      let up = false;
      while (Date.now() - t0 < 20000) { if (await ping()) { up = true; break; } await new Promise((r) => setTimeout(r, 300)); }
      if (!up) { console.log(`⚠️ 启动后 20 秒内 /api/health 未就绪（端口 ${port}）：请查看上面的启动日志`); return; }
      console.log(`已启动：PID ${pid}，端口 ${port}（/api/health 200）`);
      let lines = [];
      try {
        const { execFileSync } = await import("node:child_process");
        lines = execFileSync("ps", ["-eo", "pid=,args="]).toString().split("\n").filter((l) => {
          const w = l.trim().split(/\s+/);
          return w[1] && /(^|\/)node$/.test(w[1]) && w[2] && l.includes(root + "/server.js");
        });
      } catch { /* 检测不到就不报 */ }
      if (lines.length > 1) console.log(`⚠️ 警告：当前有 ${lines.length} 个 node server.js 实例在跑（配置缓存会互相覆盖 → 配置漂移），请只保留 1 个：${lines.map((l) => l.trim().split(/\s+/)[0]).join(", ")}`);
    })();
  ' "$PORT" "$$" "$(pwd)"
) &

# ── 引擎管家：本机桥接（出图 8791 / 视频 8792）────────────────
# 为什么放这里：出图/视频后端指向本机桥接时，桥接没起会让所有任务失败。
# 只负责「没在跑就拉起 + 健康检查」，不 kill 任何已有进程。
BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$BRIDGE_DIR/data/logs"

ensure_bridge() {
  local label="$1" port="$2" script="$3" env_key="$4" log="$5" svc="$6"
  if curl -s --max-time 2 "http://127.0.0.1:${port}/health" | grep -q "\"service\":\"${svc}\""; then
    echo "ℹ️  ${label}已在运行（端口 ${port}）"
    return 0
  fi
  echo "启动${label} → http://127.0.0.1:${port}/"
  nohup env "$env_key=$port" node "$BRIDGE_DIR/$script" >> "$BRIDGE_DIR/data/logs/$log" 2>&1 &
  for _i in $(seq 1 16); do
    if curl -s --max-time 1 "http://127.0.0.1:${port}/health" | grep -q "\"service\":\"${svc}\""; then
      echo "${label}已就绪（端口 ${port}）"
      return 0
    fi
    sleep 0.5
  done
  echo "⚠️ ${label}启动超时，请查看 data/logs/$log"
}

ensure_bridge "文生图桥接" "${IMAGE_BRIDGE_PORT:-8791}" "scripts/text-to-image-bridge.js" "IMAGE_BRIDGE_PORT" "text-to-image-bridge.log" "text-to-image-bridge"
ensure_bridge "视频适配桥" "${VIDEO_BRIDGE_PORT:-8793}" "scripts/video-bridge.js" "VIDEO_BRIDGE_PORT" "video-bridge.log" "video-bridge"

PORT="$PORT" exec node server.js
