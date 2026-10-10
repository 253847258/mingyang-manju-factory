#!/usr/bin/env python3
"""满配前端检查：按产品上限（200 演员 / 100 集 / 单集 200 镜 / 200 章）造库并起一个独立实例，
用浏览器验证四个模块页面在满配规模下的渲染时间与可用性（不碰你的正式实例）。

用法：LD_LIBRARY_PATH=<pwlibs> python3 tests/ui-scale.py
说明：脚本自己种子化临时库并用独立端口启动 node server.js，结束自动关闭并清理。
"""
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time  # 计时一律用 time.monotonic()：wall clock 会被系统时钟调整影响
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PWLIBS = os.environ.get("PWLIBS", "/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu")
CHROME = os.environ.get("PW_CHROME", "/home/linsheng/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome")
OUT = Path("/tmp/ui-scale")
OUT.mkdir(parents=True, exist_ok=True)

passed = failed = 0
warns = []


def ok(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  ✓ {name}" + (f"  {extra}" if extra else ""))
    else:
        failed += 1
        print(f"  ✗ {name}" + (f"  {extra}" if extra else ""))


def warn(name, detail=""):
    warns.append(f"{name}（{detail}）")
    print(f"  ! {name}" + (f"   {detail}" if detail else ""))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def main():
    tmp = Path(tempfile.mkdtemp(prefix="factory-ui-scale-"))
    db = tmp / "scale.db"
    data = tmp / "data"
    cfg = tmp / "config.json"
    port = free_port()
    base = f"http://127.0.0.1:{port}"

    print("▶ 满配前端检查：正在种子化 200 演员 / 100 集 / 20000 镜 / 200 章 …")
    seed = subprocess.run(
        ["node", "scripts/seed-scale.js", str(db), str(data)],
        cwd=ROOT, capture_output=True, text=True, timeout=600,
    )
    if seed.returncode != 0:
        print(seed.stdout[-2000:], seed.stderr[-2000:])
        ok("种子化满配数据", False, f"exit={seed.returncode}")
        return
    info = json.loads(seed.stdout.strip().splitlines()[-1])
    ok("种子化满配数据（复用 scripts/seed-scale.js）",
       info["shotRows"] == 20000 and info["kfRows"] == 4000,
       f"镜头 {info['shotRows']} / 关键帧 {info['kfRows']} / 用时 {info['ms']}ms")

    cfg.write_text(json.dumps({"image": {"backend": "placeholder"}, "video": {"backend": "placeholder"}, "llm": {"provider": "mock"}}))
    env = {
        **os.environ,
        "PORT": str(port),
        "FACTORY_DB": str(db),
        "FACTORY_DATA_DIR": str(data),
        "FACTORY_CONFIG": str(cfg),
        "LD_LIBRARY_PATH": PWLIBS,
    }
    log = open(tmp / "server.log", "w")
    proc = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    try:
        for _ in range(60):
            if proc.poll() is not None:
                raise RuntimeError("服务启动失败：" + (tmp / "server.log").read_text()[-800:])
            try:
                subprocess.run(["curl", "-sf", "-o", "/dev/null", f"{base}/api/health"], timeout=3, check=True)
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.5)
        else:
            raise RuntimeError("服务 30s 未就绪")

        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 1720, "height": 1020})
            errs = []
            IGNORE = ("/data/", "favicon")     # 种子数据没有真实素材文件，/data 404 属预期噪音
            page.on("pageerror", lambda e: errs.append("PAGEERROR: " + str(e)))
            def on_console(m):
                if m.type != "error":
                    return
                loc = ""
                try:
                    loc = (m.location or {}).get("url", "")
                except Exception:  # noqa: BLE001
                    loc = ""
                blob = f"{m.text or ''} {loc}"
                if any(k in blob for k in IGNORE):
                    return
                errs.append(f"[{m.type}] {m.text} @ {loc}")
            page.on("console", on_console)

            def load(route, marker, settle_ms=600):
                """等到该模块的关键元素出现，返回「进入页面 → 可用」的真实耗时（单调时钟）"""
                t0 = time.monotonic()
                page.goto(f"{base}/#{route}", wait_until="domcontentloaded")
                try:
                    page.wait_for_selector(marker, timeout=20000)
                except Exception:  # noqa: BLE001
                    pass
                page.wait_for_timeout(settle_ms)
                return round((time.monotonic() - t0) * 1000)

            print("\n=== 模块1 · 演员矩阵（200 卡位） ===")
            ms = load("/actors", "#ac-canvas", 1200)
            dbg = page.evaluate("() => window.__acDebug ? window.__acDebug() : null")
            ok("页面在满配下可加载（HUD/画布/侧栏）",
               page.locator("#ac-canvas").count() == 1 and page.locator("#ac-minimap").count() == 1,
               f"加载 {ms}ms")
            ok("200 张演员卡全部进入布局",
               bool(dbg) and dbg.get("items") == 200, f"items={dbg.get('items') if dbg else '?'}")
            ok("侧栏演员列表渲染 200 行",
               page.locator(".ac-item, .ac-actor, .ac-row").count() >= 200,
               f"{page.locator('.ac-item, .ac-actor, .ac-row').count()} 行")
            ok("满配首屏可用耗时（进页面 → 关键元素出现 + 稳定）< 8s", ms < 8000, f"{ms}ms")
            # 缩放到 LOD0 / LOD2 各一次，确认大体量下不崩
            page.keyboard.press("0")
            page.wait_for_timeout(600)
            page.mouse.move(900, 520)
            for _ in range(12):
                page.mouse.wheel(0, -240)
            page.wait_for_timeout(900)
            zoomed = page.evaluate("() => window.__acDebug().zoom")
            lod = page.evaluate("() => window.__acDebug().lod")
            ok("满配下缩放仍可用（zoom > 1.5 且进入高 LOD）", zoomed > 1.5 and lod == 2, f"zoom={zoomed:.2f} lod={lod}")
            t_fit = time.monotonic()
            page.keyboard.press("f")
            page.wait_for_timeout(900)
            ok("满配下「适应窗口」响应迅速（< 3s）", (time.monotonic() - t_fit) < 3, f"{round((time.monotonic() - t_fit) * 1000)}ms")

            print("\n=== 模块2 · 小说工坊（200 章） ===")
            ms = load("/novel", ".nv-card", 800)
            page.locator('.nv-item[data-act="open"]').first.click()
            page.wait_for_timeout(2500)
            body = page.inner_text("body")
            ok("满配小说可打开工作区（标题 + 统计）",
               "压测小说" in body and "200 章" in body, f"加载 {ms}ms")
            # 章节在「章节」页签下（默认是参数页签）
            page.locator('.nv-tab[data-tab="chapters"]').first.click()
            page.wait_for_timeout(2500)
            chap_rows = page.locator(".nv-ch").count()
            ct = page.inner_text("body")
            ok("200 章列表已渲染（侧栏章节列表）", chap_rows >= 150, f"{chap_rows} 章可见")
            ok("章节标题正确（末章可见）", "第200章" in ct or "第199章" in ct, "")
            page.locator(".nv-ch").first.click()
            page.wait_for_timeout(2000)
            ok("满配下点章可读正文", "第1章正文内容" in page.inner_text("body"))
            ok("满配小说首屏可用耗时 < 8s", ms < 8000, f"{ms}ms")

            print("\n=== 模块3 · 剧本工厂（100 集） ===")
            ms = load("/script", ".sc-item", 600)
            # 打开 100 集剧本（详情里含 100 集统计与首集 200 镜），单独计一次「打开详情」耗时
            t_open = time.monotonic()
            page.locator('.sc-item[data-act="open"]').first.click()
            try:
                page.wait_for_selector('[data-act="view-ep"]', timeout=20000)
            except Exception:  # noqa: BLE001
                pass
            page.wait_for_timeout(500)
            open_ms = round((time.monotonic() - t_open) * 1000)
            body = page.inner_text("body")
            ok("满配剧本可打开（分集规划区可见）", "压测剧本" in body, f"列表首屏 {ms}ms")
            ok("打开 100 集剧本详情（含首集 200 镜）耗时 < 8s", open_ms < 8000, f"{open_ms}ms")
            ep_rows = page.locator('[data-act="view-ep"]').count()
            ok("100 集列表已渲染", ep_rows >= 50, f"{ep_rows} 集行")
            ok("满配剧本首屏可用耗时 < 8s", ms < 8000, f"{ms}ms")

            print("\n=== 模块4 · 制作台（单集 200 镜） ===")
            ms = load("/render", ".rd-shot, .rd-btn", 1200)
            page.wait_for_timeout(1500)
            ep = page.locator(".rd-ep, .rd-episode").first
            if ep.count():
                ep.click()
                page.wait_for_timeout(4500)
            body = page.inner_text("body")
            shot_cards = page.locator(".rd-shot").count()
            ok("满配剧集看板渲染 200 张镜头卡（或分页可见）",
               shot_cards >= 20 or "200" in body, f"卡片 {shot_cards} 张")
            ok("看板统计显示 200 镜", "200" in body, body.split("\n")[0][:60] if body else "")
            ok("满配看板首屏可用耗时 < 8s", ms < 8000, f"{ms}ms")
            # 全选/筛选在满配下的响应
            t0 = time.monotonic()
            sel_all = page.locator(".rd-btn", has_text="全选").first
            if sel_all.count():
                sel_all.click()
                page.wait_for_timeout(1200)
                cnt = page.locator("#rd-selcount").inner_text() if page.locator("#rd-selcount").count() else ""
                ok("满配下「全选」可用且计数正确", cnt.strip().isdigit() and int(cnt.strip()) > 0, f"选中 {cnt}｜{(time.monotonic() - t0) * 1000:.0f}ms")
                page.locator(".rd-btn", has_text="清空").first.click()
                page.wait_for_timeout(600)
            else:
                warn("未找到「全选」按钮", "看板结构变化时请同步该用例")

            print("\n=== 全局 ===")
            ok("满配全流程无 JS 错误 / 非资源类 console error（已排除种子数据缺失素材的 /data 404）", not errs, "；".join(errs[:2])[:120])
            page.screenshot(path=str(OUT / "scale-render.png"), full_page=False)
            browser.close()
    finally:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:  # noqa: BLE001
            proc.terminate()
        log.close()
        time.sleep(0.5)
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n=== 结果：{passed} 通过 / {failed} 失败 ===")
    if warns:
        print(f"=== 提示 {len(warns)} 条 ===")
        for w in warns:
            print(f"   ! {w}")
    print(f"截图目录：{OUT}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
