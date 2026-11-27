#!/usr/bin/env bash
# Windows 설치본(NSIS, 사용자별 설치) 만들기: 옮길 수 있는 파이썬 + tractus 코어와 의존성 + tractus-rec.exe 를 설치 폴더(runtime\·bin\)에 넣는다.
# macOS 판 scripts/build_app_bundle.sh 와 같은 규칙: uv.lock 의 wheel 만(해시 검증), 쓰지 않는 하위 패키지 줄이기(bundle_slim.py),
# 바이트코드 미리 만들기(unchecked-hash), bundle.resources 는 tauri.conf.json 에 고정하지 않고 --config 로 합친다.
# Windows(Git Bash)에서 돈다 (.github/workflows/windows-bundle.yml). 서명 없음, 업데이트 아티팩트 없음, ffmpeg 은 기본으로 넣지 않는다.
# 코어는 runtime\python.exe -I -B -u -X utf8 -m tractus.cli 로 띄운다: pip 콘솔 스크립트 tractus.exe 는 만든 곳의 파이썬 절대 경로를 품어 옮기면 깨진다
# (앱 app/src-tauri/src/paths.rs core_args, 코어 paths.tool_bin 이 이 배치를 안다). 설계: docs/windows/README.md W5.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT="$REPO/dist/windows"
CHECK_ONLY=0
FFMPEG_DIR=""
# python-build-standalone (MIT·PSF): 버전·sha256 고정. 올릴 때는 릴리스의 SHA256SUMS 에서 같은 파일 줄을 옮긴다 (두 주 이상 된 릴리스)
PBS_TAG="20261110"
PBS_PY="3.12.16"
PBS_FILE="cpython-$PBS_PY+$PBS_TAG-x86_64-pc-windows-msvc-install_only.tar.gz"
PBS_SHA256="e23fe5b16926de1d81661b1a97352e89fb167549c55a6825796ccd0f32ec7f1b"
# 경로 길이 검사에 쓰는 설치 폴더 예: 사용자 이름 20자 (Tauri NSIS currentUser 기본값 %LOCALAPPDATA%\Tractus)
INSTALL_PREFIX='C:\Users\aaaaaaaaaaaaaaaaaaaa\AppData\Local\Tractus\'

usage() {
  cat <<'USAGE'
사용법: scripts/build_windows_bundle.sh [옵션]   (Windows, Git Bash)

  --check           아무것도 만들지 않고 필요한 도구만 확인합니다
  --out <폴더>      결과를 둘 폴더 (기본: dist/windows). 결과: <폴더>/Tractus_<버전>_x64-setup.exe
  --ffmpeg <폴더>   그 폴더의 ffmpeg.exe·ffprobe.exe·*.dll 을 bin\ 에 넣습니다 (기본: 넣지 않음. LGPL 빌드만, 소유자 결정 대기)
  -h, --help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --out) [ $# -ge 2 ] || { echo "--out 뒤에 폴더를 적어 주세요" >&2; exit 2; }; OUT="$2"; shift ;;
    --ffmpeg) [ $# -ge 2 ] || { echo "--ffmpeg 뒤에 폴더를 적어 주세요" >&2; exit 2; }; FFMPEG_DIR="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "알 수 없는 옵션: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

FAILS=0
ok()   { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1"; FAILS=$((FAILS + 1)); }
step() { printf '\n== %s\n' "$1"; }
mb()   { du -sk "$1" | awk '{printf "%.0fMB", $1 / 1024}'; }

step "사전 조건 확인"
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ok "Windows ($(uname -s))" ;; *) fail "Windows(Git Bash)에서 실행하세요. macOS 는 scripts/build_app_bundle.sh" ;; esac
for t in uv cargo pnpm node curl tar sha256sum cygpath; do
  if command -v "$t" >/dev/null 2>&1; then ok "$t"; else fail "$t 이(가) 없습니다 (docs/windows/README.md 3절)"; fi
done
grep -qx tractus.cli "$REPO/scripts/bundle_modules.txt" 2>/dev/null && ok "scripts/bundle_modules.txt" || fail "scripts/bundle_modules.txt 가 없거나 비었습니다"
[ -z "$FFMPEG_DIR" ] || { [ -f "$FFMPEG_DIR/ffmpeg.exe" ] && ok "ffmpeg: $FFMPEG_DIR" || fail "$FFMPEG_DIR/ffmpeg.exe 가 없습니다"; }
if [ "$FAILS" -gt 0 ]; then echo; echo "부족한 것이 $FAILS 개 있습니다."; exit 1; fi
[ "$CHECK_ONLY" -eq 0 ] || { echo; echo "사전 조건이 갖춰졌습니다. 만들려면 --check 없이 실행하세요."; exit 0; }

START=$SECONDS
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd -P)"
STAGE="$OUT/.stage"
rm -rf "$STAGE"; mkdir -p "$STAGE/bin" "$OUT/.cache"
RT="$STAGE/runtime"
PY="$RT/python.exe"
SP="$RT/Lib/site-packages"
VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$REPO/app/src-tauri/tauri.conf.json" | head -1)"

step "1. 옮길 수 있는 파이썬 (python-build-standalone $PBS_PY+$PBS_TAG)"
TGZ="$OUT/.cache/$PBS_FILE"
if ! { [ -f "$TGZ" ] && echo "$PBS_SHA256  $TGZ" | sha256sum -c --status; }; then
  curl -sSfL --retry 3 -o "$TGZ" "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_TAG/${PBS_FILE//+/%2B}"
fi
echo "$PBS_SHA256  $TGZ" | sha256sum -c --status || { echo "sha256 이 맞지 않습니다: $TGZ" >&2; exit 1; }
# GNU tar 는 C:/… 를 원격 호스트로 읽으므로 상대 경로로 푼다. 묶음 안의 python\ 이 runtime\ 이 된다
(cd "$STAGE" && tar -xzf "../.cache/$PBS_FILE" && mv python runtime)
ok "python $("$PY" -I -c 'import sys; print(sys.version.split()[0])') ($(mb "$RT"))"

step "2. 파이썬 줄이기 (tkinter·idle·테스트·pip·헤더 등 안 쓰는 것)"
BEFORE="$(mb "$RT")"
rm -rf "$RT"/{include,libs,Scripts,tcl,pythonw.exe} "$RT"/DLLs/{_tkinter.pyd,tcl86t.dll,tk86t.dll,_ctypes_test.pyd} "$RT"/DLLs/_test*.pyd "$RT"/DLLs/xxlimited*.pyd
rm -rf "$RT"/Lib/{test,idlelib,tkinter,turtledemo,ensurepip,lib2to3,pydoc_data} "$SP"/*
ok "파이썬 $BEFORE → $(mb "$RT")"

step "3. 의존성(uv.lock, wheel 만, 해시 검증)과 tractus 설치"
cd "$REPO"
uv export --frozen --no-dev --no-emit-project -o "$STAGE/requirements.txt" >/dev/null
# --python 이 번들 파이썬이라 환경 표지(sys_platform == 'win32' 등)도 Windows 기준으로 고른다. mlx-metal 처럼 darwin 전용은 빠지고,
# win32 전용 onnxruntime·flatbuffers(텍스트 변환 런타임, docs/design/asr-onnx.md 9절)는 들어간다
uv pip install --python "$PY" --target "$SP" --only-binary :all: --no-deps --require-hashes --link-mode copy -r "$STAGE/requirements.txt" --quiet
uv build --wheel --out-dir "$STAGE/wheel" --quiet
uv pip install --python "$PY" --target "$SP" --no-deps --link-mode copy "$STAGE"/wheel/tractus-*.whl --quiet
# 콘솔 스크립트(tractus.exe·typer.exe 등)는 만든 곳의 파이썬 절대 경로를 품는다. 앱은 python.exe -m tractus.cli 만 쓴다
rm -rf "$STAGE/wheel" "$STAGE/requirements.txt" "$SP/bin" "$SP/Scripts"
ok "site-packages $(mb "$SP")"

step "4. 줄이기 (tests·__pycache__·*.pyi·쓰지 않는 하위 패키지)와 바이트코드"
BEFORE="$(mb "$SP")"
find "$SP" -type d \( -name tests -o -name __pycache__ \) -prune -exec rm -rf {} +
find "$SP" -type f -name '*.pyi' -delete
rm -rf "$SP/mlx/include" "$SP/mlx/share"
# macOS 와 같은 목록으로 transformers·mlx_audio·mlx_lm·scipy 의 하위 패키지를 지운다. Windows 만 쓰는 모듈(asr_onnx·onnxruntime·tokenizers)은
# 이 패키지들 밖이라 지워지지 않는다. 아래 5단계가 Windows 경로를 실제로 불러 확인한다
"$PY" -I -X utf8 "$REPO/scripts/bundle_slim.py" "$SP" "$REPO/scripts/bundle_modules.txt"
# 표준 라이브러리와 site-packages 를 모두 미리 만든다(slim 의 목록은 macOS 에서 쓴 모듈뿐이다). 앱은 -B 로 띄워 설치 폴더에 아무것도 쓰지 않는다
"$PY" -I -X utf8 -m compileall -q -j0 --invalidation-mode unchecked-hash "$RT/Lib" >/dev/null || echo "  ! 컴파일하지 못한 파일이 있습니다 (그 모듈은 불러올 때 메모리에서 컴파일한다)"
ok "site-packages $BEFORE → $(mb "$SP"), 전체 runtime $(mb "$RT")"

step "5. 번들 파이썬으로 코어 불러오기 (Windows 경로: 변환 어댑터·onnxruntime·MCP)"
"$PY" -I -B -X utf8 -c "import tractus.cli, tractus.mcp_server, tractus.asr_onnx, tractus.vad_onnx, onnxruntime, tokenizers; print('  onnxruntime', onnxruntime.__version__)"
"$PY" -I -B -u -X utf8 -m tractus.cli --help >/dev/null
ok "python.exe -I -B -u -X utf8 -m tractus.cli"

step "6. 녹음 프로그램 tractus-rec.exe"
# 저장소 빌드와 같은 recorder/win/target 을 쓴다 (CI 캐시, 같은 --release 결과라 덮어써도 된다)
cargo build --release --locked --manifest-path "$REPO/recorder/win/Cargo.toml" 2>&1 | tail -2
cp "$REPO/recorder/win/target/release/tractus-rec.exe" "$STAGE/bin/"
if [ -n "$FFMPEG_DIR" ]; then
  # shortcut: 코어는 PATH 의 ffmpeg 만 찾는다(audio.py). 넣기로 정하면 앱이 하위 프로세스 PATH 앞에 <설치 폴더>\bin 을 붙이고 NOTICE 에 적는다
  cp "$FFMPEG_DIR"/ffmpeg.exe "$STAGE/bin/"
  cp "$FFMPEG_DIR"/ffprobe.exe "$FFMPEG_DIR"/*.dll "$STAGE/bin/" 2>/dev/null || true
fi
ok "bin\\: $(ls "$STAGE/bin" | tr '\n' ' ')"

step "7. 경로 길이 (설치 폴더 예: $INSTALL_PREFIX)"
# Windows 기본 MAX_PATH 는 260자다(긴 경로 설정이 꺼진 기기). 넘는 파일은 설치·불러오기가 실패할 수 있다
"$PY" -I -X utf8 - "$STAGE" "$INSTALL_PREFIX" <<'LEN'
import os, sys
stage, prefix = sys.argv[1], sys.argv[2]
paths = sorted((len(prefix) + len(os.path.relpath(os.path.join(d, f), stage)), os.path.relpath(os.path.join(d, f), stage))
               for top in ("runtime", "bin") for d, _, fs in os.walk(os.path.join(stage, top)) for f in fs)
print(f"  파일 {len(paths)}개, 가장 긴 경로 {paths[-1][0]}자, 260자 이상 {sum(n >= 260 for n, _ in paths)}개")
for n, p in paths[-5:][::-1]:
    print(f"    {n}  {p}")
LEN

step "8. tauri 릴리스 빌드 (NSIS, currentUser, 설치 폴더에 runtime\\·bin\\)"
# tauri.conf.json 에 고정하지 않는다: 저장소 빌드(install.sh)와 macOS 번들이 그대로이게. JSON 은 파일로 넘긴다(pnpm.cmd 가 따옴표를 바꾸지 않게)
CONF="$STAGE/tauri.windows.json"
cat > "$CONF" <<JSON
{"bundle": {"resources": {"$(cygpath -m "$STAGE/runtime")": "runtime", "$(cygpath -m "$STAGE/bin")": "bin"},
            "windows": {"nsis": {"installMode": "currentUser"}}}}
JSON
cd "$REPO/app"
[ -d node_modules ] || pnpm install --frozen-lockfile
pnpm tauri build --bundles nsis --config "$(cygpath -m "$CONF")" 2>&1 | tail -8
# 이 판의 이름으로 고른다: 이전 빌드의 설치본(예: 0.5.9)이 같은 폴더에 남아 있어도 집지 않게
SETUP="$REPO/app/src-tauri/target/release/bundle/nsis/Tractus_${VERSION}_x64-setup.exe"
[ -f "$SETUP" ] || { echo "설치본이 없습니다: $SETUP" >&2; exit 1; }
cp "$SETUP" "$OUT/"
SETUP="$OUT/$(basename "$SETUP")"

step "끝"
rm -rf "$STAGE"
echo "설치본:   $SETUP ($(mb "$SETUP"))"
echo "버전:     $VERSION (서명 없음)"
echo "걸린 시간: $((SECONDS - START))초"
