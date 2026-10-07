import { convertFileSrc } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errText, useJob, type MeetingDetail, type SpeakerEdit, type Summary } from "./api";
import type { Notify, Seek } from "./App";
import {
  applyEdits,
  baseName,
  clickSeekTime,
  evidenceStart,
  exportFilename,
  findMatches,
  fmtTime,
  inverseEdits,
  isImeKey,
  isTypingTarget,
  oneLine,
  parseRate,
  RATES,
  replaceEdits,
  SEEK_STEP,
  SEEK_STEP_BIG,
  segmentIndexAt,
  segText,
  silenceSkip,
  speakerName,
  speakerStats,
  STAGE_LABEL,
  stepRate,
  summaryMarkdown,
  tokenOffsets,
  transcriptRows,
  usableWords,
  wordIndexAt,
  type EXPORT_FORMATS,
  type Match,
  type Memo,
  type Segment,
  type TextEdit,
} from "./lib";
import { AskPanel } from "./AskPanel";
import { printDoc } from "./print";
import { PrintSheet } from "./PrintSheet";
import { SpeakerChip, SpeakerMenu, SpeakersBar, spkStyle, type MenuTarget, type MergeAsk } from "./Speakers";
import { ExportMenu, FindBar, SegmentEditor, type FindState } from "./TranscriptTools";
import { releaseVoiceBoost, resumeVoiceBoost, setVoiceBoost, voiceBoostSupported } from "./voice";

const RATE_KEY = "tractus.playbackRate";
const readRate = () => {
  try {
    return parseRate(localStorage.getItem(RATE_KEY));
  } catch {
    return 1;
  }
};

export function MeetingView({ id, seek, onChanged, notify }: { id: string; seek?: Seek; onChanged: () => void; notify: Notify }) {
  // base: 코어가 확인한 회의. pending: 저장 중인 문장 편집 묶음(낙관적 반영). 화면은 둘을 겹친 것
  const [base, setBase] = useState<MeetingDetail | null>(null);
  // 코어가 마지막으로 확인한 회의 (렌더를 기다리지 않는다). 되돌리기 묶음은 이것으로 만든다
  const confirmed = useRef<MeetingDetail | null>(null);
  const commit = useCallback((d: MeetingDetail) => {
    confirmed.current = d;
    setBase(d);
  }, []);
  const [pending, setPending] = useState<TextEdit[][]>([]);
  const detail = useMemo(() => (base && pending.length ? { ...base, segments: pending.reduce(applyEdits, base.segments) } : base), [base, pending]);
  const [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const list = useRef<HTMLOListElement>(null);
  const [t, setT] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(true);
  const [audioError, setAudioError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.loadMeeting(id);
      commit(d);
      setDuration(d.info.duration_sec);
    } catch (e) {
      setError(errText(e));
    }
  }, [id, commit]);
  useEffect(() => void load(), [load]);

  // 요약이 낡았는지: 코어가 실제로 바꾼 편집 횟수(editSeq)를 요약을 시작할 때의 값(summarySeq)과 견준다.
  // 요약하는 동안 고친 문장은 요약이 끝나도 '낡음'으로 남는다
  const [editSeq, setEditSeq] = useState(0);
  const [summarySeq, setSummarySeq] = useState(0);
  const summaryFrom = useRef(0);
  const edited = editSeq > summarySeq;
  const summarize = useJob(() => {
    setSummarySeq(summaryFrom.current);
    void load();
    onChanged();
  });
  const startSummarize = () => {
    summaryFrom.current = editSeq;
    void summarize.startJob("summarize", id);
  };

  const segments = detail?.segments ?? [];
  // 단어 타이밍 (6.1): 예전 회의는 words가 없다 → '단어 타이밍 만들기'. 코어는 정렬하는 동안 고친 문장을 덮어쓰지 않는다
  const hasWords = segments.some((s) => !!s.words?.length);
  const align = useJob(() => {
    void load();
    notify({ text: "단어 타이밍을 만들었습니다. 문장의 단어를 누르면 그 단어부터 재생합니다" });
  });
  useEffect(() => {
    if (!align.job.running && align.job.error) notify({ text: `단어 타이밍을 만들지 못했습니다: ${align.job.error}`, error: true });
  }, [align.job.running, align.job.error, notify]);
  const speakers = detail?.speakers ?? {};
  const stats = useMemo(() => speakerStats(segments, speakers), [detail]);
  const diarized = stats.length > 0;
  const slotOf = useMemo(() => new Map(stats.map((s) => [s.label, s.slot])), [stats]);
  // 화자 필터. 합치기로 그 화자가 사라지면 전체로 돌아가고, 같은 라벨이 다시 생겨도 되살리지 않는다
  const [only, setOnly] = useState<string | null>(null);
  const filter = only && stats.some((s) => s.label === only) ? only : null;
  useEffect(() => {
    if (only && !filter) setOnly(null);
  }, [only, filter]);
  const rows = useMemo(() => transcriptRows(segments, detail?.memos ?? [], filter), [detail, filter]);
  /** 화면에 보이는 세그먼트 (화자 필터 적용). 찾기와 무음 건너뛰기의 대상 */
  const visible = useMemo(() => (filter ? segments.filter((s) => s.speaker === filter) : segments), [detail, filter]);

  // 화자 편집: 코어가 파일과 색인을 고치고(약 3초) 고친 회의를 돌려준다
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [merge, setMerge] = useState<MergeAsk | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  // 편집은 한 줄로 세운다: 코어가 transcript.json을 잠금 없이 읽고-고쳐-쓴다. 화자·문장 편집·내보내기가 같은 줄에 선다
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const [inFlight, setInFlight] = useState(0);
  const editing = inFlight > 0;
  const serial = useCallback((task: () => Promise<void>) => {
    setInFlight((n) => n + 1);
    const run = chain.current.then(task).finally(() => setInFlight((n) => n - 1));
    chain.current = run.catch(() => {});
    return run;
  }, []);
  // 오류 표시는 사용자가 새로 고칠 때만 지운다: 줄에 선 다음 작업이 시작하며 지우면 실패를 못 보고 지나간다
  const editSpeakers = useCallback(
    (edit: SpeakerEdit) => {
      setEditError(null);
      return serial(async () => {
        try {
          commit(await api.editSpeakers(id, edit));
        } catch (e) {
          setEditError(errText(e));
        }
      });
    },
    [id, serial, commit],
  );

  // 문장 편집 (5.3): 낙관적으로 반영하고 줄을 세워 저장한다. 되돌리기는 묶음 단위(⌘Z)
  const undoStack = useRef<TextEdit[][]>([]);
  // 저장 한 묶음 (serial 안에서 부른다). 되돌리기 묶음은 저장이 성공한 뒤 코어가 확인한 직전 상태로 만든다:
  // 화면(낙관적 반영)으로 만들면 앞 묶음이 실패했을 때 저장된 적 없는 문장으로 되돌린다
  const persist = useCallback(
    async (edits: TextEdit[], isUndo: boolean) => {
      const before = confirmed.current;
      try {
        const { changed, meeting } = await api.editSegments(id, edits);
        commit(meeting);
        if (changed > 0) {
          setEditSeq((n) => n + 1);
          if (!isUndo && before) undoStack.current.push(inverseEdits(before.segments, edits));
        }
      } catch (e) {
        // 아무것도 쓰이지 않았다(코어 계약). 화면은 원래 문장으로 돌아가므로 고친 문장을 메시지에 남긴다
        const what = edits.length === 1 ? `“${oneLine(edits[0].text)}”` : `문장 ${edits.length}개`;
        setEditError(`저장하지 못했습니다 (${what}): ${errText(e)}`);
        if (isUndo) undoStack.current.push(edits);
      } finally {
        setPending((p) => p.filter((x) => x !== edits));
      }
    },
    [id, commit],
  );
  const saveText = useCallback(
    (edits: TextEdit[]) => {
      if (!edits.length) return;
      setEditError(null);
      setPending((p) => [...p, edits]);
      void serial(() => persist(edits, false));
    },
    [serial, persist],
  );
  // 되돌리기도 줄에 선다: 앞선 저장이 끝나 스택에 오른 뒤에 꺼낸다(저장 중에 ⌘Z를 눌러도 순서가 맞다)
  const undo = useCallback(() => {
    setEditError(null);
    void serial(async () => {
      const inv = undoStack.current.pop();
      if (!inv) return;
      setPending((p) => [...p, inv]);
      await persist(inv, true);
    });
  }, [serial, persist]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const startEdit = useCallback((seg: Segment) => setEditingId(seg.id), []);
  const finishEdit = useCallback(
    (seg: Segment, raw: string | null) => {
      setEditingId(null);
      if (raw === null) return;
      const text = oneLine(raw);
      if (!text) return setEditError("빈 문장은 저장할 수 없습니다. 원래 문장을 그대로 둡니다");
      if (text !== oneLine(segText(seg))) saveText([{ id: seg.id, text }]);
    },
    [saveText],
  );

  const openChip = useCallback((seg: Segment, anchor: HTMLElement) => setMenu({ kind: "seg", seg, anchor }), []);
  const starts = useMemo(() => new Map(segments.map((s) => [s.id, s.start])), [detail]);
  const active = segmentIndexAt(segments, t);

  // 모든 이동은 여기를 거친다 (클릭, 단축키, 무음 건너뛰기, 검색 결과)
  const seekTo = useCallback((sec: number, play = true) => {
    const a = audio.current;
    const to = Math.max(0, Math.min(sec, a && Number.isFinite(a.duration) ? a.duration : Infinity));
    setT(to);
    setFollow(true);
    if (!a) return;
    a.currentTime = to;
    if (play) void a.play().catch(() => {});
  }, []);

  // 재생 속도 (5.1). 피치는 유지한다(preservesPitch 기본값). 다음에 열 때도 같은 속도
  const [rate, setRate] = useState(readRate);
  useEffect(() => {
    const a = audio.current;
    if (a) {
      a.defaultPlaybackRate = rate;
      a.playbackRate = rate;
      a.preservesPitch = true;
    }
    try {
      localStorage.setItem(RATE_KEY, String(rate));
    } catch {
      // 저장소를 못 쓰면 이번만 쓴다
    }
  }, [rate, detail?.audio_path]);

  // 무음 건너뛰기 (5.2). 화자 필터와 함께 쓰면 '이 화자만 듣기'
  const [skip, setSkip] = useState(false);
  const [saved, setSaved] = useState(0);

  // 목소리 강조 (6.4). 켤 때 Web Audio 체인을 만든다(사용자 클릭 안에서). 못 만들면 토글을 막고 이유를 보인다
  const [voice, setVoice] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(voiceBoostSupported() ? null : "이 환경에서는 목소리 강조를 쓸 수 없습니다 (Web Audio 없음)");
  const toggleVoice = () => {
    const a = audio.current;
    if (!a || voiceError) return;
    try {
      setVoiceBoost(a, !voice);
      setVoice(!voice);
    } catch (e) {
      setVoiceError(`목소리 강조를 켜지 못했습니다: ${errText(e)}`);
    }
  };
  useEffect(() => {
    const a = audio.current;
    return () => void (a && releaseVoiceBoost(a));
  }, [detail?.audio_path]);

  // PDF (6.5): 인쇄용 문서를 body 아래에 두고 macOS 인쇄 대화상자를 연다. 대화상자의 미리보기가 나중에 그리므로
  // 한 번 만든 인쇄 문서는 회의 화면을 닫을 때까지 둔다 (화면에는 보이지 않는다)
  const [printNonce, setPrintNonce] = useState(0);
  useEffect(() => {
    if (!printNonce) return;
    const id = requestAnimationFrame(() =>
      // Tauri는 macOS에서 window.print()를 webview print 명령(Promise)으로 바꿔 둔다
      Promise.resolve(window.print() as unknown).catch((e) => notify({ text: `인쇄 창을 열지 못했습니다: ${errText(e)}`, error: true })),
    );
    return () => cancelAnimationFrame(id);
  }, [printNonce, notify]);
  const printable = useMemo(() => (printNonce && detail ? printDoc(detail) : null), [printNonce > 0, detail]);

  // 오른쪽 레일: 요약 | 질문 (6.3). 질문 탭은 처음 열 때 만들고, 그 뒤에는 숨겨도 둔다(스트리밍이 이어지게)
  const [tab, setTab] = useState<"summary" | "ask">("summary");
  const [askSeen, setAskSeen] = useState(false);
  const showTab = (k: "summary" | "ask") => {
    setTab(k);
    if (k === "ask") setAskSeen(true);
  };
  const onCite = useCallback((_m: string, _seg: string, sec: number) => seekTo(sec), [seekTo]);

  // 검색 결과·시각 칩에서 들어온 시각으로 한 번만 이동 (재생은 사용자가 시작).
  // 요약을 만든 뒤 다시 읽어도(detail이 바뀌어도) 재생 위치를 되돌리지 않게 nonce로 거른다
  const appliedSeek = useRef<number | null>(null);
  useEffect(() => {
    if (!detail || !seek || appliedSeek.current === seek.nonce) return;
    appliedSeek.current = seek.nonce;
    const sec = seek.segId !== undefined ? (starts.get(seek.segId) ?? seek.t ?? 0) : (seek.t ?? 0);
    seekTo(sec, false);
  }, [detail, seek, starts, seekTo]);

  // 찾기·바꾸기 (5.4)
  const [find, setFind] = useState<FindState | null>(null);
  const [cur, setCur] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => (find ? findMatches(visible, find.q) : []), [visible, find?.q]);
  const curMatch: Match | null = matches.length ? matches[Math.min(cur, matches.length - 1)] : null;
  const curIndex = curMatch ? matches.indexOf(curMatch) : 0;
  useEffect(() => setCur(0), [find?.q]);
  const replace = (all: boolean) => {
    if (!find || !curMatch) return;
    const edits = replaceEdits(visible, find.q, find.r, all ? undefined : curMatch);
    if (!edits.length) return setEditError("바꿔도 같거나 빈 문장이 되어 바꾸지 않았습니다");
    saveText(edits);
    const term = find.r.trim();
    if (find.glossary && term) {
      api.glossaryAdd([term]).then(
        (n) => notify({ text: n ? `용어집에 넣었습니다 — ${term} (다음 전사부터 씁니다)` : `이미 용어집에 있습니다 — ${term}` }),
        (e) => notify({ text: `용어집에 넣지 못했습니다: ${errText(e)}`, error: true }),
      );
    }
  };

  // 강조: CSS Custom Highlight API. 지원하지 않으면 현재 일치 행의 테두리(is-find)만 보인다.
  // 문장 노드는 한 번에 모아 둔다(일치마다 querySelector를 부르면 1000세그먼트에서 키 입력마다 100ms 넘게 걸린다)
  useEffect(() => {
    if (!("highlights" in CSS)) return;
    const nodes = new Map<string, Node>();
    if (matches.length)
      for (const el of list.current?.querySelectorAll<HTMLElement>(".seg-text:not(.seg-editor)") ?? []) {
        const segId = el.closest<HTMLElement>("[data-seg-id]")?.dataset.segId;
        if (segId && el.firstChild) nodes.set(segId, el.firstChild);
      }
    const range = (m: Match) => {
      const node = nodes.get(m.id);
      if (!node) return [];
      try {
        const r = new Range();
        r.setStart(node, m.start);
        r.setEnd(node, m.start + m.length);
        return [r];
      } catch {
        return [];
      }
    };
    CSS.highlights.set("find", new Highlight(...matches.flatMap(range)));
    CSS.highlights.set("find-current", new Highlight(...(curMatch ? range(curMatch) : [])));
    return () => {
      CSS.highlights.delete("find");
      CSS.highlights.delete("find-current");
    };
  }, [matches, curMatch, rows, editingId]);
  // 가라오케 (6.2): 재생 중인 단어 하나를 Highlight API로 칠한다 (단어마다 span을 만들지 않는다).
  // 재생 중에만 rAF로 돌고, 멈춘 동안은 이동할 때 한 번 칠한다. (세그먼트, 단어)가 바뀔 때만 Range를 바꾼다.
  // 찾기 강조가 위에 보이게 우선순위를 낮추고, 등록은 한 번만 한다(같은 우선순위면 나중에 등록한 것이 위)
  const karaoke = useRef<Highlight | null>(null);
  const usable = useMemo(() => new Map(segments.map((s) => [s.id, usableWords(s)])), [detail]);
  const pausedT = playing ? -1 : t;
  useEffect(() => {
    if (!("highlights" in CSS)) return;
    const h = (karaoke.current ??= Object.assign(new Highlight(), { priority: -1 }));
    if (!CSS.highlights.has("karaoke")) CSS.highlights.set("karaoke", h);
    let last: string | null = null;
    let raf = 0;
    const paint = () => {
      const now = audio.current?.currentTime ?? t;
      const seg = segments[segmentIndexAt(segments, now)];
      // 발화가 끝난 뒤의 공백과 고치는 중인 세그먼트는 칠하지 않는다
      const words = seg && seg.id !== editingId && now <= seg.end ? usable.get(seg.id) : null;
      const k = words ? wordIndexAt(words, now) : -1;
      const key = k < 0 ? "" : `${seg.id}:${k}`;
      if (key !== last) {
        last = key;
        h.clear();
        const node = k < 0 ? null : list.current?.querySelector(`[data-seg-id="${seg.id}"] .seg-text:not(.seg-editor)`)?.firstChild;
        const o = node ? tokenOffsets(segText(seg))[k] : undefined;
        if (node && o) {
          try {
            const r = new Range();
            r.setStart(node, o.start);
            r.setEnd(node, o.end);
            h.add(r);
          } catch {
            // 글자 노드가 방금 바뀌었다. 다음 갱신에 다시 칠한다
          }
        }
      }
      if (playing) raf = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [playing, pausedT, usable, rows, editingId]);
  useEffect(() => () => void ("highlights" in CSS && CSS.highlights.delete("karaoke")), []);
  useEffect(() => {
    if (!curMatch) return;
    setFollow(false);
    list.current?.querySelector(`[data-seg-id="${curMatch.id}"]`)?.scrollIntoView({ block: "center" });
  }, [curMatch]);

  // 현재 세그먼트 자동 스크롤. 사용자가 직접 스크롤하면 멈추고 "현재 위치로" 버튼을 보인다.
  // 화자를 고치는 동안(메뉴·이름 입력·합치기 확인)과 문장을 고치는 동안은 쉰다: 스크롤하면 고치던 것이 사라진다
  const holding = !!(menu || renaming || merge || editingId);
  useEffect(() => {
    if (!follow || active < 0 || holding) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-seg="${active}"]`);
    if (!el) return;
    const box = el.getBoundingClientRect();
    if (box.top < 80 || box.bottom > window.innerHeight - 140) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
    }
  }, [active, follow, holding]);

  // 단축키. e.key가 아니라 e.code(물리 키)로 본다: 한글 입력 상태에서는 e.key가 "ㅠ"·"ㅏ"다
  // (bbc/react-transcript-editor defaultHotKeys.js, MIT 참고)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isImeKey(e)) return;
      if (e.metaKey && e.code === "KeyF") {
        e.preventDefault();
        // 이미 열려 있으면 찾을 말을 고른다. 새로 열면 입력이 autoFocus로 초점을 받는다
        if (findInput.current) findInput.current.select();
        else setFind({ q: "", r: "", glossary: false });
        return;
      }
      // 탭 목록처럼 키를 이미 쓴 위젯이 있으면 재생 단축키로 다시 쓰지 않는다
      if (e.defaultPrevented || isTypingTarget(e.target)) return;
      if (e.metaKey && !e.shiftKey && e.code === "KeyZ") {
        e.preventDefault();
        undo();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const a = audio.current;
      if (!a) return;
      if (e.code === "Space" && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        if (a.paused) void a.play().catch(() => {});
        else a.pause();
      } else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        e.preventDefault();
        const step = e.shiftKey ? SEEK_STEP_BIG : SEEK_STEP;
        seekTo(a.currentTime + (e.code === "ArrowLeft" ? -step : step), !a.paused);
      } else if (e.shiftKey && (e.code === "Comma" || e.code === "Period")) {
        e.preventDefault();
        setRate((r) => stepRate(r, e.code === "Period" ? 1 : -1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seekTo, undo]);

  const exportAs = async (f: (typeof EXPORT_FORMATS)[number]) => {
    if (!detail) return;
    let out: string | null;
    try {
      out = await save({ defaultPath: exportFilename(detail.info.created_at, detail.info.title, f.ext), filters: [{ name: f.label, extensions: [f.ext] }] });
    } catch (e) {
      return notify({ text: `저장 위치를 고르지 못했습니다: ${errText(e)}`, error: true });
    }
    if (!out) return;
    const target = out;
    // 저장 중인 편집이 끝난 뒤에 내보낸다
    void serial(async () => {
      try {
        const path = await api.exportMeeting(id, f.format, target);
        notify({ text: `${f.label}로 내보냈습니다 — ${baseName(path)}` });
      } catch (e) {
        notify({ text: `내보내지 못했습니다: ${errText(e)}`, error: true });
      }
    });
  };

  if (error) return <p className="page-error">{error}</p>;
  if (!detail) return <p className="page-loading">불러오는 중…</p>;

  const { info, summary } = detail;
  const created = info.created_at ? new Date(info.created_at) : null;

  return (
    <div className="meeting">
      <article className="transcript-col" onWheel={() => playing && setFollow(false)} onScroll={() => menu && setMenu(null)}>
        {find && (
          <FindBar
            state={find}
            onChange={setFind}
            count={matches.length}
            current={curIndex}
            onStep={(d) => setCur((curIndex + d + matches.length) % Math.max(1, matches.length))}
            onReplace={() => replace(false)}
            onReplaceAll={() => replace(true)}
            onClose={() => setFind(null)}
            inputRef={findInput}
          />
        )}
        <header className="meeting-head">
          <div className="meeting-head-top">
            <p className="eyebrow tnum">
              {created?.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric", weekday: "long" })}
              {created && " · "}
              {created?.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}
            </p>
            <div className="head-actions">
              {segments.length > 0 && !hasWords && detail.audio_path && (
                <button
                  className="ghost-button head-button"
                  disabled={align.job.running}
                  onClick={() => void align.startJob("align", id)}
                  title="오디오와 문장을 단어 단위로 맞춥니다. 재생 중인 단어가 강조되고, 단어를 누르면 그 단어부터 재생합니다"
                >
                  {align.job.running
                    ? `${STAGE_LABEL[align.job.stage ?? ""] ?? "시작하는 중…"}${align.job.total ? ` ${Math.round((align.job.done / align.job.total) * 100)}%` : ""}`
                    : "단어 타이밍 만들기"}
                </button>
              )}
              <button className="ghost-button head-button" onClick={() => (findInput.current ? findInput.current.select() : setFind({ q: "", r: "", glossary: false }))} aria-keyshortcuts="Meta+F">
                찾아 바꾸기
              </button>
              <ExportMenu onPick={(f) => void exportAs(f)} onPrint={() => setPrintNonce((n) => n + 1)} />
            </div>
          </div>
          <h1>{info.title || "제목 없음"}</h1>
          <p className="meeting-stats tnum">
            {fmtTime(info.duration_sec)} · 세그먼트 {info.segments}개{detail.memos.length > 0 && ` · 메모 ${detail.memos.length}개`}
            <span className="edit-hint"> · 문장을 두 번 누르거나 Enter로 고칩니다</span>
          </p>
          {diarized && (
            <SpeakersBar
              stats={stats}
              only={filter}
              onFilter={setOnly}
              busy={editing}
              renaming={renaming}
              merge={merge}
              onRename={(label, name) => {
                setRenaming(null);
                void editSpeakers({ op: "rename", label, name });
              }}
              onStartRename={setRenaming}
              onCancelRename={() => setRenaming(null)}
              onAskMerge={setMerge}
              onMerge={() => {
                if (merge) void editSpeakers({ op: "merge", ...merge });
                setMerge(null);
              }}
              onCancelMerge={() => setMerge(null)}
              onMenu={(label, anchor) => setMenu({ kind: "speaker", label, anchor })}
            />
          )}
        </header>

        {segments.length === 0 && (
          <div className="transcript-empty" role="status">
            <p className="eyebrow">전사 없음</p>
            <p>이 녹음에서 말소리를 찾지 못했습니다. 아래 플레이어로 녹음된 소리를 확인해 보세요. 마이크가 멀었거나 녹음이 너무 짧았을 수 있습니다.</p>
          </div>
        )}
        <ol className={`transcript ${diarized ? "has-speakers" : ""}`} ref={list}>
          {rows.map((r, i) =>
            r.kind === "seg" ? (
              <SegmentRow
                key={r.seg.id}
                seg={r.seg}
                index={r.index}
                isActive={r.index === active}
                isEditing={r.seg.id === editingId}
                isFind={r.seg.id === curMatch?.id}
                order={i}
                onSeek={seekTo}
                onEdit={startEdit}
                onEditDone={finishEdit}
                speaker={diarized ? speakerName(r.seg.speaker, speakers) : undefined}
                slot={slotOf.get(r.seg.speaker ?? "")}
                turnStart={!!r.turnStart}
                onChip={openChip}
              />
            ) : (
              <MemoRow key={`m${i}`} memo={r.memo} onSeek={seekTo} />
            ),
          )}
        </ol>

        <div className="player" role="group" aria-label="오디오 플레이어">
          {detail.audio_path ? (
            <audio
              ref={audio}
              src={convertFileSrc(detail.audio_path, "media")}
              preload="metadata"
              onTimeUpdate={(e) => {
                const a = e.currentTarget;
                setT(a.currentTime);
                const to = skip && !a.paused ? silenceSkip(visible, a.currentTime) : null;
                if (to !== null) {
                  setSaved((s) => s + (to - a.currentTime));
                  seekTo(to, false);
                }
              }}
              onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
              onPlay={(e) => {
                setPlaying(true);
                resumeVoiceBoost(e.currentTarget);
              }}
              onPause={() => setPlaying(false)}
              onError={() => setAudioError("오디오를 재생할 수 없습니다")}
            />
          ) : null}
          <button
            className="play-button"
            onClick={() => (audio.current?.paused ? void audio.current.play().catch(() => {}) : audio.current?.pause())}
            disabled={!detail.audio_path || !!audioError}
            aria-label={playing ? "일시정지" : "재생"}
          >
            {playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <time className="tnum player-time">
            {fmtTime(t)} <span>/ {fmtTime(duration)}</span>
          </time>
          <div className="scrub" hidden={!detail.audio_path}>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={Math.min(t, duration || 1)}
              onChange={(e) => seekTo(Number(e.target.value), playing)}
              aria-label="재생 위치"
              style={{ "--p": `${duration ? (t / duration) * 100 : 0}%` } as React.CSSProperties}
            />
            {detail.memos.map((m, i) => (
              <span key={i} className={`scrub-mark is-${m.kind}`} style={{ left: `${duration ? (m.t / duration) * 100 : 0}%` }} aria-hidden />
            ))}
          </div>
          {detail.audio_path && (
            <>
              <button
                className="toggle-button"
                aria-pressed={skip}
                onClick={() => setSkip((v) => !v)}
                title={filter ? "이 화자의 발화만 듣습니다 (다른 화자와 1초 넘는 무음을 건너뜀)" : "발화 사이 1초 넘는 무음을 건너뜁니다. 화자를 고르면 그 화자만 듣습니다"}
              >
                {filter ? "이 화자만" : "무음 건너뛰기"}
                {skip && saved >= 1 && <span className="tnum toggle-meta">−{fmtTime(saved)}</span>}
              </button>
              <button
                className="toggle-button"
                aria-pressed={voice}
                aria-disabled={!!voiceError}
                onClick={toggleVoice}
                title={voiceError ?? "말소리 대역(3 kHz)을 살짝 올리고 100 Hz 아래 웅웅거림을 줄입니다. 큰 소리와 작은 소리의 차이도 줄입니다"}
              >
                목소리 강조
              </button>
              <select className="rate-select tnum" value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label="재생 속도 (Shift+, 느리게 · Shift+. 빠르게)" title="재생 속도 (Shift+, / Shift+.)">
                {RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}×
                  </option>
                ))}
              </select>
            </>
          )}
          {!follow && playing && (
            <button className="text-button follow-button" onClick={() => setFollow(true)}>
              현재 위치로
            </button>
          )}
          {(audioError || !detail.audio_path) && <span className="player-note">{audioError ?? "오디오 파일이 없습니다"}</span>}
          <span className={`player-note ${editError ? "inline-error" : ""}`} role="status">
            {editing ? "저장하는 중…" : editError}
          </span>
        </div>
        {menu && (
          <SpeakerMenu
            target={menu}
            stats={stats}
            busy={editing}
            onClose={() => setMenu(null)}
            onSet={(segment, label) => void editSpeakers({ op: "set", segment, label })}
            onRename={(label, name) => void editSpeakers({ op: "rename", label, name })}
            onStartRename={setRenaming}
            onAskMerge={setMerge}
          />
        )}
      </article>

      <aside className="summary-col" aria-label="요약과 질문">
        <div
          className="rail-tabs"
          role="tablist"
          aria-label="오른쪽 패널"
          onKeyDown={(e) => {
            if (e.code !== "ArrowLeft" && e.code !== "ArrowRight") return;
            e.preventDefault();
            const next = tab === "summary" ? "ask" : "summary";
            showTab(next);
            document.getElementById(`tab-${next}`)?.focus();
          }}
        >
          {(["summary", "ask"] as const).map((k) => (
            <button key={k} id={`tab-${k}`} role="tab" aria-selected={tab === k} aria-controls={`panel-${k}`} tabIndex={tab === k ? 0 : -1} onClick={() => showTab(k)}>
              {k === "summary" ? "요약" : "질문"}
            </button>
          ))}
        </div>
        <div id="panel-summary" role="tabpanel" aria-labelledby="tab-summary" hidden={tab !== "summary"}>
          {summary ? (
            <SummaryPanel
              summary={summary}
              starts={starts}
              onSeek={seekTo}
              onCopy={() =>
                navigator.clipboard.writeText(summaryMarkdown(summary, starts)).then(
                  () => notify({ text: "요약을 마크다운으로 복사했습니다" }),
                  (e) => notify({ text: `복사하지 못했습니다: ${errText(e)}`, error: true }),
                )
              }
              stale={
                edited && (
                  <div className="summary-stale" role="status">
                    <p>전사를 고쳤습니다. 요약에는 아직 반영되지 않았습니다.</p>
                    <button className="text-button" disabled={summarize.job.running || editing} onClick={startSummarize}>
                      {summarize.job.running ? (STAGE_LABEL[summarize.job.stage ?? ""] ?? "시작하는 중…") : "요약 다시 만들기"}
                    </button>
                    {summarize.job.error && <p className="inline-error">{summarize.job.error}</p>}
                  </div>
                )
              }
            />
          ) : (
            <div className="summary-empty">
              <p>아직 요약이 없습니다. 결정 사항과 할 일을 근거 세그먼트와 함께 뽑습니다.</p>
              <button className="primary-button" disabled={summarize.job.running || editing} onClick={startSummarize}>
                {summarize.job.running ? (STAGE_LABEL[summarize.job.stage ?? ""] ?? "시작하는 중…") : "요약 만들기"}
              </button>
              {summarize.job.error && <p className="inline-error">{summarize.job.error}</p>}
            </div>
          )}
        </div>
        {askSeen && (
          <div id="panel-ask" role="tabpanel" aria-labelledby="tab-ask" className="rail-ask" hidden={tab !== "ask"}>
            <AskPanel scope={{ kind: "meeting", id, starts }} onCite={onCite} />
          </div>
        )}
      </aside>
      {printable && <PrintSheet doc={printable} />}
    </div>
  );
}

const SegmentRow = memo(function SegmentRow({
  seg,
  index,
  isActive,
  isEditing,
  isFind,
  order,
  onSeek,
  onEdit,
  onEditDone,
  speaker,
  slot,
  turnStart,
  onChip,
}: {
  seg: Segment;
  index: number;
  isActive: boolean;
  isEditing: boolean;
  /** 찾기의 현재 일치 (Highlight API가 없을 때도 보이게 행 테두리) */
  isFind: boolean;
  order: number;
  onSeek: (t: number) => void;
  onEdit: (seg: Segment) => void;
  onEditDone: (seg: Segment, raw: string | null) => void;
  /** 화자 있는 회의만: 표시 이름(화자 미상이면 null). 화자 없는 회의는 undefined → 칩을 그리지 않는다 */
  speaker?: string | null;
  slot?: number;
  turnStart: boolean;
  onChip: (seg: Segment, anchor: HTMLElement) => void;
}) {
  const diarized = speaker !== undefined;
  const button = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  // 키보드로 편집을 끝내면 초점을 세그먼트로 돌려준다 (마우스로 다른 곳을 눌러 끝냈으면 그대로 둔다)
  useEffect(() => {
    if (!isEditing && refocus.current) {
      refocus.current = false;
      button.current?.focus();
    }
  }, [isEditing]);
  const edited = seg.corrected_text != null;
  return (
    <li
      className={`seg ${isActive ? "is-active" : ""} ${diarized && turnStart ? "is-turn" : ""} ${isFind ? "is-find" : ""}`}
      data-seg={index}
      data-seg-id={seg.id}
      style={{ "--i": Math.min(order, 16), ...(diarized ? spkStyle(slot) : {}) } as React.CSSProperties}
    >
      {diarized && <SpeakerChip seg={seg} display={speaker} turnStart={turnStart} onOpen={onChip} />}
      {isEditing ? (
        <div className="seg-button is-editing">
          <time className="seg-time tnum">{fmtTime(seg.start)}</time>
          <SegmentEditor
            initial={segText(seg)}
            onDone={(raw, viaKey) => {
              refocus.current = viaKey;
              onEditDone(seg, raw);
            }}
          />
        </div>
      ) : (
        <button
          ref={button}
          className="seg-button"
          onClick={(e) => {
            // 드래그로 글을 골랐으면 이동하지 않는다. 키보드(detail 0)·시간 칸은 세그먼트 시작, 단어 타이밍이 있으면 누른 단어
            const sel = window.getSelection();
            if (sel && !sel.isCollapsed && e.currentTarget.contains(sel.anchorNode)) return;
            onSeek(clickSeekTime(seg, e.detail ? caretOffset(e.currentTarget, e.clientX, e.clientY) : null));
          }}
          onDoubleClick={() => onEdit(seg)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.metaKey || isImeKey(e.nativeEvent)) return;
            e.preventDefault();
            onEdit(seg);
          }}
          aria-current={isActive}
          aria-keyshortcuts="Enter"
          aria-description="Enter로 문장 고치기"
        >
          <time className="seg-time tnum">{fmtTime(seg.start)}</time>
          <span className="seg-body">
            <span className="seg-text">{segText(seg)}</span>
            {edited && (
              <span className="seg-edited" title={`원문: ${seg.text}`}>
                수정됨
              </span>
            )}
          </span>
        </button>
      )}
    </li>
  );
});

/** 누른 지점이 문장 글자 노드의 몇 번째 글자인지. 문장 밖(시간 칸)이거나 지원하지 않으면 null */
function caretOffset(button: HTMLElement, x: number, y: number): number | null {
  const node = button.querySelector(".seg-text")?.firstChild;
  const r = node ? document.caretRangeFromPoint?.(x, y) : null;
  return r && r.startContainer === node ? r.startOffset : null;
}

function MemoRow({ memo: m, onSeek }: { memo: Memo; onSeek: (t: number) => void }) {
  const isBookmark = m.kind === "bookmark";
  return (
    <li className={`memo is-${isBookmark ? "bookmark" : "memo"}`}>
      <button className="seg-button" onClick={() => onSeek(m.t)}>
        <time className="seg-time tnum">{fmtTime(m.t)}</time>
        <span className="memo-body">
          <span className="memo-kind">{isBookmark ? "북마크" : "메모"}</span>
          {m.text}
        </span>
      </button>
    </li>
  );
}

function TimeChip({ ids, starts, onSeek }: { ids: string[]; starts: Map<string, number>; onSeek: (t: number) => void }) {
  const t = evidenceStart(ids, starts);
  if (t === null) return null;
  return (
    <button className="time-chip tnum" onClick={() => onSeek(t)} title={`근거: ${ids.join(", ")}`}>
      {fmtTime(t)}
    </button>
  );
}

function SummaryPanel({
  summary,
  starts,
  onSeek,
  onCopy,
  stale,
}: {
  summary: Summary;
  starts: Map<string, number>;
  onSeek: (t: number) => void;
  onCopy: () => void;
  /** 전사를 고친 뒤 '요약 다시 만들기' 안내 */
  stale: React.ReactNode;
}) {
  return (
    <div className="summary">
      <div className="summary-head">
        <button className="text-button" onClick={onCopy}>
          요약 복사
        </button>
      </div>
      {stale}
      <p className="summary-lead">{summary.summary}</p>

      {summary.decisions.length > 0 && (
        <section>
          <h2 className="rail-heading">
            결정 사항 <span className="tnum">{summary.decisions.length}</span>
          </h2>
          <ol className="rail-list">
            {summary.decisions.map((d, i) => (
              <li key={i}>
                <span>{d.text}</span>
                <TimeChip ids={d.segment_ids} starts={starts} onSeek={onSeek} />
              </li>
            ))}
          </ol>
        </section>
      )}

      {summary.action_items.length > 0 && (
        <section>
          <h2 className="rail-heading">
            할 일 <span className="tnum">{summary.action_items.length}</span>
          </h2>
          <ul className="rail-list is-actions">
            {summary.action_items.map((a, i) => (
              <li key={i}>
                <span>
                  {a.task}
                  {(a.owner || a.due) && (
                    <span className="action-meta">
                      {a.owner && <span>{a.owner}</span>}
                      {a.due && <span>{a.due}</span>}
                    </span>
                  )}
                </span>
                <TimeChip ids={a.segment_ids} starts={starts} onSeek={onSeek} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary.topics.length > 0 && (
        <section>
          <h2 className="rail-heading">주제</h2>
          <ul className="topic-list">
            {summary.topics.map((tp, i) => (
              <li key={i}>
                <TimeChip ids={tp.segment_ids} starts={starts} onSeek={onSeek} />
                <span>{tp.title}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary.model && <p className="summary-source">{[summary.provider, summary.model].filter(Boolean).join(" · ")}</p>}
    </div>
  );
}

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
    <path d="M7 4.5v15l12.5-7.5z" fill="currentColor" />
  </svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
    <path d="M6.5 4.5h4v15h-4zM13.5 4.5h4v15h-4z" fill="currentColor" />
  </svg>
);
