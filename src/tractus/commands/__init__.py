"""tractus 명령 모듈. 영역마다 한 모듈이고, `cli.py`는 앱을 만들어 이들을 붙일 뿐이다.

- common    명령들이 함께 쓰는 도구 (진행 이벤트·오류·노트 찾기·색인 갱신). 어떤 명령도 불러오지 않는다
- 나머지     각자 Typer 앱을 하나 이상 가지며, cli.py가 `app.add_typer(...)`로 붙인다

의존은 한 방향이다: cli → 명령 모듈 → common. 명령 모듈끼리는 서로 불러오지 않는다(공용이 필요하면 common으로 옮긴다).
테스트는 "쓰는 곳"의 이름을 바꿔 끼운다: 도구는 `common.warn`처럼 모듈 이름으로 불러 쓰므로 `monkeypatch.setattr(common, "warn", …)` 한 번이면 모든 명령에 먹는다.
"""

import os
import warnings

# 무거운 라이브러리(mlx-audio 등)를 불러오기 전에: 진행 막대·경고가 앱의 stdout/stderr를 어지럽히지 않게
os.environ.setdefault("TQDM_DISABLE", "1")
warnings.filterwarnings("ignore")
