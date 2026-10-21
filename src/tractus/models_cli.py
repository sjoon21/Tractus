"""`tractus models list|download|remove`, `tractus doctor` (docs/desktop.md §2.15). cli.py가 `register(app)` 한 번으로 붙인다.
cli의 도우미(Events·console)는 부를 때 불러온다 (cli가 이 모듈을 불러오므로)."""

import json
import os
import signal
import threading
from pathlib import Path

import typer

from tractus import diarize
from tractus import doctor as doc
from tractus import models_install as inst
from tractus import models_registry as reg
from tractus.i18n import t
from tractus.paths import models_dir

STATE_LABEL = {"installed": t("설치됨"), "missing": t("없음"), "partial": t("일부만 받음"), "corrupt": t("손상")}
LEVEL_LABEL = {"required": t("필수"), "recommended": t("권장"), "optional": t("선택")}
ONE_OF_LABEL = t("필수 (둘 중 하나)")  # level_note가 one_of인 필수 모델 (변환 엔진)


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
    models_app = typer.Typer(help="모델 목록·받기·지우기 (모델 위치는 TRACTUS_MODELS_DIR, 기본은 앱 설정 폴더의 models)")
    app.add_typer(models_app, name="models")

    @models_app.command("list")
    def list_models(as_json: bool = typer.Option(False, "--json", help="JSON으로 출력 (데스크톱 앱용)")) -> None:
        """모델마다 설치 상태(installed|missing|partial|corrupt)를 보여 준다. 네트워크를 쓰지 않는다."""
        data = doc.models_list(models_dir())
        if as_json:
            return _out(data)
        print(t("모델 폴더: {path}  (남은 공간 {free})", path=data["models_dir"], free=_gb(data["disk_free_bytes"])))
        for m in data["models"]:
            print(f"{m['id']:<10} {STATE_LABEL[m['state']]:<7} {ONE_OF_LABEL if m.get('level_note') == 'one_of' else LEVEL_LABEL[m['level']]:<11} {_gb(m['size_bytes']):>7}  {m['name']} — {m['purpose']}")
        if data["unregistered"]:
            print(t("등록되지 않은 폴더 {n}개 ({size}): tractus models prune", n=len(data["unregistered"]), size=_gb(sum(u["bytes"] for u in data["unregistered"]))))

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
            _error(t("받을 모델이 없습니다. 모델 ID나 --preset을 지정하세요"), "bad_argument", exit_code=2)
        if preset == "all" and not helper:
            cli._warn("fluid_skipped", t("도우미 프로그램(tractus-diar)이 없어 9명 이상 참석자 구분 모델은 건너뜁니다"))

        root, cancel = models_dir(), threading.Event()
        installed_before = [i for i in wanted if reg.inspect(i, root).installed]

        def stop(signum, _frame) -> None:
            if cancel.is_set():
                os._exit(128 + signum)  # 두 번째 신호: 응답 없는 네트워크 호출을 기다리지 않는다
            cancel.set()

        def emit(event: str, **data) -> None:
            cli.Events.emit(event, **data)
            if not progress_json and event == "stage":
                cli.console.print(t("받는 중 ({index}/{count}): {name} ({size})", index=data["index"], count=data["count"], name=reg.get(data["model"]).name, size=_gb(data["size_bytes"])))

        previous = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            done = inst.download(wanted, root, emit, cancel)
        except inst.ModelError as e:
            _error(e.message, e.code, e.model)
        except inst.Cancelled:
            cli.Events.emit("cancelled")
            cli.console.print(t("멈췄습니다. 같은 명령을 다시 실행하면 이어서 받습니다."))
            raise typer.Exit(130) from None
        except Exception as e:  # noqa: BLE001 — 예상 밖 예외도 이벤트로 알린다
            _error(t("모델을 받지 못했습니다: {error}", error=e), inst.classify(e))
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
        cli.Events.emit("done", models=done, already=installed_before)
        cli.console.print(t("모델 {n}개를 받았습니다", n=len(done)) + (t(" (이미 설치됨 {n}개)", n=len(installed_before)) if installed_before else ""))  # words-ok: 터미널 전용 (성공 경로라 앱이 보이지 않는다)

    @models_app.command("add")
    def add_model(
        repo: str = typer.Argument(..., metavar="REPO", help="Hugging Face 저장소 ID (예: mlx-community/whisper-large-v3-turbo). Qwen3-ASR·Whisper·SenseVoice 계열"),
        revision: str = typer.Option(None, "--revision", help="브랜치·태그·커밋. 생략하면 지금의 main을 커밋 해시로 고정한다"),
    ) -> None:
        """변환 엔진을 직접 추가한다 (받지는 않는다: 이어서 `tractus models download <ID>`). 네트워크로 파일 목록만 읽는다.
        → {"id", "repo", "revision", "engine", "size_bytes", "license"}. 같은 저장소를 다시 추가하면 리비전을 새로 고친다."""
        try:
            m = inst.add_custom(repo, models_dir(), revision)
        except inst.ModelError as e:
            _error(e.message, e.code, exit_code=2 if e.code in ("bad_repo", "unsupported_model", "unsupported_engine", "not_found") else 1)
        _out({"id": m.id, "repo": m.repo, "revision": m.revision, "engine": m.engine, "size_bytes": m.size_bytes, "license": m.license})

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
        if not yes and not typer.confirm(t("{name}({id})을(를) 지울까요?", name=reg.get(model).name, id=model)):
            raise typer.Exit(1)
        try:
            _out(inst.remove(model, models_dir()))
        except inst.ModelError as e:
            _error(e.message, e.code, e.model)

    @models_app.command("move")
    def move_models(
        dest: str = typer.Argument(..., help="새 모델 폴더"),
        yes: bool = typer.Option(False, "--yes", "-y", help="확인 없이 옮긴다 (데스크톱 앱용)"),
    ) -> None:
        """등록된 모델 폴더만 지금 모델 폴더에서 DEST로 옮긴다 (그 밖의 폴더는 그대로). 받는 중이면 거부한다. → {"moved", "freed_bytes"}"""
        if not yes and not typer.confirm(t("{src}의 모델을 {dest}(으)로 옮길까요?", src=models_dir(), dest=dest)):
            raise typer.Exit(1)
        try:
            _out(inst.move(models_dir(), Path(dest)))
        except inst.ModelError as e:
            _error(e.message, e.code, e.model)

    @models_app.command("prune")
    def prune_models(
        yes: bool = typer.Option(False, "--yes", "-y", help="확인 없이 지운다 (데스크톱 앱용)"),
        as_json: bool = typer.Option(False, "--json", help="결과를 JSON으로 출력 (데스크톱 앱용)"),
    ) -> None:
        """모델 폴더 바로 아래의 등록되지 않은 폴더(옛 버전 모델 등)를 지운다. 숨김·파일·심볼릭 링크는 건드리지 않고, 받는 중이면 거부한다.
        → {"removed": [{"name", "bytes"}], "freed_bytes"}"""
        root = models_dir()
        found = inst.unregistered(root)
        for u in found:  # 미리 보기는 stderr: stdout은 결과 JSON 하나만 나간다
            typer.echo(f"{u['name']:<40} {_gb(u['bytes']):>7}", err=True)
        if found and not yes and not typer.confirm(t("위 폴더 {n}개({size})를 지울까요?", n=len(found), size=_gb(sum(u["bytes"] for u in found))), err=True):
            raise typer.Exit(1)
        try:
            result = inst.prune(root)
        except inst.ModelError as e:
            _error(e.message, e.code, e.model)
        if as_json:
            return _out(result)
        print(t("{n}개를 지웠습니다 ({size} 확보)", n=len(result["removed"]), size=_gb(result["freed_bytes"])) if found else t("지울 폴더가 없습니다"))

    @app.command("doctor")
    def doctor_cmd(as_json: bool = typer.Option(False, "--json", help="JSON으로 출력 (데스크톱 앱용)")) -> None:
        """시스템·도구(ffmpeg, 녹음·화자 분리 도우미)·모델·기능별 준비 상태를 점검한다. 없는 것이 있어도 종료 코드 0."""
        data = doc.report(models_dir())
        if as_json:
            return _out(data)
        s = data["system"]
        verdict = "OK" if s["meets_min"] else t("최소 사양 미달 {problems}", problems=",".join(s["problems"]))
        print(t("시스템: {arch}, macOS {version}, 메모리 {memory}GB, 남은 공간 {free} → {verdict}", arch=s["arch"], version=s["macos_version"] or "-", memory=s["memory_gb"], free=_gb(s["disk_free_bytes"]), verdict=verdict))
        for name, tool in data["tools"].items():
            print(t("도구 {name}: 있음 {detail}", name=name, detail=tool.get("version") or tool["path"]) if tool["found"] else t("도구 {name}: 없음", name=name))
        print(t("변환 엔진: 권장 {recommended}, 지금 쓰는 것 {effective}", recommended=data["recommended_track"], effective=data["effective_track"] or t("없음")))
        for c in data["capabilities"]:
            state = t("준비됨") if c["ready"] else t("못 씀 (없는 것: {missing}) → {hint}", missing=", ".join(c["missing"]), hint=c["hint"])
            print(t("기능 {name}: {state}", name=c["name"], state=state))
