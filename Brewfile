# Tractus 개발·빌드 도구. scripts/bootstrap.sh 가 이 파일을 읽어 빠진 것만 설치합니다.
# 직접 설치하려면: brew bundle --file Brewfile
# 이미 다른 방법(rustup, nvm 등)으로 PATH에 있는 도구는 bootstrap.sh 가 건너뜁니다.

# 앱(Tauri) 백엔드 컴파일. cargo 가 필요합니다.
brew "rust"
# 앱 프런트엔드(Vite) 빌드. 22.12 이상이 필요합니다.
brew "node"
# 앱 의존성 설치(app/pnpm-lock.yaml 을 그대로 재현).
brew "pnpm"
# Python 코어(tractus 명령)와 가상환경 관리. Python도 uv 가 알아서 받습니다.
brew "uv"
# 오디오 디코딩(텍스트 변환, 파일 가져오기). 앱에 넣지 않고 따로 설치합니다.
brew "ffmpeg"
