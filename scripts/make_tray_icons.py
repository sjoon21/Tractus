#!/usr/bin/env python3
"""메뉴 막대(트레이) 아이콘 PNG를 만든다. 표준 라이브러리만 쓴다 (zlib + struct로 PNG를 직접 쓴다).

macOS 템플릿 이미지: 검정 + 투명 배경이다. macOS가 라이트·다크 메뉴 막대에 맞춰 색을 바꾼다 (앱이 set_icon_as_template(true)로 건다).
글리프는 소리 막대 5개 (자리표시자: 디자이너가 icons/tray/ 의 PNG를 바로 바꿔 끼우면 된다).
녹음 중 아이콘은 막대 3개 + 오른쪽 꽉 찬 점이다.

    python3 scripts/make_tray_icons.py            # app/src-tauri/icons/tray/ 에 4개를 쓴다
    python3 scripts/make_tray_icons.py --out DIR  # 다른 폴더에 쓴다

같은 입력이면 같은 바이트가 나온다 (재현 가능).
"""

from __future__ import annotations

import argparse
import math
import struct
import zlib
from pathlib import Path

BASE = 18  # 1x 크기 (pt). 2x는 36 px. macOS(tray-icon)는 어떤 이미지든 메뉴 막대 높이 18pt로 맞추므로 이 크기로 그려야 줄이지 않고 픽셀에 딱 맞는다
SUPERSAMPLE = 8  # 한 픽셀을 8x8로 나눠 덮은 비율을 알파로 쓴다 (안티앨리어싱)

# 1x 좌표계(18x18 pt)의 소리 막대: (중심 x, 높이). 폭 2, 끝은 둥글다. 2x(36 px)에서 폭·높이가 짝수 픽셀이라 가장자리가 또렷하다
BAR_W = 2.0
BARS = [(2.0, 5.0), (5.5, 10.0), (9.0, 15.0), (12.5, 9.0), (16.0, 4.0)]
DOT = (14.25, 9.0, 2.9)  # 녹음 중: 오른쪽 막대 둘 자리에 들어가는 점 (중심 x, 중심 y, 반지름)
CY = BASE / 2


def _stadium(px: float, py: float, cx: float, height: float) -> bool:
    """폭 BAR_W, 높이 height인 둥근 막대 안에 점이 있는가 (선분까지의 거리 <= 반지름)."""
    r = BAR_W / 2
    half = max(height / 2 - r, 0.0)
    dy = max(abs(py - CY) - half, 0.0)
    return math.hypot(px - cx, dy) <= r


def _inside(px: float, py: float, recording: bool) -> bool:
    bars = BARS[:3] if recording else BARS
    if any(_stadium(px, py, cx, h) for cx, h in bars):
        return True
    if recording:
        dx, dy, r = DOT
        return math.hypot(px - dx, py - dy) <= r
    return False


def render(scale: int, recording: bool) -> bytes:
    """RGBA 원시 픽셀 (검정 + 알파)."""
    size = BASE * scale
    unit = BASE / size
    n = SUPERSAMPLE
    rows = bytearray()
    for y in range(size):
        rows.append(0)  # PNG 필터 없음
        for x in range(size):
            hit = 0
            for sy in range(n):
                for sx in range(n):
                    px = (x + (sx + 0.5) / n) * unit
                    py = (y + (sy + 0.5) / n) * unit
                    hit += _inside(px, py, recording)
            rows += bytes((0, 0, 0, round(255 * hit / (n * n))))
    return bytes(rows)


def png(width: int, height: int, raw_rows: bytes) -> bytes:
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)  # 8비트 RGBA
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(raw_rows, 9)) + chunk(b"IEND", b"")


def write_all(out: Path) -> list[Path]:
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for name, recording in (("tray-idle", False), ("tray-recording", True)):
        for scale, suffix in ((1, ""), (2, "@2x")):
            size = BASE * scale
            path = out / f"{name}{suffix}.png"
            path.write_bytes(png(size, size, render(scale, recording)))
            written.append(path)
    return written


def main() -> None:
    default = Path(__file__).resolve().parent.parent / "app" / "src-tauri" / "icons" / "tray"
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=default)
    for p in write_all(ap.parse_args().out):
        print(p)


if __name__ == "__main__":
    main()
