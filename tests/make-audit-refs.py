#!/usr/bin/env python3
"""无限画布审计夹具生成器（幂等）：/tmp/refs/ref1.png …refN.png

背景（历史缺陷 R-W5-04）：
    tests/canvas-audit.py 在「参考图矩阵」与「资产节点上传参考图」两处硬编码
    /tmp/refs/ref{1,2,3}.png，但全仓库没有任何脚本创建该目录 —— 干净机器上裸跑
    `python3 tests/canvas-audit.py` 会在 :1138 抛 FileNotFoundError 并中断整个审计
    （连总结都打不出来）。本脚本是该夹具的唯一真源：canvas-audit.py 启动时调用它，
    verify-all.sh 这类编排方也可以直接先跑一遍。

幂等性：
    - 目标文件已存在且是合法 PNG（签名 + 尺寸）→ 跳过，不改动、不更新 mtime；
    - 缺失/损坏/–-force → 用 ffmpeg 重新生成（固定 640×480、固定颜色与方块位置，
      因此同一版本重复生成的内容逐字节一致）；
    - ffmpeg 不可用（或返回非 0）→ 回落到标准库 zlib+struct 手写 PNG，保证
      「零依赖、离线、裸跑也能有夹具」。

用法：
    python3 tests/make-audit-refs.py [目录=/tmp/refs] [数量=3] [--force] [--quiet]
    退出码：0 = 全部就绪；1 = 无法生成/校验失败（中文原因打到 stderr）
"""
import os
import shutil
import struct
import subprocess
import sys
import zlib
import pathlib

# 三张参考图的配色（与索引一一对应，便于人工在画布上区分；顺序固定 = 内容可复现）
COLORS = [
    (0xE7, 0x4C, 0x3C),   # 红
    (0x2E, 0xCC, 0x71),   # 绿
    (0x3C, 0x6E, 0xE7),   # 蓝
    (0xF1, 0xC4, 0x0F),   # 黄
    (0x9B, 0x59, 0xB6),   # 紫
]
WIDTH, HEIGHT = 640, 480
PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _png_size(path: pathlib.Path):
    """读 PNG 的 IHDR 拿 (宽, 高)；不是合法 PNG 时返回 None（用于幂等判定的完整性检查）"""
    try:
        with open(path, "rb") as f:
            head = f.read(24)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != PNG_SIG or head[12:16] != b"IHDR":
        return None
    w, h = struct.unpack(">II", head[16:24])
    return (w, h)


def _is_ready(path: pathlib.Path) -> bool:
    """夹具是否已就绪：存在、非空、是合法 PNG 且尺寸符合预期"""
    if not path.is_file() or path.stat().st_size <= 0:
        return False
    return _png_size(path) == (WIDTH, HEIGHT)


def _png_bytes(rgb, index: int):
    """生成 640×480 RGB PNG 字节（纯色底 + 固定位置白块，零依赖 zlib+struct）"""
    r, g, b = rgb
    # 白块位置随索引右移，保证三张图互不相同（也便于肉眼确认上传的是哪一张）
    bx0, by0 = 60 + index * 120, 120
    bx1, by1 = min(bx0 + 160, WIDTH), by0 + 200
    bx0 = min(bx0, WIDTH - 1)
    rows = []
    for y in range(HEIGHT):
        row = bytearray()
        row.append(0)                       # 每行滤波类型 0（None）
        if by0 <= y < by1:
            row.extend(bytes((r, g, b)) * bx0)
            row.extend(bytes((255, 255, 255)) * (bx1 - bx0))
            row.extend(bytes((r, g, b)) * (WIDTH - bx1))
        else:
            row.extend(bytes((r, g, b)) * WIDTH)
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 2, 0, 0, 0)   # 8bit, color type 2 (truecolor)
    return PNG_SIG + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b"")


def _gen_with_ffmpeg(path: pathlib.Path, rgb, index: int) -> bool:
    """用 ffmpeg 生成一张固定内容的 PNG；不可用/失败返回 False（由调用方回落）"""
    if not shutil.which("ffmpeg"):
        return False
    r, g, b = rgb
    bx0, by0 = 60 + index * 120, 120
    bx0 = min(bx0, WIDTH - 1)
    box = f"drawbox=x={bx0}:y={by0}:w=160:h=200:color=white@1.0:t=fill"
    cmd = [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=0x{r:02X}{g:02X}{b:02X}:s={WIDTH}x{HEIGHT}",
        "-vf", box, "-frames:v", "1", "-f", "image2", str(path),
    ]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return p.returncode == 0 and _is_ready(path)


def ensure_refs(target_dir="/tmp/refs", count=3, force=False, quiet=False):
    """幂等准备参考图夹具，返回已就绪的 pathlib.Path 列表；失败抛 RuntimeError（中文原因）"""
    d = pathlib.Path(target_dir)
    try:
        d.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise RuntimeError(f"无法创建参考图夹具目录 {d}：{e}") from e

    made, kept = [], []
    for i in range(1, count + 1):
        path = d / f"ref{i}.png"
        color = COLORS[(i - 1) % len(COLORS)]
        if not force and _is_ready(path):
            kept.append(path)
            continue
        if path.exists() and not force:
            if not quiet:
                print(f"  ! 夹具 {path} 已存在但不是合法 {WIDTH}×{HEIGHT} PNG，将重新生成")
        if not _gen_with_ffmpeg(path, color, i - 1):
            if not quiet:
                print(f"  ! ffmpeg 不可用或生成失败 → 回落标准库写 PNG：{path}")
            path.write_bytes(_png_bytes(color, i - 1))
        if not _is_ready(path):
            raise RuntimeError(f"参考图夹具生成失败：{path} 不是合法的 {WIDTH}×{HEIGHT} PNG")
        made.append(path)

    if not quiet:
        para = f"新生成 {len(made)} 张" + (f"（{', '.join(p.name for p in made)}）" if made else "")
        para += f"，复用 {len(kept)} 张" if kept else ""
        print(f"  参考图夹具就绪：{d}（共 {count} 张，{para}）")
    return [d / f"ref{i}.png" for i in range(1, count + 1)]


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    force = "--force" in argv
    quiet = "--quiet" in argv
    target = args[0] if args else os.environ.get("AUDIT_REFS_DIR") or "/tmp/refs"
    try:
        count = int(args[1]) if len(args) > 1 else 3
    except ValueError:
        print(f"用法错误：数量必须是整数，收到 {args[1]!r}", file=sys.stderr)
        return 1
    try:
        paths = ensure_refs(target, count, force=force, quiet=quiet)
    except RuntimeError as e:
        print(f"❌ {e}", file=sys.stderr)
        return 1
    for p in paths:
        print(f"  ✓ {p}  {p.stat().st_size} 字节")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
