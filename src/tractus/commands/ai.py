"""AI 명령: 요약(summarize)·질문(ask)·AI 서비스 연결(llm test|models). 원격 AI 서비스(OpenAI 호환)로 노트 내용을 보낸다."""

import json
import sys
import time
from pathlib import Path

from rich.markup import escape
import typer

from tractus.calendar_event import load_event
from tractus import llm
from tractus.commands import common
from tractus.i18n import t
from tractus.paths import home_dir
from tractus.paths import models_dir
from tractus.store import NOT_CONVERTED
from tractus.store import is_memo
from tractus.store import is_recorded
from tractus.store import load_glossary
from tractus.store import stamp

app = typer.Typer()  # 이 영역의 명령. cli.py가 이름 없이 붙여 한 층으로 합친다


@app.command()
def summarize(
    meeting: str = typer.Argument(..., help="노트 폴더 경로 또는 meeting_id (일부만 써도 됨)"),
    provider: str = typer.Option(None, "--provider", help="upstage | openai | claude | gemini | custom | gemma-local. 생략하면 TRACTUS_LLM_PROVIDER"),
    model: str = typer.Option(None, "--model", help="모델 ID. 생략하면 TRACTUS_LLM_MODEL 또는 공급자 기본값"),
    progress_json: bool = typer.Option(False, "--progress-json", help="진행 이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
    template: str = typer.Option(None, "--template", help="요약 유형 ID (`tractus templates list`). 생략하면 meeting(회의록): summary.json·summary.md. 다른 유형은 summaries/<ID>.json·md"),
    custom: bool = typer.Option(False, "--custom", help='직접 쓴 요약 방법으로 요약한다. stdin의 {"prompt": "…", "save_as"?: "이름", "key"?: "c-…"}. save_as가 있으면 내 요약 유형으로도 저장한다. --template과 함께 쓸 수 없다'),
) -> None:
    """전사본으로 요약을 만든다. 기본(회의록)은 요약·결정 사항·할 일을 summary.md와 summary.json에, 다른 유형·직접 요약은 summaries/ 폴더에 저장한다. 전사 텍스트와 요약 지침만 공급자에 전송한다.
    done 이벤트의 summary_key는 저장한 요약의 key다 (`tractus summaries <노트> list`)."""
    from tractus import enhance, minutes, summaries as sums, summarize as summ

    common.Events.enabled = progress_json
    try:
        d = common.resolve_meeting(meeting)
    except typer.BadParameter as e:
        common.emit_error(str(e))
        raise
    if template == enhance.KEY:  # 노트 완성: 요약 유형 목록에 없는 전용 경로 (docs/design/enhanced-notes.md)
        if custom:
            common.fail(t("요약 유형과 직접 입력은 함께 쓸 수 없습니다."), code="bad_input", exit_code=2)
        return _enhance(d, provider, model)
    if template == minutes.KEY:  # 회의록: 요약 유형 목록에 없는 전용 경로 (docs/design/meeting-minutes.md)
        if custom:
            common.fail(t("요약 유형과 직접 입력은 함께 쓸 수 없습니다."), code="bad_input", exit_code=2)
        return _minutes(d, provider, model)
    try:
        spec = sums.resolve_spec(home_dir(), template, sys.stdin.read() if custom else None)
    except ValueError as e:
        common.fail(str(e), code="bad_input", exit_code=2)
    transcript = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    if is_recorded(transcript):
        common.fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    if not transcript["segments"]:
        common.fail(t("메모가 비어 있어 요약할 수 없습니다") if is_memo(transcript) else t("인식된 대화가 없어 요약할 수 없습니다"), code="no_segments")
    try:
        p, m = llm.resolve_provider(provider, model)
        t0 = time.perf_counter()
        common.Events.emit("stage", stage="summarize")
        with common.console.status(t("{provider}/{model}로 요약 중… (세그먼트 {n}개)", provider=p.name, model=m, n=len(transcript["segments"]))):
            result = summ.summarize(llm.make_client(p), p, m, transcript) if spec.is_default else sums.summarize_generic(llm.make_client(p), p, m, transcript, spec)
    except llm.LLMError as e:
        if e.code == "llm_invalid":  # 검증 오류 원문(pydantic, s0012 ID)은 stderr에만 남긴다
            common.console.print(f"[red]{escape(str(e))}[/red]")  # 검증 오류의 [type=…] 같은 대괄호를 rich 마크업으로 해석하지 않게 한다
            common.fail(t("AI 응답이 형식에 맞지 않아 요약하지 못했습니다"), code=e.code)
        common.fail(str(e), code=e.code)
    try:
        if spec.is_default:
            summ.write_summary(d, result, transcript, p.name, m)
        key = sums.DEFAULT_KEY if spec.is_default else sums.write_generic(home_dir(), d, spec, result, transcript, p.name, m)
    except ValueError as e:  # 내 요약 유형으로 저장하지 못함 (50개 한도 등)
        common.fail(str(e), code="bad_input", exit_code=2)
    if spec.is_default:  # 유형별 요약(summaries/)은 검색 색인에 들어가지 않는다
        common.Events.emit("stage", stage="index")
        common.sync_index_quietly(embed=False)  # 요약은 색인에 없다: 밀린 청크를 임베딩하느라(모델 1.4 GB) 완료가 늦지 않게. 벡터는 앱의 조용한 색인이 채운다
    common.Events.emit("done", meeting_id=transcript["meeting_id"], meeting_dir=str(d), summary_key=key)
    detail = (
        t("주제 {topics}개, 결정 {decisions}개, 할 일 {actions}개", topics=len(result.topics), decisions=len(result.decisions), actions=len(result.action_items)) if spec.is_default
        else t("항목 {n}개", n=sum(len(x.items) for x in result.sections))
    )
    common.console.print(t("완료: {detail} ({sec}초)", detail=detail, sec=f"{time.perf_counter() - t0:.0f}") + f"\n{sums.paths(d, key)[1]}")


def _enhance(d: Path, provider: str | None, model: str | None) -> None:
    """summarize --template enhanced: 내 메모를 뼈대로 대화 내용의 세부를 붙인 완성된 노트 (summaries/enhanced.json)."""
    from tractus import enhance, summaries as sums

    transcript = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    if is_memo(transcript):
        common.fail(enhance.NO_RECORDING, code="no_recording", exit_code=2)
    if is_recorded(transcript):
        common.fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    if not transcript["segments"]:
        common.fail(t("인식된 대화가 없어 노트를 완성할 수 없습니다"), code="no_segments")
    try:
        p, m = llm.resolve_provider(provider, model)
        t0 = time.perf_counter()
        common.Events.emit("stage", stage="summarize")
        with common.console.status(t("{provider}/{model}로 노트 완성 중… (세그먼트 {n}개)", provider=p.name, model=m, n=len(transcript["segments"]))):
            result = enhance.enhance(llm.make_client(p), p, m, transcript, d)
    except llm.LLMError as e:
        if e.code == "llm_invalid":
            common.console.print(f"[red]{escape(str(e))}[/red]")
            common.fail(t("AI 응답이 형식에 맞지 않아 노트를 완성하지 못했습니다"), code=e.code)
        common.fail(str(e), code=e.code)
    key = enhance.write(d, transcript, result, p.name, m)
    common.Events.emit("done", meeting_id=transcript["meeting_id"], meeting_dir=str(d), summary_key=key)
    common.console.print(t("완료: 블록 {n}개 ({sec}초)", n=len(result["sections"]), sec=f"{time.perf_counter() - t0:.0f}") + f"\n{sums.paths(d, key)[1]}")


def _minutes(d: Path, provider: str | None, model: str | None) -> None:
    """summarize --template minutes: 회의록 (summaries/minutes.json). 녹음 노트만."""
    from tractus import minutes, summaries as sums

    transcript = json.loads((d / "transcript.json").read_text(encoding="utf-8"))
    if is_memo(transcript):
        common.fail(t("녹음이 없는 노트는 회의록을 만들 수 없습니다"), code="no_recording", exit_code=2)  # words-ok: 회의록은 문서 이름
    if is_recorded(transcript):
        common.fail(NOT_CONVERTED, code="not_converted", exit_code=2)
    if not transcript["segments"]:
        common.fail(t("인식된 대화가 없어 회의록을 만들 수 없습니다"), code="no_segments")  # words-ok: 회의록은 문서 이름
    try:
        p, m = llm.resolve_provider(provider, model)
        t0 = time.perf_counter()
        common.Events.emit("stage", stage="summarize")
        with common.console.status(t("{provider}/{model}로 회의록 작성 중… (세그먼트 {n}개)", provider=p.name, model=m, n=len(transcript["segments"]))):  # words-ok: 회의록은 문서 이름
            result = minutes.make(llm.make_client(p), p, m, transcript, load_glossary(home_dir() / "glossary.md"))
    except llm.LLMError as e:
        if e.code == "llm_invalid":
            common.console.print(f"[red]{escape(str(e))}[/red]")
            common.fail(t("AI 응답이 형식에 맞지 않아 회의록을 만들지 못했습니다"), code=e.code)  # words-ok: 회의록은 문서 이름
        common.fail(str(e), code=e.code)
    key = minutes.write(d, transcript, result, minutes.attendees(transcript, load_event(d)), p.name, m)
    common.Events.emit("done", meeting_id=transcript["meeting_id"], meeting_dir=str(d), summary_key=key)
    common.console.print(t("완료: 안건 {n}개, 할 일 {m}개 ({sec}초)", n=len(result["topics"]), m=len(result["actions"]), sec=f"{time.perf_counter() - t0:.0f}") + f"\n{sums.paths(d, key)[1]}")


def _save_chat(d: Path, question: str, done: dict) -> None:
    from tractus.ask import save_chat

    try:
        save_chat(d, common.read_transcript(d)["meeting_id"], {"question": question, **{k: done[k] for k in ("answer", "citations", "provider", "model", "no_evidence")}})
    except (OSError, ValueError) as e:  # ValueError: 깨졌거나 다른 형식의 chat.json (덮어쓰지 않음)
        common.warn("chat_save_failed", t("질문 기록을 저장하지 못했습니다: {error}", error=e))


@app.command()
def ask(
    meeting: str = typer.Option(None, "--meeting", help="이 노트 전사 전체로 답한다 (meeting_id 일부 또는 폴더). 생략하면 모든 노트에서 검색"),
    date_from: str = typer.Option(None, "--from", help="YYYY-MM-DD (전체 범위 검색에만)", callback=lambda v: common.iso_date(v, "--from")),
    date_to: str = typer.Option(None, "--to", help="YYYY-MM-DD (전체 범위 검색에만)", callback=lambda v: common.iso_date(v, "--to")),
    provider: str = typer.Option(None, "--provider", help="upstage | openai | claude | gemini | custom | gemma-local. 생략하면 TRACTUS_LLM_PROVIDER"),
    model: str = typer.Option(None, "--model", help="모델 ID. 생략하면 TRACTUS_LLM_MODEL 또는 공급자 기본값"),
    save: bool = typer.Option(False, "--save", help="질문·답을 노트 폴더 chat.json에 덧붙인다 (--meeting과 함께)"),
    progress_json: bool = typer.Option(False, "--progress-json", help="이벤트를 stdout에 JSON Lines로 출력 (데스크톱 앱용)"),
) -> None:
    """노트에 질문한다. stdin: {"question": "…", "history": [{"role", "content"}]} 또는 질문 평문.
    공급자에는 질문, 최근 대화, 근거 세그먼트만 보낸다. 답의 문장마다 [s0012] 인용이 붙는다."""
    from tractus import ask as qa

    common.Events.enabled = progress_json

    try:
        question, history = qa.parse_request(sys.stdin.read())
    except ValueError as e:
        common.fail(str(e))
    if save and not meeting:
        common.fail(t("--save는 --meeting과 함께만 쓸 수 있습니다 (노트 폴더의 chat.json에 저장)"))
    try:
        d = common.resolve_meeting(meeting) if meeting else None
    except typer.BadParameter as e:
        common.fail(e.message)

    def search(**kw) -> list[dict]:
        from tractus.embed import load_embedder
        from tractus.index import Index

        idx = Index(home_dir(), embedder=load_embedder(models_dir()))  # 질의 임베딩 때만 모델을 올린다 (LazyEmbedder)
        try:
            idx.sync(embed=False)  # 새 벡터는 만들지 않는다: 노트가 많으면 몇 분 걸린다. 벡터 없는 청크는 키워드로 찾힌다
            return qa.search_sources(idx, question, history, **kw)
        finally:
            idx.close()

    def get_sources() -> list[dict]:
        if d is None:
            return search(date_from=date_from, date_to=date_to)
        note = common.read_transcript(d)
        src = qa.transcript_sources(note)
        if is_recorded(note) and not src:
            common.warn("not_converted", NOT_CONVERTED)  # 변환 전 노트: 대화 내용이 없고 메모도 없으면 LLM을 부르지 않고 '근거 없음'으로 끝난다
        return search(meeting_id=note["meeting_id"]) if qa.too_long(src) else src

    try:
        p, m = llm.resolve_provider(provider, model)
        done = None
        for ev in qa.ask(llm.make_client(p), p.name, m, question, history, "global" if d is None else "meeting", get_sources, policy=p):
            if ev["event"] == "done":
                done = ev
                if save:  # done보다 먼저 저장한다: 앱이 done을 받은 직후 프로세스를 끝내도 기록이 남는다
                    _save_chat(d, question, ev)
            common.Events.emit(ev["event"], **{k: v for k, v in ev.items() if k != "event"})
    except llm.LLMError as e:
        common.fail(str(e), code=e.code)
    if not progress_json and done:
        print(done["answer"])
        if done["citations"]:
            print("\n" + t("근거:"))
        for c in done["citations"]:
            sid = c["segment_id"] if d else f"{c['meeting_id']}#{c['segment_id']}"
            print(f"  [{sid} {stamp(c)}]")


llm_app = typer.Typer(help="AI 서비스 연결 (요약·질문)")


@llm_app.command("test")
def llm_test(
    provider: str = typer.Option(None, "--provider", help="upstage | openai | claude | gemini | custom | gemma-local. 생략하면 TRACTUS_LLM_PROVIDER"),
    model: str = typer.Option(None, "--model", help="모델 ID. 생략하면 TRACTUS_LLM_MODEL 또는 공급자 기본값"),
) -> None:
    """연결 테스트: 아주 짧은 요청 한 번(30초 제한). 실제 요약·질문과 같은 해석·환경변수를 쓴다.
    성공하면 한 줄 JSON {"ok", "provider", "model", "host", "latency_ms"}, 실패하면 error 이벤트 한 줄 + 종료 코드 1. 키는 출력하지 않는다."""
    common.Events.enabled = True  # 앱이 stdout의 JSON 한 줄을 읽는다
    try:
        p, m = llm.resolve_provider(provider, model)
        print(json.dumps(llm.check_connection(p, m), ensure_ascii=False))
    except llm.LLMError as e:
        common.fail(str(e), code=e.code)


@llm_app.command("models")
def llm_models(
    provider: str = typer.Option(None, "--provider", help="upstage | openai | claude | gemini | custom | gemma-local. 생략하면 TRACTUS_LLM_PROVIDER"),
) -> None:
    """서비스가 알려 주는 AI 모델 ID 목록 (GET <주소>/models). 성공하면 한 줄 JSON {"models": [ID…]}, 실패하면 error 이벤트 한 줄 + 종료 코드 1 (`llm test`와 같은 코드)."""
    common.Events.enabled = True
    try:
        p, _ = llm.resolve_provider(provider, None, need_model=False)
        print(json.dumps({"models": llm.list_models(p)}, ensure_ascii=False))
    except llm.LLMError as e:
        common.fail(str(e), code=e.code)
app.add_typer(llm_app, name="llm")
