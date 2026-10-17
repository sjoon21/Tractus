#!/usr/bin/env bash
# README 데모 GIF(docs/images/demo.gif) 다시 만들기: 앱 미리보기(가짜 데이터) 녹화 + Claude Code 답 화면 → GIF.
# 필요: Google Chrome, ffmpeg, Node. 미리보기 서버가 떠 있어야 한다: (cd app && pnpm dev) → http://localhost:1420/preview.html
# playwright-core는 저장소 의존성에 넣지 않고 임시 폴더에 받는다. 터미널 화면의 답은 실제 플러그인 답(가상 회의)을 줄인 것이다.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
curl -sf -o /dev/null http://localhost:1420/preview.html || { echo "미리보기 서버가 없습니다: (cd app && pnpm dev)" >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg가 필요합니다: brew install ffmpeg" >&2; exit 1; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cp "$REPO"/scripts/demo/{demo-app.mjs,demo-term.mjs,screencast.mjs,terminal.html} "$T/"
(cd "$T" && npm init -y >/dev/null && npm i --silent --no-audit --no-fund playwright-core@1.56.1)
node "$T/demo-app.mjs" "$T/app"
node "$T/demo-term.mjs" "$T/term"
for f in app term; do
  ffmpeg -loglevel error -y -f concat -safe 0 -i "$T/$f/list.txt" -vf "fps=15,scale=1280:800,setsar=1" -pix_fmt yuv420p "$T/$f.mp4"
done
ffmpeg -loglevel error -y -i "$T/app.mp4" -i "$T/term.mp4" -filter_complex \
  "[0:v][1:v]concat=n=2:v=1[v];[v]fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  "$REPO/docs/images/demo.gif"
echo "docs/images/demo.gif ($(du -h "$REPO/docs/images/demo.gif" | cut -f1))"
