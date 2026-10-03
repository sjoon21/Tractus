import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText, useJob, useRecorder, type MeetingInfo, type PendingRecording } from "./api";
import { dayParts, fmtTime, groupByDay, isTypingTarget, recMode, REC_MODES, type RecMode } from "./lib";
import { MeetingView } from "./MeetingView";
import { RecordView } from "./RecordView";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";

export type Seek = { segId?: string; t?: number; nonce: number };
export type View =
  | { kind: "home" }
  | { kind: "meeting"; id: string; seek?: Seek }
  | { kind: "search"; q: string }
  | { kind: "record" }
  | { kind: "settings" };

export function App() {
  const [meetings, setMeetings] = useState<MeetingInfo[]>([]);
  const [pending, setPending] = useState<PendingRecording[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "home" });
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const [m, p] = await Promise.all([api.listMeetings(), api.listRecordings()]);
      setMeetings(m);
      setPending(p);
      setListError(null);
    } catch (e) {
      setListError(errText(e));
    }
  }, []);
  const openMeeting = useCallback((id: string, seek?: Omit<Seek, "nonce">) => {
    setView({ kind: "meeting", id, seek: seek && { ...seek, nonce: Date.now() } });
  }, []);

  // 녹음 정지 → 전사 → 회의 상세
  const transcribe = useJob((meetingId) => {
    void refresh().then(() => openMeeting(meetingId));
  });
  // 마지막 전사 대상. "다시 전사"는 방금 녹음뿐 아니라 사이드바의 남은 녹음에도 쓴다
  const transcribeDir = useRef<string | null>(null);
  const startTranscribe = useCallback((dir: string) => {
    transcribeDir.current = dir;
    void transcribe.startJob("transcribe", dir);
  }, [transcribe.startJob]);
  const { rec, startRec, sendRec, resetRec } = useRecorder(startTranscribe);
  const recording = rec.phase === "recording" || rec.phase === "starting" || rec.phase === "stopping";

  // 녹음 방식: 마지막으로 고른 값을 설정에 저장해 두고 다음에도 쓴다
  const [mode, setMode] = useState<RecMode>("in_person");
  useEffect(() => {
    // 설정을 못 읽으면 기본값(대면 회의)으로 둔다. 목록 읽기 오류가 따로 보인다
    api.getSettings().then((s) => setMode(recMode(s.rec_mode)), () => setMode("in_person"));
  }, []);
  const chooseMode = (m: RecMode) => {
    setMode(m);
    api.setRecMode(m).catch((e) => setListError(`녹음 방식을 저장하지 못했습니다: ${errText(e)}`));
  };

  // 처음, 그리고 전사가 끝날 때마다(성공·실패) 목록과 남은 녹음을 다시 읽는다
  useEffect(() => {
    if (!transcribe.job.running) void refresh();
  }, [transcribe.job.running, refresh]);
  const leftover = pending.filter((p) => !(recording && p.dir === rec.dir));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.code === "KeyK") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.code === "KeyB" && !e.metaKey && !e.ctrlKey && rec.phase === "recording" && !isTypingTarget(e.target)) {
        e.preventDefault();
        void sendRec("bookmark");
      }
    };
    // e.key가 아니라 e.code(물리 키)로 본다: 한글 입력 상태에서는 e.key가 "ㅠ"·"ㅏ"다
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rec.phase, sendRec]);

  const onRecordButton = () => {
    if (!recording && !transcribe.job.running) {
      resetRec();
      void startRec(mode);
    }
    setView({ kind: "record" });
  };

  const activeId = view.kind === "meeting" ? view.id : null;
  const groups = groupByDay(meetings);

  return (
    <div className="shell">
      <aside className="sidebar">
        <header className="brand">
          <span className="wordmark">Tractus</span>
          <span className="brand-sub">회의 기록</span>
        </header>

        <button className={`rec-button ${recording ? "is-live" : ""}`} onClick={onRecordButton} aria-current={view.kind === "record"}>
          <span className="rec-dot" aria-hidden />
          {recording ? (
            <>
              <span>녹음 중</span>
              <time className="tnum">{fmtTime(rec.t)}</time>
            </>
          ) : transcribe.job.running ? (
            <span>전사 중…</span>
          ) : (
            <span>녹음 시작</span>
          )}
        </button>

        <div className="mode-switch" role="radiogroup" aria-label="녹음 방식">
          {REC_MODES.map((m) => (
            <button
              key={m.mode}
              role="radio"
              aria-checked={mode === m.mode}
              title={m.note}
              disabled={recording}
              onClick={() => chooseMode(m.mode)}
            >
              {m.label}
            </button>
          ))}
        </div>

        <form
          className="search-box"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            const q = searchRef.current?.value.trim();
            if (q) setView({ kind: "search", q });
          }}
        >
          <input ref={searchRef} type="search" placeholder="회의 검색" aria-label="회의 검색" />
          <kbd aria-hidden>⌘K</kbd>
        </form>

        <nav className="meeting-nav" aria-label="회의 목록">
          {listError && <p className="nav-note is-error">{listError}</p>}
          {leftover.length > 0 && (
            <section className="day-group">
              <h2 className="month-label">전사 안 된 녹음</h2>
              <ul className="pending-list">
                {leftover.map((p) => (
                  <li key={p.dir}>
                    <button
                      className="meeting-link"
                      disabled={transcribe.job.running}
                      onClick={() => {
                        startTranscribe(p.dir);
                        setView({ kind: "record" });
                      }}
                    >
                      <span className="meeting-link-title tnum">
                        녹음 {p.started_at.slice(0, 10)} {p.started_at.slice(11, 16)}
                      </span>
                      <span className="meeting-link-meta tnum">
                        {p.duration === null ? "끊긴 녹음" : fmtTime(p.duration)}
                        <span className="badge">전사하기</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!listError && meetings.length === 0 && leftover.length === 0 && <p className="nav-note">아직 회의가 없습니다. 녹음을 시작하거나 설정에서 데이터 위치를 확인하세요.</p>}
          {groups.map((g, i) => {
            const p = dayParts(g.day);
            const newMonth = i === 0 || dayParts(groups[i - 1].day).month !== p.month;
            return (
              <section key={g.day} className="day-group">
                {newMonth && <h2 className="month-label">{p.month}</h2>}
                <div className="day-row">
                  <div className="day-num" aria-label={`${p.day}일 ${p.weekday}요일`}>
                    <span className="tnum">{p.day}</span>
                    <small>{p.weekday}</small>
                  </div>
                  <ul>
                    {g.items.map((m) => (
                      <li key={m.id}>
                        <button className="meeting-link" aria-current={m.id === activeId} onClick={() => openMeeting(m.id)}>
                          <span className="meeting-link-title">{m.title || "제목 없음"}</span>
                          <span className="meeting-link-meta tnum">
                            {fmtTime(m.duration_sec)}
                            {!m.has_summary && <span className="badge">요약 없음</span>}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </section>
            );
          })}
        </nav>

        <footer className="sidebar-foot">
          <button className="text-button" onClick={() => setView({ kind: "settings" })} aria-current={view.kind === "settings"}>
            설정
          </button>
          <span className="foot-note">{meetings.length}개 회의</span>
        </footer>
      </aside>

      <main className="main">
        {view.kind === "home" && <Welcome count={meetings.length} />}
        {view.kind === "meeting" && <MeetingView key={view.id} id={view.id} seek={view.seek} onChanged={refresh} />}
        {view.kind === "search" && <SearchView key={view.q} query={view.q} onOpen={openMeeting} />}
        {view.kind === "record" && <RecordView rec={rec} job={transcribe.job} send={sendRec} retry={() => transcribeDir.current && startTranscribe(transcribeDir.current)} />}
        {view.kind === "settings" && <SettingsView onSaved={refresh} />}
      </main>
    </div>
  );
}

function Welcome({ count }: { count: number }) {
  return (
    <section className="welcome">
      <p className="eyebrow">Tractus</p>
      <h1>
        말은 흘러가도
        <br />
        기록은 남습니다.
      </h1>
      <p className="welcome-lead">
        {count > 0 ? `회의 ${count}개가 이 Mac에 있습니다. 왼쪽에서 하나를 고르세요.` : "녹음은 이 Mac에서 전사되고, 파일로 남습니다."}
      </p>
      <dl className="shortcuts">
        <div>
          <dt><kbd>⌘K</kbd></dt>
          <dd>검색</dd>
        </div>
        <div>
          <dt><kbd>Space</kbd></dt>
          <dd>재생 / 일시정지</dd>
        </div>
        <div>
          <dt><kbd>B</kbd></dt>
          <dd>녹음 중 북마크</dd>
        </div>
      </dl>
    </section>
  );
}
