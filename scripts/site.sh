#!/usr/bin/env bash
# 소개 사이트(GitHub Pages, site/)를 <출력 폴더>에 모은다: site/ + 스크린샷·아이콘(docs/images에서 복사, 저장소에 두 번 두지 않는다) + 릴리스 노트 페이지(docs/releases).
# 사용: scripts/site.sh [_site]   → 로컬 확인: python3 -m http.server -d _site 8080 → http://localhost:8080/
# 배포는 .github/workflows/pages.yml이 같은 스크립트로 한다. 주소는 https://sjoon21.github.io/Tractus/
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
OUT="${1:-$REPO/_site}"
rm -rf "$OUT"
mkdir -p "$OUT"
cp -R "$REPO/site/." "$OUT/"
mkdir -p "$OUT/assets/en" "$OUT/assets/ko"
cp "$REPO/docs/images/icon.png" "$OUT/assets/icon.png"
for s in note ask home; do
  for m in light dark; do
    cp "$REPO/docs/images/en/$s-$m.png" "$OUT/assets/en/"
    cp "$REPO/docs/images/$s-$m.png" "$OUT/assets/ko/"
  done
done
# 릴리스 노트(docs/releases/v*.md) → releases/ 페이지 + sitemap. markdown-it-py는 저장소 의존성에 넣지 않고 그때 받는다
uv run --no-project --quiet --with markdown-it-py==4.2.0 python "$REPO/scripts/releases_page.py" "$OUT"
echo "$OUT"
