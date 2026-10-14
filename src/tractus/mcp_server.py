"""Tractus MCP 서버 (stdio). Claude Code · Codex CLI · Antigravity CLI가 로컬 회의 기록을 도구로 쓴다.

- LLM을 호출하지 않는다. 요약·추론은 호출한 에이전트가 자기 모델로 한다(ARCHITECTURE.md §5).
- stdout은 JSON-RPC 전용이다. 로그는 stderr로만 보낸다.
- 도구는 모두 async로 둔다. SDK는 sync 도구를 워커 스레드에서 돌리는데, sqlite 연결과 MLX 스트림은 스레드에 묶여 있다.

    TRACTUS_HOME=~/Tractus uv run --project /path/to/Tractus tractus mcp
"""

import json
import logging
import sys
from pathlib import Path
from typing import Annotated

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp_types import ToolAnnotations
from pydantic import BaseModel, Field

from tractus import organize
from tractus.index import Index
from tractus.store import find_meeting_dir, is_recorded, memo_segments, seg_text, speaker_name, stamp
from tractus.summarize import MeetingSummary, check_segment_ids, write_summary
from tractus.summaries import DEFAULT_KEY, has_any_summary, list_summaries, read_markdown

log = logging.getLogger("tractus.mcp")

INSTRUCTIONS = """Tractus: 사용자의 로컬 회의 기록(음성 전사·요약)을 조회한다. 데이터는 사용자 기기에 있다.
- 과거 회의에 관한 질문은 먼저 search_meetings로 근거를 찾고, 답에는 실제로 근거가 된 세그먼트의 cite 값([meeting_id#s0012 00:05:31])을 그대로 붙인다. 검색 결과 하나에 세그먼트가 여러 개 들어 있으니 내용이 있는 세그먼트를 골라 인용한다.
- "7월 회의", "지난주"처럼 시점이 있으면 date_from/date_to(YYYY-MM-DD)를 채운다. 어떤 회의가 있는지는 list_meetings로 본다.
- 결정 사항·할 일은 get_summary, list_action_items로 본다. 전사 원문은 get_transcript로 페이지 단위(next_offset)로 읽는다.
- kind가 memo인 노트는 사용자가 직접 쓴 메모다. 오디오·시각이 없고 세그먼트는 본문의 한 줄이다. 시각 자리에는 'n번째 줄'이 붙는다.
- 녹음 노트에는 사용자가 직접 적은 메모가 있을 수 있다(검색 결과의 source가 memo이고 id가 m0001 같은 줄). 메모 줄은 음성 인식이 아니라 사용자가 쓴 글이고 시각 대신 '메모 n번째 줄'이 붙는다. get_transcript는 전사 끝에 memo 구간으로 보여 준다. 근거로 쓸 때는 cite 값을 그대로 붙인다.
- state가 recorded인 노트는 녹음만 하고 아직 텍스트로 변환하지 않은 노트다. 전사(세그먼트)가 없고 사용자가 적은 메모만 있을 수 있다. 요약·전사 근거는 사용자가 앱에서 '텍스트로 변환'을 한 뒤에 생길 수 있다.
- 노트에는 사용자가 정리한 즐겨찾기(favorite)·태그(tags)·폴더(folder)가 있을 수 있다. "태그 X 노트", "프로젝트 폴더의 노트"처럼 범위가 있으면 list_meetings·search_meetings의 tag·folder·favorite로 좁힌다 (folder는 이름 또는 folder_id, 하위 폴더 포함, none이면 폴더 없는 노트).
- 전사는 음성 인식 결과라 오인식이 있을 수 있다. 화자는 목소리로 자동 추정한 값이다(틀릴 수 있음). S1·S2 같은 라벨은 사람 이름이 아니고, 이름으로 보이면 사용자가 지정한 것이다. 화자 표시가 없으면 모르는 것이다.
- 요약을 만들어 달라는 요청이면 get_transcript로 전사를 끝까지 읽고, save_summary로 저장한다. 모든 항목에 근거 segment_ids를 넣는다."""

READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=False)
WRITES_SUMMARY = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=True, openWorldHint=False)

Date = Annotated[str | None, Field(description="YYYY-MM-DD (포함). 회의 날짜 기준", pattern=r"^\d{4}-\d{2}-\d{2}$")]
MeetingRef = Annotated[str, Field(description="meeting_id (뒤 6–8자만 써도 됨) 또는 회의 폴더 경로")]
Tag = Annotated[str | None, Field(description="이 태그가 붙은 노트만 (대소문자 구분 없음)")]
FolderRef = Annotated[str | None, Field(description="폴더 이름 또는 folder_id (하위 폴더 포함), none이면 폴더 없는 노트")]
Favorite = Annotated[bool, Field(description="true면 즐겨찾기한 노트만")]


def _who(t: dict, s: dict) -> str:
    name = speaker_name(t, s.get("speaker"))
    return f" {name}" if name else ""


def _cite(meeting_id: str, segment_ids: list[str], where: str) -> str:
    return f"[{meeting_id}#{segment_ids[0] if segment_ids else '-'} {where}]"


class HitSegment(BaseModel):
    id: str = Field(description="세그먼트 ID. 녹음 노트의 사용자 메모 줄은 m0001 같은 ID")
    source: str = Field(default="transcript", description="transcript(음성 인식 전사, 메모 노트의 줄 포함) | memo(녹음 노트에 사용자가 직접 적은 메모 줄)")
    time: str = Field(description="HH:MM:SS. 메모 노트는 시각이 없어 'n번째 줄', 녹음 노트의 사용자 메모 줄은 '메모 n번째 줄'")
    line: int | None = Field(default=None, description="메모 노트의 줄 번호, 녹음 노트의 사용자 메모 줄이면 메모 본문의 줄 번호 (그 밖에는 null)")
    text: str
    speaker: str | None = Field(default=None, description="화자 (사용자가 지정한 이름 또는 자동 추정 라벨 S1…, 모르면 null)")
    cite: str = Field(description="이 세그먼트를 근거로 쓸 때 답에 그대로 붙이는 인용 표기")


class SearchHit(BaseModel):
    meeting_id: str
    title: str
    date: str
    segments: list[HitSegment] = Field(description="연속된 세그먼트 2–3개 (합쳐서 300–500자)")
    matched: list[str] = Field(description="keyword: 질의 단어가 모두 있음, partial: 일부만 있음, vector: 의미가 가까움. keyword 없이 vector만이면 관련성을 직접 확인할 것")
    vector_distance: float | None = Field(description="코사인 거리 (작을수록 가까움)")


class SearchResponse(BaseModel):
    query: str
    vector_used: bool = Field(description="False면 키워드 검색만 했다 (임베딩 모델 없음)")
    hits: list[SearchHit]


class MeetingInfo(BaseModel):
    meeting_id: str
    title: str
    date: str
    duration_sec: float
    kind: str = Field(default="recording", description="recording(녹음에서 만든 노트) | memo(직접 쓴 메모, 오디오 없음)")
    segments: int
    state: str | None = Field(default=None, description="recorded: 녹음만 하고 아직 텍스트로 변환하지 않은 노트 (segments 0, 전사 없음). 그 밖에는 null")
    has_summary: bool
    favorite: bool = Field(default=False, description="사용자가 즐겨찾기한 노트")
    tags: list[str] = Field(default_factory=list, description="사용자가 붙인 태그")
    folder: str | None = Field(default=None, description="노트가 들어 있는 폴더 이름 (없으면 null)")
    folder_id: str | None = None


class MeetingList(BaseModel):
    meetings: list[MeetingInfo]


class ActionItemOut(BaseModel):
    meeting_id: str
    title: str
    date: str
    task: str
    owner: str | None
    due: str | None
    segment_ids: list[str]
    cite: str


class ActionItems(BaseModel):
    items: list[ActionItemOut]
    meetings_without_summary: list[str] = Field(description="요약이 없어 할 일을 모르는 회의")


class Status(BaseModel):
    home: str
    meetings: int
    indexed_chunks: int
    vectors: int = Field(description="indexed_chunks보다 적으면 일부 회의는 키워드로만 검색된다 (`tractus index`로 채움)")
    vector_search: bool
    embedding_model: str | None
    index_errors: list[str]
    hint: str | None


class SaveResult(BaseModel):
    saved: str
    topics: int
    decisions: int
    action_items: int


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def build_server(home: Path, embedder) -> MCPServer:
    meetings_dir = home / "meetings"
    state: dict = {}

    def index() -> Index:
        if "index" not in state:
            state["index"] = Index(home, embedder=embedder)
        return state["index"]

    def synced() -> Index:
        idx = index()
        # 바뀐 회의만 다시 색인한다(변경이 없으면 파일 stat만 본다). 임베딩은 하지 않는다: 회의가 많으면 몇 분씩 걸려
        # stdio 서버가 응답하지 못한다. 벡터는 transcribe/summarize 뒤의 자동 색인이나 `tractus index`가 채운다.
        report = idx.sync(embed=False)
        state["errors"] = report.errors
        if report.added or report.updated or report.removed:
            log.info("index sync: +%d ~%d -%d", report.added, report.updated, report.removed)
        return idx

    def find(ref: str) -> Path:
        try:
            return find_meeting_dir(meetings_dir, ref)
        except LookupError as e:  # ToolError만 메시지가 에이전트에 그대로 전달된다 (그 외 예외는 일반 오류로 가려짐)
            raise ToolError(f"{e}. list_meetings로 meeting_id를 확인하세요") from e

    def meeting(ref: str) -> tuple[Path, dict]:
        d = find(ref)
        try:
            return d, _load(d / "transcript.json")
        except (OSError, ValueError) as e:
            raise ToolError(f"{d.name}/transcript.json을 읽을 수 없습니다: {e}") from e

    def only(tag: str | None, folder: str | None, favorite: bool) -> set[str] | None:
        """태그·폴더·즐겨찾기 필터에 맞는 meeting_id 집합 (필터가 없으면 None). 없는 폴더는 ToolError."""
        try:
            return organize.matching_ids(home, favorite, [tag] if tag else [], folder)
        except ValueError as e:
            raise ToolError(str(e)) from e

    def in_range(date: str, lo: str | None, hi: str | None) -> bool:
        return (not lo or date >= lo) and (not hi or date <= hi)  # 기간을 주지 않으면 날짜 없는 회의도 포함

    server = MCPServer("tractus", instructions=INSTRUCTIONS)

    @server.tool(annotations=READ_ONLY)
    async def status() -> Status:
        """Tractus 데이터 위치, 회의 수, 색인 상태. 결과가 비어 보이면 home 경로부터 확인한다."""
        idx = synced()
        st = idx.stats()
        vector_search = idx.embedder is not None and st["vectors"] > 0
        hint = None
        if idx.embedder is None:
            hint = "임베딩 모델이 없거나 올리지 못해 키워드 검색만 합니다 (터미널에서 `tractus models download embedding`)"
        elif st["pending"]:
            hint = f"벡터가 없는 청크 {st['pending']}개: 터미널에서 `tractus index`를 실행하면 의미 검색에 포함됩니다"
        return Status(
            home=str(home), meetings=st["meetings"], indexed_chunks=st["chunks"], vectors=st["vectors"], vector_search=vector_search,
            embedding_model=st["embedding_model"], index_errors=state.get("errors", []), hint=hint,
        )

    @server.tool(annotations=READ_ONLY)
    async def search_meetings(
        query: Annotated[str, Field(description="한국어·영어 자유 질의. 단어 2–3개나 짧은 문장")],
        limit: Annotated[int, Field(ge=1, le=50)] = 10,
        date_from: Date = None,
        date_to: Date = None,
        meeting_id: Annotated[str | None, Field(description="특정 회의 안에서만 찾을 때")] = None,
        tag: Tag = None,
        folder: FolderRef = None,
        favorite: Favorite = False,
    ) -> SearchResponse:
        """과거 회의 전사를 키워드(한국어 음절 bigram)와 의미(로컬 임베딩)로 함께 검색한다. tag·folder·favorite로 사용자가 정리한 노트만 찾을 수 있다."""
        idx = synced()
        mid = meeting(meeting_id)[1]["meeting_id"] if meeting_id else None
        res = idx.search(query, limit=limit, date_from=date_from, date_to=date_to, meeting_id=mid, meeting_ids=only(tag, folder, favorite))
        return SearchResponse(
            query=query, vector_used=res.vector_used,
            hits=[
                SearchHit(
                    meeting_id=h.meeting_id, title=h.title, date=h.date, matched=h.matched, vector_distance=h.distance,
                    segments=[HitSegment(id=s["id"], source=s.get("source") or "transcript", line=s.get("line"), time=stamp(s), text=seg_text(s), speaker=s.get("speaker"), cite=_cite(h.meeting_id, [s["id"]], stamp(s))) for s in h.segments],
                )
                for h in res.hits
            ],
        )

    @server.tool(annotations=READ_ONLY)
    async def list_meetings(
        date_from: Date = None, date_to: Date = None, limit: Annotated[int, Field(ge=1, le=500)] = 100,
        tag: Tag = None, folder: FolderRef = None, favorite: Favorite = False,
    ) -> MeetingList:
        """회의 목록 (날짜순). 기간을 주면 그 기간의 회의만, tag·folder·favorite를 주면 사용자가 정리한 노트만."""
        allowed = only(tag, folder, favorite)
        names = {f["id"]: f["name"] for f in organize.load_folders(home)}
        out = []
        for p in sorted(meetings_dir.glob("*/transcript.json")):
            try:  # 손상된 회의 하나 때문에 목록 전체가 실패하지 않게 건너뛴다
                t = _load(p)
                date = str(t.get("created_at") or "")[:10]
                meta = organize.meta_of(t)
                fid = meta["folder"] if meta["folder"] in names else None
                if in_range(date, date_from, date_to) and (allowed is None or t["meeting_id"] in allowed):
                    out.append(MeetingInfo(favorite=meta["favorite"], tags=meta["tags"], folder=names.get(fid), folder_id=fid, meeting_id=t["meeting_id"], title=str(t.get("title") or ""), date=date,
                                           duration_sec=float((t.get("audio") or {}).get("duration_sec") or 0.0), kind=t.get("kind") or "recording", segments=len(t["segments"]), state="recorded" if is_recorded(t) else None,
                                           has_summary=has_any_summary(p.parent)))
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
                log.warning("list_meetings: %s 건너뜀: %s", p.parent.name, e)
        out.sort(key=lambda m: (m.date, m.meeting_id))
        return MeetingList(meetings=out[:limit])

    @server.tool(annotations=READ_ONLY, structured_output=False)
    async def get_transcript(
        meeting_id: MeetingRef,
        offset: Annotated[int, Field(ge=0, description="건너뛸 세그먼트 수")] = 0,
        max_segments: Annotated[int, Field(ge=1, le=500)] = 200,
    ) -> str:
        """회의 전사 원문. 줄마다 `[세그먼트ID HH:MM:SS 화자] 텍스트` (화자를 모르면 생략, 메모 노트는 시각 자리에 'n번째 줄'). 남은 세그먼트가 있으면 마지막 줄에 next_offset이 붙는다.
        녹음 노트에 사용자가 적은 메모가 있으면 마지막 쪽(전사의 끝) 뒤에 `memo` 구간으로 줄마다 `[m0001 메모 n번째 줄] 텍스트`가 붙는다."""
        _, t = meeting(meeting_id)
        if is_recorded(t):  # 변환 전 노트: 전사가 없다. 사용자 메모는 있을 수 있다
            m = memo_segments(t)
            memo = [f"memo (사용자가 직접 적은 메모, 음성 인식 아님, {len(m)}줄):", *(f"[{x['id']} {stamp(x)}] {x['text']}" for x in m)] if m else []
            return "\n".join([f"# {t.get('title', '')} ({(t.get('created_at') or '')[:10]}, meeting_id {t['meeting_id']}, 변환 전)", "아직 텍스트로 변환하지 않은 노트라 전사가 없습니다. 사용자가 앱에서 '텍스트로 변환'을 하면 생깁니다.", "(끝)", *memo])
        segs = t["segments"]
        page = segs[offset : offset + max_segments]
        head = f"# {t.get('title', '')} ({(t.get('created_at') or '')[:10]}, meeting_id {t['meeting_id']}, 세그먼트 {offset + 1}–{offset + len(page)} / {len(segs)})"
        lines = [f"[{s['id']} {stamp(s)}{_who(t, s)}] {seg_text(s)}" for s in page]
        more = offset + len(page) < len(segs)
        tail = [f"next_offset: {offset + len(page)}"] if more else ["(끝)"]
        m = [] if more else memo_segments(t)
        memo = [f"memo (사용자가 직접 적은 메모, 음성 인식 아님, {len(m)}줄):", *(f"[{x['id']} {stamp(x)}] {x['text']}" for x in m)] if m else []
        return "\n".join([head, *lines, *tail, *memo])

    @server.tool(annotations=READ_ONLY, structured_output=False)
    async def get_summary(
        meeting_id: MeetingRef,
        template: Annotated[str | None, Field(description="요약 유형 key (meeting, brief, todo, lecture, interview, ideas, u-…, c-…). 생략하면 기본 요약(meeting)")] = None,
    ) -> str:
        """회의 요약(summary.md): 요약, 주제, 결정 사항, 할 일과 각 항목의 타임스탬프. template을 주면 그 유형의 요약(summaries/<key>.md)을 읽는다."""
        d, t = meeting(meeting_id)
        if template is not None and template != DEFAULT_KEY:
            if text := read_markdown(d, template):
                return text
            have = ", ".join(x["key"] for x in list_summaries(d)) or "없음"
            raise ToolError(f"{template!r} 요약이 없습니다. 이 회의의 요약: {have}")
        path = d / "summary.md"
        if not path.exists():
            if others := [x["key"] for x in list_summaries(d)]:  # 기본 요약은 없지만 다른 유형의 요약이 있다 (save_summary는 기본 요약을 만든다)
                return f"기본 요약(meeting)은 없지만 다른 요약이 있습니다: {', '.join(others)}. template=<key>로 읽을 수 있습니다 (meeting_id {t['meeting_id']})."
            return f"요약이 없습니다 (meeting_id {t['meeting_id']}). get_transcript로 전사를 읽고 save_summary로 저장할 수 있습니다."
        return path.read_text(encoding="utf-8")

    @server.tool(annotations=READ_ONLY)
    async def list_action_items(meeting_id: Annotated[str | None, Field(description="한 회의만 볼 때")] = None, date_from: Date = None, date_to: Date = None) -> ActionItems:
        """요약이 있는 회의들의 할 일(담당자·기한·근거). 요약이 없는 회의는 따로 알려 준다."""
        dirs = [find(meeting_id)] if meeting_id else sorted(p.parent for p in meetings_dir.glob("*/transcript.json"))
        items, missing = [], []
        for d in dirs:
            try:  # 손상된 summary.json 하나 때문에 전체가 실패하지 않게 건너뛴다
                t = _load(d / "transcript.json")
                date = str(t.get("created_at") or "")[:10]
                if not in_range(date, date_from, date_to):
                    continue
                if not (d / "summary.json").exists():
                    missing.append(t["meeting_id"])
                    continue
                seg = {s["id"]: s for s in [*t["segments"], *memo_segments(t)]}
                for a in _load(d / "summary.json").get("action_items", []):
                    found = [seg[i] for i in a["segment_ids"] if i in seg]
                    first = min([x for x in found if x.get("source") != "memo"] or found, key=lambda s: s["start"], default={"start": 0.0})  # 전사 근거가 있으면 그 시각, 메모 줄뿐이면 '메모 n번째 줄'
                    items.append(ActionItemOut(meeting_id=t["meeting_id"], title=str(t.get("title") or ""), date=date, task=a["task"], owner=a.get("owner"),
                                               due=a.get("due"), segment_ids=a["segment_ids"], cite=_cite(t["meeting_id"], a["segment_ids"], stamp(first))))
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
                log.warning("list_action_items: %s 건너뜀: %s", d.name, e)
        return ActionItems(items=items, meetings_without_summary=missing)

    @server.tool(annotations=WRITES_SUMMARY)
    async def save_summary(
        meeting_id: MeetingRef,
        summary: MeetingSummary,
        author: Annotated[str, Field(description="요약을 쓴 에이전트·모델 이름 (예: claude-code, codex, agy)", min_length=1, max_length=80)],
    ) -> SaveResult:
        """에이전트가 작성한 요약을 저장한다(summary.md·summary.json을 덮어씀). segment_ids가 전사에 없거나 비어 있으면 거부한다."""
        d, t = meeting(meeting_id)
        if is_recorded(t):
            raise ToolError("아직 텍스트로 변환하지 않은 노트라 요약을 저장할 수 없습니다. 사용자가 앱에서 '텍스트로 변환'을 한 뒤에 다시 시도하세요")
        try:
            check_segment_ids(summary, t)
        except ValueError as e:  # 에이전트가 고쳐서 다시 부를 수 있게 이유를 그대로 돌려준다
            raise ToolError(f"{e}. get_transcript에 나온 세그먼트 ID만 쓰고, 모든 항목에 근거를 하나 이상 넣으세요") from e
        write_summary(d, summary, t, provider="mcp", model=author)
        return SaveResult(saved=str(d / "summary.md"), topics=len(summary.topics), decisions=len(summary.decisions), action_items=len(summary.action_items))

    return server


def main() -> None:
    import contextlib
    import os

    from tractus.embed import load_embedder
    from tractus.env import load_env_all
    from tractus.paths import home_dir, models_dir

    os.environ.setdefault("TQDM_DISABLE", "1")
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="tractus-mcp %(levelname)s %(message)s")
    load_env_all()
    home = home_dir()
    with contextlib.redirect_stdout(sys.stderr):
        embedder = load_embedder(models_dir())
    log.info("home=%s models=%s vector_search=%s", home, models_dir(), embedder is not None)
    if not (home / "meetings").is_dir():
        log.warning("%s/meetings 폴더가 없습니다. TRACTUS_HOME을 확인하세요", home)
    build_server(home, embedder).run()


if __name__ == "__main__":
    main()
