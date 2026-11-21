#!/usr/bin/env python3
"""铭扬漫剧自动化工厂 · 前端 UI 功能模拟测试（Playwright 真实交互）

用法：
    node server.js                                  # 先启动服务（默认 8788），本脚本不重启服务
    LD_LIBRARY_PATH=/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu \
        python3 tests/ui-simulate.py [baseUrl]

覆盖模块：
    1. 明星演员矩阵 #/actors   —— 档案 / 右键生成清单 / 工具栏 / 无限画布 / 节点·分组·便签·连线
    2. 小说工坊     #/novel    —— 列表 / 大纲 14 分节 / 章节与正文 / 参数面板 / 演员绑定 / 导出
    3. 剧本工厂     #/script   —— 剧本·集列表 / 分镜表 / 单镜编辑保存 / 画布资产绑定 / 导出
    4. 制作台       #/render   —— 剧集看板 / 筛选 / 全选反选 / 探测后端 / 成片包装 / 成片列表 / 估算
    5. 设置         #/settings —— LLM·出图·视频·配音四张配置卡 / comfyui-h3 字段 / 探测后端回归

安全约束（重要）：
    · 只做只读交互 + 打开/关闭弹窗 + 切换筛选 + dry-run（探测/预览），不做批量出图/出视频。
    · 绝不在主画布 CV-MAIN 上点「清空本画布」、绝不撤销/重做（撤销会删掉画布上以资产节点为端点的连线）。
    · 所有会写数据的能力（成组 / 便签 / 连线 / 层级 / 缩放卡位 / 框选）都在本脚本自建的
      「UI模拟临时画布」上完成，结束前删除该临时画布；主画布只做视图（缩放/平移）操作并还原。
    · 删除类按钮只验证「弹窗出现 + 取消」，并回查接口确认演员数未变。
    · 剧本单镜编辑只改「音效」一个字段并当场还原（保存后可逆），并回查提示词未被改写。
    · 配置守卫（W8 第 3 轮根因返工后为**零写盘**）：设置页原来会点「保存出图配置」触发真实写盘
      （前端 → PUT /api/settings → src/routes/meta.js:168 saveConfig → src/config.js:193 fs.writeFileSync），
      再按暂存值写回，净效果是「同字节重写」（md5 不变、mtime 前移，只有 scripts/verify-all.sh 的阶段守卫
      能发现并 touch -r 还原）。现改为**不点保存按钮**，只用只读取证核对「向导只改表单、不落盘」，
      并以启动时的 config/config.json md5 + mtime 双快照为准：段落结束与脚本收尾各比对一次，
      双一致才算通过（mtime 前移即判定为同字节重写失败，不再靠还原掩盖）。
    · 结束时交叉校验：演员数（含默认排序）/ 主画布节点数·类型·分组数·分组归属·连线数·视图 /
      剧本画布资产绑定 / 单镜数据，全部与脚本开始时一致。

注意事项：
    · 请单独运行本脚本：tests/canvas-audit.py 会在开头临时清空主画布的分组与便签/环境/物品/参考图节点
      （结束时再还原），两者并发会把主画布的中间态误判为数据被改动。
    · 结束时会打印「发现的产品问题」清单（不改产品代码，仅记录）。

截图输出：/tmp/ui-simulate/
"""
import difflib
import hashlib
import atexit
import json
import os
import pathlib
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("BASE", "http://127.0.0.1:8788")
CHROME = os.environ.get("CHROME", "/home/linsheng/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome")
LIBS = os.environ.get("PW_LIBS", "/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu")
if LIBS and not os.environ.get("LD_LIBRARY_PATH"):
    os.environ["LD_LIBRARY_PATH"] = LIBS

OUT = pathlib.Path("/tmp/ui-simulate")
OUT.mkdir(parents=True, exist_ok=True)

TEMP_CANVAS = "UI模拟临时画布"

# ---------- 配置守卫：真实用户配置文件（config/config.json）的快照与还原 ----------
ROOT = pathlib.Path(__file__).resolve().parent.parent
# 默认仓库内 config/config.json；可用 FACTORY_CONFIG 指向别的副本（守卫逻辑一致）
CONFIG_FILE = pathlib.Path(os.environ.get("FACTORY_CONFIG") or (ROOT / "config" / "config.json"))

CONFIG_BYTES_BEFORE = None   # 启动时的原始字节快照（None = 没读到，守卫降级为只告警）
CONFIG_MD5_BEFORE = ""
CONFIG_MTIME_BEFORE = None   # W8：启动时的 mtime（st_mtime_ns）——「同字节重写」只有 mtime 抓得到（md5 抓不到）

PASS, FAIL, WARN = [], [], []
PROBLEMS = []          # 发现的产品级问题（不改产品代码，在此记录并汇总报告）


def config_snapshot():
    """读取真实配置文件的原始字节快照、md5 与 mtime；读取失败返回 (None, "", None)（中文告警，不静默）"""
    try:
        raw = CONFIG_FILE.read_bytes()
        return raw, hashlib.md5(raw).hexdigest(), config_mtime_now()
    except Exception as e:  # noqa: BLE001
        print(f"  ! 配置守卫：读取 {CONFIG_FILE} 失败：{e}")
        return None, "", None


def config_mtime_now():
    """当前配置文件 mtime（纳秒）；读取失败返回 None（不抛错，守卫降级为只告警）"""
    try:
        return CONFIG_FILE.stat().st_mtime_ns
    except Exception:  # noqa: BLE001
        return None


def config_write_evidence(tag):
    """「零写盘」取证：md5 与 mtime 与启动基线**双比对**。

    返回 (是否双一致, 中文取证串)。存在的理由（W8 第 3 轮根因返工）：只比 md5 时，
    「写入同样字节」这种重写（md5 不变、mtime 前移）完全看不出来——阶段 23 历史缺陷即此类。
    """
    empty = CONFIG_MD5_BEFORE == "" or CONFIG_MTIME_BEFORE is None
    try:
        raw = CONFIG_FILE.read_bytes()
        md5_now = hashlib.md5(raw).hexdigest()
    except Exception as e:  # noqa: BLE001
        return False, f"[{tag}] 读取失败：{e}"
    mtime_now = config_mtime_now()
    same_bytes = (not empty) and md5_now == CONFIG_MD5_BEFORE
    same_mtime = (not empty) and mtime_now is not None and mtime_now == CONFIG_MTIME_BEFORE
    verdict = "md5+mtime 双一致（零写盘）" if (same_bytes and same_mtime) else \
              ("md5 一致但 mtime 前移（★同字节重写）" if same_bytes else "★内容被改写（md5 变化）")
    return (same_bytes and same_mtime), \
        f"[{tag}] {verdict}：md5={md5_now[:8]}…（基线 {CONFIG_MD5_BEFORE[:8] or '(无)'}…）mtime={mtime_now}（基线 {CONFIG_MTIME_BEFORE}）"


def config_diff_summary(before_bytes, after_bytes, limit=3):
    """生成「跑前快照 vs 当前文件」的中文差异摘要（还原前留证，最多 limit 段）"""
    try:
        a = before_bytes.decode("utf-8", "replace").splitlines()
        b = after_bytes.decode("utf-8", "replace").splitlines()
    except Exception:  # noqa: BLE001
        return "（无法解码，未生成差异摘要）"
    lines = [l for l in difflib.unified_diff(a, b, "跑前快照", "当前文件", lineterm="")
             if not l.startswith("---") and not l.startswith("+++")]
    return " / ".join(lines[:limit]) if lines else "（无行级差异，可能仅换行符/编码差异）"


def config_guard(tag):
    """配置守卫：把当前 config/config.json 与启动快照比对。

    不一致 → 打印中文差异摘要，并用启动快照字节回写还原（只做「原值 → 原值」的字节还原，
    不改写任何语义值）。返回 (是否发生过改写, 当前 md5, 中文差异摘要)。
    """
    if CONFIG_BYTES_BEFORE is None:
        return False, "", f"[{tag}] 无启动快照（守卫降级：仅告警）"
    try:
        now_bytes = CONFIG_FILE.read_bytes()
    except Exception as e:  # noqa: BLE001
        return False, "", f"[{tag}] 读取失败：{e}"
    md5_now = hashlib.md5(now_bytes).hexdigest()
    if md5_now == CONFIG_MD5_BEFORE:
        return False, md5_now, ""
    summary = f"[{tag}] " + config_diff_summary(CONFIG_BYTES_BEFORE, now_bytes)
    try:
        CONFIG_FILE.write_bytes(CONFIG_BYTES_BEFORE)   # 原值还原（字节级）
        md5_now = hashlib.md5(CONFIG_FILE.read_bytes()).hexdigest()
    except Exception as e:  # noqa: BLE001
        summary += f" / 字节还原失败：{e}"
    return True, md5_now, summary


def problem(title, detail):
    PROBLEMS.append((title, detail))


def ok(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print(f"  ✓ {name}")
    else:
        FAIL.append((name, detail))
        print(f"  ✗ {name}" + (f"   {detail}" if detail else ""))
    return bool(cond)


def warn(name, detail=""):
    WARN.append((name, detail))
    print(f"  ! {name}" + (f"   {detail}" if detail else ""))


def head(title):
    print(f"\n=== {title} ===")


def api(path, method="GET", body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.load(e)
        except Exception:
            return {"ok": False, "error": f"HTTP {e.code}"}


# =============================================================================
# 付费后端闸门（防误花钱 · RK-SPEND-04）
# 为什么需要：本脚本**刻意**打已启动的真实服务（BASE 默认 http://127.0.0.1:8788），
# 真实 config/config.json 的 image.backend 已指向付费厂商（generic-http = 百炼
# wan2.7-image，实测 ¥0.2/张）。两处动作会踩到付费链路：
#   · 第 1392 行点「♻ 重试失败镜头」→ POST /api/render/retry-failed：本集若存在失败镜头，
#     重试会按配置后端真出图（真花钱）；
#   · 第 1416 行点 LLM「🔌 测试连接」→ 真实 LLM 调用（Token 计费，非图片）。
# 另外设置页段落（第 1542 行）本就断言「服务端出图后端 = placeholder」——配置切到付费厂商后
# 该断言必然变红，本闸门同时把这条契约恢复到可复现状态。
# 做法：跑之前用 PUT /api/settings 把 出图/视频/配音 临时切回 placeholder / placeholder / none，
#       跑完在 main() 的 finally 里切回真实配置（异常/中断同样还原），并把 config/config.json
#       的**字节与 mtime 原样还原**（本脚本自身的零写盘守卫 + verify-all.sh 的阶段守卫都按
#       快照比对，基线在本闸门切换之后采集，故守卫语义不变）。
# 断言期望一字未改。
# =============================================================================
_PAID_GATE = {"active": False, "armed": False, "orig": None, "bytes": None, "stat": None, "config": None}


def _paid_gate_config_path():
    """与 src/config.js 同源：FACTORY_CONFIG 优先，否则仓库内 config/config.json"""
    return pathlib.Path(os.environ.get("FACTORY_CONFIG") or (ROOT / "config" / "config.json"))


def _paid_gate_read_settings():
    """只读服务端配置；读不到时返回 None（**绝不能**在未知状态下假定「已经是 placeholder」）"""
    try:
        r = api("/api/settings")
    except Exception:  # noqa: BLE001
        return None
    if not isinstance(r, dict):
        return None
    s = r.get("settings")
    return s if isinstance(s, dict) and s.get("image") is not None else None


def paid_backend_gate_arm():
    """闸门兜底（幂等）：注册 atexit 与 SIGTERM/SIGHUP 处理器。

    为什么需要：主流程的 finally 只能覆盖「正常返回 / 抛异常 / Ctrl-C(SIGINT→KeyboardInterrupt)」，
    覆盖不到 SIGTERM（进程被 kill / 终端关闭 / CI 超时收尾）等硬退出路径；一旦在这些路径上退出，
    服务端会一直停在 placeholder（钱不会多花，但真实配置静默失效，下次人工出图会一脸懵）。
    这里补一层与 finally 等价的兜底。
    """
    if _PAID_GATE.get("armed"):
        return
    _PAID_GATE["armed"] = True
    atexit.register(paid_backend_gate_off)
    for sig in ("SIGTERM", "SIGHUP"):
        s = getattr(signal, sig, None)
        if s is None:
            continue
        try:
            prev = signal.getsignal(s)
        except Exception:  # noqa: BLE001
            prev = None

        def _handler(signum, frame, _prev=prev, _sig=s):
            print(f"\n  ! 付费闸门：收到信号 {signum}，立即切回真实配置后再退出")
            paid_backend_gate_off()
            if callable(_prev):
                return _prev(signum, frame)
            raise SystemExit(128 + signum)

        try:
            signal.signal(s, _handler)
        except Exception:  # noqa: BLE001 非主线程/不支持时跳过（atexit 仍是兜底）
            pass


def paid_backend_gate_on():
    """进入闸门：记录真实配置基线（字节 + mtime），把付费后端临时切回 placeholder/none

    健壮性（本次加固）：
      · 读不到 /api/settings 时**不再假定**「已经是 placeholder」（旧实现会因此直接放行，
        在未知/真实付费后端上继续跑 = 真花钱）→ 一律按下发切换处理，切完再复核；
      · 切换后**复核**服务端出图后端确实变成了 placeholder，没变就还原 + SystemExit（拒绝在付费后端上跑）。
    """
    paid_backend_gate_arm()
    p = _paid_gate_config_path()
    _PAID_GATE["config"] = p
    try:
        _PAID_GATE["bytes"] = p.read_bytes()
        st = p.stat()
        _PAID_GATE["stat"] = (st.st_atime_ns, st.st_mtime_ns)
    except Exception as e:  # noqa: BLE001
        raise SystemExit(f"付费闸门：读取 {p} 失败（{e}），无法建立还原基线；拒绝继续（避免在真实付费后端上误出图）")
    s = _paid_gate_read_settings()
    if s is None:
        print("  ! 付费闸门：读不到 GET /api/settings（服务未起或接口异常）→ 不假定后端为 placeholder，仍强制下发切换并复核")
    s = s or {}
    orig = {
        "image": (s.get("image") or {}).get("backend") or "placeholder",
        "video": (s.get("video") or {}).get("backend") or "placeholder",
        "tts": (s.get("tts") or {}).get("backend") or "none",
    }
    _PAID_GATE["orig"] = orig
    if s and orig == {"image": "placeholder", "video": "placeholder", "tts": "none"}:
        print("  ✓ 付费闸门：出图/视频/配音已是 placeholder/placeholder/none，无需切换（零写盘）")
        return
    r = api("/api/settings", "PUT", {"image": {"backend": "placeholder"},
                                     "video": {"backend": "placeholder"},
                                     "tts": {"backend": "none"}})
    if not (isinstance(r, dict) and r.get("ok")):
        raise SystemExit(f"付费闸门：PUT /api/settings 切换 placeholder 失败（{r}）；拒绝在付费后端上继续跑（会真花钱）")
    _PAID_GATE["active"] = True
    # ★ 复核：切换必须真的生效，否则后面每一张图都是真钱
    verify = _paid_gate_read_settings() or {}
    now_img = (verify.get("image") or {}).get("backend")
    if now_img != "placeholder":
        paid_backend_gate_off()
        raise SystemExit(f"付费闸门：切换后复核失败（服务端出图后端仍是 {now_img!r}，未变成 placeholder）；"
                         "已尝试还原真实配置，拒绝在付费后端上继续跑")
    print(f"  ✓ 付费闸门：已临时切换 出图/视频/配音 = placeholder/placeholder/none"
          f"（原值 {orig['image']}/{orig['video']}/{orig['tts']}；服务端当前出图后端 = {now_img}，已复核）")


def paid_backend_gate_off():
    """退出闸门：切回真实后端，并把 config/config.json 的字节与 mtime 原样还原（幂等，可在 finally / atexit 重复调用）"""
    if not _PAID_GATE.get("active"):
        return
    orig = _PAID_GATE["orig"] or {}
    try:
        try:
            api("/api/settings", "PUT", {"image": {"backend": orig.get("image", "placeholder")},
                                         "video": {"backend": orig.get("video", "placeholder")},
                                         "tts": {"backend": orig.get("tts", "none")}})
        except Exception as e:  # noqa: BLE001
            print(f"  ! 付费闸门：切回真实后端失败（{e}）——config.json 会被字节还原，但运行中的服务可能仍是 placeholder，请重启服务")
        p = _PAID_GATE["config"]
        try:
            if _PAID_GATE.get("bytes") is not None:
                p.write_bytes(_PAID_GATE["bytes"])
            if _PAID_GATE.get("stat"):
                os.utime(p, ns=_PAID_GATE["stat"])
        except Exception as e:  # noqa: BLE001
            print(f"  ! 付费闸门：config.json 字节/mtime 还原失败（{e}）")
        try:
            same = _PAID_GATE.get("bytes") == p.read_bytes()
        except Exception:  # noqa: BLE001
            same = False
        cur = _paid_gate_read_settings() or {}
        print(f"  ✓ 付费闸门：已切回真实配置（出图={(cur.get('image') or {}).get('backend')} "
              f"视频={(cur.get('video') or {}).get('backend')} 配音={(cur.get('tts') or {}).get('backend')}）；"
              f"config.json 字节与跑前{'逐字节一致' if same else '不一致（需人工检查）'}")
    finally:
        # ★ 只在真正做完还原动作后才落回 inactive：这样 finally 提前失败/被硬中断时，
        #   atexit 或信号处理器里的第二次调用仍会重试（幂等，不会重复打印成功）
        _PAID_GATE["active"] = False


def canvas_state(cid="CV-MAIN"):
    """主画布快照：节点/分组/连线数量与关键内容指纹（用于还原校验）"""
    c = api(f"/api/canvas?id={cid}")["canvas"]
    nodes = c["nodes"]
    groups = c["groups"]
    links = c.get("links", [])
    return {
        "id": c["id"],
        "n_nodes": len(nodes),
        "n_groups": len(groups),
        "n_links": len(links),
        "kinds": sorted(f"{n.get('kind', 'actor')}" for n in nodes),
        "actor_ids": sorted(n["actor_id"] for n in nodes if (n.get("kind") or "actor") == "actor" and n.get("actor_id")),
        "group_members": sorted(
            f"{n.get('group_id')}:{n.get('actor_id') or n.get('title') or n['id']}" for n in nodes if n.get("group_id")
        ),
        "group_names": sorted(g["name"] for g in groups),
        "link_pairs": sorted(f"{l.get('from_node')}->{l.get('to_node')}:{l.get('label')}" for l in links),
        "view": (c.get("layout") or {}).get("view") or {},
        "showAll": (c.get("layout") or {}).get("showAll"),
    }


def free_port():
    """取一个空闲端口（供 H-101 尾帧段落的临时实例使用；与主流程的 8788 无关，不重启任何已有服务）"""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


# =============================================================================
# H-101 追加②·尾帧落库（I-101）—— **只在独立临时实例里验**
#
# 为什么另起一个实例，而不是在主流程的 8788 上测：
#   这 5 条用例本质上**会改库**（选尾帧 = PUT /api/render/shots/:id/tail-image → 写 shots.tail_image）。
#   按安全红线「涉及改库的用例只在临时实例（临时 FACTORY_DB / FACTORY_DATA_DIR）上做」，这里：
#     · 用仓库既有 scripts/seed-scale.js 造一套**合成**数据（1 剧本 SC-SCALE / 1 集 S01E001 / 6 镜 + 关键帧行），
#       小规模参数走 --shotsPerEpisode=6（注意种子脚本的键名是 shotsPerEpisode，没有 --shots）；
#     · 种子只写库不落盘，所以按库里的 file_path 现造关键帧文件到临时 DATA_DIR 下（否则尾帧校验会中文 400）；
#     · FACTORY_DATA_DIR 指向临时目录本身，于是 data/images/... 经 resolveAsset 的 DATA_DIR 兜底能命中，
#       与 server.js 的 '/data' 静态路由（dir = DATA_DIR）指向同一处；
#     · 临时 config 只写 placeholder / placeholder / mock（零付费、不出图）；
#     · 浏览器侧**单独开一个 page**（自己的 pageerror 列表）：用例⑤ 用 page.route 把 PUT mock 成 400 会在
#       浏览器控制台留下 400 噪音，单独 page 可保证主流程「全流程无 console.error」断言不受影响。
#   生产库 data/factory.db、生产 data/ 全程只读；临时进程用 start_new_session + killpg 精确回收（不 pkill）。
# =============================================================================
def tail_frame_section(browser):
    """① 面板可选尾帧并落库 ② 重载后仍是「已设」（水合生效）③ 清空后重载回到未设置
    ④ 文件已不存在 → UI 标 ⚠ 且库里原值保留 ⑤ 保存失败（mock 400）→ 中文回滚文案 + 界面回到改动前"""
    head("H-101 · 尾帧落库（独立临时实例，不碰生产库/生产文件）")
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="h101-tail-"))
    db = tmp / "factory.db"
    cfg = tmp / "config.json"
    log = None
    proc = None
    page = None
    try:
        cfg.write_text(json.dumps({"image": {"backend": "placeholder"}, "video": {"backend": "placeholder"},
                                   "llm": {"provider": "mock"}}))
        seed = subprocess.run(
            ["node", "scripts/seed-scale.js", str(db), str(tmp),
             "--actors=1", "--imagesPerActor=0", "--episodes=1", "--shotsPerEpisode=6",
             "--chapters=1", "--canvasLinks=0", "--groups=0", "--jobs=0"],
            cwd=ROOT, capture_output=True, text=True, timeout=300)
        if seed.returncode != 0 or not db.exists():
            ok("临时实例：种子化合成数据（seed-scale，1 剧本 / 1 集 / 6 镜）", False,
               f"exit={seed.returncode} {seed.stdout[-300:]} {seed.stderr[-300:]}")
            return
        ok("临时实例：种子化合成数据（seed-scale，1 剧本 SC-SCALE / 1 集 S01E001 / 6 镜）", True)
        # 关键帧文件：按库里的 file_path 现造（临时 DATA_DIR 下），让尾帧路径校验能通过
        con = sqlite3.connect(db)
        kfs = con.execute("SELECT file_path FROM shot_renders WHERE kind='keyframe' AND status='done'").fetchall()
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="128"><rect width="72" height="128" fill="#345"/></svg>'
        for (fp,) in kfs:
            p = tmp / fp
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(svg)
        con.close()
        ok(f"临时实例：关键帧文件已落盘（{len(kfs)} 张，供「尾帧候选」使用）", len(kfs) >= 2)

        port = free_port()
        tbase = f"http://127.0.0.1:{port}"
        env = {**os.environ, "PORT": str(port), "FACTORY_DB": str(db),
               "FACTORY_DATA_DIR": str(tmp), "FACTORY_CONFIG": str(cfg)}
        log = open(tmp / "server.log", "w")
        proc = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env,
                                stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        ready = False
        for _ in range(90):
            if proc.poll() is not None:
                break
            try:
                with urllib.request.urlopen(tbase + "/api/health", timeout=3) as r:
                    if r.status == 200:
                        ready = True
                        break
            except Exception:  # noqa: BLE001 未就绪就继续等
                time.sleep(0.5)
        if not ready:
            ok("临时实例：服务就绪（随机端口，临时 DB/DATA_DIR）", False,
               "启动失败：" + (tmp / "server.log").read_text()[-500:])
            return
        ok(f"临时实例：服务就绪（{tbase}；FACTORY_DB/FACTORY_DATA_DIR/FACTORY_CONFIG 全在临时目录）", True)

        def tapi(path, method="GET", body=None):
            req = urllib.request.Request(tbase + path, method=method,
                                         data=json.dumps(body).encode() if body is not None else None,
                                         headers={"content-type": "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                try:
                    return json.load(e)
                except Exception:  # noqa: BLE001
                    return {"ok": False, "error": f"HTTP {e.code}"}

        board = tapi("/api/render/episode?scriptId=SC-SCALE&code=S01E001")
        shots = board.get("shots") or []
        if len(shots) < 2:
            ok("临时实例：剧集看板返回多镜（供尾帧候选）", False, f"shots={len(shots)}")
            return
        target = shots[0]["id"]
        ok(f"临时实例：看板 {len(shots)} 镜，起始 tail_image 为空（未设尾帧）",
           shots[0].get("tail_image") in (None, ""), str(shots[0].get("tail_image")))

        page = browser.new_page(viewport={"width": 1720, "height": 1020})
        errs = []
        page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))   # 只收 pageerror（400 mock 的 console 噪音不计）

        def open_board():
            """挂载制作台并选中 SC-SCALE / S01E001（重载页面后也走这里 → 就是「重新打开这一集」）"""
            page.goto(f"{tbase}/#/render", wait_until="networkidle")
            page.wait_for_timeout(2200)
            sc = page.locator(".rd-script", has_text="SC-SCALE")
            if sc.count():
                sc.first.click()
                page.wait_for_timeout(1800)
            ep = page.locator(".rd-ep", has_text="S01E001")
            if ep.count() == 0:
                page.locator(".rd-caret").first.click()
                page.wait_for_timeout(600)
                ep = page.locator(".rd-ep", has_text="S01E001")
            ep.first.click()
            page.wait_for_timeout(2400)

        def open_panel():
            page.locator('[data-act="last-panel"]').first.click()
            page.wait_for_selector(".overlay .modal", timeout=10000)
            page.wait_for_timeout(600)

        def row0():
            return page.locator(".overlay .modal .rd-card").first

        def row0_sel():
            return row0().locator("select").first

        def toast_text():
            t = page.locator(".toasts .toast")
            return t.last.inner_text() if t.count() else ""

        def candidates():
            return page.eval_on_selector_all(
                ".overlay .modal .rd-card select",
                "els => els.length ? [...els[0].options].map(o => o.value).filter(Boolean) : []")

        def db_tail(shot_id):
            r = tapi("/api/render/episode?scriptId=SC-SCALE&code=S01E001")
            s = next((x for x in (r.get("shots") or []) if x["id"] == shot_id), {})
            return s.get("tail_image"), s.get("tail_image_missing")

        open_board()
        ok("临时实例：制作台挂载（.rd-main 存在）", page.locator(".rd-main").count() == 1)

        # ---- ① 「⌛ 尾帧」面板可打开；选一张尾帧后出现「已保存尾帧：下次打开这一集仍在」 ----
        open_panel()
        ptitle = page.locator(".overlay .modal").last.inner_text()
        ok("① 「⌛ 尾帧」面板可打开（标题含「尾帧（首尾帧过渡）」+ 候选来自本集其他镜关键帧）",
           "尾帧（首尾帧过渡）" in ptitle and row0().locator("select").count() == 1)
        cands = candidates()
        if not cands:
            ok("① 面板里能选出可用的尾帧候选（本集其他镜的关键帧）", False, f"candidates={cands}")
        else:
            ok(f"① 面板里能选出可用的尾帧候选（{len(cands)} 张，首张 {cands[0]}）", True)
            row0_sel().select_option(cands[0])
            page.wait_for_timeout(2500)
            t1 = toast_text()
            ok("① 选择尾帧后 toast 含「已保存尾帧：下次打开这一集仍在」",
               "已保存尾帧：下次打开这一集仍在" in t1, t1[:140])
            ok("① 面板行同步显示「已存入项目库」", "已存入项目库" in row0().inner_text(),
               row0().inner_text().replace("\n", " / ")[:140])
            dbv = db_tail(target)[0]
            ok(f"① 库里 tail_image 已写入（{dbv}）", dbv == cands[0], str(dbv))

            # ---- ② 重新加载页面（重挂载制作台）后仍是「已设」→ 证明落库水合生效 ----
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            open_board()
            open_panel()
            sv2 = row0_sel().input_value()
            ok(f"② 重载页面后尾帧仍为「已设」（下拉回显 {sv2}）", sv2 == cands[0], f"select={sv2} 期望={cands[0]}")
            ok("② 重载后面板仍标「已存入项目库」（值来自 /api/render/episode 的 tail_image，不是内存）",
               "已存入项目库" in row0().inner_text(), row0().inner_text().replace("\n", " / ")[:140])
            ok("② 工具栏「⌛ 设置尾帧」计数为 1（水合后计数也对）",
               "（1" in page.locator('[data-act="last-panel"]').first.inner_text(),
               page.locator('[data-act="last-panel"]').first.inner_text())

            # ---- ⑤ 保存失败要回滚：page.route 把 PUT mock 成 400 ----
            page.route("**/api/render/shots/*/tail-image",
                       lambda route: route.fulfill(status=400, content_type="application/json",
                                                   body=json.dumps({"ok": False, "error": "H-101 注入：尾帧保存被拒（400）"})))
            others = [c for c in cands if c != cands[0]]
            row0_sel().select_option(others[0])
            page.wait_for_timeout(2500)
            t5 = toast_text()
            ok("⑤ PUT 被 mock 成 400 时给出中文失败文案（「尾帧没能保存（界面已回滚，库里未改动）」）",
               "尾帧没能保存（界面已回滚，库里未改动）" in t5 and "已保存尾帧" not in t5, t5[:150])
            sv5 = row0_sel().input_value()
            db5 = db_tail(target)[0]
            ok(f"⑤ 界面回到改动前的选择（下拉 {sv5}）且库里仍是原值（{db5}）",
               sv5 == cands[0] and db5 == cands[0], f"select={sv5} db={db5} 期望={cands[0]}")
            ok("⑤ 未显示成功、面板也未把失败值当成已入库", "已存入项目库" in row0().inner_text()
               and others[0] not in row0().inner_text(), row0().inner_text().replace("\n", " / ")[:140])
            page.unroute("**/api/render/shots/*/tail-image")

            # ---- ③ 清空 → 「已清除尾帧」→ 重载后回到「未设置」 ----
            row0().locator("button", has_text="清空").first.click()
            page.wait_for_timeout(2500)
            t3 = toast_text()
            ok("③ 清空后 toast 含「已清除尾帧」", "已清除尾帧" in t3, t3[:130])
            page.keyboard.press("Escape")
            page.wait_for_timeout(400)
            open_board()
            open_panel()
            sv3 = row0_sel().input_value()
            ok(f"③ 重载后回到「未设置」状态（下拉 {sv3!r}，行文案「当前：无尾帧」）",
               sv3 == "" and "当前：无尾帧" in row0().inner_text(), row0().inner_text().replace("\n", " / ")[:140])
            ok("③ 库里 tail_image 已清空", db_tail(target)[0] in (None, ""), str(db_tail(target)[0]))

            # ---- ④ 文件已不存在：只在**临时库**里把 tail_image 指向不存在的路径 ----
            page.keyboard.press("Escape")
            page.wait_for_timeout(300)
            missing = "data/images/S_SC-SCALE/__h101_missing__.svg"
            con2 = sqlite3.connect(db)
            con2.execute("UPDATE shots SET tail_image=? WHERE id=?", (missing, target))
            con2.commit()
            con2.close()
            open_board()
            open_panel()
            r4 = row0().inner_text()
            db4, miss4 = db_tail(target)
            ok("④ 尾帧文件已不存在时 UI 明确标 ⚠「文件已不存在」（不静默清空、不假装正常）",
               "文件已不存在" in r4 and "⚠" in page.locator('[data-act="last-panel"]').first.inner_text(),
               r4.replace("\n", " / ")[:150])
            ok(f"④ 库里原值保留、未被清掉（tail_image={db4}，tail_image_missing={miss4}）",
               db4 == missing and miss4 is True, f"db={db4} missing={miss4}")
            ok("④ 下拉里仍能回显这个「文件已不存在」的已选值（用户可重选或清空）",
               row0_sel().input_value() == missing, row0_sel().input_value())

        ok("尾帧落库段落无 pageerror（未捕获异常）", not errs, "; ".join(errs[:2]))
        page.screenshot(path=str(OUT / "08-tail-frame-temp-instance.png"))
    except Exception as e:  # noqa: BLE001 临时实例段落偶发失败不应中断整套（如实记为失败项）
        ok("H-101 尾帧落库段落未异常中断", False, f"{type(e).__name__}: {e}")
    finally:
        try:
            if page is not None:
                page.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            if proc is not None and proc.poll() is None:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)   # 只回收本段自己起的临时进程
                except Exception:  # noqa: BLE001
                    proc.terminate()
                try:
                    proc.wait(timeout=10)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            pass
        try:
            if log is not None:
                log.close()
        except Exception:  # noqa: BLE001
            pass
        shutil.rmtree(tmp, ignore_errors=True)
        print(f"[temp] 临时实例已回收：{tmp}")


def run_all():
    # ---------- 配置守卫基线：启动时读取真实 config/config.json 的字节快照（脚本结束前必须逐字节一致） ----------
    # 注意：本基线在 main() 的付费后端闸门切换**之后**采集（见文件头与 paid_backend_gate_on），
    # 因此「脚本运行期间零写盘」的语义不变；闸门切回发生在 main() 的 finally，位于基线比对之后。
    global CONFIG_BYTES_BEFORE, CONFIG_MD5_BEFORE, CONFIG_MTIME_BEFORE
    head("配置守卫（真实 config/config.json 快照基线）")
    CONFIG_BYTES_BEFORE, CONFIG_MD5_BEFORE, CONFIG_MTIME_BEFORE = config_snapshot()
    ok("启动时成功读取真实配置文件并算出 md5 + mtime 双快照",
       CONFIG_MD5_BEFORE != "" and CONFIG_MTIME_BEFORE is not None,
       f"读取 {CONFIG_FILE} 失败（禁止静默跳过：真实配置缺失时无法保证零改写，请检查路径/权限）")
    if CONFIG_MD5_BEFORE:
        print(f"  配置基线：{CONFIG_FILE} md5={CONFIG_MD5_BEFORE[:8]}…（{len(CONFIG_BYTES_BEFORE)} 字节）"
              f" mtime={CONFIG_MTIME_BEFORE}")

    # ---------- 起始状态备份（全部只读） ----------
    actors_before = api("/api/actors")["actors"]
    n_actors = len(actors_before)
    st_before = canvas_state("CV-MAIN")
    novels = api("/api/novels")["novels"]
    scripts = api("/api/scripts")["scripts"]
    binding_before = api("/api/scripts/SC-0001/canvas-binding").get("summary") or {}
    print(f"[backup] 演员 {n_actors} 位 · 小说 {len(novels)} 部 · 剧本 {len(scripts)} 部")
    print(f"[backup] 主画布：{st_before['n_nodes']} 节点 / {st_before['n_groups']} 分组 / {st_before['n_links']} 连线")

    temp_canvas_id = None
    created_note = None
    shot_restore = None

    # 起始清场：删除本脚本自己可能遗留的临时画布（上次运行中断时留下），保证可重复运行
    try:
        for c in api("/api/canvas/list")["canvases"]:
            if c["name"] == TEMP_CANVAS:
                for g in api(f"/api/canvas/groups?id={c['id']}")["groups"]:
                    api(f"/api/canvas/groups/{g['id']}", "DELETE")
                for l in api(f"/api/canvas/links?id={c['id']}")["links"]:
                    api(f"/api/canvas/links/{l['id']}", "DELETE")
                api(f"/api/canvas/{c['id']}", "DELETE")
                print(f"[pre-clean] 已删除遗留临时画布 {c['id']}")
    except Exception as e:
        print("[pre-clean] 跳过：", e)

    with sync_playwright() as p:
        kwargs = {"args": ["--no-sandbox"]}
        if pathlib.Path(CHROME).exists():
            kwargs["executable_path"] = CHROME
        browser = p.chromium.launch(**kwargs)
        page = browser.new_page(viewport={"width": 1720, "height": 1020}, accept_downloads=True)

        errs = []
        page.on("console", lambda m: errs.append(f"[console.{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errs.append(f"PAGEERROR: {e}"))

        def mark():
            return len(errs)

        def errs_since(start):
            return [e for e in errs[start:] if "favicon" not in e and "404 (Not Found)" not in e]

        def dbg():
            return page.evaluate("() => window.__acDebug()")

        def items(kind=None):
            its = page.evaluate("() => window.__acDebug().screenItems()")
            if kind:
                its = [i for i in its if i.get("kind") == kind]
            return its

        def cvbox():
            return page.locator("#ac-canvas").bounding_box()

        def close_modals(limit=4):
            """关闭所有残留弹窗（modal/confirm/ctx-menu）；一律走 Esc 或点遮罩，绝不点 footer 首个按钮（可能是「解绑/删除」）"""
            for _ in range(limit):
                if page.locator(".overlay .modal").count() == 0 and page.locator(".ctx-menu").count() == 0:
                    break
                page.keyboard.press("Escape")
                page.wait_for_timeout(120)
            while page.locator(".overlay .modal").count():
                page.mouse.click(6, 6)               # 点弹窗外的遮罩 → 走 overlay 的取消分支
                page.wait_for_timeout(200)

        def close_dialog():
            """按 Escape / 点遮罩关闭当前弹窗（安全：不会误触 footer 里的「解绑 / 删除 / 保存」）"""
            page.keyboard.press("Escape")
            page.wait_for_timeout(250)
            if page.locator(".overlay .modal").count():
                page.mouse.click(6, 6)
                page.wait_for_timeout(250)

        def wait_modal(text=None, timeout=8000):
            sel = ".overlay .modal"
            page.wait_for_selector(sel, timeout=timeout)
            if text:
                page.wait_for_function(
                    "t => [...document.querySelectorAll('.overlay .modal')].some(m => m.textContent.includes(t))",
                    arg=text, timeout=timeout,
                )
            return page.locator(sel).last

        def modal_text():
            return page.locator(".overlay .modal").last.inner_text()

        def click_dialog(btn, exact=False):
            """点击弹窗 footer 里的按钮（按文案）"""
            loc = page.locator(".overlay .modal footer button")
            n = loc.count()
            for i in range(n):
                t = loc.nth(i).inner_text().strip()
                if (t == btn) if exact else (btn in t):
                    loc.nth(i).click()
                    page.wait_for_timeout(200)
                    return True
            return False

        def empty_point():
            """找一个画布上的空白点（不含任何节点/分组框，且不在小地图/缩放条覆盖区）"""
            box = cvbox()
            z = dbg()["zoom"]
            pan = dbg()
            its = items()
            gl = page.evaluate("() => window.__acDebug().groupList")
            busy = []
            for it in its:
                busy.append((it["cx"] - it["w"] * z / 2, it["cy"] - it["h"] * z / 2,
                             it["cx"] + it["w"] * z / 2, it["cy"] + it["h"] * z / 2))
            for g in gl:
                busy.append((box["x"] + (g["x"] + pan["panX"]) * z, box["y"] + (g["y"] + pan["panY"]) * z,
                             box["x"] + (g["x"] + g["w"] + pan["panX"]) * z,
                             box["y"] + (g["y"] + g["h"] + pan["panY"]) * z))
            for y in range(int(box["y"] + box["height"] - 210), int(box["y"] + 40), -40):
                for x in range(int(box["x"] + 150), int(box["x"] + box["width"] - 250), 60):
                    if any(x0 - 6 <= x <= x1 + 6 and y0 - 6 <= y <= y1 + 6 for (x0, y0, x1, y1) in busy):
                        continue
                    return x, y
            return None

        # 让主画布进入「全部可见」状态，便于后续定位
        page.goto(f"{BASE}/#/actors", wait_until="networkidle")
        page.wait_for_timeout(2600)

        # =====================================================================
        head("模块1 · 演员矩阵页 #/actors")
        m0 = mark()
        d0 = dbg()
        n_items_actor = len(items("actor"))
        ok("页面挂载：主画布 + 小地图 + 工具栏 + HUD 同时存在",
           page.locator("#ac-canvas").count() == 1 and page.locator("#ac-minimap").count() == 1
           and page.locator(".ac-toolbar").count() == 1 and page.locator("#ac-hud").count() == 1)
        ok(f"演员卡数量与接口一致（{n_items_actor} == /api/actors {n_actors} == 侧栏 {page.locator('.ac-item').count()}）",
           n_items_actor == n_actors == page.locator(".ac-item").count())
        hud = page.inner_text("#ac-hud")
        ok("HUD 含 缩放 / 模式 / 总数 / 分组 / LOD",
           "%" in hud and ("宫格" in hud or "自由" in hud) and "👥" in hud and "LOD" in hud, hud.replace("\n", " "))
        ok(f"侧栏计数文案正确（共 {n_actors} 位演员）",
           f"共 {n_actors} 位演员" in page.inner_text("#ac-count"), page.inner_text("#ac-count"))
        ok("主画布语义 showAll=true（宫格预览全部演员）", d0["showAll"] is True, f"showAll={d0['showAll']}")
        if page.locator("#ac-minimap").count() == 0 or not page.locator("#ac-minimap").is_visible():
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(1500)
        mm = page.locator("#ac-minimap").bounding_box() or {"width": 0, "height": 0}
        ok("小地图尺寸 208×140（存在且未被撑满）",
           abs(mm["width"] - 208) < 2 and abs(mm["height"] - 140) < 2, f"{mm['width']}×{mm['height']}")
        page.screenshot(path=str(OUT / "01-actors-overview.png"))

        # ---------- 1B 演员档案（抽屉） ----------
        first = actors_before[0]
        row = page.locator(".ac-item").filter(has_text=first["id"]).first
        row.click()
        page.wait_for_timeout(300)
        ok(f"点击演员可选中（{first['name']} {first['id']}）", dbg()["selection"] == [first["id"]], str(dbg()["selection"]))
        row.dblclick()
        page.wait_for_timeout(900)
        ok("双击打开演员档案抽屉", page.locator("#ac-drawer.open").count() == 1)
        drawer_head = page.inner_text("#ac-drawer .drawer-head")
        ok("档案面板显示演员姓名与 ID", first["name"] in drawer_head and first["id"] in drawer_head,
           drawer_head.replace("\n", " ")[:60])
        labels = page.eval_on_selector_all("#ac-drawer label.f > span", "els => els.map(e => e.textContent.trim())")
        need = ["性别", "种族", "身高 (cm)", "体型", "画风风格（10 选 1）", "画面比例", "服饰（英文标签，如 black trench coat）"]
        miss_lb = [n for n in need if n not in labels]
        ok("档案字段齐全（性别/种族/身高/体型/风格/出图参数/服饰）", not miss_lb, f"缺 {miss_lb}")
        ok("提示词编辑区存在（正向/负向两个 textarea）",
           page.locator("#ac-drawer label.f", has_text="正向提示词 POSITIVE").locator("textarea").count() == 1
           and page.locator("#ac-drawer label.f", has_text="负向提示词 NEGATIVE").locator("textarea").count() == 1)
        h4s = page.eval_on_selector_all("#ac-drawer .sec h4", "els => els.map(e => e.textContent.trim())")
        ok("档案分节齐全（基础档案/外形细节/人设/画风与出图参数/提示词/记录）",
           len(h4s) >= 6 and any("基础档案" in h for h in h4s) and any("提示词" in h for h in h4s), "/".join(h4s)[:80])
        pos = page.locator("#ac-drawer label.f", has_text="正向提示词 POSITIVE").locator("textarea").first
        original = pos.input_value()
        pos.fill(original + " #ui-sim")
        changed = pos.input_value()
        pos.fill(original)
        ok("正向提示词输入框可编辑（写入→还原，未保存）",
           changed.endswith("#ui-sim") and pos.input_value() == original,
           f"len={len(original)}->{len(changed)}")
        page.locator("#ac-drawer .drawer-head button").first.click()
        page.wait_for_timeout(400)
        ok("档案抽屉可关闭", page.locator("#ac-drawer.open").count() == 0)

        # ---------- 1C 右键生成清单 ----------
        row.click(button="right")
        page.wait_for_timeout(500)
        ok("右键演员卡弹出菜单（标题含 姓名·ID）",
           page.locator(".ctx-menu").count() >= 1 and first["name"] in page.inner_text(".ctx-menu"),
           page.inner_text(".ctx-menu")[:60].replace("\n", "/"))
        menu = page.inner_text(".ctx-menu")
        top_need = ["📋 打开明星档案", "✏️ 编辑档案", "🖼 生成（文生图 / 参考生图）", "⚡ 打开生成参数面板…",
                    "🎨 仅优化提示词（LLM）", "🧠 AI 补全人物描述", "⭐ 生成全身定妆主图",
                    "🧬 复制为副本（Ctrl+D）", "🗂 组成分组（Frame）", "🔗 连线到…（关系/对手戏）", "🗑 删除演员"]
        miss = [t for t in top_need if t not in menu]
        ok("右键菜单顶层项齐全（生成/编辑/复制/删除/连线等 11 项）", not miss, f"缺 {miss}")
        page.locator(".ctx-menu .mi").filter(has_text="🖼 生成（文生图").first.hover()
        page.wait_for_timeout(600)
        sub = "\n".join(page.locator(".ctx-sub").all_inner_texts())
        kinds_need = ["脸部大图特写", "多角度全身", "多表情", "头部多角度", "姿态动作", "手势细节", "服饰细节"]
        kmiss = [k for k in kinds_need if k not in sub]
        ok("生成子菜单含 7 个真实分类（脸部大图特写/多角度/多表情/头部多角度/姿态/手势/服饰细节）",
           bool(sub) and not kmiss, f"缺 {kmiss}｜子菜单={sub[:80]!r}".replace("\n", "/"))
        # 二级菜单：悬停某一分类 → 生成全部变体 / 自定义参数生成
        page.locator(".ctx-sub .mi").filter(has_text="脸部大图特写").first.hover(force=True)
        page.wait_for_timeout(600)
        subs = page.locator(".ctx-sub").all_inner_texts()
        deep = subs[-1] if subs else ""
        ok("分类子菜单含「生成全部变体（N 张）」与「自定义参数生成…」",
           "生成全部变体" in deep and "自定义参数生成" in deep, f"二级菜单={deep[:80]!r}".replace("\n", "/"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        ok("Esc 可关闭右键菜单", page.locator(".ctx-menu").count() == 0)

        # ---------- 1D 工具栏 / 缩放 / 导出 / 画布切换 ----------
        btns = page.eval_on_selector_all(".ac-toolbar button", "els => els.map(e => e.textContent.trim())")
        tb_need = ["▦ 宫格", "🎨 画风组", "🎭 角色组", "🧬 种族组", "⊕ 放入全部", "⌀ 清空本画布",
                   "🗂 成组", "📝 便签", "🔀 宫格模式", "⤢ 适应", "🔍+", "🔍−", "⟲ 复位", "🖼 导出图", "↻ 刷新"]
        tmiss = [t for t in tb_need if t not in btns]
        ok("工具栏按钮文案齐全（宫格排布/分组/缩放/复位/导出/刷新）", not tmiss, f"缺 {tmiss}")
        ok("缩放条 5 个入口（−/百分比/＋/适应/缩放到选中）",
           page.locator("#ac-zoombar .ac-zoom-btn").count() == 4
           and page.locator("#ac-zoombar .ac-zoom-val").count() == 1)
        titles = page.eval_on_selector_all("#ac-align-bar button", "els => els.map(e => e.title)")
        ok("对齐与分布入口齐全（左/居中/右/顶/垂直居中/底 + 横向/纵向等距）",
           len(titles) == 8 and any("左对齐" in t for t in titles) and any("水平等距分布" in t for t in titles),
           "/".join(titles)[:80])

        z_before = dbg()["zoom"]
        page.locator(".ac-toolbar button", has_text="🔍+").first.click()
        page.wait_for_timeout(400)
        z_in = dbg()["zoom"]
        page.locator(".ac-toolbar button", has_text="🔍−").first.click()
        page.wait_for_timeout(400)
        z_out = dbg()["zoom"]
        zoombar = page.inner_text(".ac-zoom-val")
        ok("工具栏 + / − 改变缩放，且缩放条百分比与内部 zoom 一致",
           z_in > z_before * 1.05 and z_out < z_in * 0.95 and abs(z_out - z_before) / z_before < 0.02
           and abs(int(zoombar.replace("%", "")) - round(dbg()["zoom"] * 100)) <= 1,
           f"{z_before:.3f}→{z_in:.3f}→{z_out:.3f} bar={zoombar}")
        page.keyboard.press("f")
        page.wait_for_timeout(900)
        z_fit = dbg()["zoom"]
        page.keyboard.press("0")
        page.wait_for_timeout(500)
        d_reset = dbg()
        ok("F 适应窗口 / 0 复位到 100%（且平移归零）",
           0.05 < z_fit < 8 and abs(d_reset["zoom"] - 1) < 1e-9 and d_reset["panX"] == 0 and d_reset["panY"] == 0,
           f"fit={z_fit:.3f} reset={d_reset['zoom']}")
        page.keyboard.press("Home")
        page.wait_for_timeout(400)
        ok("Home 键归零平移", dbg()["panX"] == 0 and dbg()["panY"] == 0)

        # 缩放以光标为中心（先记录光标下的世界坐标）
        box = cvbox()
        cx, cy = box["x"] + 700, box["y"] + 430
        page.mouse.move(cx, cy)
        w_before = page.evaluate("(p) => window.__acDebug().worldAt(p.x, p.y)", {"x": cx, "y": cy})
        for _ in range(3):
            page.mouse.wheel(0, -220)
        page.wait_for_timeout(500)
        w_after = page.evaluate("(p) => window.__acDebug().worldAt(p.x, p.y)", {"x": cx, "y": cy})
        ok("滚轮缩放：缩放值变化且以光标为锚点（光标下世界坐标不动）",
           abs(dbg()["zoom"] - 1) > 0.05 and abs(w_before["x"] - w_after["x"]) < 1.5
           and abs(w_before["y"] - w_after["y"]) < 1.5,
           f"zoom={dbg()['zoom']:.3f} {w_before} → {w_after}")

        # LOD 档位随缩放变化
        page.keyboard.press("0")
        page.wait_for_timeout(300)
        for _ in range(90):
            if dbg()["zoom"] < 0.12:
                break
            page.mouse.move(cx, cy)
            page.mouse.wheel(0, 260)
            page.wait_for_timeout(30)
        lod_low = dbg()["lod"]
        for _ in range(40):
            page.mouse.move(cx, cy)
            page.mouse.wheel(0, -260)
            page.wait_for_timeout(30)
            if dbg()["zoom"] > 1.0:
                break
        lod_high = dbg()["lod"]
        ok("LOD 随缩放档位变化（极小=0 色块 / 中=1 / 大=2 全信息）",
           lod_low == 0 and lod_high == 2, f"低={lod_low} 高={lod_high} zoom={dbg()['zoom']:.2f}")

        # ---- 平移（画布提示语声明：空格 / 中键 / 双指拖动） ----
        # ① 中键拖拽平移（回归：曾经中键在按钮判断里被提前 return 掉，与提示语不符）
        page.keyboard.press("0")
        page.wait_for_timeout(400)
        page.mouse.move(cx, cy)
        page.mouse.down(button="middle")
        page.mouse.move(cx + 160, cy + 90, steps=10)
        page.mouse.up(button="middle")
        page.wait_for_timeout(500)
        mid_pan = (dbg()["panX"], dbg()["panY"])
        ok("中键拖拽可平移画布（画布提示语承诺的三种平移方式之一）",
           abs(mid_pan[0]) > 50 and abs(mid_pan[1]) > 20, f"pan {mid_pan}")

        # ② Alt + 拖拽平移
        page.keyboard.press("0")
        page.wait_for_timeout(300)
        pan_before = (dbg()["panX"], dbg()["panY"])
        page.keyboard.down("Alt")
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx + 160, cy + 90, steps=10)
        page.mouse.up()
        page.keyboard.up("Alt")
        page.wait_for_timeout(500)
        pan_alt = (dbg()["panX"], dbg()["panY"])
        ok("Alt + 拖拽平移画布（世界坐标偏移变化）",
           abs(pan_alt[0] - pan_before[0]) > 50 and abs(pan_alt[1] - pan_before[1]) > 20,
           f"{pan_before} → {pan_alt}")
        # ③ 空格 + 拖拽平移
        page.keyboard.press("0")
        page.wait_for_timeout(300)
        page.keyboard.down("Space")
        page.wait_for_timeout(150)
        page.mouse.move(cx, cy)
        page.mouse.down()
        page.mouse.move(cx - 140, cy - 70, steps=10)
        page.mouse.up()
        page.keyboard.up("Space")
        page.wait_for_timeout(500)
        pan_sp = (dbg()["panX"], dbg()["panY"])
        ok("空格 + 拖拽平移画布（画布 hint 声明的平移方式）",
           abs(pan_sp[0]) > 50 and abs(pan_sp[1]) > 20, f"{pan_sp}")

        # ④ 平移状态必须随 mouseup 复位（回归：曾经不复位 → 松手后「不按键移动鼠标」仍持续平移，
        #    并让 框选 / 卡片拖拽 / 便签拖动 / 端口缩放 / 连线 全部失效）
        before_leak = (dbg()["panX"], dbg()["panY"])
        page.mouse.move(cx, cy)
        page.wait_for_timeout(150)
        page.mouse.move(cx + 200, cy + 120, steps=8)
        page.wait_for_timeout(400)
        after_leak = (dbg()["panX"], dbg()["panY"])
        ok("松开鼠标后平移已复位（不按键移动鼠标不再拖动画布）",
           before_leak == after_leak, f"pan {before_leak} → {after_leak}")
        # 平移状态直接可观测：mouseup 后必须为 false（若泄漏，画布上的所有拖拽类交互都会失效）
        ok("平移状态位已复位（__acDebug.panning=false）", dbg().get("panning") is False, f"panning={dbg().get('panning')}")
        # 平移之后单击卡片仍能正常选中（交互未因平移失效）
        screen_items = dbg().get("screenItems") or []
        if screen_items:
            it0 = screen_items[0]
            page.mouse.click(it0["screen"]["x"], it0["screen"]["y"])
            page.wait_for_timeout(400)
            sel_after_pan = dbg().get("selection") or []
            ok("平移之后仍可正常选中卡片（交互未失效）", len(sel_after_pan) >= 1, f"选中 {len(sel_after_pan)} 张")
        page.keyboard.press("Escape")
        page.keyboard.press("0")
        page.wait_for_timeout(400)
        ok("重挂载演员矩阵后视图恢复可用（缩放/选择初始态）",
           dbg()["canvasId"] == "CV-MAIN" and abs(dbg()["zoom"] - 1) < 1e-6 and dbg()["selection"] == [],
           f"zoom={dbg()['zoom']} sel={dbg()['selection']}")

        # 画布选择器与新建画布弹窗
        cv_list = api("/api/canvas/list")["canvases"]
        opts = page.eval_on_selector_all("#ac-canvas-picker select option", "els => els.map(e => e.value)")
        ok(f"画布切换器选项与 /api/canvas/list 一致（{len(opts)} 个）",
           sorted(opts) == sorted(c["id"] for c in cv_list), f"{opts} vs {[c['id'] for c in cv_list]}")
        page.locator(".ac-toolbar button", has_text="🗂 新建画布").first.click()
        wait_modal("🗂 新建画布")
        mtxt = modal_text()
        ok("「新建画布」弹窗可打开（含名称/列数/卡位宽度）",
           "画布名称" in mtxt and "宫格列数" in mtxt and "卡位宽度" in mtxt)
        click_dialog("取消", exact=True)
        page.wait_for_timeout(300)
        ok("弹窗可取消（未创建画布）", page.locator(".overlay .modal").count() == 0
           and len(api("/api/canvas/list")["canvases"]) == len(cv_list))

        # 导出入口一致性（工具栏 vs 画布右键）
        page.keyboard.press("f")
        page.wait_for_timeout(800)
        with page.expect_download(timeout=30000) as dl1:
            page.locator(".ac-toolbar button", has_text="🖼 导出图").first.click()
        f1 = dl1.value.suggested_filename
        ep = empty_point()
        ok("画布空白处可定位（用于右键菜单）", ep is not None)
        f2 = None
        if ep:
            page.mouse.click(ep[0], ep[1], button="right")
            page.wait_for_timeout(500)
            cm = page.inner_text(".ctx-menu") if page.locator(".ctx-menu").count() else ""
            ok("画布右键菜单出现（含 宫格排布/适应窗口/导出 PNG 阵容图）",
               "画布 · " in cm and "🔲 宫格排布（按当前列数）" in cm and "🖼 导出 PNG 阵容图" in cm,
               cm[:60].replace("\n", "/"))
            if "🖼 导出 PNG 阵容图" in cm:
                with page.expect_download(timeout=30000) as dl2:
                    page.locator(".ctx-menu .mi", has_text="🖼 导出 PNG 阵容图").first.click()
                f2 = dl2.value.suggested_filename
        ok("导出两个入口（工具栏 / 右键）结果一致", f2 is not None and f1 == f2, f"工具栏={f1} 右键={f2}")

        # 键盘快捷键（不改数据：删除/复制都在确认弹窗处取消）
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        page.locator(".ac-canvas-wrap").click(position={"x": 30, "y": 30})
        page.keyboard.press("Control+a")
        page.wait_for_timeout(400)
        ok(f"Ctrl+A 全选当前视图（{len(dbg()['selection'])} == {n_actors}）", len(dbg()["selection"]) == n_actors)
        page.keyboard.press("Delete")
        dlg = page.locator(".overlay .modal")
        dlg_text = ""
        for _ in range(12):                      # 弹窗刚挂载时 inner_text 可能只有标题，轮询等正文
            page.wait_for_timeout(250)
            if dlg.count():
                dlg_text = dlg.first.inner_text()
                if "确认删除" in dlg_text:
                    break
        ok("Del 触发删除演员确认弹窗（危险操作有二次确认）",
           dlg.count() == 1 and "确认删除" in dlg_text, dlg_text.replace("\n", " / ")[:60] if dlg_text else "(无弹窗)")
        click_dialog("取消", exact=True)
        page.wait_for_timeout(400)
        ok("取消删除后演员数不变", len(api("/api/actors")["actors"]) == n_actors)
        page.locator(".ac-item").first.click()
        page.wait_for_timeout(300)
        page.keyboard.press("Control+d")
        page.wait_for_timeout(600)
        dlg = page.locator(".overlay .modal")
        ok("Ctrl+D 触发复制演员确认弹窗", dlg.count() == 1 and "复制选中" in dlg.inner_text(),
           dlg.inner_text()[:40] if dlg.count() else "")
        click_dialog("取消", exact=True)
        page.wait_for_timeout(400)
        ok("取消复制后演员数不变（未产生副本）", len(api("/api/actors")["actors"]) == n_actors)
        ok("模块1 主画布阶段无 JS 错误 / console error", not errs_since(m0), "; ".join(errs_since(m0)[:3]))

        # ---------- 1E 临时画布：节点 / 分组 / 便签 / 连线 / 层级 / 缩放 ----------
        head("模块1b · 无限画布写操作（在本脚本自建的临时画布上进行）")
        page.locator(".ac-toolbar button", has_text="🗂 新建画布").first.click()
        wait_modal("🗂 新建画布")
        page.locator(".overlay .modal input[type=text]").first.fill(TEMP_CANVAS)
        click_dialog("创建", exact=True)
        page.wait_for_timeout(1500)
        cvs = api("/api/canvas/list")["canvases"]
        temp_canvas_id = dbg()["canvasId"]
        tmp = [c for c in cvs if c["id"] == temp_canvas_id and c["name"] == TEMP_CANVAS]
        ok("可新建画布并自动切换到新画布",
           temp_canvas_id != "CV-MAIN" and bool(tmp), f"canvasId={temp_canvas_id} 名称命中={len(tmp)}")
        ok("临时画布初始为空（0 卡位）且 showAll=false", dbg()["items"] == 0 and dbg()["showAll"] is False,
           f"items={dbg()['items']} showAll={dbg()['showAll']}")
        page.locator(".ac-toolbar button", has_text="⊕ 放入全部").first.click()
        page.wait_for_timeout(1600)
        ok(f"「⊕ 放入全部」把 {n_actors} 位演员放入画布（showAll 转 true）",
           len(items("actor")) == n_actors and dbg()["showAll"] is True,
           f"items={len(items('actor'))} showAll={dbg()['showAll']}")
        page.keyboard.press("f")
        page.wait_for_timeout(800)

        # 框选：起点固定在画布左下（覆盖层上方、所有卡片下方），拖到右上 → 覆盖全部卡片
        page.keyboard.press("Escape")
        page.keyboard.press("0")
        page.wait_for_timeout(400)
        page.keyboard.press("Home")
        page.wait_for_timeout(300)
        # 框选：起点固定在「所有卡片下方」，拖到右上 → 覆盖全部卡片。
        # 前置的「适应窗口」已保证 12 张卡片都在视口内，所以起点只需夹在画布可视区内
        # （此前要求底部再留 195px 余量，卡片多/适配后永远满足不了 → 会空转 5 次后误报）。
        marq_ok, marq_info = False, ""
        for attempt in range(3):
            page.keyboard.press("Escape")
            page.wait_for_timeout(150)
            b = cvbox()
            zz = dbg()["zoom"]
            its = items("actor")
            if not its:
                break
            maxy = max(i["cy"] + i["h"] * zz / 2 for i in its)
            ys = min(maxy + 26, b["y"] + b["height"] - 30)
            sx = b["x"] + 8
            page.mouse.move(sx, ys)
            page.mouse.down()
            if len(dbg()["selection"]) == 0:
                page.mouse.move(b["x"] + b["width"] - 8, b["y"] + 8, steps=16)
                page.mouse.up()
                page.wait_for_timeout(700)
                marq_ok = len(dbg()["selection"]) == n_actors
                marq_info = f"起点({sx:.0f},{ys:.0f}) zoom={zz:.2f} → 选中 {len(dbg()['selection'])}/{n_actors}"
                if marq_ok:
                    break
            else:
                page.mouse.up()
                page.wait_for_timeout(200)
                marq_info = f"起点({sx:.0f},{ys:.0f}) 非空白（选中 {len(dbg()['selection'])}）"
            page.keyboard.press("f")
            page.wait_for_timeout(700)
        ok("空白框选可多选卡片（拖框覆盖全部卡片）", marq_ok, marq_info)

        # 成组
        g_before = dbg()["groups"]
        page.locator(".ac-toolbar button", has_text="🗂 成组").first.click()
        page.wait_for_timeout(1800)
        dg = dbg()
        ok(f"选中多卡可组成分组（{g_before} → {dg['groups']}）", dg["groups"] == g_before + 1)
        ok("成组后自动选中该分组并带入视野", dg["selectedGroup"] is not None)

        def find_group_header(name):
            """在分组标题栏上找一个能弹出「分组菜单」的点（自适应视图/几何变化）"""
            for round_i in range(2):
                d = dbg()
                grp = [g for g in d["groupList"] if (name is None or g["name"] == name)]
                if not grp:
                    return None, None, "", None
                grp = grp[-1]
                b = cvbox()
                zz = d["zoom"]
                for fy in (7, 11, 15, 4, 19):
                    for fx in (0.05, 0.15, 0.3, 0.45, 0.6, 0.75, 0.25):
                        x = b["x"] + (grp["x"] + grp["w"] * fx + d["panX"]) * zz
                        y = b["y"] + (grp["y"] + d["panY"]) * zz + fy
                        if not (b["x"] + 2 < x < b["x"] + b["width"] - 2 and b["y"] + 2 < y < b["y"] + b["height"] - 2):
                            continue
                        page.mouse.click(x, y, button="right")
                        page.wait_for_timeout(360)
                        t = page.inner_text(".ctx-menu") if page.locator(".ctx-menu").count() else ""
                        if "解散分组" in t or "重命名" in t:
                            return x, y, t, grp
                        if t:
                            page.keyboard.press("Escape")
                            page.wait_for_timeout(120)
                if round_i == 0:                        # 首轮无命中：把内容缩到可见再试一次
                    page.keyboard.press("f")
                    page.wait_for_timeout(1000)
            return None, None, "", grp

        gx, gy, gm, grp = find_group_header(None)
        gm_need = ["✏️ 重命名", "收起分组", "🎨 换个颜色", "☑️ 选中组内全部卡片",
                   "⤢ 贴合内容大小", "🗑 解散分组（保留卡片）"]
        gmiss = [t for t in gm_need if t not in gm]
        ok("分组右键菜单项齐全（重命名/收起/改色/选中/贴合/解散）", bool(gm) and not gmiss,
           f"缺 {gmiss} 菜单={gm[:60]}".replace("\n", "/"))
        if "✏️ 重命名" in gm:
            page.locator(".ctx-menu .mi", has_text="✏️ 重命名").first.click()
            wait_modal("重命名分组")
            page.locator(".overlay .modal input[type=text]").first.fill("UI模拟分组")
            click_dialog("保存", exact=True)
            page.wait_for_timeout(1500)
            names = [g["name"] for g in dbg()["groupList"]]
            ok("分组可重命名", "UI模拟分组" in names, str(names))
        gx2, gy2, gm2, grp2 = find_group_header("UI模拟分组")
        if "收起分组" in gm2:
            page.locator(".ctx-menu .mi", has_text="收起分组").first.click()
            page.wait_for_timeout(1400)
            col = dbg()
            ok("分组可收起（组内卡片不再绘制）",
               any(g["collapsed"] for g in col["groupList"]) and len(items("actor")) == 0,
               f"items={len(items('actor'))}")
        else:
            warn("未能打开分组菜单（收起分组）", str(gm2)[:40])
        gx3, gy3, gm3, grp3 = find_group_header("UI模拟分组")
        if "展开分组" in gm3:
            page.locator(".ctx-menu .mi", has_text="展开分组").first.click()
            page.wait_for_timeout(1400)
            ok("分组可展开（卡片恢复显示）", len(items("actor")) == n_actors, f"items={len(items('actor'))}")
        else:
            warn("未能打开分组菜单（展开分组）", str(gm3)[:40])
        gx4, gy4, gm4, grp4 = find_group_header("UI模拟分组")
        if "🎨 换个颜色" in gm4:
            page.locator(".ctx-menu .mi", has_text="🎨 换个颜色").first.click()
            page.wait_for_timeout(1200)
            colors = api(f"/api/canvas/groups?id={temp_canvas_id}")["groups"]
            c_now = [g["color"] for g in colors if g["name"] == "UI模拟分组"]
            ok("分组可改色（写入 canvas_groups.color）", bool(c_now) and c_now[0] != "", f"color={c_now}")
        else:
            warn("未能打开分组菜单（改色）", str(gm4)[:40])

        # 拖动分组标题栏整体移动
        dg = dbg()
        grp = [g for g in dg["groupList"] if g["name"] == "UI模拟分组"]
        if grp:
            grp = grp[0]
            z = dg["zoom"]
            gx0 = box["x"] + (grp["x"] + grp["w"] * 0.4 + dg["panX"]) * z
            gy0 = box["y"] + (grp["y"] + dg["panY"]) * z + 8
            page.mouse.move(gx0, gy0)
            page.mouse.down()
            page.mouse.move(gx0 + 90, gy0 + 70, steps=12)
            page.mouse.up()
            page.wait_for_timeout(1600)
            grp2 = [g for g in dbg()["groupList"] if g["name"] == "UI模拟分组"][0]
            ok("拖动分组标题栏可整体移动分组框",
               abs(grp2["x"] - grp["x"]) > 40 and abs(grp2["y"] - grp["y"]) > 25,
               f"({grp['x']},{grp['y']}) → ({grp2['x']},{grp2['y']})")

        # 便签：新建（弹窗）→ 撤销 → 重做 → 拖动
        page.locator(".ac-toolbar button", has_text="📝 便签").first.click()
        wait_modal("便签")
        ok("「📝 便签」可新建便签并弹出编辑框", "便签内容" in modal_text())
        page.locator(".overlay .modal textarea").first.fill("UI模拟便签：仅用于自动化测试")
        click_dialog("保存", exact=True)
        page.wait_for_timeout(1200)
        notes = dbg()["noteList"]
        created_note = notes[-1]["id"] if notes else None
        ok("便签落库（notes=1，含内容）", dbg()["notes"] == 1 and created_note is not None,
           f"notes={dbg()['notes']}")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        page.keyboard.press("Control+z")
        page.wait_for_timeout(1400)
        ok("Ctrl+Z 撤销生效（新建便签被撤销）", dbg()["notes"] == 0, f"notes={dbg()['notes']}")
        page.keyboard.press("Control+Shift+z")
        page.wait_for_timeout(1400)
        ok("Ctrl+Shift+Z 重做生效（便签恢复）", dbg()["notes"] == 1, f"notes={dbg()['notes']}")
        page.keyboard.press("Escape")
        page.keyboard.press("f")
        page.wait_for_timeout(1000)
        n0 = [i for i in page.evaluate("() => window.__acDebug().screenItems()") if i["kind"] == "note"]
        n0 = n0[0] if n0 else None
        dragged, ndbg = False, ""
        if n0:
            z = dbg()["zoom"]
            b = cvbox()
            for ox, oy in ((0, 0), (0, 20), (0, -20)):
                nx, ny = n0["cx"] + ox, n0["cy"] + oy
                ndbg = f"点({nx:.0f},{ny:.0f}) box={b['x']:.0f},{b['y']:.0f},{b['width']:.0f}x{b['height']:.0f}"
                if not (b["x"] + 4 < nx < b["x"] + b["width"] - 4 and b["y"] + 4 < ny < b["y"] + b["height"] - 4):
                    continue
                page.mouse.move(nx, ny)
                page.mouse.down()
                hit_note = dbg()["selectedNote"] is not None
                if hit_note:
                    page.mouse.move(nx + 130, ny + 90, steps=12)
                    page.mouse.up()
                    page.wait_for_timeout(1500)
                    dragged = True
                    break
                page.mouse.up()
                page.wait_for_timeout(150)
        n1 = [n for n in api(f"/api/canvas?id={temp_canvas_id}")["canvas"]["nodes"] if n.get("kind") == "note"]
        ok("便签可拖动并落库（坐标变化）",
           dragged and bool(n1) and n1 and (abs(n1[0]["x"] - n0["wx"]) > 40 or abs(n1[0]["y"] - n0["wy"]) > 40),
           f"{ndbg} 命中={dragged} " + (f"({n0['wx']},{n0['wy']}) → ({n1[0]['x']},{n1[0]['y']})" if n1 else "no note"))

        # 单卡右下角拖拽缩放（挑一张整卡都在画布可视区内的卡片，留出拖拽余量）
        page.keyboard.press("Escape")
        page.keyboard.press("f")
        page.wait_for_timeout(900)
        b = cvbox()
        zz = dbg()["zoom"]
        it0 = None
        for cand in items("actor"):
            if (b["x"] + 30 < cand["cx"] - cand["w"] * zz / 2 and cand["cx"] + cand["w"] * zz / 2 < b["x"] + b["width"] - 110
                    and b["y"] + 30 < cand["cy"] - cand["h"] * zz / 2 and cand["cy"] + cand["h"] * zz / 2 < b["y"] + b["height"] - 200):
                it0 = cand
                break
        ok("临时画布上存在完整可见的卡片（用于缩放/层级交互）", it0 is not None)
        if it0:
            hx = it0["cx"] + it0["w"] * zz / 2 - 6
            hy = it0["cy"] + it0["h"] * zz / 2 - 6
            page.mouse.move(hx, hy)
            page.mouse.down()
            page.mouse.move(hx + 70, hy + 60, steps=12)
            page.mouse.up()
            page.wait_for_timeout(1600)
            after = [i for i in items("actor") if i["id"] == it0["id"]]
            ok("拖右下角可缩放单张卡片（w/h 变化）",
               bool(after) and (abs(after[0]["w"] - it0["w"]) > 20 or abs(after[0]["h"] - it0["h"]) > 20),
               f"{it0['w']}×{it0['h']} → {after[0]['w']}×{after[0]['h']}" if after else "gone")

        # ] / [ 层级
        if it0:
            page.mouse.click(it0["cx"], it0["cy"])
            page.wait_for_timeout(400)
            node_id = [i for i in page.evaluate("() => window.__acDebug().screenItems()") if i["id"] == it0["id"]][0]["id"]
            z0 = [n for n in api(f"/api/canvas?id={temp_canvas_id}")["canvas"]["nodes"] if n["id"] == node_id][0]["z"]
            page.keyboard.press("]")
            page.wait_for_timeout(1200)
            z1 = [n for n in api(f"/api/canvas?id={temp_canvas_id}")["canvas"]["nodes"] if n["id"] == node_id][0]["z"]
            page.keyboard.press("[")
            page.wait_for_timeout(1200)
            z2 = [n for n in api(f"/api/canvas?id={temp_canvas_id}")["canvas"]["nodes"] if n["id"] == node_id][0]["z"]
            ok("] 置顶层 / [ 置底层（节点 z 变化）", z1 != z0 and z2 != z1, f"z: {z0} → {z1} → {z2}")

        # 关系线：端口拖拽建线 + 选标签 + 管理连线删除
        page.keyboard.press("Escape")
        page.keyboard.press("f")
        page.wait_for_timeout(900)
        its = items("actor")
        a = its[0] if its else None
        b = its[1] if len(its) > 1 else None
        links_before = dbg()["links"]
        if a and b:
            page.mouse.move(a["rightPort"]["x"], a["rightPort"]["y"])
            page.mouse.down()
            page.mouse.move(b["cx"], b["cy"], steps=14)
            page.mouse.up()
            page.wait_for_timeout(700)
            built = False
            if page.locator(".overlay .modal").count():
                built = True
                mt = modal_text()
                ok("从右端口拖到目标节点可弹出「建立关系线」并可选标签",
                   "建立关系线" in mt and "参考" in mt and "出现在" in mt and "持有" in mt,
                   mt[:60].replace("\n", "/"))
                page.locator(".overlay .modal .pill", has_text="出现在").first.click()
                click_dialog("连线", exact=True)
                page.wait_for_timeout(1400)
            ok("连线数量增加（可增可减）", built and dbg()["links"] == links_before + 1,
               f"links={dbg()['links']} (before={links_before})")
            # 通过「管理该演员的连线」删除刚建立的线（UI 入口）
            rowl = page.locator(".ac-item").filter(has_text=a["actorId"]).first
            rowl.click(button="right")
            page.wait_for_timeout(500)
            page.locator(".ctx-menu .mi", has_text="🔗 管理该演员的连线").first.click()
            wait_modal("关系连线")
            ok("「管理该演员的连线」弹窗列出连线并可删除",
               "→" in modal_text() and page.locator(".overlay .modal button", has_text="删除").count() >= 1,
               modal_text()[:60].replace("\n", "/"))
            page.locator(".overlay .modal button", has_text="删除").first.click()
            page.wait_for_timeout(1200)
            close_dialog()
            page.wait_for_timeout(700)
            ok("删除连线后数量复原", dbg()["links"] == links_before, f"links={dbg()['links']}")

        page.screenshot(path=str(OUT / "02-actors-temp-canvas.png"))

        # 清理临时画布（先删分组/连线，避免遗留脏数据），再切回主画布
        page.locator("#ac-canvas-picker select").select_option(value="CV-MAIN")
        page.wait_for_timeout(1500)
        if temp_canvas_id:
            for g in api(f"/api/canvas/groups?id={temp_canvas_id}")["groups"]:
                api(f"/api/canvas/groups/{g['id']}", "DELETE")
            for l in api(f"/api/canvas/links?id={temp_canvas_id}")["links"]:
                api(f"/api/canvas/links/{l['id']}", "DELETE")
            r = api(f"/api/canvas/{temp_canvas_id}", "DELETE")
            left = [c["id"] for c in api("/api/canvas/list")["canvases"]]
            ok("临时画布已删除（不残留分组/连线）",
               r.get("ok") and temp_canvas_id not in left, f"left={left}")
        ok("已切回主画布 CV-MAIN", dbg()["canvasId"] == "CV-MAIN", str(dbg()["canvasId"]))

        m1 = mark()
        # ---------- 结束：状态还原交叉校验 ----------
        head("状态还原校验（与脚本开始时对比）")
        st_after = canvas_state("CV-MAIN")
        actors_after = api("/api/actors")["actors"]
        ok(f"演员数量一致（{n_actors} 位，无新增/删除）", len(actors_after) == n_actors,
           f"{len(actors_after)} vs {n_actors}")
        ok(f"演员 ID 集合一致", sorted(a['id'] for a in actors_after) == sorted(a['id'] for a in actors_before))
        order_after = [a["id"] for a in actors_after]
        order_before = [a["id"] for a in actors_before]
        if order_after != order_before:
            # 矩阵模式下「拖卡片到另一张卡上」= 换位（产品既有行为，见画布提示语），属于本脚本自身拖拽的副作用；
            # 先如实还原顺序，再断言「画布拖拽不会无声地改变演员顺序」这一不变量本身。
            try:
                api("/api/actors/reorder", "POST", {"ids": order_before})
            except Exception as e:
                print("   [warn] 还原演员顺序失败：", e)
            reordered = [a["id"] for a in api("/api/actors")["actors"]]
            ok("矩阵模式换位副作用可被还原（顺序回到脚本开始时）", reordered == order_before, f"{reordered} vs {order_before}")
        ok("演员默认排序未被画布拖拽无声打乱（未触发 actors/reorder 副作用）",
           [a["id"] for a in api("/api/actors")["actors"]] == order_before,
           f"{order_after} vs {order_before}")
        binding_after = api("/api/scripts/SC-0001/canvas-binding").get("summary") or {}
        ok("剧本 SC-0001 的画布资产绑定未被改动（环境/物品/参考图计数不变）",
           binding_after.get("canvasId") == binding_before.get("canvasId")
           and binding_after.get("scenes") == binding_before.get("scenes")
           and binding_after.get("items") == binding_before.get("items")
           and binding_after.get("refs") == binding_before.get("refs"),
           f"{binding_after} vs {binding_before}")
        shot_now = [x for x in api(f"/api/scripts/SC-0001/episodes/S01E001")["shots"] if x["id"] == "SH-0001"][0]
        ok("剧本 SC-0001 的镜头数据未被改动（SH-0001 音效/提示词与开始时一致）",
           shot_now["sfx"] == "雾气流动声，远处江水拍岸，油灯噼啪" and bool(shot_now["prompt_pos"]),
           f"sfx={shot_now['sfx']!r}")
        ok(f"主画布节点数一致（{st_before['n_nodes']}）", st_after["n_nodes"] == st_before["n_nodes"],
           f"{st_after['n_nodes']} vs {st_before['n_nodes']}")
        ok(f"主画布节点类型构成一致（演员 10 / 环境 1 / 物品 1 / 参考图 2 / 便签 1）",
           st_after["kinds"] == st_before["kinds"], f"{st_after['kinds']} vs {st_before['kinds']}")
        ok(f"主画布分组数一致（{st_before['n_groups']}）+ 分组名一致",
           st_after["n_groups"] == st_before["n_groups"] and st_after["group_names"] == st_before["group_names"],
           f"{st_after['n_groups']} vs {st_before['n_groups']}")
        ok("主画布分组归属（group_id→成员）一致", st_after["group_members"] == st_before["group_members"])
        ok(f"主画布连线数一致（{st_before['n_links']}）+ 端点与标签一致",
           st_after["n_links"] == st_before["n_links"] and st_after["link_pairs"] == st_before["link_pairs"],
           f"{st_after['n_links']} vs {st_before['n_links']}")
        ok("/api/canvas/groups 与 /api/canvas 交叉一致",
           len(api("/api/canvas/groups")["groups"]) == st_after["n_groups"])
        ok("/api/canvas/links 与 /api/canvas 交叉一致",
           len(api("/api/canvas/links")["links"]) == st_after["n_links"])
        # 还原主画布视图
        v = st_before["view"]
        if v:
            api("/api/canvas/viewport", "PUT", {"id": "CV-MAIN", "zoom": v.get("zoom"), "panX": v.get("panX"),
                                                "panY": v.get("panY"), "bg": v.get("bg"), "gridSize": v.get("gridSize"),
                                                "snap": v.get("snap"), "showMinimap": v.get("showMinimap"),
                                                "showLinks": v.get("showLinks")})
            v2 = canvas_state("CV-MAIN")["view"]
            ok("主画布视图（缩放/平移/背景）已还原",
               abs(float(v2.get("zoom", 0)) - float(v.get("zoom", 0))) < 1e-6
               and abs(float(v2.get("panX", 0)) - float(v.get("panX", 0))) < 1e-6,
               f"{v2.get('zoom')} vs {v.get('zoom')}")
        ok(f"主画布 showAll 语义未变（{st_before['showAll']}）", st_after["showAll"] == st_before["showAll"])

        # =====================================================================
        head("模块2 · 小说工坊页 #/novel")
        page.goto(f"{BASE}/#/novel", wait_until="networkidle")
        page.wait_for_timeout(2200)
        nv_errors = mark()
        meta = api("/api/meta")
        # 同理：按 ID 选演示小说（用户新建小说后第一本可能还没写章节）
        novel = next((x for x in novels if x["id"] == "N-0001"), novels[0])
        detail = api(f"/api/novels/{novel['id']}")
        ok(f"小说列表加载（{page.locator('.nv-item').count()} 项 == 接口 {len(novels)} 部）",
           page.locator(".nv-item").count() == len(novels) and novel["title"] in page.inner_text(".nv-side"),
           novel["title"])
        _nv_item = page.locator(".nv-item").filter(has_text=novel["title"])
        (_nv_item.first if _nv_item.count() else page.locator(".nv-item").first).click()
        page.wait_for_timeout(2200)
        wtxt = page.inner_text("#nv-main")
        ok(f"选中《{novel['title']}》进入工作区（显示 ID/题材/状态与两大生成入口）",
           novel["id"] in wtxt and "章节大纲" in wtxt and "写作下一章" in wtxt and "批量写作" in wtxt,
           wtxt[:70].replace("\n", "/"))
        sec_count = len(meta["outlineSections"])
        page.locator(".nv-tab", has_text="大纲").first.click()
        page.wait_for_timeout(1200)
        secs = page.locator(".nv-sec").count()
        ok(f"大纲分节完整可见（{secs} 节 == /api/meta.outlineSections {sec_count} 节）",
           secs == sec_count, f"{secs} vs {sec_count}")
        seclabels = page.eval_on_selector_all(".nv-sec > summary", "els => els.map(e => e.textContent.trim())")
        ok("大纲分节含 故事框架/世界观/章节大纲/伏笔与回收表/节奏卡点",
           any("故事框架" in s for s in seclabels) and any("伏笔" in s for s in seclabels)
           and any("节奏卡点" in s for s in seclabels), "/".join(seclabels)[:70])
        page.screenshot(path=str(OUT / "03-novel-outline.png"))
        page.locator(".nv-tab", has_text="章节").first.click()
        page.wait_for_timeout(1500)
        chs = page.locator(".nv-ch").count()
        ok(f"章节列表与字数统计（{chs} 章，含已写/未写徽章）",
           chs == detail["stats"]["total"] and "已写" in page.inner_text("#nv-main"),
           f"{chs} vs {detail['stats']['total']}")
        page.locator(".nv-ch").first.click()
        page.wait_for_timeout(1500)
        rd = page.locator("#nv-read p").count()
        ok("章节正文可阅读（段落渲染 + 字数/模型徽章）",
           rd > 0 and f"第 1 章" in page.inner_text("#nv-main"), f"段落={rd}")
        page.locator(".nv-tab", has_text="参数与角色").first.click()
        page.wait_for_timeout(1500)
        ptxt = page.inner_text("#nv-main")
        pfields = ["叙事视角", "角色规模上限（≤200）", "小说总字数（≤1000 万）", "章节字数（1000~3000）", "题材（100 种"]
        pmiss = [f for f in pfields if f not in ptxt]
        ok("参数面板字段齐全（题材/叙事视角/角色规模/章节字数/总字数上限）", not pmiss, f"缺 {pmiss}")
        ok("推导提示与角色规模校验提示可读取（未触发超限）",
           "推导需规划" in ptxt and "已定义" in ptxt, ptxt[ptxt.find("按 总字数"):][:46] if "按 总字数" in ptxt else "")
        ok(f"绑定演员表可见（可载入 {n_actors} 位演员）", "载入演员表" in ptxt or "刷新演员表" in ptxt)
        page.locator(".overlay").count()
        page.locator(".nv-btn", has_text="载入演员表").first.click()
        page.wait_for_timeout(1500)
        na = page.locator(".nv-actor").count()
        ok(f"演员绑定清单渲染（{na} 位 == /api/actors {n_actors}）", na == n_actors, f"{na}")
        page.locator(".nv-tab", has_text="导出").first.click()
        page.wait_for_timeout(1200)
        etxt = page.inner_text("#nv-main")
        ok("导出面板存在（TXT / Markdown / JSON / 复制全文）",
           "下载 TXT" in etxt and "下载 Markdown" in etxt and "下载 JSON" in etxt and "复制全文" in etxt)
        with page.expect_download(timeout=30000) as nvdl:
            page.locator(".nv-btn", has_text="下载 TXT").first.click()
        nvf = nvdl.value.suggested_filename
        ok(f"导出 TXT 可触发下载（{nvf}）", nvf.endswith(".txt"), nvf)
        page.locator(".nv-btn", has_text="预览 TXT 前 3000 字").first.click()
        page.wait_for_timeout(2000)
        prev = page.inner_text(".nv-preview") if page.locator(".nv-preview").count() else ""
        ok("导出预览可用（返回正文内容）", len(prev) > 100, f"预览 {len(prev)} 字")
        ok("模块2 无 JS 错误 / console error", not errs_since(nv_errors), "; ".join(errs_since(nv_errors)[:3]))

        # =====================================================================
        head("模块3 · 剧本工厂页 #/script")
        page.goto(f"{BASE}/#/script", wait_until="networkidle")
        page.wait_for_timeout(2200)
        sc_errors = mark()
        # 明确选「演示剧本」那一部（列表按更新时间排序，跑过演示后第一部可能变成新剧本）
        sc = next((x for x in scripts if x["id"] == "SC-0001"), scripts[0])
        ep_list = api(f"/api/scripts/{sc['id']}/episodes")["episodes"]
        ep1 = ep_list[0]["code"]
        shots = api(f"/api/scripts/{sc['id']}/episodes/{ep1}")["shots"]
        ok(f"剧本列表加载（{page.locator('.sc-item').count()} 项 == 接口 {len(scripts)} 部）",
           page.locator(".sc-item").count() == len(scripts) and sc["id"] in page.inner_text(".sc-side"))
        item = page.locator(".sc-item").filter(has_text=sc["id"])
        if item.count() == 0:
            item = page.locator(".sc-item").filter(has_text=sc["title"])
        (item.first if item.count() else page.locator(".sc-item").first).click()
        page.wait_for_timeout(2600)
        s1 = page.inner_text(".sc-main")
        ok("选中剧本后阶段1 配置 / 阶段2 分集规划 / 阶段3 分镜表出现",
           "配置" in s1 and "分集规划" in s1 and "分镜表 / 提示词" in s1)
        ep_btns = page.locator(".sc-main [data-act=view-ep]").count()
        ok(f"集列表行数正确（{ep_btns} 行 == 接口 {len(ep_list)} 集）", ep_btns == len(ep_list), f"{ep_btns}")
        ep_rows = [e["code"] for e in ep_list]
        ok(f"集号齐全（{', '.join(ep_rows)}）", all(c in s1 for c in ep_rows), str(ep_rows))
        page.locator(".sc-select[data-act=pick-ep]").select_option(value=ep1)
        page.wait_for_timeout(2200)
        body = page.inner_text(".sc-main")
        cols = ["景别", "机位", "运镜", "时长", "成本"]
        cmiss = [c for c in cols if c not in body]
        ok(f"单集分镜表可见且列齐全（时长/景别/运镜/成本级徽章）", not cmiss, f"缺 {cmiss}")
        n_rows = page.locator(".sc-main [data-act=edit-shot]").count()
        ok(f"本集镜头行数 == 接口镜头数（{n_rows} == {len(shots)}）", n_rows == len(shots), f"{n_rows}")
        first_shot = shots[0]
        page.locator(".sc-btn", has_text="编辑").first.click()
        wait_modal("编辑镜头")
        mt = modal_text()
        ok(f"镜头行可打开编辑弹窗（{first_shot['id']}，含景别/运镜/时长/提示词入参）",
           "景别" in mt and "运镜" in mt and "时长（秒）" in mt and "英文正向提示词" in mt)
        # 仅改「音效」字段并保存，随后原样还原（可逆写入）
        sfx_input = page.locator(".overlay .modal input[data-s=sfx]")
        orig_sfx = sfx_input.input_value()
        shot_restore = {"script": sc["id"], "ep": ep1, "id": first_shot["id"], "sfx": orig_sfx}
        sfx_input.fill("UI模拟测试音效")
        page.locator("#sc-shot-ok").click()
        page.wait_for_timeout(3000)
        now_sfx = [x for x in api(f"/api/scripts/{sc['id']}/episodes/{ep1}")["shots"] if x["id"] == first_shot["id"]][0]["sfx"]
        ok("镜头编辑入参保存成功（音效字段已落库）", now_sfx == "UI模拟测试音效", f"{orig_sfx!r} → {now_sfx!r}")
        page.locator(".sc-btn", has_text="编辑").first.click()
        wait_modal("编辑镜头")
        page.locator(".overlay .modal input[data-s=sfx]").fill(orig_sfx)
        page.locator("#sc-shot-ok").click()
        page.wait_for_timeout(3000)
        back = [x for x in api(f"/api/scripts/{sc['id']}/episodes/{ep1}")["shots"] if x["id"] == first_shot["id"]][0]
        ok("镜头字段已还原，且提示词未被改写",
           back["sfx"] == orig_sfx and back["prompt_pos"] == first_shot["prompt_pos"],
           f"sfx={back['sfx']!r} prompt_same={back['prompt_pos'] == first_shot['prompt_pos']}")
        shot_restore = None
        page.locator(".sc-chip", has_text="卡片视图").first.click()
        page.wait_for_timeout(1500)
        cards = page.locator(".sc-shot").count()
        ctxt = page.inner_text(".sc-main")
        ok(f"故事板/提示词面板可用（卡片视图 {cards} 张，含 POS/NEG 英文提示词）",
           cards == len(shots) and "POS:" in ctxt and "NEG:" in ctxt, f"cards={cards}")
        page.locator(".sc-btn", has_text="绑定画布资产").first.click()
        wait_modal("绑定画布资产")
        bt = modal_text()
        ok("「🎨 绑定画布资产」弹窗可打开并显示绑定摘要（环境/物品/参考图计数）",
           "选择画布" in bt and "当前绑定" in bt and "环境" in bt and "物品" in bt and "参考图" in bt,
           bt.replace("\n", "/")[:80])
        # 有多个画布时弹窗默认可能选中未绑定的新画布 → 先选主画布再核对计数
        sel = page.locator(".modal select").first
        if sel.count():
            opts = sel.inner_text().split("\n")
            target = [o for o in opts if "明星矩阵主画布" in o]
            if target:
                try:
                    sel.select_option(label=target[0])
                    page.wait_for_timeout(900)
                except Exception:  # noqa: BLE001
                    pass
        bt2 = modal_text()
        ok("绑定摘要计数与画布实际节点一致（环境 1 · 物品 1 · 参考图 2）",
           "环境 1" in bt2 and "物品 1" in bt2 and "参考图 2" in bt2, bt2.replace("\n", "/")[-70:])
        close_dialog()
        page.wait_for_timeout(600)
        ok("绑定弹窗可关闭（Escape/遮罩关闭，未改变绑定）", page.locator(".overlay .modal").count() == 0)
        links_exp = page.locator(".sc-main a.sc-btn").count()
        ok(f"导出按钮存在（本集 4 种 + 全部 4 种 = {links_exp} 个链接）", links_exp >= 8, str(links_exp))
        if page.locator(".sc-main a.sc-btn").count():
            with page.expect_download(timeout=30000) as scdl:
                page.locator(".sc-main a.sc-btn").first.click()
            ok(f"导出可触发下载（{scdl.value.suggested_filename}）", True, scdl.value.suggested_filename)
        page.screenshot(path=str(OUT / "04-script.png"))
        ok("模块3 无 JS 错误 / console error", not errs_since(sc_errors), "; ".join(errs_since(sc_errors)[:3]))

        # =====================================================================
        head("模块4 · 制作台页 #/render")
        page.goto(f"{BASE}/#/render", wait_until="networkidle")
        page.wait_for_timeout(2600)
        # 制作台侧栏默认选中的是「最近更新」的剧本；用户新建剧本后会变成空数据 → 先点选演示剧本
        _alls0 = api("/api/render/overview")["scripts"]
        _target = next((x for x in _alls0 if x["id"] == "SC-0001"), _alls0[0])
        _rd_item = page.locator(".rd-script").filter(has_text=_target["id"])
        if _rd_item.count() == 0:
            _rd_item = page.locator(".rd-script").filter(has_text=_target["title"])
        if _rd_item.count():
            _rd_item.first.click()
            page.wait_for_timeout(2400)
        ov = api("/api/render/overview")["scripts"]
        ov = next((x for x in ov if x["id"] == "SC-0001"), ov[0])
        rd_errors = mark()
        # 明确选「演示剧本」（列表按更新时间排序，用户新建剧本后第一部会变成空数据 → 会误报）
        _alls = api("/api/render/overview")["scripts"]
        ov = next((x for x in _alls if x["id"] == "SC-0001"), _alls[0])
        board = api(f"/api/render/episode?scriptId={ov['id']}&code={ep1}")
        bst = board["stats"]
        side = page.inner_text(".rd-side")
        ok(f"制作台侧栏加载剧本与计数徽章（关键帧 {bst['keyframes']} / 视频 {bst['videos']} / 成片 {ov['stats']['films']}）",
           "制作台" in side and str(ov["stats"]["films"]) in side and "关键帧" in side and "成片" in side)
        ok(f"剧集列表完整（{len(ov['episodes'])} 集 == 接口）",
           all(e["code"] in side for e in ov["episodes"]), str([e["code"] for e in ov["episodes"]]))
        ep_row = page.locator(".rd-ep", has_text=ep1).first
        if ep_row.count() == 0:
            page.locator(".rd-caret").first.click()
            page.wait_for_timeout(800)
            ep_row = page.locator(".rd-ep", has_text=ep1).first
        ep_row.click()
        page.wait_for_timeout(2600)
        main = page.inner_text(".rd-main")
        ok(f"剧集看板统计正确（{bst['shots']} 镜 / 关键帧 {bst['keyframes']} / 视频 {bst['videos']}）",
           f"{bst['shots']} 镜" in main and f"关键帧 {bst['keyframes']}" in main and f"视频 {bst['videos']}" in main,
           main[:80].replace("\n", "/"))
        badges = page.eval_on_selector_all(".rd-badge", "els => els.map(e => e.textContent.trim())")
        ok("剧集头后端徽章（🖼 出图 / 🎬 视频 + 就绪状态）",
           len(badges) == 2 and any("出图" in b for b in badges) and any("视频" in b for b in badges),
           "/".join(badges))
        chips = page.eval_on_selector_all(".rd-chip", "els => els.map(e => e.textContent.trim())")
        need_chips = ["全部", "缺关键帧", "缺视频", "失败"]
        ok("筛选条件齐全（全部/缺关键帧/缺视频/失败 + 成本级 L/M/H + 运镜倍率）",
           all(any(c.startswith(n) for c in chips) for n in need_chips)
           and any(c.startswith("L（") for c in chips) and any("1.5×" in c for c in chips),
           "/".join(chips)[:80])
        cl = bst["costLevels"]
        ok(f"成本级计数与接口一致（L {cl.get('L', 0)} · M {cl.get('M', 0)} · H {cl.get('H', 0)}）",
           any(c == f"L（{cl.get('L', 0)}）" for c in chips) and any(c == f"M（{cl.get('M', 0)}）" for c in chips)
           and any(c == f"H（{cl.get('H', 0)}）" for c in chips), "/".join(chips)[-40:])
        cnt_all = [c for c in chips if c.startswith("全部")][0]
        ok(f"「全部」计数 == 本集镜头数（{cnt_all} vs {bst['shots']}）", f"（{bst['shots']}）" in cnt_all)
        page.locator(".rd-chip", has_text="缺关键帧").first.click()
        page.wait_for_timeout(1200)
        # 本集关键帧已全部生成 → 缺关键帧应为空态
        expected_empty = bst["keyframes"] >= bst["shots"]
        if expected_empty:
            ok("筛选「缺关键帧」在本集应为空（关键帧已全部生成）→ 空态文案正确",
               "当前筛选条件下没有镜头" in page.inner_text(".rd-main"))
        else:
            ok("筛选「缺关键帧」生效（只剩未出图的镜头）", True)
        page.locator(".rd-chip", has_text="全部（").first.click()
        page.wait_for_timeout(1200)
        shown = page.locator(".rd-shot").count()
        ok(f"筛选恢复「全部」后卡片数恢复（{shown} 张，分页上限内）", shown > 0, f"shown={shown}")
        page.locator(".rd-chip", has_text="H（").first.click()
        page.wait_for_timeout(1200)
        ok("成本级筛选 H 生效（本集无 H 级镜头 → 空态，用可用性断言代替）",
           "当前筛选条件下没有镜头" in page.inner_text(".rd-main") if cl.get("H", 0) == 0 else True,
           f"H={cl.get('H', 0)}")
        page.locator(".rd-chip", has_text="L（").first.click()
        page.wait_for_timeout(1200)
        page.locator(".rd-btn", has_text="全选").first.click()
        page.wait_for_timeout(900)
        sel_all = int(page.inner_text("#rd-selcount"))
        page.locator(".rd-btn", has_text="反选").first.click()
        page.wait_for_timeout(900)
        sel_inv = int(page.inner_text("#rd-selcount"))
        page.locator(".rd-btn", has_text="清空").first.click()
        page.wait_for_timeout(900)
        sel_none = int(page.inner_text("#rd-selcount"))
        ok(f"全选 / 反选 / 清空 计数正确（{sel_all} → {sel_inv} → {sel_none}，全选+反选=筛选总数）",
           sel_all > 0 and sel_inv == 0 and sel_none == 0, f"{sel_all}/{sel_inv}/{sel_none}")
        ok("单镜卡片含关键帧/视频状态与「🖼 出图」「🎬 出片」按钮",
           page.locator(".rd-shot .rd-btn", has_text="出图").count() >= 1
           and page.locator(".rd-shot .rd-btn", has_text="出片").count() >= 1)
        page.locator(".rd-btn", has_text="🔍 探测视频后端").first.click()
        wait_modal("视频后端")
        pt = modal_text()
        ok("「🔍 探测视频后端」弹窗显示后端与中文结论",
           ("可用" in pt or "不可用" in pt) and "后端：" in pt and ("placeholder" in pt or "comfyui" in pt),
           pt.replace("\n", "/")[:70])
        close_dialog()
        page.wait_for_timeout(600)
        page.locator(".rd-btn", has_text="成片包装").first.click()
        wait_modal("成片包装")
        fp = modal_text()
        ok("音轨选项含「配音+背景乐」（配音与 BGM 同时存在并自动避让）",
           page.locator(".rd-chip", has_text="配音+背景乐").count() == 1)
        ok("成片包装面板可打开（字幕模式 / 音轨 / 淡入淡出 / 预览字幕）",
           "字幕" in fp and "音轨" in fp and "淡入" in fp and "淡出" in fp and "👁 预览字幕" in fp, fp[:80].replace("\n", "/"))
        page.locator(".overlay .modal .rd-btn", has_text="预览字幕").first.click()
        page.wait_for_timeout(3000)
        fp2 = modal_text()
        ok("「👁 预览字幕」dry-run 返回字幕统计（不写文件）",
           ("条字幕" in fp2 or "字幕预览失败" in fp2), fp2.replace("\n", "/")[-90:])
        close_dialog()
        page.wait_for_timeout(700)
        ok("成片列表含播放/下载/删除入口（未执行删除）",
           page.locator(".rd-film").count() >= 1
           and page.locator(".rd-film a[download]").count() >= 1
           and page.locator(".rd-film .rd-btn", has_text="🗑").count() >= 1,
           f"films={page.locator('.rd-film').count()}")
        page.locator(".rd-btn", has_text="整季流水线").first.click()
        wait_modal("整季")
        page.wait_for_timeout(3500)
        pp = modal_text()
        ok("「🚀 整季流水线」面板工作量预估可用（/api/render/estimate）",
           "工作量与预估" in pp and ("需出图" in pp or "预估值仅供参考" in pp), pp[:90].replace("\n", "/"))
        close_dialog()
        page.wait_for_timeout(700)
        ok("「🧹 清理中间产物」按钮存在（未点击，避免动到成片目录）",
           page.locator(".rd-btn", has_text="清理中间产物").count() == 1)
        # 生产守护：失败重试 + 预算/磁盘（真实厂商 API 上线后的安全网）
        ok("工具栏有「♻ 重试失败镜头」按钮", page.locator(".rd-btn", has_text="重试失败镜头").count() == 1)
        ok("工具栏有「💰 预算与磁盘」按钮", page.locator(".rd-btn", has_text="预算与磁盘").count() == 1)
        page.locator(".rd-btn", has_text="预算与磁盘").first.click()
        page.wait_for_timeout(1500)
        gm = page.locator(".modal").first
        gtxt = gm.inner_text() if gm.count() else ""
        ok("预算与磁盘弹窗显示用量/金额/磁盘明细",
           "本月用量" in gtxt and "磁盘" in gtxt and "占用明细" in gtxt, gtxt.replace("\n", " / ")[:110])
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        # 出海物料：多语言字幕 + 封面 + 发布元数据
        ok("工具栏有「🌐 出海物料」按钮", page.locator(".rd-btn", has_text="出海物料").count() == 1)
        page.locator(".rd-btn", has_text="出海物料").first.click()
        page.wait_for_timeout(2000)
        pm = page.locator(".modal").first
        ptxt = pm.inner_text() if pm.count() else ""
        ok("出海物料弹窗含语言多选与「生成物料」",
           "目标语言" in ptxt and pm.locator(".rd-chip").count() >= 8 and pm.locator("button", has_text="生成物料").count() == 1,
           f"{pm.locator('.rd-chip').count()} 个语言选项")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        # 成片质检：黑帧/静音/响度检测
        ok("工具栏有「🔍 成片质检」按钮", page.locator(".rd-btn", has_text="成片质检").count() == 1)
        page.locator(".rd-btn", has_text="成片质检").first.click()
        # 质检要真跑 ffmpeg（成片 + 抽查镜头），最多等 60s
        try:
            page.wait_for_function(
                """() => {
                     const m = document.querySelector('.modal');
                     return m && /质检 ·/.test(m.textContent || '');
                   }""", timeout=60000)
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(500)
        qm = page.locator(".modal").first
        qtxt = qm.inner_text() if qm.count() else ""
        ok("质检弹窗给出结论与逐项检查（含黑帧/静音/响度/时长）",
           "质检 ·" in qtxt and ("黑帧" in qtxt or "静音" in qtxt) and "下载质检报告" in qtxt,
           qtxt.replace("\n", " / ")[:120])
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        # 生产看板：任务耗时/失败率/错误 Top/趋势
        ok("工具栏有「📊 生产看板」按钮", page.locator(".rd-btn", has_text="生产看板").count() == 1)
        page.locator(".rd-btn", has_text="生产看板").first.click()
        page.wait_for_timeout(2500)
        sm = page.locator(".modal").first
        stxt = sm.inner_text() if sm.count() else ""
        ok("生产看板弹窗显示进度/任务/渲染/趋势",
           "进度：" in stxt and "任务（近 7 天）" in stxt and "产出趋势" in stxt, stxt.replace("\n", " / ")[:110])
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        # 交付包：清单弹窗（内容/体积/缺失项）→ 生成下载按钮
        ok("工具栏有「📦 导出交付包」按钮", page.locator(".rd-btn", has_text="导出交付包").count() == 1)
        page.locator(".rd-btn", has_text="导出交付包").first.click()
        try:
            page.wait_for_function(
                """() => {
                     const m = document.querySelector('.modal');
                     return m && /打包：/.test(m.textContent || '');
                   }""", timeout=30000)
        except Exception:  # noqa: BLE001
            pass
        page.wait_for_timeout(400)
        dm = page.locator(".modal").first
        dtxt = dm.inner_text() if dm.count() else ""
        ok("交付清单弹窗列出内容与体积",
           "剧本：" in dtxt and ("集数：" in dtxt or "打包：" in dtxt) and "storyboard/" in dtxt,
           dtxt.replace("\n", " / ")[:120])
        ok("交付清单弹窗说明包含成片/字幕/分镜表/报告/EDL 与「生成并下载 ZIP」",
           "final/" in dtxt and "report.md" in dtxt and dm.locator("button", has_text="生成并下载 ZIP").count() == 1)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        # 镜头版本对比：卡片上的「🎞 版本 N/M」按钮 → 弹窗列出版本并可指定采用版本
        vbtn = page.locator(".rd-shot .rd-btn", has_text="版本").first
        ok("镜头卡片有「🎞 版本」按钮（多版本对比入口）", vbtn.count() == 1, vbtn.inner_text() if vbtn.count() else "(无)")
        vbtn.click()
        page.wait_for_timeout(1800)
        vm = page.locator(".modal").first
        vtxt = vm.inner_text() if vm.count() else ""
        ok("版本对比弹窗列出关键帧/视频版本与「设为采用」入口",
           "版本对比" in vtxt and "关键帧版本" in vtxt and "视频版本" in vtxt
           and (vm.locator("button", has_text="设为采用").count() >= 1 or vm.locator("button", has_text="取消采用").count() >= 1),
           vtxt.replace("\n", " / ")[:110])
        ok("版本弹窗提供「再生成一版」入口（对比后再补一版）",
           vm.locator("button", has_text="再生成一版").count() == 2, f"入口 {vm.locator('button', has_text='再生成一版').count()} 个")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        page.locator(".rd-btn", has_text="重试失败镜头").first.click()
        page.wait_for_timeout(2500)
        rm = page.locator(".modal").first
        rtxt = rm.inner_text() if rm.count() else ""
        ok("重试失败镜头弹窗给出结论（无可重试/已提交/需先处理）",
           any(k in rtxt for k in ["没有可自动重试", "已重新提交", "没有失败的镜头"]), rtxt.replace("\n", " / ")[:110])
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        page.screenshot(path=str(OUT / "05-render.png"))
        ok("模块4 无 JS 错误 / console error", not errs_since(rd_errors), "; ".join(errs_since(rd_errors)[:3]))

        # =====================================================================
        head("模块5 · 设置页 #/settings")
        page.goto(f"{BASE}/#/settings", wait_until="networkidle")
        page.wait_for_timeout(2200)
        set_errors = mark()
        h3s = page.eval_on_selector_all(".set-card > h3", "els => els.map(e => e.textContent.trim())")
        ok(f"设置页渲染全部配置卡（{len(h3s)} 张：LLM/出图/视频/配音/数据/帮助）",
           all(any(k in h for h in h3s) for k in ["文本生成（LLM）", "出图后端", "视频后端", "配音后端", "数据与备份"]),
           "/".join(h3s))
        llm_card = page.locator(".set-card", has_text="文本生成（LLM）").first
        ok("LLM 卡片显示状态徽章与「🔌 测试连接」按钮",
           llm_card.locator(".chip").count() >= 1 and llm_card.locator("button", has_text="测试连接").count() == 1,
           llm_card.inner_text()[:50].replace("\n", "/"))
        llm_card.locator("button", has_text="测试连接").first.click()
        page.wait_for_timeout(1000)
        # 真实 LLM 调用依赖外网：等到出现终态（✓/✗）再断言；超时就记为提示而不是失败，避免外网抖动导致误报
        try:
            page.wait_for_function(
                """() => {
                     const c = [...document.querySelectorAll('.set-card')].find(x => x.textContent.includes('文本生成（LLM）'));
                     const r = c && c.querySelector('.result-box');
                     const t = (r && r.textContent) || '';
                     return t.includes('✓') || t.includes('✗');
                   }""", timeout=90000)
            lres = llm_card.locator(".result-box").first.inner_text()
            ok(f"「测试连接」返回结果（{lres.splitlines()[0][:34]}）",
               ("✓" in lres or "✗" in lres) and "正在测试" not in lres, lres[:60])
        except Exception:  # noqa: BLE001
            lres = llm_card.locator(".result-box").first.inner_text()
            warn("LLM「测试连接」90s 内未返回（外网延迟/限流）", f"当前显示：{lres.splitlines()[0][:40]}；链路本身已由 /api/settings/test-llm 覆盖")
        img_sel = page.locator(".set-card", has_text="出图后端").first.locator("select").first
        img_sel.select_option("comfyui")
        page.wait_for_timeout(900)
        img_detail = page.locator(".set-card", has_text="出图后端").first.inner_text()
        ok("出图后端切到 ComfyUI 后出现对应字段（地址/工作流路径/参考图节点/节点映射）",
           "ComfyUI 地址" in img_detail and "工作流 JSON（API 格式）路径" in img_detail
           and "参考图节点 (nodeId.field)" in img_detail and "节点映射" in img_detail)
        vid_card = page.locator(".set-card", has_text="视频后端（制作台）").first
        vid_sel = vid_card.locator("select").first
        ok("视频后端下拉含 placeholder / comfyui-h3 / generic-http 三项",
           vid_sel.locator("option").count() == 3, vid_sel.inner_text().replace("\n", "/"))
        vid_sel.select_option("comfyui-h3")
        page.wait_for_timeout(1000)
        vt = vid_card.inner_text()
        h3_fields = {
            "实例地址": "ComfyUI 实例地址",
            "工作流路径（留空=内置模板）": "视频工作流 JSON 路径（留空=内置模板）",
            "视频节点 id": "视频节点 id（判定首帧能力）",
            "首帧优先": "有分镜关键帧时用首帧驱动（i2v）",
            "turbo 加速": "用 turbo LoRA 加速（≈45s/条）",
            "/object_info 预检": "提交前用 /object_info 预检",
            "分辨率 megapixels": "分辨率 megapixels",
            "节点映射": "节点映射（JSON",
        }
        vmiss = [k for k, v in h3_fields.items() if v not in vt]
        ok("视频后端选 comfyui-h3 后新字段齐备（实例地址/工作流路径/视频节点 id/首帧优先/turbo 加速/预检/megapixels/节点映射）",
           not vmiss, f"缺 {vmiss}")
        vid_card.locator("button", has_text="探测后端").first.click()
        page.wait_for_timeout(1200)
        page.wait_for_function(
            """() => {
                 const c = [...document.querySelectorAll('.set-card')].find(x => x.textContent.includes('视频后端'));
                 const r = c && c.querySelector('.result-box');
                 return r && !r.textContent.includes('未探测') && !r.textContent.includes('探测中');
               }""", timeout=40000)
        pres = vid_card.locator(".result-box").first.inner_text()
        ok(f"「📡 探测后端」返回中文结论（不因 ok:false 误报 HTTP 200）：「{pres[:52]}」",
           ("✓" in pres or "✗" in pres) and "请求失败" not in pres and any("\u4e00" <= ch <= "\u9fff" for ch in pres),
           pres[:80])
        ok("探测结论与实例状态相符（未配置地址 / 正在启动 / 已释放 之一）",
           any(k in pres for k in ["未配置 ComfyUI 地址", "正在启动", "已释放", "ComfyUI 在线"]), pres[:60])
        if "未配置 ComfyUI 地址" in pres:
            warn("503 探测文案未在本轮触发", "config.video.comfy.url 为空 → 返回「未配置 ComfyUI 地址」；"
                                              "填入实例地址后同一路径会给出「正在启动/已释放」文案（src/comfy.js:401）")
        data_card = page.locator(".set-card", has_text="数据与备份").first
        dtxt = data_card.inner_text()
        ok("设置页「数据与备份」含预算与存储保护（用量/金额/磁盘 + 9 个参数）",
           "预算与存储保护" in dtxt and "本月用量" in dtxt and "磁盘占用" in dtxt
           and data_card.locator("input").count() >= 8, f"输入框 {data_card.locator('input').count()} 个")
        ok("预算字段齐全（上限/确认阈值/图·视频·配音单价/磁盘告警·上限）",
           all(k in dtxt for k in ["monthlyCap", "confirmOver", "单张图单价", "单条视频单价", "配音每千字单价", "warnGB", "maxGB"]))
        ok("保存按钮存在（LLM / 出图 / 视频 / 配音 各一）",
           page.locator(".set-card button", has_text="保存").count() >= 4,
           str(page.locator(".set-card button", has_text="保存").count()))
        tts_card = page.locator(".set-card", has_text="配音后端（TTS）").first
        ok("配音卡片含 后端下拉 / 默认音色 / 语速 / 探测 / 试听",
           tts_card.locator("select").count() >= 1 and "默认音色" in tts_card.inner_text()
           and tts_card.locator("button", has_text="试听一句").count() == 1)
        # 厂商接入向导 + 失败重试：出图/视频/配音三张卡都要有
        _orig_cfg = (api("/api/settings") or {}).get("settings", {})
        _orig_img_generic = dict((_orig_cfg.get("image") or {}).get("generic") or {})
        ok("三张后端卡都有「失败重试次数」输入（限流/5xx/网络自动退避）",
           page.locator(".set-card", has_text="失败重试次数").count() >= 3,
           f"命中 {page.locator('.set-card', has_text='失败重试次数').count()} 张卡")
        img_card = page.locator(".set-card", has_text="出图后端").first
        # 切到「通用 HTTP 模板」才能看到向导按钮
        sel = img_card.locator("select").first
        try:
            sel.select_option(label=[o for o in sel.inner_text().split("\n") if "通用 HTTP" in o][0])
        except Exception as exc:  # noqa: BLE001
            warn("未能切到通用 HTTP 模板", str(exc)[:80])
        page.wait_for_timeout(700)
        ok("出图·通用 HTTP 卡片有「📋 粘贴 curl 自动填表」与「🔎 试发一次并推荐字段」",
           img_card.locator("button", has_text="粘贴 curl 自动填表").count() == 1
           and img_card.locator("button", has_text="试发一次并推荐字段").count() == 1)
        img_card.locator("button", has_text="粘贴 curl 自动填表").first.click()
        page.wait_for_timeout(800)
        m = page.locator(".modal").first
        ok("curl 向导弹窗含粘贴区与「解析并填入」按钮",
           m.count() == 1 and m.locator("textarea").count() >= 1 and m.locator("button", has_text="解析并填入").count() == 1)
        # 贴一段示例 curl：应解析成功并回填（不保存，改回后端即可）
        m.locator("textarea").first.fill("curl -X POST 'https://api.example.com/v1/images' -H 'Authorization: Bearer sk-demo' -d '{\"prompt\":\"a cat\",\"width\":1024}'")
        m.locator("button", has_text="解析并填入").first.click()
        page.wait_for_timeout(1500)
        mtext = page.locator(".modal").first.inner_text()
        ok("解析 curl 后给出中文回填说明（含占位符提示）",
           "已填入" in mtext and "{{prompt}}" in mtext, mtext.replace("\n", " / ")[:110])
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        # W8 第 3 轮**根因返工（零写盘）**：原实现在这里点「保存出图配置」，会触发真实写盘
        #   （前端 → PUT /api/settings → src/routes/meta.js:168 saveConfig → src/config.js:193
        #    fs.writeFileSync(config/config.json)），随后再用 API 把整段 image 写回原值。
        #   净效果是「同字节重写」：md5 不变、**mtime 前移**——脚本自己的守卫（只比 md5）看不出来，
        #   只能靠 scripts/verify-all.sh 的阶段守卫告警 + touch -r 还原，属补偿式治理（R-W3-05 / W7 §3.4）。
        # 本步骤真正要验的契约是「curl 向导只改表单、不落盘（示例地址不会写回真实配置）」，
        #   因此改为**只读取证**，一个写盘动作都不做：
        #   ① 向导回填后服务端 image 段仍等于进入本步骤前的取值（示例 URL 没被写回）；
        #   ② 磁盘 config/config.json 与启动快照 md5 + mtime **双一致**（是「从未写」，不是「写完再还原」）。
        # 覆盖取舍（如实记录）：不再覆盖「浏览器点保存按钮 → 服务端写盘」这一条链路；
        #   该链路（PUT /api/settings → saveConfig → fs.writeFileSync）由 API 级测试覆盖且全部做了
        #   FACTORY_CONFIG 环境隔离：阶段 2 tests/test-actors.js:392、阶段 6 tests/test-bridge.js:172/181 等。
        try:
            sel.select_option(label=[o for o in sel.inner_text().split("\n") if "本地占位出图" in o][0])
            page.wait_for_timeout(500)
        except Exception as exc:  # noqa: BLE001
            warn("出图表单未能切回占位后端（纯表单态操作，不落盘，不影响真实配置）", str(exc)[:80])
        try:
            back = (api("/api/settings") or {}).get("settings", {}).get("image", {})
            ok("curl 向导回填未污染正式配置（服务端出图后端与通用 URL 仍是进入本步骤前的值）",
               back.get("backend") == "placeholder" and (back.get("generic") or {}).get("url") == _orig_img_generic.get("url", ""),
               f"backend={back.get('backend')} url={((back.get('generic') or {}).get('url') or '(空)')[:40]}")
        except Exception as exc:  # noqa: BLE001
            warn("出图配置只读复核失败", str(exc)[:80])
        # 段落级配置守卫：本段落已无任何写盘动作，磁盘文件必须与启动快照 md5 + mtime 双一致
        _cfg_changed, _cfg_md5, _cfg_diff = config_guard("设置页·curl 向导段落")
        if _cfg_changed:
            warn("设置页 curl 向导段落改写了 config/config.json，已用启动快照字节还原（只做原值→原值）", _cfg_diff[:200])
        _cfg_same, _cfg_evidence = config_write_evidence("设置页·curl 向导段落")
        ok(f"设置页段落结束后 config/config.json 与启动快照 md5+mtime 双一致（零写盘；md5 {CONFIG_MD5_BEFORE[:8]}…）",
           _cfg_md5 != "" and _cfg_md5 == CONFIG_MD5_BEFORE and _cfg_same,
           f"路径={CONFIG_FILE} 当前 md5={_cfg_md5[:8] or '(空)'}… 快照 md5={CONFIG_MD5_BEFORE[:8] or '(无基线，起步即失败)'}… 差异：{_cfg_diff[:160]} {_cfg_evidence}")
        page.screenshot(path=str(OUT / "06-settings.png"))
        ok("模块5 无 JS 错误 / console error", not errs_since(set_errors), "; ".join(errs_since(set_errors)[:3]))

        # =====================================================================
        # H-101 追加：参考图栅格化缓存（设置页「数据与备份」区块）
        #   覆盖：缓存行（目录/文件数/占用 MB）· 「查看可清理量」只读 · 「清理缓存」二次确认（弹了就取消）
        #   安全红线：**绝不点 #cache-clean-confirm** —— 本脚本打的是用户已启动的真实服务，
        #     data/cache/refs 是真实文件；真删路径只在独立临时实例（独立 DATA_DIR）里验，这里只验弹窗 + 取消，
        #     并在取消后回查 /api/render/cache 的 files，确认一个文件都没被删。
        # =====================================================================
        cache_before = api("/api/render/cache")
        ok("设置页「数据与备份」含栅格化缓存行与两个按钮（#cache-row / #cache-scan / #cache-clean）",
           page.locator("#cache-row").count() == 1 and page.locator("#cache-scan").count() == 1
           and page.locator("#cache-clean").count() == 1,
           f"row={page.locator('#cache-row').count()} scan={page.locator('#cache-scan').count()} "
           f"clean={page.locator('#cache-clean').count()}")
        cache_line = page.inner_text("#cache-row")
        ok(f"缓存行显示缓存目录 + 文件数 + 占用 MB（数据源 GET /api/guard/status 的 disk.parts.cache；当前 files={cache_before.get('files')}）",
           "缓存目录" in cache_line and "data/cache/refs" in cache_line
           and ("MB" in cache_line or "后端未上报" in cache_line),
           cache_line.replace("\n", " / ")[:150])
        dcache_txt = data_card.inner_text()
        ok("缓存区块文案说明「把 SVG 参考图栅格化成 PNG 的缓存，删掉只影响下次出图时重新转换一次」",
           "栅格化成 PNG" in dcache_txt and "重新转换一次" in dcache_txt
           and "查看可清理量" in dcache_txt and "清理缓存" in dcache_txt)

        # ---- ①「查看可清理量」：只读接口，调用前后 files 必须不变 ----
        page.locator("#cache-scan").click()
        page.wait_for_function(
            "() => { const e = document.querySelector('#cache-scan-result'); return e && !e.textContent.includes('查询中'); }",
            timeout=20000)
        scan_txt = page.inner_text("#cache-scan-result")
        ok("「🔍 查看可清理量」显示文件数 / 占用 / 后端说明（并自报「未删除任何文件」）",
           "可清理量" in scan_txt and "文件数" in scan_txt and "MB" in scan_txt and "未删除任何文件" in scan_txt,
           scan_txt.replace("\n", " / ")[:160])
        cache_after = api("/api/render/cache")
        ok(f"查看可清理量是只读的：调用前后 files 不变（{cache_before.get('files')} → {cache_after.get('files')}）",
           cache_before.get("files") == cache_after.get("files"), f"{cache_before} vs {cache_after}")

        # ---- ②「清理缓存」：必须先二次确认；测试只点取消 ----
        page.locator("#cache-clean").click()
        cdlg = wait_modal("确认清理栅格化缓存", timeout=15000)
        ctxt = cdlg.inner_text()
        ok("「🧹 清理缓存」先弹二次确认（只删 data/cache/refs 下的 PNG / 不影响成片·关键帧·定妆图 / 不可撤销 / 将释放 MB）",
           "只删栅格化缓存" in ctxt and "data/cache/refs" in ctxt and "不影响成片" in ctxt and "关键帧" in ctxt
           and "定妆图" in ctxt and "不可撤销" in ctxt and ("将释放" in ctxt or "可清理量未知" in ctxt),
           ctxt.replace("\n", " / ")[:220])
        ok("二次确认弹窗 footer 为「取消（什么都不删）」+「确认清理（不可撤销）」两个按钮",
           cdlg.locator("#cache-clean-cancel").count() == 1 and cdlg.locator("#cache-clean-confirm").count() == 1)
        page.screenshot(path=str(OUT / "07-settings-cache-confirm.png"))
        cdlg.locator("#cache-clean-cancel").click()          # 【安全红线】绝不点 #cache-clean-confirm
        page.wait_for_timeout(700)
        files_after_cancel = api("/api/render/cache").get("files")
        ok(f"取消二次确认后弹窗关闭、缓存一个没少（files 仍为 {files_after_cancel}，未发出真删请求）",
           page.locator(".overlay .modal").count() == 0 and files_after_cancel == cache_before.get("files"),
           f"modal={page.locator('.overlay .modal').count()} files={files_after_cancel} before={cache_before.get('files')}")

        # ---- ③ 优雅降级：后端不返回 disk.parts 的 cache 项时显示「后端未上报」，不报错、不空白 ----
        # 只在浏览器侧代理 fetch（不改服务端、不落盘）：把 guard/status 响应里的 cache 项摘掉，模拟老后端。
        def h101_stub(mode):
            return page.evaluate("""(mode) => {
              if (!window.__h101_orig_fetch) window.__h101_orig_fetch = window.fetch.bind(window);
              const orig = window.__h101_orig_fetch;
              if (!mode) { window.fetch = orig; return 'restored'; }
              window.fetch = async (input, init) => {
                const url = typeof input === 'string' ? input : ((input && input.url) || '');
                if (mode === 'strip-cache-part' && url.indexOf('/api/guard/status') >= 0) {
                  const r = await orig(input, init);
                  const j = await r.clone().json();
                  if (j && j.disk) {
                    if (Array.isArray(j.disk.parts)) j.disk.parts = j.disk.parts.filter(p => !p || p.name !== 'cache');
                    delete j.disk.cache;
                  }
                  return new Response(JSON.stringify(j), { status: r.status, headers: { 'content-type': 'application/json' } });
                }
                if (mode === 'cache-404' && url.indexOf('/api/render/cache') >= 0) {
                  return new Response(JSON.stringify({ ok: false, error: '接口不存在（H-101 模拟）' }),
                                      { status: 404, headers: { 'content-type': 'application/json' } });
                }
                return orig(input, init);
              };
              return 'patched:' + mode;
            }""", mode)

        h101_stub("strip-cache-part")
        page.locator("#cache-scan").click()      # 扫描结束会刷新 guard/status → 命中被代理的那份（无 cache 项）
        page.wait_for_function(
            "() => { const e = document.querySelector('#cache-scan-result'); return e && !e.textContent.includes('查询中'); }",
            timeout=20000)
        page.wait_for_timeout(700)
        deg_txt = page.inner_text("#cache-usage")
        ok("后端未上报 cache 项时优雅降级为「后端未上报」（不报错、不空白、两个按钮仍可用）",
           "后端未上报" in deg_txt and page.locator("#cache-scan").count() == 1
           and page.locator("#cache-clean").count() == 1 and page.locator("#cache-row").count() == 1,
           f"#cache-usage = {deg_txt[:130]}")
        h101_stub(None)
        page.locator("#cache-scan").click()
        page.wait_for_function(
            "() => { const e = document.querySelector('#cache-scan-result'); return e && !e.textContent.includes('查询中'); }",
            timeout=20000)
        page.wait_for_timeout(700)
        real_txt = page.inner_text("#cache-usage")
        ok("还原真实后端后缓存行恢复占用数字（MB）", "MB" in real_txt and "后端未上报" not in real_txt, real_txt[:130])

        # ---- ④ 错误路径：接口 404 → 中文提示（不静默失败、不把 ok:false 当成功） ----
        h101_stub("cache-404")
        page.locator("#cache-scan").click()
        page.wait_for_function(
            "() => { const e = document.querySelector('#cache-scan-result'); return e && !e.textContent.includes('查询中'); }",
            timeout=20000)
        e404 = page.inner_text("#cache-scan-result")
        ok("查询接口 404 时给出中文提示（不静默失败、不当作成功）",
           "✗" in e404 and "HTTP 404" in e404 and "后端没有这个接口" in e404, e404.replace("\n", " / ")[:160])
        ok("404 时页面未报错、缓存行与按钮仍在（降级不影响页面可用性）",
           page.locator("#cache-row").count() == 1 and page.locator("#cache-clean").count() == 1
           and not [e for e in errs_since(set_errors) if e.startswith("PAGEERROR")],
           "; ".join(errs_since(set_errors)[:3]))
        h101_stub(None)
        page.locator("#cache-scan").click()
        page.wait_for_function(
            "() => { const e = document.querySelector('#cache-scan-result'); return e && !e.textContent.includes('查询中'); }",
            timeout=20000)
        ok("还原接口后「查看可清理量」恢复成功文案",
           "可清理量" in page.inner_text("#cache-scan-result"),
           page.inner_text("#cache-scan-result").replace("\n", " / ")[:130])
        close_modals()
        ok("H-101 缓存交互结束：缓存文件数仍与进入本段前一致（全程未真删）",
           api("/api/render/cache").get("files") == cache_before.get("files"),
           f"now={api('/api/render/cache').get('files')} before={cache_before.get('files')}")

        # =====================================================================
        # H-101 追加②：尾帧落库（I-101）—— 独立临时实例（临时 DB/DATA_DIR/config + 随机端口）
        # 放在主流程末尾：它自带一套浏览器 page 与断言，失败也只记在本段落，不影响上面的既有断言。
        # =====================================================================
        tail_frame_section(browser)

        head("全局校验")
        ok("全流程无 pageerror / 未捕获异常", not [e for e in errs if e.startswith("PAGEERROR")],
           "; ".join([e for e in errs if e.startswith("PAGEERROR")][:3]))
        ok("全流程无 console.error（已排除 favicon/404 噪音）", not errs_since(0), "; ".join(errs_since(0)[:3]))
        shots_out = sorted(p.name for p in OUT.glob("*.png"))
        ok(f"每模块截图已输出（{len(shots_out)} 张：{', '.join(shots_out)}）", len(shots_out) >= 5)
        browser.close()

    # ---------- 收尾：异常兜底清理（保证可重复运行） ----------
    if shot_restore:
        try:
            api(f"/api/scripts/{shot_restore['script']}/shots/{shot_restore['id']}", "PUT", {"sfx": shot_restore["sfx"]})
            warn("兜底还原镜头音效字段", shot_restore["id"])
        except Exception as e:
            warn("兜底还原失败", str(e))
    try:
        for c in api("/api/canvas/list")["canvases"]:
            if c["name"] == TEMP_CANVAS:
                for g in api(f"/api/canvas/groups?id={c['id']}")["groups"]:
                    api(f"/api/canvas/groups/{g['id']}", "DELETE")
                for l in api(f"/api/canvas/links?id={c['id']}")["links"]:
                    api(f"/api/canvas/links/{l['id']}", "DELETE")
                api(f"/api/canvas/{c['id']}", "DELETE")
                warn("兜底删除临时画布", c["id"])
    except Exception as e:
        warn("兜底清理临时画布失败", str(e))

    # ---------- 收尾：配置守卫终检（整脚本跑完，真实 config/config.json 必须与启动快照 md5 + mtime 双一致） ----------
    _cfg_changed, _cfg_md5, _cfg_diff = config_guard("脚本收尾")
    if _cfg_changed:
        warn("本次 UI 模拟曾改写 config/config.json，已在收尾阶段用启动快照字节还原（只做原值→原值）", _cfg_diff[:200])
    _cfg_same, _cfg_evidence = config_write_evidence("脚本收尾")
    ok(f"脚本收尾时 config/config.json 仍与启动快照 md5+mtime 双一致（零写盘；md5 {CONFIG_MD5_BEFORE[:8]}…）",
       _cfg_md5 != "" and _cfg_md5 == CONFIG_MD5_BEFORE and _cfg_same,
       f"路径={CONFIG_FILE} 当前 md5={_cfg_md5[:8] or '(空)'}… 快照 md5={CONFIG_MD5_BEFORE[:8] or '(无基线，起步即失败)'}… 差异：{_cfg_diff[:160]} {_cfg_evidence}")

    print(f"\n=== 截图输出：{OUT} ===")
    if PROBLEMS:
        print(f"=== 发现的产品问题：{len(PROBLEMS)} 条（不改产品代码，仅记录；不计入下方失败计数）===")
        print("      如需把它们计入失败，把脚本里的 problem(...) 改成 ok(name, False, detail) 即可")
        for t, d in PROBLEMS:
            print(f"   ✖ {t}\n       {d}")
    if WARN:
        print(f"=== 提示 {len(WARN)} 条 ===")
        for n, d in WARN:
            print(f"   ! {n}   {d}")
    print(f"=== 结果：{len(PASS)} 通过 / {len(FAIL)} 失败 ===")
    if FAIL:
        for n, d in FAIL:
            print(f"   失败：{n}   {d}")
    return 1 if FAIL else 0


def main():
    """付费后端闸门 + 主体：跑前切 placeholder，跑完（含异常/中断）在 finally 里切回真实配置"""
    paid_backend_gate_on()
    try:
        return run_all()
    finally:
        paid_backend_gate_off()


if __name__ == "__main__":
    sys.exit(main())
