"""`tractus models list|download|remove`, `tractus doctor` (docs/desktop.md §2.15). cli.py가 `register(app)` 한 번으로 붙인다.
cli의 도우미(Events·console)는 부를 때 불러온다 (cli가 이 모듈을 불러오므로)."""

import json
import os
import signal
import threading

import typer

from tractus import diarize
from tractus import doctor as doc
from tractus import models_install as inst
from tractus import models_registry as reg
from tractus.paths import models_dir

STATE_LABEL = {"installed": "설치됨", "missing": "없음", "partial": "일부만 받음", "corrupt": "손상"}
LEVEL_LABEL = {"required": "필수", "recommended": "권장", "optional": "선택"}
ONE_OF_LABEL = "필수 (둘 중 하나)"  # level_note가 one_of인 필수 모델 (변환 엔진)


def _cli():
    from tractus import cli

    return cli


def _out(data: dict) -> None:
    print(json.dumps(data, ensure_ascii=False))


def _gb(n: int) -> str:
    return f"{n / 1e9:.1f}GB" if n >= 1e8 else f"{n / 1e6:.0f}MB"


def _error(message: str, code: str, model: str | None = None, exit_code: int = 1) -> None:
    cli = _cli()
    cli.Events.emit("error", message=message, code=code, **({"model": model} if model else {}))
    cli.console.print(f"[red]{cli.escape(message)}[/red]")
    raise typer.Exit(exit_code)


def register(app: typer.Typer) -> None:
    models_app = typer.Typer(help="모델 목록·받기·지우기 (모델 위치는 TRACTUS_MODELS_DIR, 기본 ~/Tractus/models)")
    app.add_typer(models_app, name="models")

    @models_app.command("list")
    def list_models(as_json: bool = typer.Option(False, "--json", help="JSON으로 출력 (데스크톱 앱용)")) -> None:
        """모델마다 설치 상태(installed|missing|partial|corrupt)를 보여 준다. 네트워크를 쓰지 않는다."""
        data = doc.models_list(models_dir())
        if as_json:
            return _out(data)
        print(f"모델 폴더: {data['models_dir']}  (남은 공간 {_gb(data['disk_free_bytes'])})")
        for m in data["models"]:
            print(f"{m['id']:<10} {STATE_LABEL[m['state']]:<7} {ONE_OF_LABEL if m.get('level_note') == 'one_of' else LEVEL_LABEL[m['level']]:<11} {_gb(m['size_bytes']):>7}  {m['name']} — {m['purpose']}")

    @models_app.command("download")
    def download_models(
        ids: list[str] = typer.Argument(None, help="모델 ID (tractus models list). 여러 개 가능"),
        preset: str = typer.Option(None, "--preset", help=f"{' | '.join(reg.PRESETS)}. ID와 함께 쓰면 합친다"),
        progress_json: bool = typer.Option(False, "--progress-json", help="진행 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
    ) -> None:
        """모델을 받는다. 이미 설치된 모델은 건너뛰고, 받다 만 모델은 이어받는다. SIGTERM이면 받던 파일을 남기고 멈춘다 (종료 코드 130)."""
        cli = _cli()
        cli.Events.enabled = progress_json
        helper = diarize._executable(diarize.fluid_bin())
        try:
            wanted = reg.resolve_ids(ids or [], preset, helper=helper)
        except ValueError as e:
            _error(str(e), "bad_argument", exit_code=2)
        if not wanted:
            _error("받을 모델이 없습니다. 모델 ID나 --preset을 지정하세요", "bad_argument", exit_code=2)
        if preset == "all" and not helper:
            cli._warn("fluid_skipped", "도우미 프로그램(tractus-diar)이 없어 9명 이상 참석자 구분 모델은 건너뜁니다")

        root, cancel = models_dir(), threading.Event()
        installed_before = [i for i in wanted if reg.inspect(i, root).installed]

        def stop(signum, _frame) -> None:
            if cancel.is_set():
                os._exit(128 + signum)  # 두 번째 신호: 응답 없는 네트워크 호출을 기다리지 않는다
            cancel.set()

        def emit(event: str, **data) -> None:
            cli.Events.emit(event, **data)
            if not progress_json and event == "stage":
                cli.console.print(f"받는 중 ({data['index']}/{data['count']}): {reg.get(data['model']).name} ({_gb(data['size_bytes'])})")

        previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            done = inst.download(wanted, root, emit, cancel)
        except inst.ModelError as e:
            _error(e.message, e.code, e.model)
        except inst.Cancelled:
            cli.Events.emit("cancelled")
            cli.console.print("멈췄습니다. 같은 명령을 다시 실행하면 이어서 받습니다.")
            raise typer.Exit(130) from None
        except Exception as e:  # noqa: BLE001 — 예상 밖 예외도 이벤트로 알린다
            _error(f"모델을 받지 못했습니다: {e}", inst.classify(e))
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        cli.Events.emit("done", models=done, already=installed_before)
        cli.console.print(f"모델 {len(done)}개를 받았습니다" + (f" (이미 설치됨 {len(installed_before)}개)" if installed_before else ""))  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)

    @models_app.command("remove")
    def remove_model(
        model_id: str = typer.Argument(..., metavar="ID", help="모델 ID"),
        yes: bool = typer.Option(False, "--yes", "-y", help="확인 없이 지운다 (데스크톱 앱용)"),
    ) -> None:
        """모델 폴더 하나를 지운다 (모델 폴더 안의 것만). 받는 중이면 거부한다. → {"id", "removed", "freed_bytes"}"""
        try:
            model = reg.resolve_ids([model_id], None)[0]
        except ValueError as e:
            _error(str(e), "bad_argument", exit_code=2)
        if not yes and not typer.confirm(f"{reg.get(model).name}({model})을(를) 지울까요?"):
            raise typer.Exit(1)
        try:
            _out(inst.remove(model, models_dir()))
        except inst.ModelError as e:
            _error(e.message, e.code, e.model)

    @app.command("doctor")
    def doctor_cmd(as_json: bool = typer.Option(False, "--json", help="JSON으로 출력 (데스크톱 앱용)")) -> None:
        """시스템·도구(ffmpeg, 녹음·화자 분리 도우미)·모델·기능별 준비 상태를 점검한다. 없는 것이 있어도 종료 코드 0."""
        data = doc.report(models_dir())
        if as_json:
            return _out(data)
        s = data["system"]
        print(f"시스템: {s['arch']}, macOS {s['macos_version'] or '-'}, 메모리 {s['memory_gb']}GB, 남은 공간 {_gb(s['disk_free_bytes'])} → {'OK' if s['meets_min'] else '최소 사양 미달 ' + ','.join(s['problems'])}")
        for name, t in data["tools"].items():
            print(f"도구 {name}: {'있음 ' + str(t.get('version') or t['path']) if t['found'] else '없음'}")
        print(f"변환 엔진: 권장 {data['recommended_track']}, 지금 쓰는 것 {data['effective_track'] or '없음'}")
        for c in data["capabilities"]:
            print(f"기능 {c['name']}: {'준비됨' if c['ready'] else '못 씀 (없는 것: ' + ', '.join(c['missing']) + ') → ' + c['hint']}")
