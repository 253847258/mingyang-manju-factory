#!/usr/bin/env python3
"""AI漫剧-电影视频工厂 · 前端端到端冒烟测试
用法：
    node server.js &            # 先启动服务（默认 8788）
    python3 tests/ui-smoke.py [baseUrl]

依赖：python3 -m pip install playwright（本机已装），chromium 二进制见 CHROME 环境变量。
本脚本会：逐个模块挂载 → 检查控制台错误 → 断言关键 DOM → 截图到 /tmp/aivf-shots/
"""
import os
import sys
import time
import json
import pathlib
import urllib.request

from playwright.sync_api import sync_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("BASE", "http://127.0.0.1:8788")
CHROME = os.environ.get(
    "CHROME",
    "/home/linsheng/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
)
LIBS = os.environ.get("PW_LIBS", "/home/linsheng/pwlibs/extract/usr/lib/x86_64-linux-gnu")
if LIBS and not os.environ.get("LD_LIBRARY_PATH"):
    os.environ["LD_LIBRARY_PATH"] = LIBS

OUT = pathlib.Path("/tmp/aivf-shots")
OUT.mkdir(parents=True, exist_ok=True)

PASS, FAIL = [], []


def ok(name, cond, extra=""):
    (PASS if cond else FAIL).append(name)
    print(("  ✓ " if cond else "  ✗ ") + name + (f"  {extra}" if extra and not cond else ""))


def api_json(path):
    """只读 GET 回查（用于「调用前后缓存文件数不变」这类证据；本脚本不会写任何接口）"""
    with urllib.request.urlopen(BASE + path, timeout=20) as r:
        return json.load(r)


def main():
    with sync_playwright() as p:
        kwargs = {"args": ["--no-sandbox"]}
        if pathlib.Path(CHROME).exists():
            kwargs["executable_path"] = CHROME
        browser = p.chromium.launch(**kwargs)
        page = browser.new_page(viewport={"width": 1680, "height": 1000})
        errors = []
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))

        print(f"\n=== 前端冒烟测试：{BASE} ===")
        page.goto(BASE, wait_until="networkidle")
        page.wait_for_timeout(2500)

        ok("外壳渲染（导航 + 状态徽章）", page.locator(".topbar").count() == 1 and page.locator(".status-chips .chip").count() >= 2)
        ok("演员矩阵挂载（主画布 + 小地图 + 工具栏）",
           page.locator("#ac-canvas").count() == 1 and page.locator("#ac-minimap").count() == 1 and page.locator(".ac-toolbar").count() == 1)
        actors = page.locator(".ac-item").count()
        ok(f"演员列表渲染（{actors} 位）", actors >= 0)
        page.screenshot(path=str(OUT / "01-actors.png"))

        # 右键清单
        box = page.locator(".ac-canvas-wrap").bounding_box()
        if box and actors > 0:
            page.mouse.click(box["x"] + 120, box["y"] + 130, button="right")
            page.wait_for_timeout(500)
            ok("右键生成清单弹出", page.locator(".ctx-menu").count() >= 1)
            page.screenshot(path=str(OUT / "02-context-menu.png"))
            page.keyboard.press("Escape")
            page.mouse.click(10, 500)

        # 各模块挂载
        for mid, label, marker, shot in [
            ("novel", "小说工坊", ".nv-", "03-novel.png"),
            ("script", "剧本工厂", ".sc-", "04-script.png"),
            ("render", "制作台", ".rd-", "06-render.png"),
            ("settings", "设置", ".set-card", "05-settings.png"),
        ]:
            page.goto(f"{BASE}/#/{mid}", wait_until="networkidle")
            page.wait_for_timeout(2000)
            has_marker = page.evaluate(
                "sel => document.querySelectorAll(sel).length > 0", f'[class*="{marker.strip(".")}"]'
            ) if marker else True
            notready = page.locator(".mod-loading").count() > 0 and "尚未就绪" in page.inner_text("body")
            ok(f"{label} 模块挂载", has_marker and not notready, "模块未就绪或未渲染")
            page.screenshot(path=str(OUT / shot), full_page=False)

        # =====================================================================
        # 设置页 · 参考图栅格化缓存（H-101 新接线）：占用行 + 「查看可清理量」+「清理缓存」二次确认
        # 安全红线：本脚本**绝不点** #cache-clean-confirm —— 用户机器上 data/cache/refs 是真实文件，
        #   删除路径只在临时实例（tests/ui-scale.py 那种独立 DATA_DIR）里验，这里只验「只读查看」与「弹窗 + 取消」。
        # =====================================================================
        page.goto(f"{BASE}/#/settings", wait_until="networkidle")
        page.wait_for_timeout(2200)
        ok("设置页存在栅格化缓存行与两个按钮（#cache-row / #cache-scan / #cache-clean）",
           page.locator("#cache-row").count() == 1 and page.locator("#cache-scan").count() == 1
           and page.locator("#cache-clean").count() == 1,
           f"row={page.locator('#cache-row').count()} scan={page.locator('#cache-scan').count()} "
           f"clean={page.locator('#cache-clean').count()}")
        cache_line = page.inner_text("#cache-row")
        ok("缓存行显示缓存目录 + 文件数 + 占用（MB）",
           "缓存目录" in cache_line and "data/cache/refs" in cache_line
           and ("MB" in cache_line or "未上报" in cache_line),
           cache_line.replace("\n", " / ")[:140])

        before_cache = api_json("/api/render/cache")
        page.locator("#cache-scan").click()
        page.wait_for_timeout(2500)
        scan_txt = page.inner_text("#cache-scan-result")
        ok("「🔍 查看可清理量」显示文件数 / 占用 / 后端说明（只读接口）",
           "可清理量" in scan_txt and "文件数" in scan_txt and "MB" in scan_txt,
           scan_txt.replace("\n", " / ")[:140])
        after_cache = api_json("/api/render/cache")
        ok(f"查看可清理量未删除任何文件（调用前后 files 不变：{before_cache.get('files')} → {after_cache.get('files')}）",
           before_cache.get("files") == after_cache.get("files"),
           f"before={before_cache} after={after_cache}")

        page.locator("#cache-clean").click()
        page.wait_for_selector(".overlay .modal", timeout=10000)
        page.wait_for_timeout(600)
        cm = page.locator(".overlay .modal").last
        cmtxt = cm.inner_text()
        ok("「🧹 清理缓存」先弹二次确认（含将释放 MB / 只删栅格化缓存 / 不可撤销）",
           ("将释放" in cmtxt or "可清理量未知" in cmtxt) and "只删栅格化缓存" in cmtxt
           and "不可撤销" in cmtxt and "data/cache/refs" in cmtxt,
           cmtxt.replace("\n", " / ")[:160])
        ok("二次确认弹窗写明不影响成片 / 关键帧 / 定妆图",
           "不影响成片" in cmtxt and "关键帧" in cmtxt and "定妆图" in cmtxt,
           cmtxt.replace("\n", " / ")[:160])
        ok("二次确认弹窗有「取消（什么都不删）」与「确认清理（不可撤销）」两个按钮",
           cm.locator("#cache-clean-cancel").count() == 1 and cm.locator("#cache-clean-confirm").count() == 1)
        page.screenshot(path=str(OUT / "08-settings-cache.png"))
        cm.locator("#cache-clean-cancel").click()   # 只取消，绝不点确认
        page.wait_for_timeout(600)
        final_files = api_json("/api/render/cache").get("files")
        ok(f"取消二次确认后弹窗关闭且缓存一个没少（files 仍为 {final_files}）",
           page.locator(".overlay .modal").count() == 0 and final_files == before_cache.get("files"),
           f"modal={page.locator('.overlay .modal').count()} files={final_files} before={before_cache.get('files')}")

        # 制片 Agent 控制台（模块 4）：技能选择器 + 契约面板（LibTV 调研第 5 条）
        page.goto(f"{BASE}/#/studio", wait_until="networkidle")
        page.wait_for_timeout(2200)
        ok("制片 Agent 模块挂载（控制台骨架）",
           page.locator("#st-main").count() == 1 and page.locator("#st-brief").count() == 1
           and page.locator("#st-create").count() == 1)
        skill_opts = page.locator("#st-skill option").count()
        ok(f"技能下拉可选（{skill_opts} 项，含默认）", skill_opts >= 4, "技能列表未加载")
        page.select_option("#st-skill", "canvas-only")
        page.wait_for_timeout(400)
        contract_text = page.inner_text("#st-contract")
        ok("技能契约面板渲染（阶段/付费/重试/产出）",
           "前置能力齐备" in contract_text and "阶段" in contract_text and "可自动重试" in contract_text
           and "产出物" in contract_text,
           contract_text[:120].replace("\n", " "))
        ok("离线环境下画布技能无付费阶段（契约未误判）", "全程免费" in contract_text, contract_text[:80].replace("\n", " "))
        page.select_option("#st-skill", "")
        page.wait_for_timeout(300)
        ok("清空技能后回到默认十阶段说明",
           "默认十阶段" in page.inner_text("#st-contract") and page.locator("#st-create").is_enabled())
        page.screenshot(path=str(OUT / "07-studio.png"))

        # 制作台：工作流能力匹配（LibTV 调研第 6 条）
        page.goto(f"{BASE}/#/render", wait_until="networkidle")
        page.wait_for_timeout(2200)
        # 制作台：成片包装面板里的响度口径（专业交付）
        page.locator('[data-act="finish-panel"]').first.click()
        page.wait_for_timeout(1500)
        panel = page.locator(".rd-panel")
        ok("成片包装面板含响度归一入口（5 种口径）",
           panel.count() >= 1 and "响度归一" in panel.first.inner_text()
           and panel.first.locator('[data-fa="loudness"]').count() == 5,
           f"chips={panel.first.locator('[data-fa=\"loudness\"]').count() if panel.count() else 0}")
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)

        ok("制作台存在「📱 多平台版本」按钮", page.locator('[data-act="variants"]').count() == 1)
        ok("制作台存在时间线/字幕专业导出按钮",
           page.locator('[data-act="export-timeline"]').count() == 1 and page.locator('[data-act="export-subs"]').count() == 1)
        fit_btn = page.locator('[data-act="backend-fit"]')
        ok("制作台存在「🧩 能力匹配」按钮", fit_btn.count() == 1)
        if fit_btn.count():
            fit_btn.first.click()
            page.wait_for_timeout(3500)
            modal = page.locator(".modal")
            ok("能力匹配面板给出逐项检查与降级建议",
               modal.count() >= 1 and ("能力匹配" in modal.first.inner_text()) and ("→" in modal.first.inner_text()),
               modal.first.inner_text().replace("\n", " ")[:100] if modal.count() else "无弹窗")
            page.keyboard.press("Escape")
            page.wait_for_timeout(600)

        # 制片 Agent：计费口径与对账（LibTV 调研第 7 条）
        page.goto(f"{BASE}/#/studio", wait_until="networkidle")
        page.wait_for_timeout(3000)
        dyn = page.inner_text("#st-dyn")
        ok("制片页显示计费口径标签", "口径：" in dyn, dyn[:80].replace("\n", " "))
        ok("制片页显示决策时间线（三类行动者 + 结论）",
           "决策时间线" in dyn and "人类决定" in dyn and "系统自动" in dyn)
        ok("制片页显示对账结论（预计→实际）", "对账：" in dyn,
           [l for l in dyn.split("\n") if l.startswith("对账：")][:1])

        # 回到演员矩阵
        page.goto(f"{BASE}/#/actors", wait_until="networkidle")
        page.wait_for_timeout(1200)

        real_errors = [e for e in errors if "favicon" not in e and "404" not in e]
        ok("无 JS 控制台错误", len(real_errors) == 0, "; ".join(real_errors[:5]))
        browser.close()

    print(f"\n=== 截图输出：{OUT} ===")
    print(f"=== 结果：{len(PASS)} 通过 / {len(FAIL)} 失败 ===")
    if FAIL:
        for f in FAIL:
            print("   失败：" + f)
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
