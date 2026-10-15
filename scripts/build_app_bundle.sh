#!/usr/bin/env bash
# 저장소 없이 도는 Tractus.app 만들기: 옮길 수 있는 파이썬 + tractus 코어와 의존성 + tractus-rec 을 앱 안(Contents/Resources)에 넣는다.
# 쓰는 곳: --out 폴더(기본 dist/bundle)와 app/src-tauri/target, app/dist(프런트 빌드). 저장소의 .venv·recorder/.build 는 건드리지 않는다.
# 서명은 ad-hoc(-)이다: 받은 사람은 첫 실행에서 Gatekeeper 경고를 거친다 (docs/setup.md "미리 만든 앱 받기").
# 인터넷: uv.lock 에 고정된 PyPI wheel 만 받고(sdist 는 거부), 그 밖에는 이미 있는 uv·pnpm·cargo 캐시를 쓴다. 안내서는 docs/setup.md.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="$REPO/dist/bundle"
CHECK_ONLY=0
WITH_FLUID=0
PY_SERIES="3.12"   # pyproject 의 requires-python(>=3.12)과 uv.lock 의 wheel(cp312) 기준

usage() {
  cat <<'USAGE'
사용법: scripts/build_app_bundle.sh [옵션]

  --check          아무것도 만들지 않고 필요한 도구만 확인합니다
  --out <폴더>     결과를 둘 폴더 (기본: dist/bundle). 결과: <폴더>/Tractus.app
  --with-fluid     9명 이상 참석자 구분용 tractus-diar 도 넣습니다 (Swift 6.2 이상, Xcode 26)
  -h, --help

만드는 순서: 옮길 수 있는 파이썬(uv 의 python-build-standalone) → 줄이기 → uv.lock 의존성(wheel)·tractus 설치 → 래퍼 →
tractus-rec 빌드 → tauri 릴리스 빌드(번들에 runtime/·bin/ 포함) → 서명(ad-hoc) → 검증.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --with-fluid) WITH_FLUID=1 ;;
    --out) [ $# -ge 2 ] || { echo "--out 뒤에 폴더를 적어 주세요" >&2; exit 2; }; OUT="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ -t 1 ]; then G=$'\033[32m'; R=$'\033[31m'; B=$'\033[1m'; N=$'\033[0m'; else G=""; R=""; B=""; N=""; fi
FAILS=0
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
fail() { printf '  %s✗%s %s\n' "$R" "$N" "$1"; FAILS=$((FAILS + 1)); }
step() { printf '\n%s== %s%s\n' "$B" "$1" "$N"; }
kb()   { du -sk "$1" | awk '{printf "%.0fMB", $1 / 1024}'; }
# 폴더 안의 Mach-O 파일 경로 (한 줄에 하나)
macho_files() { find "$@" -type f \( -name '*.so' -o -name '*.dylib' -o -perm -u+x \) -print0 | xargs -0 file | sed -n 's/ (for architecture [^)]*)//; s/:[[:space:]].*Mach-O.*//p' | sort -u; }

step "사전 조건 확인"
if [ "$(uname -s)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then ok "Apple Silicon Mac"; else fail "Apple Silicon(arm64) Mac이 필요합니다"; fi
for t in uv swift cargo pnpm node codesign ditto file; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t"; else fail "$t 이(가) 없습니다. scripts/bootstrap.sh 를 먼저 실행하세요"; fi
done
PY=""
if command -v uv >/dev/null 2>&1; then
  # python-build-standalone: uv 가 받는 옮길 수 있는 파이썬. 없으면 uv python install 이 받는다 (인터넷)
  PY="$(uv python find --no-project --managed-python "$PY_SERIES" 2>/dev/null || true)"
  if [ -n "$PY" ]; then ok "uv 관리 파이썬 $("$PY" -c 'import sys; print(sys.version.split()[0])') ($PY)"
  else ok "uv 관리 파이썬 $PY_SERIES 은 아직 없습니다 (uv python install $PY_SERIES 로 받습니다)"; fi
fi
if [ "$FAILS" -gt 0 ]; then echo; echo "부족한 것이 $FAILS 개 있습니다."; exit 1; fi
[ "$CHECK_ONLY" -eq 0 ] || { echo; echo "사전 조건이 갖춰졌습니다. 만들려면 --check 없이 실행하세요."; exit 0; }

START=$SECONDS
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd -P)"
STAGE="$OUT/.stage"
rm -rf "$STAGE"; mkdir -p "$STAGE/bin"
RT="$STAGE/runtime"
SP="$RT/lib/python$PY_SERIES/site-packages"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/app/src-tauri/tauri.conf.json" | head -1)"

step "1. 옮길 수 있는 파이썬"
[ -n "$PY" ] || { uv python install "$PY_SERIES"; PY="$(uv python find --no-project --managed-python "$PY_SERIES")"; }
BASE="$("$PY" -c 'import sys; print(sys.base_prefix)')"
cp -R "$BASE" "$RT"   # 심볼릭 링크는 그대로 둔다
# 옮겨도 되는지: 실행 파일이 libpython 을 @executable_path 기준으로 찾아야 하고, 설치 위치의 절대 경로가 남아 있으면 안 된다
otool -L "$RT/bin/python$PY_SERIES" | grep -q '@executable_path/../lib/libpython' || { echo "이 파이썬은 옮길 수 없습니다(libpython 이 @executable_path 기준이 아님)" >&2; exit 1; }
ok "python $("$RT/bin/python$PY_SERIES" -c 'import sys; print(sys.version.split()[0])') 복사 ($(kb "$RT"))"

step "2. 파이썬 줄이기 (tkinter·idle·테스트·pip·헤더 등 안 쓰는 것)"
BEFORE_PY="$(kb "$RT")"
# bin 에는 python3.12 만 남긴다: pip·idle·2to3 같은 스크립트는 만든 위치의 절대 경로 shebang 을 담고 있다
find "$RT/bin" -mindepth 1 ! -name "python$PY_SERIES" -delete
rm -rf "$RT/include" "$RT/share" "$RT/lib/pkgconfig" "$RT"/lib/tcl* "$RT"/lib/tk* "$RT"/lib/itcl* "$RT"/lib/thread* "$RT"/lib/libtcl* "$RT"/lib/libtk*
LIB="$RT/lib/python$PY_SERIES"
rm -rf "$LIB"/{test,idlelib,tkinter,turtledemo,ensurepip,lib2to3,pydoc_data,config-$PY_SERIES-darwin} "$LIB"/lib-dynload/_tkinter*.so "$LIB"/site-packages/*
rm -f "$RT/BUILD"
# uv 가 sysconfig 데이터(빌드용 정보)에 설치 위치를 적어 둔다. 실행에는 쓰이지 않는다(아래 검증이 확인)
{ grep -rIl "$BASE" "$RT" 2>/dev/null | grep -v '/_sysconfigdata_' || true; } | head -3 | while read -r f; do echo "  ! 설치 위치의 절대 경로가 남아 있음: $f"; done
ok "파이썬 $BEFORE_PY → $(kb "$RT")"

step "3. 의존성(uv.lock, wheel 만, 해시 검증)과 tractus 설치"
cd "$REPO"
uv export --frozen --no-dev --no-emit-project -o "$STAGE/requirements.txt" >/dev/null
# uv 는 이 Mac 의 macOS 버전으로 wheel 을 고른다(26 이면 mlx 의 macosx_26_0 wheel, minos 26.2 라 14.4~15 에서는 열리지 않는다).
# 그래서 uv.lock 에 macOS arm64 wheel 이 있는 패키지는 그중 가장 낮은 macOS 용(macosx_14_0)을 URL 과 해시로 고정한다. 아래 3단계 끝의 검사가 14.4 를 넘는 Mach-O 를 막는다.
# ponytail: 파이썬 3.12 에 맞는 wheel 이름만 단순 비교한다 (cp312·abi3·py3). 이름 규칙이 달라지면 packaging.tags 로 바꾼다.
"$PY" - "$REPO/uv.lock" "$STAGE/requirements.txt" <<'PIN'
import re, sys, tomllib
lock, req = sys.argv[1:]
pins = {}
for p in tomllib.load(open(lock, "rb"))["package"]:
    best = None
    for w in p.get("wheels", []):
        f = w["url"].rsplit("/", 1)[-1][:-4].split("-")
        m = re.fullmatch(r"macosx_(\d+)_(\d+)_(arm64|universal2)", f[-1])
        py, abi = f[-3], f[-2]
        if m and (py == "cp312" or py in ("py3", "py2.py3") or (abi == "abi3" and re.fullmatch(r"cp3(\d+)", py) and int(py[3:]) <= 12)):
            key = (int(m[1]), int(m[2]))
            if best is None or key < best[0]:
                best = (key, w)
    if best:
        pins[p["name"].lower().replace("_", "-")] = best[1]
out, block = [], []
def flush():
    if not block:
        return
    name = re.match(r"[A-Za-z0-9_.-]+", block[0])[0].lower().replace("_", "-")
    w = pins.get(name)
    out.extend([f"{name} @ {w['url']} \\\n", f"    --hash={w['hash']}\n"] if w else block)
    block.clear()
for line in open(req):
    if line and not line[0].isspace() and not line.startswith("#"):
        flush()
    if line.strip() and not line.startswith("#"):
        block.append(line)
flush()
open(req, "w").write("".join(out))
print(f"  macOS 최저 wheel 로 고정: {', '.join(sorted(pins)) or '없음'}")
PIN
# --only-binary: sdist 를 빌드하지 않는다. --require-hashes: uv.lock 의 sha256 과 맞지 않으면 설치하지 않는다. --target: 이 파이썬(uv 가 고칠 수 없게 표시한 환경)의 site-packages 에 직접 푼다
uv pip install --python "$RT/bin/python$PY_SERIES" --target "$SP" --only-binary :all: --no-deps --require-hashes --link-mode copy -r "$STAGE/requirements.txt" --quiet
uv build --wheel --out-dir "$STAGE/wheel" --quiet
uv pip install --python "$RT/bin/python$PY_SERIES" --target "$SP" --no-deps --link-mode copy "$STAGE"/wheel/tractus-*.whl --quiet
rm -rf "$STAGE/wheel" "$STAGE/requirements.txt"
ok "site-packages $(kb "$SP")"

step "4. 줄이기 (site-packages: tests·__pycache__·*.pyi)와 바이트코드 다시 만들기"
BEFORE_SP="$(kb "$SP")"
find "$SP" -type d \( -name tests -o -name __pycache__ \) -prune -exec rm -rf {} +
find "$SP" -type f -name '*.pyi' -delete
rm -rf "$SP/mlx/include" "$SP/mlx/share"   # 확장 모듈을 빌드할 때만 쓰는 헤더·cmake
rm -rf "$SP/bin"   # 의존성의 콘솔 스크립트(typer·mlx_lm.* 등): 만든 위치의 절대 경로 shebang 을 담고 있고, 앱은 runtime/bin/tractus 만 쓴다
# arm64 전용 앱이라 universal2 wheel 의 x86_64 조각은 버린다
find "$SP" -type f \( -name '*.so' -o -name '*.dylib' \) | while read -r f; do
  case "$(lipo -archs "$f" 2>/dev/null)" in *x86_64*arm64*|*arm64*x86_64*) lipo -thin arm64 "$f" -output "$f.thin" && mv "$f.thin" "$f" ;; esac
done
# 앱 안은 서명으로 봉인되어 실행 중에 쓰면 안 된다(PYTHONDONTWRITEBYTECODE=1). 그래서 미리 만든다.
# unchecked-hash: 원본 수정 시각을 보지 않는다 (복사하면 시각이 바뀌어 pyc 가 낡은 것으로 보이는 일을 막는다)
"$RT/bin/python$PY_SERIES" -m compileall -q -j0 --invalidation-mode unchecked-hash "$LIB" >/dev/null
ok "site-packages $BEFORE_SP → $(kb "$SP"), 전체 runtime $(kb "$RT")"

step "5. 코어 실행 래퍼 runtime/bin/tractus"
# 파이썬은 -I(= -E -s -P: PYTHON* 환경변수·사용자 site-packages·현재 폴더를 보지 않는다)로 띄운다. macOS 에서는 -I 로도 막지 못하는 PYTHONEXECUTABLE·__PYVENV_LAUNCHER__ 만 따로 지운다. 앱이 PYTHONUNBUFFERED·PYTHONIOENCODING 으로 주던 것은 -u -X utf8 로 대신 준다.
# 링크(~/.local/bin/tractus 등)로 불려도 진짜 위치를 찾도록 링크를 따라간다
cat > "$RT/bin/tractus" <<WRAP
#!/bin/sh
f=\$0
while [ -L "\$f" ]; do l=\$(readlink "\$f"); case \$l in /*) f=\$l ;; *) f=\$(dirname "\$f")/\$l ;; esac; done
d=\$(cd "\$(dirname "\$f")" && pwd -P)
unset PYTHONEXECUTABLE __PYVENV_LAUNCHER__
exec "\$d/python$PY_SERIES" -I -B -u -X utf8 -c 'import sys; sys.argv[0] = "tractus"; from tractus.cli import app; app()' "\$@"
WRAP
chmod +x "$RT/bin/tractus"
ok "$RT/bin/tractus"

step "6. 녹음 프로그램 tractus-rec"
swift build -c release --product tractus-rec --package-path "$REPO/recorder" --scratch-path "$STAGE/rec-build" 2>&1 | tail -2
cp "$STAGE/rec-build/release/tractus-rec" "$STAGE/bin/"
if [ "$WITH_FLUID" -eq 1 ]; then
  swift build -c release --package-path "$REPO/recorder/diar" --scratch-path "$STAGE/diar-build" 2>&1 | tail -2
  cp "$STAGE/diar-build/release/tractus-diar" "$STAGE/bin/"
fi
rm -rf "$STAGE/rec-build" "$STAGE/diar-build"
ok "bin/: $(ls "$STAGE/bin" | tr '\n' ' ')"

step "6b. 최소 macOS 검사: 앱이 약속한 14.4 를 넘는 Mach-O 가 없어야 한다"
# 안내서·Info.plist 는 macOS 14.4 이상이라고 말한다. wheel 이 더 새 macOS 용이면 14.4~15 에서 import 할 때 dlopen 에서 막힌다
TOO_NEW="$(macho_files "$RT" "$STAGE/bin" | while read -r f; do
  otool -l "$f" 2>/dev/null | awk -v f="$f" '/LC_BUILD_VERSION/{b=1} b&&$1=="minos"{v=$2; b=0} /LC_VERSION_MIN_MACOSX/{m=1} m&&$1=="version"{v=$2; m=0}
    END{split(v, a, "."); if (v != "" && a[1] * 100 + a[2] > 1404) print v "  " f}'
done)"
[ -z "$TOO_NEW" ] || { echo "macOS 14.4 보다 새 시스템을 요구하는 파일이 있습니다 (minos 버전  파일):" >&2; echo "$TOO_NEW" | head -20 >&2; exit 1; }
ok "모든 Mach-O 가 macOS 14.4 이하를 요구한다"

step "7. tauri 릴리스 빌드 (Resources 에 runtime/·bin/ 포함)"
# tauri.conf.json 에 고정하지 않고 --config 로 합친다: runtime/ 이 없는 install.sh 의 일반 빌드가 깨지지 않게
CONF="{\"bundle\":{\"resources\":{\"$STAGE/runtime\":\"runtime\",\"$STAGE/bin\":\"bin\"}}}"
cd "$REPO/app"
[ -d node_modules ] || pnpm install --frozen-lockfile
pnpm tauri build --bundles app --config "$CONF" 2>&1 | tail -8
APP_BUILT="$REPO/app/src-tauri/target/release/bundle/macos/Tractus.app"
[ -d "$APP_BUILT/Contents/Resources/runtime" ] || { echo "번들에 runtime/ 이 들어가지 않았습니다" >&2; exit 1; }
rm -rf "$OUT/Tractus.app"
ditto "$APP_BUILT" "$OUT/Tractus.app"
APP="$OUT/Tractus.app"

step "8. 서명 (ad-hoc): 안쪽 Mach-O 전부 → 앱"
# 안쪽부터 서명한다. 하드런타임 옵션은 주지 않는다: 켜면 ad-hoc 라이브러리를 불러오지 못한다(library validation)
macho_files "$APP/Contents/Resources" \
  | tr '\n' '\0' | xargs -0 -n 20 -P 8 codesign --force --sign - --timestamp=none 2>&1 | grep -v 'replacing existing signature' || true
codesign --force --deep --sign - --timestamp=none --entitlements "$REPO/app/src-tauri/Entitlements.plist" "$APP" 2>&1 | grep -v 'replacing existing signature' || true
codesign --verify --deep --strict "$APP" && ok "codesign --verify --deep --strict 통과"

step "끝"
rm -rf "$STAGE"
echo "앱:     $APP ($(kb "$APP"))"
echo "버전:   $VERSION"
echo "걸린 시간: $((SECONDS - START))초"
echo "다음:   scripts/make_dmg.sh \"$APP\""
