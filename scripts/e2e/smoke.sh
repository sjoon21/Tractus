#!/usr/bin/env bash
# 미리보기 e2e 스모크 (smoke.mjs). 필요: Google Chrome, Node, 미리보기 서버 (cd app && pnpm dev).
#   scripts/e2e/smoke.sh [스크린샷 폴더]   (기본 e2e-shots, gitignore 대상은 아니니 저장소 밖을 권한다)
# playwright-core는 저장소 의존성에 넣지 않고 임시 폴더에 받는다 (스크린샷 스크립트와 같다).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd -P)"
OUT="$(cd "$(dirname "${1:-${TMPDIR:-/tmp}/tractus-e2e-shots}")" 2>/dev/null && pwd -P)/$(basename "${1:-tractus-e2e-shots}")"
curl -sf -o /dev/null "${PREVIEW_URL:-http://localhost:1420/preview.html}" || { echo "미리보기 서버가 없습니다: (cd app && pnpm dev)" >&2; exit 1; }
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cp "$REPO/scripts/e2e/smoke.mjs" "$T/"
(cd "$T" && npm init -y >/dev/null && npm i --silent --no-audit --no-fund playwright-core@1.56.1)
node "$T/smoke.mjs" "$OUT"
echo "스크린샷: $OUT"
