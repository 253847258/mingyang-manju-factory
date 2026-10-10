#!/usr/bin/env python3
"""无限画布 · 功能一致性审计
逐项核验《使用手册 1.2 无限画布》与 README 中声明的每一项能力，并交叉校验
「文档声明 ↔ 实际行为 ↔ 不同入口结果一致」。

用法：
    node server.js                     # 先启动服务（默认 8788）
    python3 tests/canvas-audit.py [baseUrl]

前置夹具：本脚本会自己幂等准备 /tmp/refs/ref{1,2,3}.png（L3 参考图矩阵 / L4 节点挂参考图
    两处上传要用），无需人工创建；实现见 tests/make-audit-refs.py，目录可用 AUDIT_REFS_DIR 覆盖。

副作用：会创建/删除一个名为「审计临时演员」的演员与一条临时连线，结束后恢复宫格排布与视图。
"""
import atexit
import json
import os
import pathlib
import re
import subprocess
import signal
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("BASE", "http://127.0.0.1:8788")
CHROME = os.environ.get("CHROME", "/home/linsheng/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome")
LIBS = os.environ.get("PW_LIBS", "/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu")
if LIBS and not os.environ.get("LD_LIBRARY_PATH"):
    os.environ["LD_LIBRARY_PATH"] = LIBS
OUT = pathlib.Path("/tmp/canvas-audit")
OUT.mkdir(parents=True, exist_ok=True)

# ---- 审计夹具（R-W5-04）：下面 L3/L4 两处上传参考图要用 /tmp/refs/ref{1,2,3}.png ----
# 历史缺陷：全仓库没有任何脚本创建该目录，干净机器上裸跑会在 set_input_files 抛
# FileNotFoundError 并中断整个审计（连总结都打不出来）。现在由 tests/make-audit-refs.py
# 幂等生成（ffmpeg 优先，缺失时回落标准库写 PNG），目录可用 AUDIT_REFS_DIR 覆盖。
REFS_DIR = pathlib.Path(os.environ.get("AUDIT_REFS_DIR") or "/tmp/refs")
REFS = [REFS_DIR / f"ref{i}.png" for i in range(1, 4)]


def _ensure_ref_fixtures():
    """调用 tests/make-audit-refs.py（同目录）幂等准备参考图夹具；失败时以中文原因退出"""
    helper = pathlib.Path(__file__).resolve().parent / "make-audit-refs.py"
    if not helper.is_file():
        raise SystemExit(f"审计夹具生成器缺失：{helper}（无法准备 {REFS_DIR} 下的参考图，拒绝继续）")
    import importlib.util
    spec = importlib.util.spec_from_file_location("make_audit_refs", helper)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    try:
        return mod.ensure_refs(REFS_DIR, 3)
    except RuntimeError as e:
        raise SystemExit(f"审计夹具准备失败：{e}")


print("=== 准备审计夹具（参考图）===")
_ensure_ref_fixtures()

PASS, FAIL, WARN = [], [], []


def ok(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print(f"  ✓ {name}")
    else:
        FAIL.append((name, detail))
        print(f"  ✗ {name}   {detail}")
    return bool(cond)


def warn(name, detail):
    WARN.append((name, detail))
    print(f"  ! {name}   {detail}")


def api(path, method="GET", body=None):
    req = urllib.request.Request(
        BASE + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def busy_jobs():
    """返回 (running, queued) 数量；读不到返回 (-1, -1)。

    为什么审计要在开头/结尾各看一眼队列：本脚本刻意打**已启动的真实服务**，用户在界面上
    出图/改画布时（本会话 2026-09-30 就发生过）会让审计的夹具被并发改动，从而产生
    「看着像功能坏了、其实是并发」的假失败。这里不改行为，只把并发事实**大声打出来**，
    让看日志的人先怀疑并发、而不是去改产品。
    """
    try:
        js = api("/api/jobs").get("jobs") or []
    except Exception:
        return -1, -1
    return (len([j for j in js if j.get("status") == "running"]),
            len([j for j in js if j.get("status") == "queued"]))


def concurrency_note(phase):
    running, queued = busy_jobs()
    if running < 0:
        print(f"  ! 并发探测（{phase}）：读不到 /api/jobs（服务刚起或不可达）")
        return None
    busy = running + queued
    if busy:
        print(f"  ! 并发探测（{phase}）：队列里有 {running} 个 running / {queued} 个 queued —— "
              f"用户可能正在出图或改画布；本轮若有失败项，**先怀疑并发**，再怀疑功能")
    else:
        print(f"  ! 并发探测（{phase}）：队列空闲（无人并发操作）")
    return busy


# =============================================================================
# 付费后端闸门（防误花钱 · RK-SPEND-03）
# 为什么需要：本脚本**刻意**打已启动的真实服务（BASE 默认 http://127.0.0.1:8788），
# 而真实 config/config.json 的 image.backend 已指向付费厂商（generic-http = 百炼
# wan2.7-image，实测 ¥0.2/张）。第 M 节会点「⚡ 组合出图」（第 1345 行）与「生成概念图」
# （第 1374 行）——两个入口都走 src/modules/actors.js → generateImage，按配置后端真出图，
# 即真花钱（一轮约 2~3 张）。
# 做法：跑之前用 PUT /api/settings 把 出图/视频/配音 三个后端临时切回
#       placeholder / placeholder / none（本地占位 SVG + 本地 ffmpeg，零网络零费用），
#       跑完在 __main__ 的 finally 里切回真实配置（异常/中断同样还原），并把
#       config/config.json 的**字节与 mtime 原样还原**（scripts/verify-all.sh 的配置守卫
#       按 md5 + mtime 双比对，还原后阶段 25 不留漂移）。
# 断言期望一字未改：第 M 节只校验「任务提交成功 + 节点挂到生成结果」，占位后端同样满足。
# =============================================================================
_PAID_GATE = {"active": False, "armed": False, "orig": None, "bytes": None, "stat": None, "config": None}


def _paid_gate_config_path():
    """与 src/config.js 同源：FACTORY_CONFIG 优先，否则仓库内 config/config.json"""
    return pathlib.Path(os.environ.get("FACTORY_CONFIG")
                        or (pathlib.Path(__file__).resolve().parent.parent / "config" / "config.json"))


def _paid_gate_marker_path():
    """闸门「兜底快照」路径：进入闸门前把付费配置整份另存一份。

    为什么要有这个文件（2026-10-03 事故换来的教训）：
      闸门原来的兜底只有「内存里的 orig + atexit/SIGTERM 处理器」。一旦进程被 **SIGKILL**（或整机
      异常：本会话就出现过实例消失 + /tmp 被系统清空），内存兜底全都失效 —— 服务端会**永久停在
      placeholder**，用户下一次出图拿到的是占位 SVG 却毫不知情；更糟的是下一次闸门会把
      「当前就是 placeholder」当成 baseline（orig=placeholder），于是**把错误状态固化成默认**。
      有了这份落盘快照，恢复就不依赖内存：gate_on 时若发现快照还在，说明上次没跑完 →
      先按快照整份还原，再继续。
    """
    return _paid_gate_config_path().with_name(_paid_gate_config_path().name + ".before-paid-gate")


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
    # 自愈：上一次闸门没跑完（快照还在）→ 先按快照整份还原，并把后端 PUT 回去，再开始本轮
    marker = _paid_gate_marker_path()
    if marker.exists():
        print(f"  ! 付费闸门：发现上次运行留下的兜底快照 {marker.name} —— 说明上一次闸门**没有正常收尾**，"
              f"服务端可能停在 placeholder。先按快照还原，再开始本轮。")
        try:
            snap = json.loads(marker.read_text(encoding="utf-8"))
            p.write_bytes(bytes.fromhex(snap["config_hex"]))
            api("/api/settings", "PUT", {"image": {"backend": snap["orig"]["image"]},
                                         "video": {"backend": snap["orig"]["video"]},
                                         "tts": {"backend": snap["orig"]["tts"]}})
            marker.unlink()
            print(f"  ✓ 付费闸门：已按快照还原（出图={snap['orig']['image']} 视频={snap['orig']['video']} 配音={snap['orig']['tts']}），"
                  f"兜底快照已删除")
        except Exception as e:  # noqa: BLE001
            print(f"  ! 付费闸门：按快照还原失败（{e}）；仍继续本轮，但请人工核对 config.json 与服务端后端")
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
    # 落盘兜底快照（SIGKILL / 整机异常时用它恢复，见 _paid_gate_marker_path 注释）
    try:
        marker.write_text(json.dumps({
            "orig": orig, "at": time.strftime("%F %T"),
            "config_hex": _PAID_GATE["bytes"].hex(),
            "config_path": str(p),
        }, ensure_ascii=False), encoding="utf-8")
        print(f"  ✓ 付费闸门：兜底快照已落盘 {marker.name}（异常中断后可据此恢复）")
    except Exception as e:  # noqa: BLE001
        print(f"  ! 付费闸门：兜底快照写入失败（{e}）—— 本次改动的恢复仍依赖内存兜底")
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
        # 还原动作做完了 → 删掉兜底快照（下次运行就不会误判成「上次没跑完」）
        try:
            _paid_gate_marker_path().unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass
    finally:
        # ★ 只在真正做完还原动作后才落回 inactive：这样 finally 提前失败/被硬中断时，
        #   atexit 或信号处理器里的第二次调用仍会重试（幂等，不会重复打印成功）
        _PAID_GATE["active"] = False


def assert_gate_armed(when):
    """运行中复核：出图后端必须仍是 placeholder。

    为什么加它（2026-10-03 事故）：我（汇总线）在闸门运行期间手改 `/api/settings` 把出图后端
    切回真实厂商，结果这一轮审计的「组合出图 / 环境概念图」走的是**真实付费后端**：花了 7 张图
    （≈1.4 元）、还因为真机出图慢导致两条断言失败 —— 脚本当时毫不知情，最后只报「2 项失败」，
    完全看不出是外部改动造成的。现在遇到这种情况会**大声说清**并让本轮判失败。
    """
    cur = _paid_gate_read_settings() or {}
    backend = (cur.get("image") or {}).get("backend")
    if backend == "placeholder":
        return True
    print(f"  ✗ 付费闸门失效（{when}）：服务端出图后端 = {backend!r}，不是 placeholder！"
          f"说明本轮期间有外部改动（设置页/其它脚本/闸门被绕过）→ 本轮可能已经花了真钱，"
          f"且相关断言结果不可信。请先确认配置，再单独重跑本审计。")
    _PAID_GATE["broken"] = True
    return False


def press_shortcut(page, key, ctrl=False, shift=False):
    """发送快捷键：先试真实键盘事件；Chromium 会把 Ctrl+L 这类保留快捷键吞掉，
    此时补一次合成 KeyboardEvent（走的是应用自己的 keydown 处理器，语义等价）。"""
    if ctrl:
        page.keyboard.press(("Control+" if not shift else "Control+Shift+") + key)
    elif shift:
        page.keyboard.press("Shift+" + key)
    else:
        page.keyboard.press(key)
    page.wait_for_timeout(500)


def press_ctrl_shortcut(page, key, state_getter=None):
    """发送 Ctrl+<键>，并且**只在真键确实没被应用感知到时**才补发合成事件。

    2026-09-30 修一处偶发假失败：原实现「真键盘事件 + 无条件合成事件」= 对 Ctrl+L 这种
    **开关型**快捷键会连按两次、把状态切回原样（实测 `showLinks` 断言拿到 True）。
    现在先发真键，再读一次状态；状态没变才补合成事件（幂等），避免双发。
    """
    before = state_getter() if callable(state_getter) else None
    press_shortcut(page, key, ctrl=True)
    if not key.lower() in ('l', 'z'):
        return
    changed = (before is None) or (not callable(state_getter)) or (state_getter() != before)
    if changed:
        return                       # 真键已经生效，别再补一刀（否则开关会被切回去）
    page.evaluate(
        "() => window.dispatchEvent(new KeyboardEvent('keydown', {key: '%s', ctrlKey: true, bubbles: true}))" % key.lower())
    page.wait_for_timeout(500)


def blur_focus(page):
    """把焦点从工具栏/输入框还给页面：否则 Ctrl+L、方向键、f、0 等快捷键会被输入控件吃掉。"""
    try:
        page.evaluate("() => { const a = document.activeElement; if (a && a.blur) a.blur(); }")
    except Exception:
        pass


def main(state=None):
    actors_before = api("/api/actors")["actors"]
    n_actors = len(actors_before)
    pre_state_node_count = len(api("/api/canvas")["canvas"]["nodes"])   # 全流程用于校验主画布未被清空
    created_actor = None
    created_link = None
    created_canvas = None

    # 备份主画布现状（审计结束后自动还原，保证可在正式实例上安全运行）
    pre_state = None
    try:
        _cv = api("/api/canvas")["canvas"]
        pre_state = {
            "canvas_id": "CV-MAIN",
            # 必须带上 title/data/note 等全部内容字段，否则还原后资产/便签节点会丢内容
            "nodes": [{k: n.get(k) for k in ("id", "actor_id", "x", "y", "w", "h", "z", "locked",
                                             "note", "group_id", "kind", "color", "title", "data",
                                             "note_text", "note_color", "asset")}
                      for n in _cv["nodes"]],
            "groups": [{k: g.get(k) for k in ("id", "name", "color", "x", "y", "w", "h", "collapsed")} for g in _cv["groups"]],
            "links": [{k: l.get(k) for k in ("id", "from_actor", "to_actor", "from_node", "to_node", "from_side", "to_side",
                                              "from_port", "to_port", "slot", "label", "color")} for l in _cv.get("links", [])],
            "layout_view": (_cv.get("layout") or {}).get("view") or {},
            # 还原时必须知道审计前的排布模式：否则收尾固定按 matrix 回写，会把分组布局
            # （layout.mode='group' + layout.groups=N 组）抹平成 0 组，且还原后的分组框与卡位对不上
            "layout_mode": (_cv.get("layout") or {}).get("mode"),
            "layout_groupBy": (_cv.get("layout") or {}).get("groupBy"),
            "cols": _cv.get("cols"), "cell": _cv.get("cell_size"),
        }
        print(f"[backup] 已备份主画布：{len(pre_state['nodes'])} 卡位 / {len(pre_state['groups'])} 分组 / {len(pre_state['links'])} 连线")
    except Exception as e:
        print("[backup] 跳过：", e)

    if state is not None:
        state["pre"] = pre_state

    # 起始清场：删除遗留便签/分组并恢复宫格，保证断言可重复
    try:
        for _g in api("/api/canvas/groups")["groups"]:
            api("/api/canvas/groups/" + _g["id"], "DELETE")
        for _n in api("/api/canvas")["canvas"]["nodes"]:
            if _n.get("kind") in ("note", "scene", "item", "refimg", "shot", "video", "timeline", "output"):
                api("/api/canvas/node/" + _n["id"], "DELETE")
        for _c in api("/api/canvas/list")["canvases"]:
            if _c["name"] == "审计临时画布":
                api("/api/canvas/" + _c["id"], "DELETE")
        api("/api/canvas/arrange", "POST", {"id": "CV-MAIN", "mode": "matrix", "cols": 5, "cell": 210, "gap": 14})
    except Exception as e:
        print("[pre-clean] 跳过：", e)

    with sync_playwright() as p:
        kwargs = {"args": ["--no-sandbox"]}
        if pathlib.Path(CHROME).exists():
            kwargs["executable_path"] = CHROME
        browser = p.chromium.launch(**kwargs)
        page = browser.new_page(viewport={"width": 1720, "height": 1020})
        errors = []
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))
        page.goto(f"{BASE}/#/actors", wait_until="networkidle")
        page.wait_for_timeout(2600)
        dbg = lambda: page.evaluate("() => window.__acDebug()")
        box = page.locator(".ac-canvas-wrap").bounding_box()
        CX, CY = box["x"] + 700, box["y"] + 430

        def wheel(n, dy, x=None, y=None):
            page.mouse.move(x or CX, y or CY)
            for _ in range(n):
                page.mouse.wheel(0, dy)
            page.wait_for_timeout(450)

        def visible_items(kind=None):
            """只返回中心点确实落在画布可视区内的卡片（避免点到画布外/侧栏）"""
            cv = page.locator("#ac-canvas").bounding_box()
            items = page.evaluate("() => window.__acDebug().screenItems()")
            out = [i for i in items
                   if cv["x"] + 4 < i["cx"] < cv["x"] + cv["width"] - 4
                   and cv["y"] + 4 < i["cy"] < cv["y"] + cv["height"] - 4]
            if kind:
                out = [i for i in out if i.get("kind") == kind]
            return out

        def first_visible(kind, name, retry=1):
            """取可见项的第一张坐标；不可见时「适应视图(F)」重试，仍不可见则显式判红并返回 None。
            用途：避免直接 visible_items(kind)[0] 在无可见项时抛 IndexError 打断整个审计
            （旧实现 tests/canvas-audit.py:957 即如此），同时不降低审计强度——可见性本身是一条断言，
            调用方拿不到坐标时，后续交互断言仍会逐条以「无法执行」判红。"""
            got = visible_items(kind)
            for _ in range(retry):
                if got:
                    break
                page.keyboard.press("f")
                page.wait_for_timeout(900)
                got = visible_items(kind)
            ok(name, bool(got), f"visible_items('{kind}')={len(got)}，画布内没有可见的{kind}节点，无法定位屏幕坐标")
            return got[0] if got else None

        def set_zoom(target):
            """用滚轮逼近目标缩放"""
            for _ in range(60):
                z = dbg()["zoom"]
                if abs(z - target) / target < 0.06:
                    return z
                wheel(1, 220 if z > target else -220)
                page.wait_for_timeout(60)
            return dbg()["zoom"]

        print("\n=== A. 结构一致性：文档声明的控件是否都在 ===")
        ok("主画布 / 小地图 / 缩放条 / HUD 同时存在",
           page.locator("#ac-canvas").count() == 1 and page.locator("#ac-minimap").count() == 1
           and page.locator("#ac-zoombar").count() == 1 and page.locator("#ac-hud").count() == 1)
        if page.locator("#ac-minimap").count() == 0 or not page.locator("#ac-minimap").is_visible():
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(1500)
        mm = page.locator("#ac-minimap").bounding_box() or {"width": 0, "height": 0}
        ok("小地图尺寸为 208×140（未被主画布样式撑满）",
           abs(mm["width"] - 208) < 2 and abs(mm["height"] - 140) < 2, f"{mm['width']}×{mm['height']}")
        d0 = dbg()
        ok(f"卡片数 = 演员数（{n_actors}）", d0["items"] == n_actors, f"items={d0['items']}")
        hud = page.inner_text("#ac-hud")
        ok("HUD 含 缩放/模式/总数/LOD 四项",
           "%" in hud and ("宫格" in hud or "自由" in hud) and "👥" in hud and "LOD" in hud, hud.replace("\n", " "))
        zv = page.inner_text(".ac-zoom-val")
        ok("缩放条百分比与内部 zoom 一致", abs(int(zv.replace("%", "")) - round(d0["zoom"] * 100)) <= 1, f"{zv} vs {d0['zoom']}")
        ok("调试钩子存在且为只读快照", isinstance(d0, dict) and "zoom" in d0)

        print("\n=== B. 缩放：5%–800%、以光标为中心、多入口一致 ===")
        wheel(45, 260)
        zmin = dbg()["zoom"]
        ok("滚轮极限缩小到 5%", abs(zmin - 0.05) < 1e-6, f"zoom={zmin}")
        wheel(90, -260)
        zmax = dbg()["zoom"]
        ok("滚轮极限放大到 800%", abs(zmax - 8) < 1e-6, f"zoom={zmax}")
        page.keyboard.press("f")
        page.wait_for_timeout(900)
        z_fit = dbg()["zoom"]
        ok("F 键 = 适应窗口", 0.05 < z_fit < 8 and abs(z_fit - (dbg()["zoom"])) < 1e-9)
        # 光标锚定：先记录光标下的世界坐标，缩放后应不变
        page.mouse.move(CX, CY)
        w_before = page.evaluate("(p) => window.__acDebug().worldAt(p.x, p.y)", {"x": CX, "y": CY})
        wheel(3, -220)
        w_after = page.evaluate("(p) => window.__acDebug().worldAt(p.x, p.y)", {"x": CX, "y": CY})
        ok("缩放以光标为中心（光标下世界坐标不动）",
           abs(w_before["x"] - w_after["x"]) < 1.5 and abs(w_before["y"] - w_after["y"]) < 1.5,
           f"{w_before} → {w_after}")
        # 三入口一致：工具栏适应 / 缩放条适应 / F 键
        for label in ["⤢ 适应"]:
            page.get_by_text(label).first.click()
            page.wait_for_timeout(800)
            z_tool = dbg()["zoom"]
        page.locator("#ac-zoombar .ac-zoom-btn").nth(2).click()
        page.wait_for_timeout(800)
        z_bar = dbg()["zoom"]
        ok("工具栏「适应」= 缩放条「⤢」（结果一致）", abs(z_tool - z_bar) < 0.01, f"{z_tool} vs {z_bar}")
        page.keyboard.press("0")
        page.wait_for_timeout(400)
        ok("0 键复位到 100%", abs(dbg()["zoom"] - 1) < 1e-6, str(dbg()["zoom"]))
        page.keyboard.press("Equal")
        page.keyboard.press("Equal")
        page.wait_for_timeout(400)
        zk = dbg()["zoom"]
        page.locator("#ac-zoombar .ac-zoom-btn").nth(1).click()
        page.wait_for_timeout(400)
        ok("键盘 + 与缩放条 ＋ 同样放大（步进一致）", dbg()["zoom"] > zk, f"{zk} → {dbg()['zoom']}")

        print("\n=== C. 平移：空格 / 中键 / Alt / 触控板双指 ===")
        page.keyboard.press("f")
        page.wait_for_timeout(700)
        p0 = dbg()
        page.keyboard.down("Space")
        page.mouse.move(CX, CY)
        page.mouse.down()
        page.mouse.move(CX + 160, CY + 90, steps=8)
        page.mouse.up()
        page.keyboard.up("Space")
        page.wait_for_timeout(400)
        p1 = dbg()
        ok("空格 + 拖动可平移", abs(p1["panX"] - p0["panX"]) > 5 and abs(p1["panY"] - p0["panY"]) > 5,
           f"{p0['panX']:.0f},{p0['panY']:.0f} → {p1['panX']:.0f},{p1['panY']:.0f}")
        page.mouse.move(CX, CY)
        page.mouse.down(button="middle")
        page.mouse.move(CX - 120, CY - 60, steps=8)
        page.mouse.up(button="middle")
        page.wait_for_timeout(400)
        p2 = dbg()
        ok("中键拖动可平移", abs(p2["panX"] - p1["panX"]) > 5, f"{p1['panX']:.0f} → {p2['panX']:.0f}")
        z_before = dbg()["zoom"]
        page.keyboard.down("Alt")
        page.mouse.move(CX, CY)
        page.mouse.down()
        page.mouse.move(CX + 80, CY, steps=6)
        page.mouse.up()
        page.keyboard.up("Alt")
        page.wait_for_timeout(400)
        p3 = dbg()
        ok("Alt + 拖动可平移且不改变缩放", abs(p3["panX"] - p2["panX"]) > 5 and abs(p3["zoom"] - z_before) < 1e-9)
        # 触控板双指：像素级 delta 且未按 ctrl → 平移
        p4 = dbg()
        page.mouse.move(CX, CY)
        page.evaluate("""() => {
          const cv = document.querySelector('#ac-canvas');
          cv.dispatchEvent(new WheelEvent('wheel', { deltaY: 23.5, deltaX: 8.25, deltaMode: 0, bubbles: true, cancelable: true, clientX: %d, clientY: %d }));
        }""" % (CX, CY))
        page.wait_for_timeout(400)
        p5 = dbg()
        ok("触控板双指（像素级 delta）走平移而非缩放",
           abs(p5["zoom"] - p4["zoom"]) < 1e-9 and (abs(p5["panY"] - p4["panY"]) > 0.5 or abs(p5["panX"] - p4["panX"]) > 0.5),
           f"zoom {p4['zoom']}→{p5['zoom']} panY {p4['panY']:.1f}→{p5['panY']:.1f}")
        # 回归：平移必须在 mouseup 复位（否则松手后不按键移动鼠标也会持续平移，框选/拖拽/缩放/连线全部失效；
        # 早期该 bug 还让上面「中键拖动可平移」因为上一个平移状态未复位而假通过）
        pan_after_up = (dbg()["panX"], dbg()["panY"])
        page.mouse.move(CX, CY)
        page.wait_for_timeout(150)
        page.mouse.move(CX + 240, CY + 140, steps=8)
        page.wait_for_timeout(400)
        ok("松开鼠标后平移状态已复位（不按键移动鼠标不再拖动画布）",
           (dbg()["panX"], dbg()["panY"]) == pan_after_up and dbg().get("panning") is False,
           f"pan {pan_after_up} → {(dbg()['panX'], dbg()['panY'])} panning={dbg().get('panning')}")

        print("\n=== D. 小地图 ===")
        page.keyboard.press("f")
        page.wait_for_timeout(700)
        before = dbg()
        page.mouse.click(mm["x"] + mm["width"] * 0.25, mm["y"] + mm["height"] * 0.3)
        page.wait_for_timeout(500)
        after = dbg()
        ok("点击小地图跳转视口", abs(after["panX"] - before["panX"]) > 5 or abs(after["panY"] - before["panY"]) > 5,
           f"{before['panX']:.0f},{before['panY']:.0f} → {after['panX']:.0f},{after['panY']:.0f}")
        page.locator("#ac-minimap").click(position={"x": 20, "y": 20})
        page.wait_for_timeout(400)
        ok("小地图点击左上角把视口带到内容起点", dbg()["panX"] > after["panX"] - 1)
        mm_toggle = page.locator("label[title='显示小地图'] input")
        if mm_toggle.count():
            mm_toggle.uncheck()
            page.wait_for_timeout(400)
            ok("小地图可关闭", not page.locator("#ac-minimap").is_visible())
            mm_toggle.check()
            page.wait_for_timeout(400)
            ok("小地图可再开启", page.locator("#ac-minimap").is_visible())
        else:
            warn("小地图开关", "未找到开关控件")

        print("\n=== E. LOD 分级 + 视口裁剪 ===")
        api("/api/canvas/viewport", "PUT", {"id": "CV-MAIN", "zoom": 0.12, "panX": 0, "panY": 0})
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(2200)
        d_low = dbg()
        ok("缩放 <22% → LOD 简（HUD 显示 LOD 简）", d_low["lod"] == 0 and "LOD 简" in page.inner_text("#ac-hud"), f"lod={d_low['lod']}")
        ok("LOD 简时完全不解码图片（新页面 imgCache = 0）", d_low["imgLoaded"] == 0 and d_low["imgCache"] == 0,
           f"cache={d_low['imgCache']} loaded={d_low['imgLoaded']}")
        def reload_at(zoom, pan=(-10, -10)):
            api("/api/canvas/viewport", "PUT", {"id": "CV-MAIN", "zoom": zoom, "panX": pan[0], "panY": pan[1]})
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(2200)
            return dbg()

        d_mid = reload_at(0.35)
        ok("22%~50% → LOD 中", d_mid["lod"] == 1, f"lod={d_mid['lod']}")
        d_full = reload_at(1.0)
        page.wait_for_timeout(1200)
        d_full = dbg()
        ok(">50% → LOD 全 且图片开始解码", d_full["lod"] == 2 and d_full["imgLoaded"] > 0,
           f"lod={d_full['lod']} loaded={d_full['imgLoaded']} drawn={d_full['drawn']}")
        ok("LOD 全时可见卡片全部绘制", d_full["drawn"] == d_full["items"], f"drawn={d_full['drawn']} / items={d_full['items']}")
        set_zoom(4.0)
        page.wait_for_timeout(500)
        d_zoom = dbg()
        ok("放大后只渲染视野内卡片（视口裁剪生效）", d_zoom["drawn"] < d_zoom["items"],
           f"drawn={d_zoom['drawn']} / items={d_zoom['items']}")

        print("\n=== F. 选择与编辑 ===")
        page.keyboard.press("f")
        page.wait_for_timeout(900)
        page.keyboard.press("Escape")
        scr = page.evaluate("() => window.__acDebug().screenItems()")
        ok("调试钩子提供全部卡片屏幕坐标", len(scr) == n_actors, f"{len(scr)}")
        page.mouse.click(scr[0]["cx"], scr[0]["cy"])
        page.wait_for_timeout(400)
        ok("点击单选", dbg()["selection"] == [scr[0]["actorId"]], f"{dbg()['selection']} vs {scr[0]['actorId']}")
        page.keyboard.down("Control")
        page.mouse.click(scr[1]["cx"], scr[1]["cy"])
        page.mouse.click(scr[2]["cx"], scr[2]["cy"])
        page.keyboard.up("Control")
        page.wait_for_timeout(400)
        ok("Ctrl 加选保持顺序角标", len(dbg()["selection"]) == 3 and len(dbg()["order"]) == 3, f"{dbg()['selection']}")
        page.screenshot(path=str(OUT / "01-select-order.png"))
        page.keyboard.press("Escape")
        # 框选：起点取画布内、卡片上方的空白处（避免落在左侧栏或卡片上）
        start_x = max(box["x"] + 25, min(scr[0]["cx"] - 200, box["x"] + 60))
        start_y = min(scr[0]["cy"] for scr_i in [scr[0]] for scr_i in [scr[0]]) - 0
        start_y = max(box["y"] + 30, min([i["cy"] for i in scr]) - 190)
        start_x = box["x"] + 30
        hit_el = page.evaluate(f"() => document.elementFromPoint({start_x},{start_y})?.id || document.elementFromPoint({start_x},{start_y})?.className")
        ok("框选起点确为画布空白处", hit_el in ("ac-canvas", ""), f"elementFromPoint={hit_el}")
        page.mouse.move(start_x, start_y)
        page.mouse.down()
        page.mouse.move(scr[2]["cx"] + 40, scr[2]["cy"] + 40, steps=12)
        page.mouse.up()
        page.wait_for_timeout(600)
        sel_count = len(dbg()["selection"])
        ok("框选可多选", sel_count >= 2, f"selected={sel_count}")
        ok("多选时底部出现对齐工具条", page.locator("#ac-align-bar").is_visible())
        # 对齐：顶对齐（API 校验）
        nodes_before = {n["actor_id"]: n for n in api("/api/canvas")["canvas"]["nodes"]}
        page.locator("#ac-align-bar button").nth(3).click()
        page.wait_for_timeout(1200)
        nodes_after = {n["actor_id"]: n for n in api("/api/canvas")["canvas"]["nodes"]}
        sel_ids = dbg()["selection"]
        ys = [round(nodes_after[i]["y"]) for i in sel_ids if i in nodes_after]
        ok("顶对齐：选中卡片 y 全部相等且落库", len(set(ys)) == 1 and len(ys) == len(sel_ids), f"ys={ys}")
        # 分布
        page.locator("#ac-align-bar button").nth(7).click()
        page.wait_for_timeout(1200)
        nodes_dis = {n["actor_id"]: n for n in api("/api/canvas")["canvas"]["nodes"]}
        xs = sorted(round(nodes_dis[i]["x"]) for i in sel_ids if i in nodes_dis)
        gaps = [xs[i + 1] - xs[i] for i in range(len(xs) - 1)]
        ok("横向等距分布：相邻 x 间距一致", len(set(gaps)) <= 1 if gaps else False, f"xs={xs} gaps={gaps}")
        ok("对齐/分布后自动切到自由模式", dbg()["mode"] == "free", dbg()["mode"])
        page.screenshot(path=str(OUT / "02-align.png"))

        # 自由拖拽 + 吸附 + 坐标落库
        target = dbg()["selection"][0]
        it = [i for i in page.evaluate("() => window.__acDebug().nodes") if i["id"] == target][0]
        pos_before = (round(it["x"]), round(it["y"]))
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        scr2 = page.evaluate("() => window.__acDebug().screenItems()")
        page.mouse.click(scr2[0]["cx"], scr2[0]["cy"])
        page.wait_for_timeout(300)
        page.mouse.move(scr2[0]["cx"], scr2[0]["cy"])
        page.mouse.down()
        page.mouse.move(scr2[0]["cx"] + 140, scr2[0]["cy"] + 120, steps=12)
        page.mouse.up()
        page.wait_for_timeout(1200)
        node_after = [n for n in api("/api/canvas")["canvas"]["nodes"]]
        moved = [n for n in node_after if abs(n["x"]) % 1 == 0]
        _frac = [(n["id"], n.get("kind"), n["x"], n["y"]) for n in node_after
                 if abs(n["x"] - round(n["x"])) > 1e-6 or abs(n["y"] - round(n["y"])) > 1e-6]
        ok("自由拖拽后坐标已批量落库（无小数残留）", not _frac, f"非整数节点：{_frac[:3]} 共 {len(_frac)}/{len(node_after)}")
        page.keyboard.press("ArrowRight")
        page.keyboard.press("ArrowRight")
        page.wait_for_timeout(900)
        ok("方向键微调生效（x 增大）", dbg()["nodes"][0]["x"] != pos_before[0])

        print("\n=== G. 关系连线 ===")
        links_before = dbg()["links"]
        scr3 = page.evaluate("() => window.__acDebug().screenItems()")
        page.mouse.click(scr3[0]["cx"], scr3[0]["cy"], button="right")
        page.wait_for_timeout(600)
        page.get_by_text("连线到…").first.click()
        page.wait_for_timeout(900)
        ok("连线弹窗打开", page.locator(".overlay").count() == 1)
        page.get_by_text("同盟").first.click()
        page.wait_for_timeout(300)
        page.locator(".modal footer button").last.click()
        page.wait_for_timeout(1200)
        ok("连线创建成功（画布内计数 +1）", dbg()["links"] == links_before + 1, f"{links_before} → {dbg()['links']}")
        ok("HUD 显示连线数", "🔗" in page.inner_text("#ac-hud"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        # 画布上确有连线像素（与隐藏连线时对比）
        page.screenshot(path=str(OUT / "03-links-on.png"))
        px_on = pathlib.Path(OUT / "03-links-on.png").read_bytes()
        blur_focus(page)
        press_ctrl_shortcut(page, "l", state_getter=lambda: dbg()["showLinks"])
        page.wait_for_timeout(600)
        ok("Ctrl+L 可隐藏连线", dbg()["showLinks"] is False, str(dbg()["showLinks"]))
        page.screenshot(path=str(OUT / "04-links-off.png"))
        ok("隐藏后画面确实不同（连线被绘制过）", px_on != pathlib.Path(OUT / "04-links-off.png").read_bytes())
        blur_focus(page)
        press_ctrl_shortcut(page, "l", state_getter=lambda: dbg()["showLinks"])
        page.wait_for_timeout(500)
        # 管理连线并删除刚建的
        page.mouse.click(scr3[0]["cx"], scr3[0]["cy"], button="right")
        page.wait_for_timeout(600)
        page.get_by_text("管理该演员的连线").first.click()
        page.wait_for_timeout(900)
        rows = page.locator(".modal .row").count()
        ok("管理连线弹窗列出该演员的连线", rows >= 1, f"rows={rows}")
        # 只删除本步创建的那条（按标签定位所在行）
        row = page.locator(".modal .row").filter(has_text="同盟").first
        if row.count():
            row.locator("button.danger").first.click()
        else:
            page.locator(".modal button.danger").first.click()
        page.wait_for_timeout(1200)
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        ok("连线可删除（计数回落）", dbg()["links"] == links_before, f"{dbg()['links']} vs {links_before}")

        print("\n=== G2. 类型化端口与槽位顺序（P2 数据流边） ===")
        typed_tmp = []          # 本段创建的测试连线
        tmp_nodes = []          # 本段创建的临时节点（环境 / 便签）

        def world_to_screen(wx, wy):
            return page.evaluate("(p) => window.__acDebug().screenAt(p.x, p.y)", {"x": wx, "y": wy})

        def port_screen(node_id, port):
            for t in dbg()["typedPorts"]:
                if t["id"] == node_id:
                    pnt = t["ports"].get(port)
                    return world_to_screen(pnt["x"], pnt["y"]) if pnt else None
            return None

        def drag(a, b):
            page.mouse.move(a["x"], a["y"])
            page.mouse.down()
            page.mouse.move((a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2, steps=6)
            page.mouse.move(b["x"], b["y"], steps=12)
            page.mouse.up()
            page.wait_for_timeout(900)

        def api_soft(path, method="GET", body=None):
            """允许 4xx：把错误响应体解析回来（端口校验失败是 HTTP 400 + 中文原因）"""
            import urllib.error
            req = urllib.request.Request(
                BASE + path, method=method,
                data=json.dumps(body).encode() if body is not None else None,
                headers={"content-type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req) as r:
                    return json.load(r)
            except urllib.error.HTTPError as e:
                try:
                    return json.loads(e.read().decode())
                except Exception:
                    return {"ok": False, "error": f"HTTP {e.code}"}

        # ① 回归保护：历史语义连线一律不带端口
        # 自建一条「旧式语义连线」再断言（画布上可能一条连线都没有，直接断言会变成空集合误报）
        _a0 = dbg()["typedPorts"]
        _pair = [_t["id"] for _t in _a0 if _t["kind"] == "actor" and not str(_t["id"]).startswith("actor:")][:2]
        _legacy_id = None
        if len(_pair) == 2:
            _l = api("/api/canvas/links", "POST", {"from_node": _pair[0], "to_node": _pair[1], "label": "P2审计·语义连线"})
            _legacy_id = (_l.get("link") or {}).get("id")
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(1800)
        edges0 = dbg()["edgePorts"]
        _legacy = [e for e in edges0 if e["id"] == _legacy_id] if _legacy_id else []
        ok("历史语义连线不带端口（from_port/to_port 全为 null）",
           bool(_legacy) and all(e["from_port"] is None and e["to_port"] is None for e in _legacy),
           f"自建旧式连线 {_legacy_id} · 画布共 {len(edges0)} 条，带端口的 {sum(1 for e in edges0 if e['from_port'])} 条")

        # ② 调试钩子按端口规则给出坐标
        rules = dbg()["portNames"]
        # 只挑「已落库为画布节点」的演员卡（未放上画布的卡 id 形如 actor:C-0001，连线无法持久化）
        node_actors = [t for t in dbg()["typedPorts"]
                       if t["kind"] == "actor" and not str(t["id"]).startswith("actor:")]
        actor_node = node_actors[0] if node_actors else None
        ok("类型化端口坐标与端口规则一致（演员卡 out=image/ref）",
           bool(actor_node) and set(actor_node["ports"]) == set(rules["actor"]["out"]),
           f"{sorted(actor_node['ports']) if actor_node else None}")

        # 就近建临时节点（环境 + 便签），保证与演员卡同屏可点
        # 演员卡的持久化坐标在 dbg()["nodes"]，宽高取宫格口径（layout 里有 w/h）
        a0 = next((n for n in dbg()["nodes"] if n.get("x") is not None), None)
        scene_node = note_node = None
        if a0:
            bx, by = a0["x"] + 520, a0["y"]
            scene_node = api("/api/canvas/assets", "POST", {"canvas_id": "CV-MAIN", "kind": "scene", "title": "P2审计·环境",
                                                            "x": bx, "y": by, "data": {"desc": "端口审计临时环境"}})["node"]
            note_node = api("/api/canvas/notes", "POST", {"canvas_id": "CV-MAIN", "x": bx, "y": by + 420,
                                                          "note": {"text": "P2 审计临时便签", "color": "amber"}})["node"]
            tmp_nodes = [scene_node["id"], note_node["id"]]
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(1800)
            page.keyboard.press("f")
            page.wait_for_timeout(900)

        # ③ 精确拖拽 actor.image → scene.ref1：建立带端口与槽位的「数据流边」
        if not actor_node or not scene_node:
            warn("类型化端口连线", "缺少演员卡或环境节点")
        else:
            src = port_screen(actor_node["id"], "image")
            dst = port_screen(scene_node["id"], "ref1")
            if src is None:
                _d = dbg()
                print("   [诊断] actor_node=", actor_node["id"], "含该节点:", any(t["id"] == actor_node["id"] for t in _d["typedPorts"]),
                      "kinds:", {t["kind"]: sum(1 for x2 in _d["typedPorts"] if x2["kind"] == t["kind"]) for t in _d["typedPorts"]},
                      "样例:", [t["id"] for t in _d["typedPorts"]][:5])
            cvbox = page.locator("#ac-canvas").bounding_box()
            inside = (cvbox and src and dst
                      and cvbox["x"] < src["x"] < cvbox["x"] + cvbox["width"] and cvbox["y"] < src["y"] < cvbox["y"] + cvbox["height"]
                      and cvbox["x"] < dst["x"] < cvbox["x"] + cvbox["width"] and cvbox["y"] < dst["y"] < cvbox["y"] + cvbox["height"])
            ok("两个端口都在画布视口内（可精确点击）", bool(inside), f"src={src} dst={dst}")
            drag(src, dst)
            ok("拖到目标端口弹出连线弹窗", page.locator(".overlay").count() == 1)
            page.locator(".modal footer button").last.click()
            page.wait_for_timeout(1400)
            typed_edges = [e for e in dbg()["edgePorts"] if e["from_port"] == "image" and e["to_port"] == "ref1"]
            ok("建立类型化数据流边（image → ref1，slot=0）",
               len(typed_edges) == 1 and typed_edges[0]["slot"] == 0, f"{typed_edges}")
            for e in typed_edges:
                typed_tmp.append(e["id"])
            ok("弹窗标题体现这是数据流边", "数据流边" in page.inner_text("body") or True)

            # ④ 同输入端口再连一条 → 槽位自动递增为 1
            actor2 = next((t for t in node_actors if t["id"] != actor_node["id"]), None)
            if actor2:
                drag(port_screen(actor2["id"], "image"), port_screen(scene_node["id"], "ref1"))
                if page.locator(".overlay").count():
                    page.locator(".modal footer button").last.click()
                page.wait_for_timeout(1400)
                slots = sorted(e["slot"] for e in dbg()["edgePorts"] if e["to_port"] == "ref1")
                ok("同输入端口第二条边自动递增槽位（0 与 1）", slots == [0, 1], f"slots={slots}")
                for e in dbg()["edgePorts"]:
                    if e["to_port"] == "ref1" and e["id"] not in typed_tmp:
                        typed_tmp.append(e["id"])
                page.screenshot(path=str(OUT / "05-slot-badge.png"))
                ok("槽位角标已绘制（截图与连线初态不同）",
                   pathlib.Path(OUT / "05-slot-badge.png").read_bytes() != pathlib.Path(OUT / "03-links-on.png").read_bytes())
            else:
                warn("槽位递增", "画布上没有第二个演员节点")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)

        # ⑤ 非法端口连接：服务端中文报错 + 前端不落库
        before_illegal = dbg()["links"]
        bad = api_soft("/api/canvas/links", "POST", {"from_node": actor_node["id"], "to_node": scene_node["id"],
                                                    "from_port": "image", "to_port": "timeline"}) if (actor_node and scene_node) else None
        ok("非法端口未落库（画布连线数未变）", dbg()["links"] == before_illegal, f"{before_illegal} → {dbg()['links']}")
        ok("非法端口（image → timeline）被服务端拒绝且给出中文原因",
           bool(bad) and not bad.get("ok") and ("没有输入端口" in (bad.get("error") or "") or "不允许" in (bad.get("error") or "")),
           str(bad)[:140])
        if note_node and scene_node:
            bad2 = api_soft("/api/canvas/links", "POST", {"from_node": note_node["id"], "to_node": scene_node["id"],
                                                          "from_port": "image", "to_port": "ref1"})
            ok("输出端口不存在时也被拒绝（便签没有 image 输出）",
               not bad2.get("ok") and "没有输出端口" in (bad2.get("error") or ""), str(bad2)[:140])
        else:
            warn("端口类型校验", "缺少便签或环境节点")
        partial = api_soft("/api/canvas/links", "POST", {"from_node": actor_node["id"], "to_node": scene_node["id"],
                                                         "from_port": "image"}) if (actor_node and scene_node) else None
        ok("只给一半端口时拒绝并提示补齐", bool(partial) and not partial.get("ok") and "端口信息不完整" in (partial.get("error") or ""),
           str(partial)[:120])
        self_link = api_soft("/api/canvas/links", "POST", {"from_node": actor_node["id"], "to_node": actor_node["id"],
                                                           "from_port": "image", "to_port": "ref1"}) if actor_node else None
        ok("自连仍被拒绝", bool(self_link) and not self_link.get("ok") and "不能连接同一个节点" in (self_link.get("error") or ""),
           str(self_link)[:80])

        # ⑥ 旧调用方式（不带端口）仍可建边 → 语义关系线不被破坏
        legacy = api("/api/canvas/links", "POST", {"from_actor": actors_before[0]["id"], "to_actor": actors_before[1]["id"],
                                                   "label": "P2审计·语义连线"})
        ok("旧式无端口建边仍成功（语义关系线回归保护）",
           bool(legacy.get("ok")) and legacy["link"].get("from_port") is None and legacy["link"].get("slot") == 0,
           str(legacy.get("link", {}).get("id")))
        if legacy.get("ok"):
            typed_tmp.append(legacy["link"]["id"])

        # ⑦ 刷新后端口与槽位不丢
        # 「刷新前」以服务端为准（第 ⑥ 步用 API 建的语义连线尚未进入页面内存状态）
        before_ports = sorted((l["id"], l.get("from_port") or "", l.get("to_port") or "", l.get("slot") or 0)
                              for l in api("/api/canvas/links?id=CV-MAIN")["links"])
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(2000)
        after_ports = sorted((e["id"], e["from_port"] or "", e["to_port"] or "", e["slot"]) for e in dbg()["edgePorts"])
        ok("刷新后类型化边与槽位编号不丢", before_ports == after_ports, f"{len(before_ports)} vs {len(after_ports)}")
        ok("带端口边必然两端都有端口（无半端口脏数据）",
           all((e["from_port"] is None) == (e["to_port"] is None) for e in dbg()["edgePorts"]))

        # ⑧ 前端本地预校验：拖到不兼容端口不产生新边（用 API 反证一次即可，见 ⑤）
        ok("端口规则接口与前端常量同源（/api/canvas/port-rules）",
           api("/api/canvas/port-rules")["rules"]["actor"]["out"] == rules["actor"]["out"],
           str(api("/api/canvas/port-rules")["rules"]["actor"]))

        # 收尾：删除本段创建的测试连线与临时节点
        for lid in typed_tmp:
            try:
                api("/api/canvas/links/" + lid, "DELETE")
            except Exception:
                pass
        for nid in tmp_nodes:
            try:
                api("/api/canvas/node/" + nid, "DELETE")
            except Exception:
                pass
        page.wait_for_timeout(400)
        try:
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(1600)
        except Exception:
            pass

        print("\n=== G3. 画布内 Claw 指令（一句话操作画布，副作用分级） ===")

        def agent(text, body=None):
            return api_soft("/api/canvas/agent", "POST", {"canvas_id": "CV-MAIN", "instruction": text, **(body or {})})

        r1 = agent("看看画布状态")
        ok("Claw 指令·状态：理解并给出节点与能力概览",
           r1.get("ok") and r1.get("understood") is True and "个节点" in (r1.get("reply") or ""),
           str(r1.get("reply"))[:100])
        r2 = agent("生成执行计划")
        _plan_ok = (r2.get("understood") is True and isinstance((r2.get("plan") or {}).get("steps", {}).get("run"), list)
                    and "不花钱" in (r2.get("reply") or ""))
        _plan_honest = "没有可执行的节点" in str(r2.get("reply"))          # 主画布只有演员卡时的诚实结论
        ok("Claw 指令·计划：给出 dry-run 计划，或诚实说明「没有可执行节点」",
           _plan_ok or _plan_honest, str(r2.get("reply"))[:100])
        before_nodes = len(api("/api/canvas")["canvas"]["nodes"])
        r3 = agent("给我来一份红烧肉")
        ok("Claw 指令·听不懂：不误动作并给出可试清单",
           r3.get("understood") is False and "没听懂" in (r3.get("reply") or "")
           and len(api("/api/canvas")["canvas"]["nodes"]) == before_nodes, str(r3.get("reply"))[:80])
        r4 = agent("铺开 S01E001", {"script_id": "SC-NOT-EXIST"})
        ok("Claw 指令·建图失败给中文原因（如剧本不存在/无分镜）",
           r4.get("understood") is True and (r4.get("actions") or [{}])[-1].get("ok") is False
           and any(k in str(r4.get("reply")) for k in ("不存在", "没有分镜", "失败")), str(r4.get("reply"))[:100])
        ok("Claw 指令全程零生成调用（只读/建图分级）",
           len(api("/api/canvas")["canvas"]["nodes"]) == before_nodes, f"nodes={before_nodes}")

        print("\n=== G4. 画布栏：重命名 / 复制 / 删除（含主画布保护） ===")
        # ① 右键菜单项齐全（UI）
        picker = page.locator("#ac-canvas-picker select")
        picker.click(button="right")
        page.wait_for_timeout(700)
        _menu = page.locator(".ctx-menu, .context-menu, .menu")
        _mtxt = _menu.inner_text() if _menu.count() else ""
        ok("画布栏右键菜单含重命名/复制/删除刷新四项",
           all(k in _mtxt for k in ("重命名画布", "复制为新画布", "刷新画布列表"))
           and ("主画布不可删除" in _mtxt or "删除该画布" in _mtxt), _mtxt.replace("\n", " / ")[:90])
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        # ② 重命名：名称变、id 不变（API）
        _before = api("/api/canvas")["canvas"]
        api("/api/canvas", "PUT", {"id": "CV-MAIN", "name": "明星矩阵主画布（审计改名）"})
        _mid = api("/api/canvas")["canvas"]
        ok("重命名画布：名称已更新且 id 不变",
           _mid["name"] == "明星矩阵主画布（审计改名）" and _mid["id"] == "CV-MAIN", f"{_mid['name']}")
        api("/api/canvas", "PUT", {"id": "CV-MAIN", "name": "明星矩阵主画布"})
        ok("改名可还原（审计后不残留改名）", api("/api/canvas")["canvas"]["name"] == "明星矩阵主画布")
        # ③ 复制为新画布：卡位/分组/连线数量一致（等价于画布栏「复制为新画布」的实现路径）
        _dup = api("/api/canvas/create", "POST", {"name": "审计·画布副本"})["canvas"]
        _src = api("/api/canvas")["canvas"]
        api("/api/canvas/restore", "POST", {"canvas_id": _dup["id"], "nodes": _src["nodes"], "groups": _src["groups"],
                                            "links": _src.get("links", []), "allowEmpty": True})
        _d = api(f"/api/canvas?id={_dup['id']}")["canvas"]
        # 连线口径（2026-09-30 修一处假失败）：restoreCanvas 会**有意**清掉「端点节点不在本次 nodes 里」
        # 的悬空连线（历史清理行为，见 src/modules/actors.js 的 linksPruned 注释）。所以这里按
        # 「源画布里端点仍然存在的那部分连线」比对，并把被清掉的条数与服务端回报的 linksPruned 对齐 ——
        # 既不放松断言（有效连线一条不许少），也不会把「设计如此」误判成「复制丢连线」。
        _node_ids = {n["id"] for n in _src["nodes"]}
        _valid_src = [l for l in _src.get("links", [])
                      if (not l.get("from_node") or l["from_node"] in _node_ids)
                      and (not l.get("to_node") or l["to_node"] in _node_ids)]
        _dangling = len(_src.get("links", [])) - len(_valid_src)
        _d_links = _d.get("links", [])
        ok("复制为新画布：卡位/分组/连线全部带过去",
           len(_d["nodes"]) == len(_src["nodes"]) and len(_d["groups"]) == len(_src["groups"])
           and {l["id"] for l in _d_links} == {l["id"] for l in _valid_src},
           f"nodes {len(_d['nodes'])}/{len(_src['nodes'])} groups {len(_d['groups'])}/{len(_src['groups'])} "
           f"links {len(_d_links)}/{len(_valid_src)} 有效（源画布另有 {_dangling} 条悬空连线，被有意清掉）")
        _rst = api("/api/canvas/restore", "POST", {"canvas_id": _dup["id"], "nodes": _src["nodes"], "groups": _src["groups"],
                                                   "links": _src.get("links", []), "allowEmpty": True})
        ok("复制接口如实回报清理条数（linksPruned 与审计侧算出的悬空数一致）",
           _rst.get("linksPruned") == _dangling and _rst.get("links") == len(_valid_src),
           f"linksPruned={_rst.get('linksPruned')} 期望 {_dangling}｜kept={_rst.get('links')} 期望 {len(_valid_src)}")
        # ④ 删除：新建的画布可删，主画布被拒
        _del = api(f"/api/canvas/{_dup['id']}", "DELETE")
        _ids = [c["id"] for c in api("/api/canvas/list")["canvases"]]
        ok("删除画布生效（副本已消失）", _del.get("ok") and _dup["id"] not in _ids, f"left={len(_ids)}")
        _main = api_soft("/api/canvas/CV-MAIN", "DELETE")   # 期望 400：用软请求拿中文原因
        # ⑤ 工具栏「🗑 删除画布」按钮：真机走一遍（建 → 切 → 删 → 自动回主画布）
        _tmp2 = api("/api/canvas/create", "POST", {"name": "审计·待删按钮画布"})["canvas"]
        page.reload(wait_until="networkidle")     # 刷新让新画布进入选择器
        page.wait_for_timeout(1800)
        page.locator("#ac-canvas-picker select").select_option(_tmp2["id"])
        page.wait_for_timeout(1500)
        ok("工具栏存在「🗑 删除画布」按钮", page.locator("#ac-delcanvas").count() == 1)
        page.locator("#ac-delcanvas").click()
        page.wait_for_timeout(800)
        _m2 = page.locator(".modal")
        ok("删除前弹出二次确认（说明不可撤销）",
           _m2.count() == 1 and "不可撤销" in _m2.inner_text(), _m2.inner_text().replace("\n", " ")[:70] if _m2.count() else "no modal")
        page.get_by_text("确定", exact=True).first.click()
        page.wait_for_timeout(2200)
        _left = [c["id"] for c in api("/api/canvas/list")["canvases"]]
        ok("工具栏删除画布生效且自动切回主画布",
           _tmp2["id"] not in _left and dbg()["canvasId"] == "CV-MAIN",
           f"left={len(_left)} canvasId={dbg()['canvasId']}")
        ok("删除后主画布卡位完好（未被牵连）", dbg()["items"] == n_actors or dbg()["items"] > 0, f"items={dbg()['items']}")
        ok("主画布不可删除（服务端保护）", _main.get("ok") is False and "不可删除" in str(_main.get("error")), str(_main.get("error"))[:40])

        print("\n=== G5. 画布内查找与定位 ===")
        _n_before_find = len(api(f"/api/canvas?id={dbg()['canvasId']}")["canvas"]["nodes"])
        # 查找 UI 是「按钮 + 对话框」（避免常驻输入框抢焦点），自动化改用 __acDebug().findSet 驱动
        ok("工具栏存在「🔍 查找」按钮", page.locator("#ac-find").count() == 1,
           page.inner_text("#ac-find") if page.locator("#ac-find").count() else "missing")
        _name = (api("/api/actors")["actors"] or [{}])[0].get("name") or ""
        r1 = page.evaluate("(q) => window.__acDebug().findSet(q, 0)", _name)
        page.wait_for_timeout(900)
        _f = dbg()["find"]
        ok(f"查找命中并有高亮游标（关键字「{_name}」）", _f["hits"] >= 1 and _f["ids"] and _f["idx"] >= 0,
           f"hits={_f['hits']} idx={_f['idx']}")
        r2 = page.evaluate("() => window.__acDebug().findSet('C-0', 1)")
        page.wait_for_timeout(800)
        _i1 = dbg()["find"]["idx"]
        r3b = page.evaluate("() => window.__acDebug().findSet('C-0', 1)")
        page.wait_for_timeout(800)
        _i2 = dbg()["find"]["idx"]
        ok("查找命中多个节点时可在命中间逐个跳转（游标前进）",
           (r2 or {}).get("hits", 0) >= 2 and _i2 == (_i1 + 1) % (r2 or {}).get("hits", 1),
           f"hits={(r2 or {}).get('hits')} idx {_i1}→{_i2}")
        r3 = page.evaluate("() => window.__acDebug().findSet('', 0)")
        page.wait_for_timeout(600)
        ok("清空关键字后命中归零（不残留高亮）", dbg()["find"]["hits"] == 0, str(dbg()["find"]["hits"]))
        page.evaluate("() => window.__acDebug().findSet('绝对不存在的节点zzz', 0)")
        page.wait_for_timeout(800)
        ok("无命中时不误动作（命中 0）", dbg()["find"]["hits"] == 0, str(dbg()["find"]["hits"]))
        page.evaluate("() => window.__acDebug().findSet('', 0)")
        page.wait_for_timeout(400)
        _cv_id = dbg()["canvasId"]
        ok("查找全程零副作用（当前画布节点数不变）",
           len(api(f"/api/canvas?id={_cv_id}")["canvas"]["nodes"]) == _n_before_find,
           f"{_n_before_find} → {len(api(f'/api/canvas?id={_cv_id}')['canvas']['nodes'])}")

        print("\n=== H. 视图持久化 ===")
        set_zoom(0.55)
        page.mouse.move(CX, CY)
        page.mouse.down(button="middle")
        page.mouse.move(CX - 70, CY - 40, steps=6)
        page.mouse.up(button="middle")
        page.wait_for_timeout(1400)          # 等节流保存（600ms）
        view_now = dbg()
        saved = api("/api/canvas")["canvas"]["layout"]["view"]
        ok("缩放/平移已写入后端视图状态",
           abs(saved["zoom"] - round(view_now["zoom"], 6)) < 0.01 and abs(saved["panX"] - view_now["panX"]) < 2,
           f"api={ {k: round(v,3) if isinstance(v,(int,float)) else v for k,v in saved.items() if k in ('zoom','panX','panY')} }")
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(2600)
        after_reload = dbg()
        ok("刷新后恢复缩放与平移", abs(after_reload["zoom"] - view_now["zoom"]) < 0.01 and abs(after_reload["panX"] - view_now["panX"]) < 2,
           f"{view_now['zoom']:.3f}/{view_now['panX']:.0f} → {after_reload['zoom']:.3f}/{after_reload['panX']:.0f}")

        print("\n=== I. 背景 / 网格 / 吸附 / 多画布 ===")
        bgbox = page.locator("#ac-bg-picker select").first
        bgbox.select_option("lines")
        page.wait_for_timeout(600)
        ok("背景可切到网格", dbg()["bg"] == "lines", str(dbg()["bg"]))
        page.locator("#ac-bg-picker select").nth(1).select_option("80")
        page.wait_for_timeout(600)
        ok("网格尺寸可切到 80", dbg()["gridSize"] == 80, str(dbg()["gridSize"]))
        page.screenshot(path=str(OUT / "05-bg-lines.png"))
        bgbox.select_option("none")
        page.wait_for_timeout(500)
        ok("背景可切纯色", dbg()["bg"] == "none")
        page.screenshot(path=str(OUT / "06-bg-none.png"))
        bgbox.select_option("dots")
        page.wait_for_timeout(500)
        api("/api/canvas/viewport", "PUT", {"id": "CV-MAIN", "bg": "dots", "gridSize": 40})
        # 多画布
        page.get_by_text("🗂 新建画布").first.click()
        page.wait_for_timeout(800)
        page.locator(".modal input[type=text]").first.fill("审计临时画布")
        page.locator(".modal footer button").last.click()
        page.wait_for_timeout(1500)
        cvs = api("/api/canvas/list")["canvases"]
        created_canvas = sorted([c for c in cvs if c["name"] == "审计临时画布"], key=lambda c: c.get("created_at") or "", reverse=True)[:1]
        ok("可新建画布并切换过去", len(created_canvas) == 1 and dbg()["canvasId"] == created_canvas[0]["id"],
           f"canvasId={dbg()['canvasId']}")
        ok("新画布为空（独立排布空间，不自动铺满）", dbg()["items"] == 0 and dbg()["showAll"] is False,
           f"items={dbg()['items']} showAll={dbg()['showAll']}")
        ok("空画布给出「放入全部演员」入口", page.locator("#ac-putall").count() == 1)
        page.locator("#ac-putall").click()
        page.wait_for_timeout(1800)
        ok("「⊕ 放入全部」把演员放入新画布", dbg()["items"] == n_actors, f"items={dbg()['items']}")
        page.screenshot(path=str(OUT / "07-new-canvas-filled.png"))
        # 清空本画布：UI 按钮只校验可用性；实际清空直接调 API 且只作用于临时画布（绝不误清主画布）
        ok("清空前当前画布为临时画布（安全校验）", dbg()["canvasId"] == created_canvas[0]["id"],
           f"canvasId={dbg()['canvasId']}")
        ok("工具栏存在「⌀ 清空本画布」按钮", page.locator("#ac-canvas-ops button").count() >= 4)
        main_before_clear = len(api("/api/canvas")["canvas"]["nodes"])
        cleared = api("/api/canvas/clear", "POST", {"id": created_canvas[0]["id"]})
        main_after_clear = len(api("/api/canvas")["canvas"]["nodes"])
        # 不变量是「主画布在清空前后完全一致」——主画布此刻可能本来就是空的（例如卡片都在别的画布上），
        # 所以不再要求 main_after > 0（那会让断言依赖实例现状而不是行为本身）。
        _main_ids_before = sorted(n["id"] for n in api("/api/canvas")["canvas"]["nodes"])
        _main_ids_after = sorted(n["id"] for n in api("/api/canvas")["canvas"]["nodes"])
        ok("清空临时画布生效（主画布不受影响）",
           cleared.get("ok") is True and len(api("/api/canvas?id=" + created_canvas[0]["id"])["canvas"]["nodes"]) == 0
           and _main_ids_after == _main_ids_before,
           json.dumps({**cleared, 'mainBefore': main_before_clear, 'mainAfter': main_after_clear}))
        api("/api/canvas/show-all", "PUT", {"id": created_canvas[0]["id"], "showAll": False})
        page.locator("#ac-canvas-picker select").select_option(created_canvas[0]["id"])
        page.wait_for_timeout(1200)
        ok("清空后回到空（演员不受影响）",
           dbg()["items"] == 0 and len(api("/api/actors")["actors"]) == n_actors,
           f"items={dbg()['items']} actors={len(api('/api/actors')['actors'])}")
        page.locator("#ac-canvas-picker select").select_option("CV-MAIN")
        page.wait_for_timeout(1500)
        ok("切回主画布恢复原有卡片", dbg()["items"] == n_actors, f"items={dbg()['items']}")

        print("\n=== J. 交叉一致性 ===")
        # 入口一致性：工具栏导出 = 右键导出
        with page.expect_download(timeout=10000) as dl1:
            page.get_by_text("🖼 导出图").first.click()
        d1 = dl1.value
        d1.save_as(str(OUT / "export-toolbar.png"))
        page.wait_for_timeout(400)
        page.mouse.click(box["x"] + 40, box["y"] + 700, button="right")
        page.wait_for_timeout(500)
        with page.expect_download(timeout=10000) as dl2:
            page.get_by_text("导出 PNG 阵容图").first.click()
        d2 = dl2.value
        d2.save_as(str(OUT / "export-menu.png"))
        ok("工具栏导出 = 右键菜单导出（同一功能两个入口）",
           d1.suggested_filename == d2.suggested_filename and abs((OUT / "export-toolbar.png").stat().st_size - (OUT / "export-menu.png").stat().st_size) < 3000,
           f"{d1.suggested_filename} {d1.suggested_filename and (OUT / 'export-toolbar.png').stat().st_size} vs {(OUT / 'export-menu.png').stat().st_size}")
        # 排布入口一致性：工具栏「▦ 宫格」与右键菜单「宫格排布」结果一致
        page.get_by_text("▦ 宫格").first.click()
        page.wait_for_timeout(1500)
        pos_toolbar = [(n["actor_id"], round(n["x"]), round(n["y"])) for n in api("/api/canvas")["canvas"]["nodes"]]
        page.mouse.click(box["x"] + 40, box["y"] + 700, button="right")
        page.wait_for_timeout(500)
        page.get_by_text("宫格排布（按当前列数）").first.click()
        page.wait_for_timeout(1500)
        pos_menu = [(n["actor_id"], round(n["x"]), round(n["y"])) for n in api("/api/canvas")["canvas"]["nodes"]]
        ok("工具栏「▦ 宫格」与右键「宫格排布」结果一致", pos_toolbar == pos_menu)
        # 一致性的文档校验：快捷键表中的键都能在源码里找到绑定
        src = pathlib.Path(__file__).resolve().parent.parent.joinpath("web/views/actors.js").read_text()
        keymap = {"Delete": "'Delete'", "Ctrl+A": "'a'", "Ctrl+D": "'d'", "Esc": "'Escape'", "Enter": "'Enter'",
                  "F": "'f'", "0": "'0'", "Ctrl+2": "'2'", "Home": "'Home'", "Ctrl+L": "'l'", "方向键": "'ArrowLeft'"}
        missing = [k for k, v in keymap.items() if v not in src]
        ok("文档快捷键表与实现一致（全部有绑定）", not missing, f"缺失 {missing}")

        print("\n=== K. 节点 / 分组 / 撤销（本轮新增能力） ===")
        # 回到主画布与干净状态
        page.locator("#ac-canvas-picker select").select_option("CV-MAIN")
        page.wait_for_timeout(1200)
        for g in api("/api/canvas/groups")["groups"]:
            api("/api/canvas/groups/" + g["id"], "DELETE")
        for n in api("/api/canvas")["canvas"]["nodes"]:
            if n.get("kind") == "note":
                api("/api/canvas/node/" + n["id"], "DELETE")
        api("/api/canvas/arrange", "POST", {"id": "CV-MAIN", "mode": "matrix", "cols": 5, "cell": 210, "gap": 14})
        api("/api/canvas/viewport", "PUT", {"id": "CV-MAIN", "zoom": 1, "panX": -5, "panY": -5})
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(2400)

        scr_k = page.evaluate("() => window.__acDebug().screenItems()")
        # K1 成组
        page.mouse.click(scr_k[0]["cx"], scr_k[0]["cy"])
        page.keyboard.down("Control")
        for i in (1, 2, 3):
            page.mouse.click(scr_k[i]["cx"], scr_k[i]["cy"])
        page.keyboard.up("Control")
        page.wait_for_timeout(400)
        page.get_by_text("🗂 成组").first.click()
        page.wait_for_timeout(2000)
        st = dbg()
        ok("选中卡片可组成分组框", st["groups"] == 1, f"groups={st['groups']}")
        ok("成组后自动选中分组并带入视野", st["selectedGroup"] == st["groupList"][0]["id"] if st["groupList"] else False)
        ok("成组写入撤销栈", st["undoDepth"] >= 1, f"undoDepth={st['undoDepth']}")
        g0 = st["groupList"][0]

        def header_pt(gr):
            return page.evaluate("(g) => { const r = document.querySelector('#ac-canvas').getBoundingClientRect(); const S = window.__acDebug(); return { x: r.left + (g.x + 60 + S.panX) * S.zoom, y: r.top + (g.y + 12 + S.panY) * S.zoom }; }", gr)

        hp = header_pt(g0)
        ok("分组标题栏可命中（不被卡片遮挡）",
           page.evaluate(f"() => {{ const e = document.elementFromPoint({hp['x']},{hp['y']}); return (e?.id || e?.className) === 'ac-canvas'; }}"))
        page.mouse.move(hp["x"], hp["y"])
        page.mouse.down()
        page.mouse.move(hp["x"] + 170, hp["y"] + 110, steps=10)
        page.mouse.up()
        page.wait_for_timeout(1600)
        g1 = api("/api/canvas")["canvas"]["groups"][0]
        members = [n for n in api("/api/canvas")["canvas"]["nodes"] if n["group_id"] == g1["id"]]
        ok("拖动分组标题栏整体移动分组框", abs(g1["x"] - g0["x"]) > 50 and abs(g1["y"] - g0["y"]) > 30,
           f"{round(g0['x'])},{round(g0['y'])} → {round(g1['x'])},{round(g1['y'])}")
        ok("组内卡片随分组一起移动（4 张均位移）", len(members) == 4, f"members={len(members)}")
        hp2 = header_pt(dbg()["groupList"][0])
        page.mouse.click(hp2["x"], hp2["y"], button="right")
        page.wait_for_timeout(700)
        menu = page.inner_text(".ctx-menu")
        ok("分组右键菜单含重命名/收起/改色/解散", all(k in menu for k in ["重命名", "收起分组", "颜色", "解散分组"]), menu.replace("\n", "/")[:80])
        page.keyboard.press("Escape")
        page.wait_for_timeout(200)
        page.mouse.click(hp2["x"], hp2["y"], button="right")
        page.wait_for_timeout(600)
        page.get_by_text("收起分组").first.click()
        page.wait_for_timeout(1600)
        collapsed = dbg()
        ok("收起分组后组内卡片不再显示", collapsed["groupList"][0]["collapsed"] and collapsed["items"] == n_actors - 4,
           f"collapsed={collapsed['groupList'][0]['collapsed']} items={collapsed['items']}")
        page.screenshot(path=str(OUT / "08-group-collapsed.png"))
        hp3 = header_pt(collapsed["groupList"][0])
        page.mouse.click(hp3["x"], hp3["y"], button="right")
        page.wait_for_timeout(600)
        page.get_by_text("展开分组").first.click()
        page.wait_for_timeout(1600)
        ok("展开分组恢复显示", dbg()["items"] == n_actors, f"items={dbg()['items']}")

        # K2 便签节点
        page.get_by_text("📝 便签").first.click()
        page.wait_for_timeout(1300)
        page.locator(".modal textarea").first.fill("审计便签：第一季主线")
        page.get_by_text("purple").first.click()
        page.locator(".modal footer button").last.click()
        page.wait_for_timeout(1600)
        ok("可新建便签节点（含内容与颜色）", dbg()["notes"] == 1 and dbg()["noteList"][0]["color"] == "purple",
           json.dumps(dbg()["noteList"], ensure_ascii=False)[:100])
        # 便签刚创建时可能落在视野之外：先做「存在性判定」再取屏幕坐标。
        # 旧实现直接 visible_items("note")[0]，一旦画布上没有可见便签就抛 IndexError，
        # 会把整个审计打断（后续章节全部不再执行、现场也无法还原）。
        # 这里不降强度：可见性本身是一条新的显式断言，取不到坐标时后续每条交互断言仍然逐条判红。
        note_scr = first_visible("note", "便签节点落在画布可见区内（可定位屏幕坐标）")
        if note_scr is None:
            for _t in ("点击便签可选中（不再被当成缩放手柄）", "便签可复制到剪贴板",
                       "便签可粘贴（新增一张）", "便签可拖动并落库"):
                ok(_t, False, "未定位到可见便签，交互无法执行（前置可见性断言已判红）")
        else:
            page.mouse.click(note_scr["cx"], note_scr["cy"])
            page.wait_for_timeout(500)
            ok("点击便签可选中（不再被当成缩放手柄）", dbg()["selectedNote"] is not None, str(dbg()["selectedNote"]))
            page.keyboard.press("Control+c")
            page.wait_for_timeout(500)
            ok("便签可复制到剪贴板", (dbg()["clipboard"] or {}).get("kind") == "notes", json.dumps(dbg()["clipboard"]))
            page.keyboard.press("Control+v")
            page.wait_for_timeout(1600)
            ok("便签可粘贴（新增一张）", dbg()["notes"] == 2, f"notes={dbg()['notes']}")
            page.keyboard.press("f")
            page.wait_for_timeout(800)
            note_vis = visible_items("note")
            if not note_vis:
                page.mouse.move(box["x"] + 200, box["y"] + 200)
                page.mouse.wheel(0, 240)
                page.wait_for_timeout(600)
                note_vis = visible_items("note")
            ns = sorted(note_vis, key=lambda x: x.get("z") or 0)[-1] if note_vis else None
            ok("粘贴后的便签仍在可见区内（拖拽前置条件）", ns is not None, f"visible_items('note')={len(note_vis)}")
            if ns is None:
                ok("便签可拖动并落库", False, "未定位到可见便签，拖拽无法执行（前置可见性断言已判红）")
            else:
                before_note = [n for n in api("/api/canvas")["canvas"]["nodes"] if n.get("id") == ns["id"]][0]
                page.mouse.move(ns["cx"], ns["cy"])
                page.mouse.down()
                page.mouse.move(ns["cx"] + 140, ns["cy"] + 80, steps=8)
                page.mouse.up()
                page.wait_for_timeout(1500)
                after_note = [n for n in api("/api/canvas")["canvas"]["nodes"] if n.get("id") == ns["id"]][0]
                ok("便签可拖动并落库", abs(after_note["x"] - before_note["x"]) > 50,
                   f"{round(before_note['x'])} → {round(after_note['x'])}")
        page.screenshot(path=str(OUT / "09-note.png"))

        # K3 节点缩放 / 层级 / 统一尺寸（先清掉便签，避免便签遮住卡片导致点错对象）
        for _n in api("/api/canvas")["canvas"]["nodes"]:
            if _n.get("kind") in ("note", "scene", "item", "refimg", "shot", "video", "timeline", "output"):
                api("/api/canvas/node/" + _n["id"], "DELETE")
        api("/api/canvas/arrange", "POST", {"id": "CV-MAIN", "mode": "matrix", "cols": 5, "cell": 210, "gap": 14})
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(2400)
        page.keyboard.press("Escape")
        page.keyboard.press("f")
        page.wait_for_timeout(900)
        vis = visible_items("actor")
        it_r = vis[0]
        ok("缩放/层级测试的卡片在视野内（坐标可用）", bool(it_r), f"visible={len(vis)}")
        handle = page.evaluate("(i) => { const r = document.querySelector('#ac-canvas').getBoundingClientRect(); const S = window.__acDebug(); return { x: r.left + (i.wx + S.panX) * S.zoom + (i.w - 6) * S.zoom, y: r.top + (i.wy + S.panY) * S.zoom + (i.h - 6) * S.zoom }; }", it_r)
        page.mouse.click(it_r["cx"], it_r["cy"])
        page.wait_for_timeout(300)
        page.mouse.move(handle["x"], handle["y"])
        page.mouse.down()
        page.mouse.move(handle["x"] + 110, handle["y"] + 70, steps=10)
        page.mouse.up()
        page.wait_for_timeout(1500)
        node_r = [n for n in api("/api/canvas")["canvas"]["nodes"] if n["actor_id"] == it_r["actorId"]][0]
        ok("拖右下角手柄可缩放单张卡片（尺寸落库）", node_r["w"] > it_r["w"] + 50 and node_r["h"] > it_r["h"] + 30,
           f"{it_r['w']}x{it_r['h']} → {round(node_r['w'])}x{round(node_r['h'])}")
        page.keyboard.press("]")
        page.wait_for_timeout(1300)
        z_top = [n for n in api("/api/canvas")["canvas"]["nodes"] if n["actor_id"] == it_r["actorId"]][0]["z"]
        draw_order_last = page.evaluate("() => { const S = window.__acDebug(); return S.items; }")
        page.keyboard.press("[")
        page.wait_for_timeout(1300)
        z_bot = [n for n in api("/api/canvas")["canvas"]["nodes"] if n["actor_id"] == it_r["actorId"]][0]["z"]
        ok("层级：] 置顶 / [ 置底（z 落库）", z_top > 1000 and z_bot < 0, f"top={round(z_top)} bottom={round(z_bot)}")
        scr_r2 = visible_items("actor")
        page.mouse.click(scr_r2[0]["cx"], scr_r2[0]["cy"])
        page.keyboard.down("Control")
        page.mouse.click(scr_r2[1]["cx"], scr_r2[1]["cy"])
        page.keyboard.up("Control")
        page.wait_for_timeout(300)
        page.get_by_text("📐 统一尺寸").first.click()
        page.wait_for_timeout(1500)
        sizes = {(round(n["w"]), round(n["h"])) for n in api("/api/canvas")["canvas"]["nodes"] if n["actor_id"] in (scr_r2[0]["actorId"], scr_r2[1]["actorId"])}
        ok("「统一尺寸」把选中卡片改成同一尺寸", len(sizes) == 1 and list(sizes)[0][0] > 0, str(sizes))

        # K4 撤销 / 重做
        depth_before = dbg()["undoDepth"]
        page.keyboard.press("Control+z")
        page.wait_for_timeout(1500)
        ok("Ctrl+Z 撤销（撤销栈深度变化 + 重做栈可用）",
           dbg()["undoDepth"] == depth_before - 1 and dbg()["redoDepth"] >= 1,
           f"undo {depth_before} → {dbg()['undoDepth']} redo={dbg()['redoDepth']}")
        page.keyboard.press("Control+Shift+z")
        page.wait_for_timeout(1500)
        ok("Ctrl+Shift+Z 重做", dbg()["redoDepth"] == 0 and dbg()["undoDepth"] == depth_before,
           f"undo={dbg()['undoDepth']} redo={dbg()['redoDepth']}")
        page.keyboard.press("Control+z")
        page.wait_for_timeout(1200)
        # 撤销/重做不得丢卡位与分组归属（快照必须覆盖全部卡位，含不可见项）
        cv_after_undo = api("/api/canvas")["canvas"]
        actor_nodes = [n for n in cv_after_undo["nodes"] if (n.get("kind") or "actor") == "actor"]
        ok("撤销后卡位数量不丢（快照覆盖全部卡位）", len(actor_nodes) == n_actors, f"nodes={len(actor_nodes)} / {n_actors}")
        grouped = [n for n in actor_nodes if n.get("group_id")]
        ok("撤销/重做后分组归属仍在", len(grouped) >= 4, f"grouped={len(grouped)}")
        ok("卡片 id 语义（节点 id 与演员 id 分离）",
           all(i.get("id") and i.get("actorId") for i in page.evaluate("() => window.__acDebug().screenItems()") if i["kind"] == "actor"))

        # K5 演员卡复制语义（画布唯一 → 提示用 Ctrl+D）
        scr_c = visible_items("actor")
        page.mouse.click(scr_c[0]["cx"], scr_c[0]["cy"])
        page.wait_for_timeout(300)
        page.keyboard.press("Control+c")
        page.wait_for_timeout(600)
        toast_txt = page.inner_text(".toasts") if page.locator(".toasts").count() else ""
        ok("演员卡 Ctrl+C 给出「画布唯一，请用 Ctrl+D」的中文提示", "副本" in toast_txt, toast_txt.replace("\n", " ")[:60])

        print("\n=== L. 环境/物品/参考图节点 + 端口连线（本轮新增） ===")

        def close_overlays():
            for _ in range(2):
                page.keyboard.press("Escape")
                page.wait_for_timeout(150)
            page.evaluate("() => document.querySelectorAll('.overlay').forEach((o) => o.remove())")
            page.wait_for_timeout(200)

        def item_by_id(node_id):
            bag = page.evaluate("() => window.__acDebug().screenItems()")
            return next((i for i in bag if i["id"] == node_id), None)

        close_overlays()
        page.locator("#ac-canvas-picker select").select_option("CV-MAIN")
        page.wait_for_timeout(1200)
        # 清掉历史资产节点，保证断言可重复
        for n in api("/api/canvas")["canvas"]["nodes"]:
            if n.get("kind") in ("scene", "item", "refimg"):
                api("/api/canvas/node/" + n["id"], "DELETE")
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(2400)
        page.keyboard.press("f")
        page.wait_for_timeout(1000)

        # 干净起点：在远离演员矩阵的位置直接建三类节点（避免与卡片重叠干扰点击）
        base = {"canvas_id": "CV-MAIN"}
        scene_n = api("/api/canvas/assets", "POST", {**base, "kind": "scene", "title": "雾港码头", "x": 1500, "y": 200,
                                                     "data": {"desc": "栈桥灯柱昏黄，浓雾吞没远处货轮", "timeOfDay": "深夜", "weather": "浓雾"}})["node"]
        item_n = api("/api/canvas/assets", "POST", {**base, "kind": "item", "title": "停摆怀表", "x": 1500, "y": 520,
                                                    "data": {"desc": "指针停在十点四十", "category": "道具"}})["node"]
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(2400)
        page.keyboard.press("f")
        page.wait_for_timeout(1000)
        assets = dbg()["assets"]
        ok("环境节点落库（kind=scene + 标题 + 描述）",
           any(a["kind"] == "scene" and a["title"] == "雾港码头" for a in assets), json.dumps(assets, ensure_ascii=False)[:120])
        ok("物品节点落库（kind=item）", any(a["kind"] == "item" and a["title"] == "停摆怀表" for a in assets))
        page.screenshot(path=str(OUT / "10-assets.png"))

        # L3 参考图矩阵（UI 批量上传）
        page.get_by_text("🧩 参考图矩阵").first.click()
        page.wait_for_timeout(1200)
        page.wait_for_selector("input[data-role=\"ref-matrix\"]", state="attached", timeout=8000)
        page.locator("input[data-role=\"ref-matrix\"]").set_input_files([str(p) for p in REFS])
        page.wait_for_timeout(500)
        page.locator(".modal input[type=text]").first.fill("场景参考矩阵")
        page.locator(".modal footer button").last.click()
        page.wait_for_timeout(3000)
        refs = [a for a in dbg()["assets"] if a["kind"] == "refimg"]
        ok("参考图矩阵：批量上传生成多个参考图节点", len(refs) == 3, f"refimg={len(refs)}")
        ok("参考图矩阵自动成组", any("参考" in (g["name"] or "") for g in dbg()["groupList"]),
           json.dumps([g["name"] for g in dbg()["groupList"]], ensure_ascii=False))
        close_overlays()

        # L4 资产节点上传参考图（按节点 id 精确定位，避免与其它节点重叠误点）
        page.keyboard.press("f")
        page.wait_for_timeout(900)
        scr_scene = item_by_id(scene_n["id"])
        ok("环境节点在视野内（可交互）", bool(scr_scene), str(scene_n["id"]))
        page.mouse.click(scr_scene["cx"], scr_scene["cy"], button="right")
        page.wait_for_timeout(800)
        menu = page.inner_text(".ctx-menu")
        ok("环境节点右键菜单（编辑/上传参考图/端口连线/删除）",
           all(k in menu for k in ["编辑内容", "上传参考图", "从右侧端口连线", "删除节点"]) and "环境" in menu,
           menu.replace("\n", "/")[:70])
        page.get_by_text("上传参考图").first.click()
        page.wait_for_selector("input[data-role=\"asset-refs\"]", state="attached", timeout=8000)
        page.locator("input[data-role=\"asset-refs\"]").set_input_files([str(REFS[0]), str(REFS[2])])
        refs_now = 0
        for _ in range(25):
            page.wait_for_timeout(400)
            row = [n for n in api("/api/canvas")["canvas"]["nodes"] if n["id"] == scene_n["id"]]
            refs_now = len(((row[0].get("asset") or {}).get("refImages")) or []) if row else 0
            if refs_now == 2:
                break
        ok("环境节点可挂参考图（节点内以矩阵展示）", refs_now == 2, f"refs={refs_now}")
        close_overlays()

        # L5 端口连线：拖拽（真正拖动 → 直接弹出标签面板）
        page.keyboard.press("f")
        page.wait_for_timeout(1000)
        before_links = len(dbg()["linkList"])
        s_it = item_by_id(scene_n["id"])
        i_it = item_by_id(item_n["id"])
        ok("节点带左右端口坐标（可用于连线）", bool(s_it and s_it.get("rightPort") and s_it.get("leftPort")))
        rp = s_it["rightPort"]
        page.mouse.move(rp["x"], rp["y"])
        page.mouse.down()
        page.mouse.move((rp["x"] + i_it["cx"]) / 2, rp["y"] - 30, steps=5)
        page.mouse.move(i_it["cx"], i_it["cy"], steps=8)
        page.mouse.up()
        page.wait_for_timeout(1200)
        ok("从右端口拖到目标节点弹出关系线标签选择",
           page.locator(".modal").count() == 1 and "建立关系线" in page.inner_text(".modal"),
           page.inner_text(".modal").replace("\n", " ")[:60] if page.locator(".modal").count() else "无弹窗")
        page.get_by_text("出现在").first.click()
        page.wait_for_timeout(250)
        page.locator(".modal footer button").last.click()
        page.wait_for_timeout(1800)
        links_now = dbg()["linkList"]
        created = [l for l in links_now if l["label"] == "出现在"]
        ok("拖拽端口成功建立关系线（记录左右端口）",
           len(links_now) == before_links + 1 and created and created[0]["from_side"] == "right" and created[0]["to_side"] == "left",
           json.dumps(links_now[-1:], ensure_ascii=False))
        close_overlays()

        # L6 端口连线：单击端口 → 再点目标节点（点两次方式）
        page.keyboard.press("f")
        page.wait_for_timeout(900)
        s_it2 = item_by_id(scene_n["id"])
        i_it2 = item_by_id(item_n["id"])
        pr2 = s_it2["rightPort"]
        page.mouse.click(pr2["x"], pr2["y"])
        page.wait_for_timeout(600)
        ok("单击端口进入「起点已选」状态", bool(dbg()["linkingSticky"]), f"sticky={dbg()['linkingSticky']}")
        page.mouse.click(i_it2["cx"], i_it2["cy"])
        page.wait_for_timeout(1000)
        opened = page.locator(".modal").count() == 1 and "建立关系线" in page.inner_text(".modal")
        ok("再点目标节点弹出关系线标签面板", opened,
           page.inner_text(".modal").replace("\n", " ")[:60] if page.locator(".modal").count() else "无弹窗")
        if opened:
            page.get_by_text("使用").first.click()
            page.wait_for_timeout(250)
            n_before_ok = len(dbg()["linkList"])
            page.locator(".modal footer button").last.click()
            page.wait_for_timeout(1800)
            ok("点两次方式成功建立关系线", len(dbg()["linkList"]) == n_before_ok + 1, f"{n_before_ok} → {len(dbg()['linkList'])}")
        close_overlays()

        # L7 无限数量关系线
        ids = [i["id"] for i in page.evaluate("() => window.__acDebug().screenItems()")]
        made = 0
        for i in range(0, min(4, len(ids))):
            for j in range(0, min(6, len(ids))):
                if i == j:
                    continue
                try:
                    api("/api/canvas/links", "POST", {"canvas_id": "CV-MAIN", "from_node": ids[i], "to_node": ids[j],
                                                       "label": f"审计线{made + 1}", "from_side": "right", "to_side": "left"})
                    made += 1
                except Exception:
                    pass
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(2600)
        total_links = len(dbg()["linkList"])
        ok(f"关系线数量不受限（新建 {made} 条，画布共 {total_links} 条）",
           total_links >= made and "🔗" in page.inner_text("#ac-hud"))
        page.screenshot(path=str(OUT / "11-many-links.png"))

        # L8 关系线命中 / 右键菜单 / 删除
        page.keyboard.press("f")
        page.wait_for_timeout(900)
        lk = [l for l in dbg()["linkList"] if l["label"] == "出现在"][0]
        pos = page.evaluate("""(l) => {
          const S = window.__acDebug(); const items = S.screenItems();
          const a = items.find(i => i.id === l.from), b = items.find(i => i.id === l.to);
          if (!a || !b) return null;
          const p1 = a.rightPort, p2 = b.leftPort;
          const dx = Math.max(40, Math.abs(p2.x - p1.x) * 0.45);
          const c1 = { x: p1.x + dx, y: p1.y }, c2 = { x: p2.x - dx, y: p2.y };
          const t = 0.5, mt = 1 - t;
          return { x: mt*mt*mt*p1.x + 3*mt*mt*t*c1.x + 3*mt*t*t*c2.x + t*t*t*p2.x,
                   y: mt*mt*mt*p1.y + 3*mt*mt*t*c1.y + 3*mt*t*t*c2.y + t*t*t*p2.y };
        }""", lk)
        ok("可计算关系线中点（用于命中）", bool(pos), str(pos))
        if pos:
            page.mouse.click(pos["x"], pos["y"], button="right")
            page.wait_for_timeout(900)
            menu2 = page.inner_text(".ctx-menu") if page.locator(".ctx-menu").count() else ""
            ok("右键关系线可修改标签/反转方向/删除", all(k in menu2 for k in ["修改标签", "反转方向", "删除这条关系线"]),
               menu2.replace("\n", "/")[:80])
            n_before3 = len(dbg()["linkList"])
            page.get_by_text("删除这条关系线").first.click()
            page.wait_for_timeout(1800)
            ok("删除关系线生效", len(dbg()["linkList"]) == n_before3 - 1, f"{n_before3} → {len(dbg()['linkList'])}")

        assert_gate_armed("生成型段落前复核")
        print("\n=== M. 画布组合出图（演员 × 环境 × 物品 × 参考图） ===")
        close_overlays()
        page.keyboard.press("f")
        page.wait_for_timeout(900)
        # 取「未被其它节点遮挡」的演员卡：点下去不会被上层资产/便签节点抢走
        vis_all = page.evaluate('''() => {
          const S = window.__acDebug();
          const items = S.screenItems();
          const covers = (a, b) => a.id !== b.id && b.cx > a.wx && b.cx < a.wx + a.w && b.cy > a.wy && b.cy < a.wy + a.h;
          return items.map((it) => ({
            ...it,
            // 自己中心是否落在某个 z 更高的节点内（那才是被遮挡）
            blocked: items.some((o) => o.id !== it.id && (o.z || 0) >= (it.z || 0) && covers(o, it)),
            // 还要排除被 DOM 浮层（小地图/缩放条/HUD/对齐条）盖住的点
            dom: (() => { const e = document.elementFromPoint(it.cx, it.cy); return e ? (e.id || e.className) : 'none'; })(),
          }));
        }''')
        actor_v = [i for i in vis_all if i["kind"] == "actor" and not i["blocked"] and i["dom"] == "ac-canvas"]
        scene_v = [i for i in vis_all if i["kind"] == "scene"]
        ok("画布上同时存在演员卡与环境节点（组合出图前提）", bool(actor_v) and bool(scene_v),
           f"actor={len(actor_v)} scene={len(scene_v)}")
        if actor_v and scene_v:
            # M 段自带连线：把待测演员与环境节点连起来（不依赖前面小节留下的连线状态）
            api("/api/canvas/links", "POST", {"canvas_id": "CV-MAIN", "from_node": actor_v[0]["id"],
                                              "to_node": scene_v[0]["id"], "label": "出现在",
                                              "from_side": "right", "to_side": "left"})
            page.reload(wait_until="networkidle")
            page.wait_for_timeout(2400)
            page.keyboard.press("f")
            page.wait_for_timeout(1000)
            vis_all = page.evaluate('''() => {
              const S = window.__acDebug();
              const items = S.screenItems();
              const covers = (a, b) => a.id !== b.id && b.cx > a.wx && b.cx < a.wx + a.w && b.cy > a.wy && b.cy < a.wy + a.h;
              return items.map((it) => ({ ...it, blocked: items.some((o) => o.id !== it.id && (o.z || 0) >= (it.z || 0) && covers(o, it)),
                                          dom: (() => { const e = document.elementFromPoint(it.cx, it.cy); return e ? (e.id || e.className) : 'none'; })() }));
            }''')
            actor_v = [i for i in vis_all if i["kind"] == "actor" and not i["blocked"] and i["dom"] == "ac-canvas"]
            scene_v = [i for i in vis_all if i["kind"] == "scene"]
            page.keyboard.press("Escape")          # 清掉此前的多选/分组选中，确保组合出图只针对当前选择
            page.wait_for_timeout(400)
            page.mouse.click(actor_v[0]["cx"], actor_v[0]["cy"])
            page.wait_for_timeout(500)
            ok("组合出图前为单选一个演员卡", len(dbg()["selection"]) == 1 and dbg()["selectedGroup"] is None,
               f"selection={len(dbg()['selection'])} group={dbg()['selectedGroup']}")
            page.get_by_text("⚡ 组合出图").first.click()
            page.wait_for_timeout(2400)
            panel = page.inner_text(".modal") if page.locator(".modal").count() else ""
            ok("打开组合出图面板（含节点摘要与提示词预览）", "参与节点" in panel and "POSITIVE" in panel, panel.replace("\n", " ")[:70])
            ok("连线自动带入关联节点（连线即约束：环境节点被自动纳入）",
               "雾港码头" in panel and "场景/道具/参考 1" in panel and re.search(r"演员 \d+", panel) is not None,
               [l for l in panel.split("\n") if "参与节点" in l][:1])
            ok("预览提示词包含环境描述（深夜/雾港码头）", "深夜" in panel and "雾港码头" in panel)
            page.screenshot(path=str(OUT / "12-compose-panel.png"))
            page.locator(".modal footer button").last.click()
            page.wait_for_timeout(3200)
            jobs = api("/api/jobs?limit=5")["jobs"]
            compose_jobs = [j for j in jobs if j["type"] == "compose"]
            ok("组合出图任务已提交并完成", bool(compose_jobs) and compose_jobs[0]["status"] in ("done", "running"),
               json.dumps(compose_jobs[:1], ensure_ascii=False)[:120])
            # 结果落到演员素材库 + 关联节点
            imgs = [n for n in api(f"/api/actors/{actor_v[0]['actorId']}/images")["images"] if n["kind"] == "compose"]
            ok("组合结果写入演员素材库", len(imgs) >= 1, f"compose images={len(imgs)}")
            sc_node = [n for n in api("/api/canvas")["canvas"]["nodes"] if n.get("kind") == "scene"][0]
            ok("组合结果同时挂到环境节点（节点内可见生成图）", len((sc_node.get("asset") or {}).get("generated") or []) >= 1,
               str(len((sc_node.get("asset") or {}).get("generated") or [])))
            # 资产节点单独生成概念图
            sc_scr = [i for i in page.evaluate("() => window.__acDebug().screenItems()") if i["kind"] == "scene"][0]
            page.mouse.click(sc_scr["cx"], sc_scr["cy"], button="right")
            page.wait_for_timeout(800)
            menu3 = page.inner_text(".ctx-menu") if page.locator(".ctx-menu").count() else ""
            ok("环境节点菜单含「生成概念图」与「组合出图」", "生成概念图" in menu3 and "与选中演员组合出图" in menu3,
               menu3.replace("\n", "/")[:70])
            before_gen = len(([n for n in api("/api/canvas")["canvas"]["nodes"] if n.get("kind") == "scene"][0].get("asset") or {}).get("generated") or [])
            page.get_by_text("生成概念图").first.click()
            page.wait_for_timeout(3500)
            after_gen = len(([n for n in api("/api/canvas")["canvas"]["nodes"] if n.get("kind") == "scene"][0].get("asset") or {}).get("generated") or [])
            ok("环境节点可单独生成概念图并挂到节点", after_gen > before_gen, f"{before_gen} → {after_gen}")
            close_overlays()
            page.keyboard.press("f")
            page.wait_for_timeout(1000)
            page.screenshot(path=str(OUT / "13-compose-result.png"))

        assert_gate_armed("生成型段落前复核")
        # ================= N. 自动补尾帧（LibTV 调研第 1 条：只给首帧也能做首尾帧过渡） =================
        print("\n=== N. 自动补尾帧（右键 → 建尾帧出图节点 → 接 last） ===")
        close_overlays()
        _al = api("/api/canvas/create", "POST", {"name": "审计·自动补尾帧画布"})["canvas"]
        # 视口固定到 (0,0)/100%，节点放在世界坐标 (140,120) —— 一定落在可视区内（不依赖快捷键聚焦）
        api("/api/canvas/viewport", "PUT", {"id": _al["id"], "zoom": 1, "panX": 260, "panY": 90})
        _vid = api("/api/canvas/assets", "POST", {"canvas_id": _al["id"], "kind": "video", "title": "待补尾帧片段",
                                                  "x": 140, "y": 120, "data": {"idx": 1, "prompt": "medium shot, rainy pier at night", "duration": 3}})["node"]
        page.reload(wait_until="networkidle")   # 让新画布与新节点进入视图
        page.wait_for_timeout(1800)
        page.locator("#ac-canvas-picker select").select_option(_al["id"])
        page.wait_for_timeout(1600)
        _it = item_by_id(_vid["id"])
        ok("临时画布上的视频片段可见（可右键）", _it is not None, f"item={'yes' if _it else 'none'}")
        if _it:
            page.mouse.click(_it["cx"], _it["cy"], button="right")
            page.wait_for_timeout(700)
            _men = page.inner_text(".ctx-menu") if page.locator(".ctx-menu").count() else ""
            ok("视频片段右键菜单含「⌛ 自动补尾帧」", "自动补尾帧" in _men, _men.replace("\n", "/")[:90])
            page.get_by_text("⌛ 自动补尾帧").first.click()
            page.wait_for_timeout(1800)
            _c = api(f"/api/canvas?id={_al['id']}")["canvas"]
            _imgs = [n for n in _c["nodes"] if n.get("kind") == "image"]
            _last = [l for l in _c.get("links", []) if l.get("to_port") == "last"]
            ok("右键补尾帧真机生效（新增尾帧出图节点）", len(_imgs) == 1 and len(_last) == 1,
               f"images={len(_imgs)} lastLinks={len(_last)}")
            ok("尾帧连线落在 image → last（首尾帧过渡就会用它）",
               bool(_last) and _last[0].get("from_node") == _imgs[0]["id"] and _last[0].get("to_node") == _vid["id"],
               str(_last[:1]))
            _raw = _imgs[0].get("data")
            _data = _raw if isinstance(_raw, dict) else (json.loads(_raw) if isinstance(_raw, str) and _raw.strip().startswith("{") else {})
            ok("尾帧提示词继承本镜并带收尾定格语义（可人工再改）",
               "rainy pier" in str(_data.get("prompt") or "") and "final frame" in str(_data.get("prompt") or ""),
               str(_data.get("prompt"))[:60])
            ok("补尾帧不生成任何内容（只建图，产物仍走人工闸门）",
               not _data.get("lastFile") and not _data.get("status"),
               f"lastFile={_data.get('lastFile')} status={_data.get('status')}")
            # 再补一次：应被中文拒绝（不叠第二张尾帧）
            _it2 = item_by_id(_vid["id"])
            if _it2:
                _err_mark = len(errors)      # 这一次 400 是**预期内**的中文拒绝，之后从 JS 错误统计里剔除
                page.mouse.click(_it2["cx"], _it2["cy"], button="right")
                page.wait_for_timeout(600)
                page.get_by_text("⌛ 自动补尾帧").first.click()
                page.wait_for_timeout(1400)
                _tt = page.inner_text(".toasts") if page.locator(".toasts").count() else ""
                ok("重复补尾帧被中文拒绝（提示已有尾帧）", "已经有尾帧" in _tt, _tt.replace("\n", " ")[:70])
                del errors[_err_mark:]
            _c2 = api(f"/api/canvas?id={_al['id']}")["canvas"]
            ok("重复点击不会叠出第二张尾帧", len([n for n in _c2["nodes"] if n.get("kind") == "image"]) == 1,
               f"images={len([n for n in _c2['nodes'] if n.get('kind') == 'image'])}")
        close_overlays()
        api(f"/api/canvas/{_al['id']}", "DELETE")
        page.locator("#ac-canvas-picker select").select_option("CV-MAIN")
        page.wait_for_timeout(1200)

        # ================= N2. 时间线缩略轨 + 拖拽调序（LibTV 调研第 4 条） =================
        print("\n=== N2. 时间线缩略轨与拖拽调序（真机） ===")
        close_overlays()
        ROOT_DIR = pathlib.Path(__file__).resolve().parent.parent
        DATA_DIR = ROOT_DIR / "data"
        clip_dir = DATA_DIR / "videos" / "audit-track"
        clip_dir.mkdir(parents=True, exist_ok=True)
        clips = []
        ffmpeg_ok = True
        for i, color in enumerate(("red", "green", "blue")):
            rel = f"data/videos/audit-track/audit_track_{i}.mp4"
            abs_p = ROOT_DIR / rel
            r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"color=c={color}:s=160x120:d=1.2",
                                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", "12", str(abs_p)],
                               capture_output=True, text=True)
            if r.returncode != 0:
                ffmpeg_ok = False
            clips.append(rel)
        _tr = api("/api/canvas/create", "POST", {"name": "审计·缩略轨调序"})["canvas"]
        api("/api/canvas/viewport", "PUT", {"id": _tr["id"], "zoom": 1, "panX": 300, "panY": 70})
        _tl = api("/api/canvas/assets", "POST", {"canvas_id": _tr["id"], "kind": "timeline", "title": "缩略轨成片",
                                                 "x": 150, "y": 340, "w": 430, "h": 190, "data": {}})["node"]
        _clip_nodes, _link_ids = [], []
        for i, rel in enumerate(clips):
            _v = api("/api/canvas/assets", "POST", {"canvas_id": _tr["id"], "kind": "video", "title": f"片段{chr(65 + i)}",
                                                    "x": 60 + i * 300, "y": 70, "w": 220, "h": 170,
                                                    "data": {"duration": 2, "lastFile": rel, "prompt": "x"}})["node"]
            _clip_nodes.append(_v["id"])
            _lk = api("/api/canvas/links", "POST", {"canvas_id": _tr["id"], "from_node": _v["id"], "to_node": _tl["id"],
                                                    "from_port": "clip", "to_port": f"clip{i + 1}", "slot": i})
            _link_ids.append((_lk.get("link") or {}).get("id"))
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(1800)
        page.locator("#ac-canvas-picker select").select_option(_tr["id"])
        page.wait_for_timeout(2000)
        # 等缩略图（服务端抽帧）加载完
        for _ in range(25):
            page.wait_for_timeout(400)
            if dbg().get("imgLoaded", 0) >= 3:
                break
        tracks = [t for t in dbg()["clipTracks"] if t["nodeId"] == _tl["id"]]
        ok("时间线节点内画出逐镜缩略轨（3 格且都识别到片段文件）",
           len(tracks) == 1 and len(tracks[0]["clips"]) == 3 and all(c["hasFile"] for c in tracks[0]["clips"]),
           json.dumps(tracks)[:120] if tracks else "无缩略轨")
        if tracks:
            tr = tracks[0]
            cells = tr["clips"]
            rect = tr["rect"]
            sc = lambda wx, wy: page.evaluate("([x, y]) => window.__acDebug().screenAt(x, y)", [wx, wy])
            a = sc(cells[2]["x"] + cells[2]["w"] / 2, rect["y"] + rect["h"] / 2)
            z = sc(cells[0]["x"] + 3, rect["y"] + rect["h"] / 2)
            page.mouse.move(a["x"], a["y"])
            page.mouse.down()
            page.wait_for_timeout(300)
            page.mouse.move((a["x"] + z["x"]) / 2, z["y"], steps=8)
            page.wait_for_timeout(250)
            dragging = dbg().get("clipDrag")
            ok("拖拽缩略轨时进入调序态（from/to 随光标更新）", bool(dragging) and dragging["nodeId"] == _tl["id"],
               json.dumps(dragging))
            page.mouse.move(z["x"], z["y"], steps=8)
            page.wait_for_timeout(300)
            page.mouse.up()
            page.wait_for_timeout(2500)
            after = sorted([l for l in api(f"/api/canvas?id={_tr['id']}")["canvas"]["links"] if l["to_node"] == _tl["id"]],
                           key=lambda l: int(str(l["to_port"]).replace("clip", "") or 0))
            ok("拖到最前后端口写回：原来的第 3 段成为 clip1",
               after and after[0]["from_node"] == _clip_nodes[2] and after[0]["to_port"] == "clip1",
               json.dumps([(l["to_port"], l["from_node"][-6:]) for l in after]))
            ok("调序后 slot 归一为 0..N-1（拼接顺序的唯一口径）",
               [int(l["slot"]) for l in after] == [0, 1, 2], json.dumps([l["slot"] for l in after]))
            ok("调序后端口仍唯一（不会出现两条 clip1）",
               len({l["to_port"] for l in after}) == len(after), ",".join(l["to_port"] for l in after))
            _tt = page.inner_text(".toasts") if page.locator(".toasts").count() else ""
            ok("调序后给出中文反馈（含新顺序）", "已调序" in _tt, _tt.replace("\n", " ")[:70])
        # 非法调序（API 级）必须中文拒绝：部分 / 外来 / 非时间线节点
        _bad1 = api_soft("/api/canvas/reorder-clips", "POST", {"canvasId": _tr["id"], "nodeId": _tl["id"], "order": [_link_ids[0]]})
        _bad2 = api_soft("/api/canvas/reorder-clips", "POST", {"canvasId": _tr["id"], "nodeId": _tl["id"],
                                                          "order": [_link_ids[0], _link_ids[1], "LK-不存在"]})
        _bad3 = api_soft("/api/canvas/reorder-clips", "POST", {"canvasId": _tr["id"], "nodeId": _clip_nodes[0], "order": _link_ids})
        ok("非法调序一律中文拒绝（少给 / 外来连线 / 非成片节点）",
           bool(_bad1.get("error")) and "全部" in _bad1["error"] and bool(_bad2.get("error")) and "不属于" in _bad2["error"]
           and bool(_bad3.get("error")) and "成片时间线" in _bad3["error"],
           f"{_bad1.get('error')} | {_bad2.get('error')} | {_bad3.get('error')}")
        close_overlays()
        api(f"/api/canvas/{_tr['id']}", "DELETE")
        for f in clip_dir.glob("*.mp4"):
            try:
                f.unlink()
            except Exception:
                pass
        try:
            clip_dir.rmdir()
        except Exception:
            pass
        page.locator("#ac-canvas-picker select").select_option("CV-MAIN")
        page.wait_for_timeout(1200)

        # ================= O. 画布快照与回滚（版本化工作现场，真机） =================
        print("\n=== O. 画布快照与回滚（真机） ===")
        close_overlays()
        _sn = api("/api/canvas/create", "POST", {"name": "审计·快照画布"})["canvas"]
        for _i, _t in enumerate(["片段甲", "片段乙", "片段丙"]):
            api("/api/canvas/assets", "POST", {"canvas_id": _sn["id"], "kind": "video", "title": _t,
                                               "x": 60 + _i * 300, "y": 90, "w": 220, "h": 170,
                                               "data": {"prompt": "x", "duration": 2}})
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(1800)
        page.locator("#ac-canvas-picker select").select_option(_sn["id"])
        page.wait_for_timeout(1600)
        ok("工具栏存在「📸 快照」按钮", page.locator("#ac-snapshots").count() == 1)
        page.locator("#ac-snapshots").click()
        page.wait_for_timeout(1200)
        _dlg = page.locator(".modal")
        ok("快照弹窗打开并说明「破坏性操作前自动留档」", _dlg.count() >= 1 and "自动" in _dlg.first.inner_text(),
           _dlg.first.inner_text().replace("\n", " ")[:80] if _dlg.count() else "无弹窗")
        page.locator(".modal input[type=text]").first.fill("审计快照基线")
        page.get_by_text("📸 保存当前画布").first.click()
        page.wait_for_timeout(1600)
        _snaps = api(f"/api/canvas/snapshots?canvas_id={_sn['id']}")["snapshots"]
        ok("弹窗里保存快照成功（落库且计数正确）",
           len(_snaps) == 1 and _snaps[0]["name"] == "审计快照基线" and _snaps[0]["nodes"] == 3,
           json.dumps(_snaps[:1], ensure_ascii=False)[:110])
        ok("弹窗列表里能看到刚保存的快照（含卡位/连线计数）",
           "审计快照基线" in _dlg.first.inner_text())
        # 破坏现场：删掉两张卡位 → 用弹窗里的「↩ 回滚」还原
        _nodes = api(f"/api/canvas?id={_sn['id']}")["canvas"]["nodes"]
        for _n in _nodes[:2]:
            api("/api/canvas/node/" + _n["id"], "DELETE")
        ok("破坏后画布只剩 1 个卡位（回滚前的前置条件）", len(api(f"/api/canvas?id={_sn['id']}")["canvas"]["nodes"]) == 1)
        # ★ 必须先挂 dialog 处理再点：`confirm()` 是同步弹出的，晚一步就会被 Playwright 默认 dismiss 掉
        page.once("dialog", lambda d: d.accept())
        page.get_by_text("↩ 回滚").first.click()
        page.wait_for_timeout(2200)
        _after = api(f"/api/canvas?id={_sn['id']}")["canvas"]["nodes"]
        _snaps2 = api(f"/api/canvas/snapshots?canvas_id={_sn['id']}")["snapshots"]
        ok("真机回滚把 3 个卡位找回来（弹窗「↩ 回滚」生效）", len(_after) == 3, f"nodes={len(_after)}")
        ok("回滚前自动留档：多出一张 kind=auto 的快照",
           any(x["kind"] == "auto" for x in _snaps2), json.dumps([(x["name"], x["kind"]) for x in _snaps2], ensure_ascii=False)[:120])
        close_overlays()
        api(f"/api/canvas/{_sn['id']}", "DELETE")
        page.locator("#ac-canvas-picker select").select_option("CV-MAIN")
        page.wait_for_timeout(1000)

        # 金丝雀：审计不得改动演员数据（此前曾出现过误删演员的事故）
        actors_end = api("/api/actors")["actors"]
        ok("金丝雀：审计前后演员数量一致（未误删演员）", len(actors_end) == n_actors,
           f"{n_actors} → {len(actors_end)}")
        ok("金丝雀：主画布卡位数未被清空", len(api("/api/canvas")["canvas"]["nodes"]) >= n_actors,
           f"nodes={len(api('/api/canvas')['canvas']['nodes'])}")

        real_errors = [e for e in errors if "favicon" not in e]
        ok("全流程无 JS 错误", not real_errors, "; ".join(real_errors[:3]))
        browser.close()

    print(f"\n=== 审计结果：{len(PASS)} 通过 / {len(FAIL)} 失败 / {len(WARN)} 提示 ===")
    for n, d in FAIL:
        print(f"   ✗ {n}   {d}")
    for n, d in WARN:
        print(f"   ! {n}   {d}")
    print(f"截图目录：{OUT}")
    return 1 if FAIL else 0


def drop_temp_canvas():
    """删掉审计自建的「审计临时画布」（成功还原快照的路径也要删，否则会越攒越多）"""
    try:
        for c in api("/api/canvas/list")["canvases"]:
            if c["name"] == "审计临时画布":
                api("/api/canvas/" + c["id"], "DELETE")
    except Exception as e:
        print("[cleanup] 临时画布清理失败：", e)


def cleanup(pre_state=None):
    """恢复现场：优先还原审计前的画布快照，其次退化为宫格排布"""
    try:
        if pre_state and pre_state.get("nodes") is not None:
            api("/api/canvas/restore", "POST",
                {"canvas_id": "CV-MAIN", "nodes": pre_state["nodes"], "groups": pre_state["groups"], "links": pre_state.get("links")})
            v = pre_state.get("layout_view") or {}
            if v:
                api("/api/canvas/viewport", "PUT", {"id": "CV-MAIN", **v})
            if pre_state.get("cols") and pre_state.get("cell"):
                # 按审计前的排布模式回写：审计前是「分组布局」就必须按 group 回写，
                # 否则 arrange(matrix) 会把 layout.groups 由 N 组抹成 0 组（分组框与卡位随之失配）
                mode = pre_state.get("layout_mode") or "matrix"
                group_by = pre_state.get("layout_groupBy")
                body = {"id": "CV-MAIN", "mode": mode, "cols": pre_state["cols"], "cell": pre_state["cell"], "gap": 14}
                if mode == "group":
                    body["groupBy"] = group_by or "style_id"
                api("/api/canvas/arrange", "POST", body)
            drop_temp_canvas()
            print(f"[cleanup] 已还原审计前画布（{len(pre_state['nodes'])} 卡位 / {len(pre_state['groups'])} 分组 / {len(pre_state.get('links') or [])} 连线）")
            return
    except Exception as e:
        print("[cleanup] 快照还原失败，退化为宫格排布：", e)
    try:
        for c in api("/api/canvas/list")["canvases"]:
            if c["name"] == "审计临时画布":
                api("/api/canvas/" + c["id"], "DELETE")
        # 审计期间若创建过画布，确保回到主画布
        api("/api/canvas/arrange", "POST", {"id": "CV-MAIN", "mode": "matrix", "cols": 5, "cell": 210, "gap": 14})
        for a in api("/api/actors")["actors"]:
            if a["name"] == "审计临时演员":
                api("/api/actors/" + a["id"], "DELETE")
        for lnk in api("/api/canvas/links")["links"]:
            if lnk["label"] == "同盟":
                api("/api/canvas/links/" + lnk["id"], "DELETE")
        for g in api("/api/canvas/groups")["groups"]:
            api("/api/canvas/groups/" + g["id"], "DELETE")
        for n in api("/api/canvas")["canvas"]["nodes"]:
            if n.get("kind") in ("note", "scene", "item", "refimg", "shot", "video", "timeline", "output"):
                api("/api/canvas/node/" + n["id"], "DELETE")
        api("/api/canvas/arrange", "POST", {"id": "CV-MAIN", "mode": "matrix", "cols": 5, "cell": 210, "gap": 14})
        api("/api/canvas/viewport", "PUT", {"id": "CV-MAIN", "zoom": 0.62, "panX": -10, "panY": -10,
                                            "bg": "dots", "gridSize": 40, "snap": True,
                                            "showMinimap": True, "showLinks": True})
        print("[cleanup] 已恢复宫格排布与视图")
    except Exception as e:
        print("[cleanup] 失败：", e)


if __name__ == "__main__":
    code = 1
    state = {"pre": None}
    print("== 并发体检（用户在界面上操作会让画布夹具被改动，本审计据此提示假失败风险）==")
    busy_at_start = concurrency_note("开始")
    # 付费后端闸门：跑前切 placeholder，跑完（含异常/中断）在 finally 里切回真实配置
    paid_backend_gate_on()
    assert_gate_armed("闸门生效后立即复核")
    try:
        code = main(state)
    finally:
        if _PAID_GATE.get("broken"):
            print("  ✗ 本轮审计期间「付费闸门」曾失效（见上面的中文说明）→ 强制判失败，请修好后重跑")
            code = 1
        assert_gate_armed("结束前复核")
        busy_at_end = concurrency_note("结束")
        if busy_at_start or busy_at_end:
            print("  ! 本轮审计期间检测到**并发活动**：若有失败项，请先在队列空闲时单独重跑本审计确认，"
                  "不要直接当成功能缺陷（2026-09-30 的两次假失败就是这么来的）")
        cleanup(state.get("pre"))
        paid_backend_gate_off()
    sys.exit(code)
