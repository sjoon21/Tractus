import { useEffect, useState } from "react";
import { api, errText, type McpStatus, type Settings, type VoiceList, type VoicePerson } from "./api";
import { recMode, withRecMode } from "./lib";

const FIELDS: { key: keyof Omit<Settings, "fake_recorder" | "rec_mode">; label: string; hint: string }[] = [
  { key: "home", label: "데이터 위치 (TRACTUS_HOME)", hint: "meetings/와 recordings/가 들어 있는 폴더" },
  { key: "models_dir", label: "모델 위치 (TRACTUS_MODELS_DIR)", hint: "비우면 데이터 위치의 models/" },
  { key: "tractus_bin", label: "tractus 실행 파일", hint: "GUI 앱은 셸 PATH를 모르므로 절대 경로" },
  { key: "rec_bin", label: "tractus-rec 실행 파일", hint: "recorder/.build/release/tractus-rec" },
];

export function SettingsView({ onSaved }: { onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<McpStatus | string | null>(null);

  useEffect(() => {
    api.getSettings().then(setS, (e) => setMsg(errText(e)));
  }, []);

  const checkStatus = () => {
    setStatus("확인 중…");
    api.status().then(setStatus, (e) => setStatus(errText(e)));
  };

  if (!s) return <p className="page-loading">{msg ?? "불러오는 중…"}</p>;

  return (
    <section className="settings" aria-labelledby="settings-title">
      <p className="eyebrow">설정</p>
      <h1 id="settings-title">경로와 실행 파일</h1>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            // 녹음 방식은 사이드바에서 바꾼다. 이 화면을 연 뒤 바뀌었을 수 있으니 저장된 값을 유지한다
            const latest = await api.getSettings();
            await api.saveSettings(withRecMode(s, recMode(latest.rec_mode)));
            setMsg("저장했습니다.");
            onSaved();
          } catch (err) {
            setMsg(errText(err));
          }
        }}
      >
        {FIELDS.map((f) => (
          <label key={f.key} className="field">
            <span className="field-label">{f.label}</span>
            <input value={s[f.key]} onChange={(e) => setS({ ...s, [f.key]: e.target.value })} spellCheck={false} />
            <span className="field-hint">{f.hint}</span>
          </label>
        ))}
        <label className="check">
          <input type="checkbox" checked={s.fake_recorder} onChange={(e) => setS({ ...s, fake_recorder: e.target.checked })} />
          <span>
            개발용 가짜 녹음 (<code>--fake</code>) — 권한 없이 합성 신호로 녹음 흐름을 시험합니다
          </span>
        </label>
        <div className="settings-actions">
          <button className="primary-button" type="submit">
            저장
          </button>
          <button className="ghost-button" type="button" onClick={checkStatus}>
            검색 서버 상태
          </button>
          {msg && <span className="field-hint">{msg}</span>}
        </div>
      </form>

      {status && (
        <div className="status-box tnum">
          {typeof status === "string" ? (
            <p>{status}</p>
          ) : (
            <>
              <p>
                회의 {status.meetings}개 · 색인 청크 {status.indexed_chunks}개 · 벡터 {status.vectors}개 · 의미 검색 {status.vector_search ? "켜짐" : "꺼짐"}
              </p>
              {status.hint && <p className="field-hint">{status.hint}</p>}
            </>
          )}
        </div>
      )}

      <VoicesSection home={s.home} />
    </section>
  );
}

/** 목소리 프로필 (Phase 7.1). 지우기는 앱 안에서 한 번 더 묻는다 (window.confirm은 쓰지 않는다) */
function VoicesSection({ home }: { home: string }) {
  const [list, setList] = useState<VoiceList | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [asking, setAsking] = useState<VoicePerson | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.voicesList().then(setList, (e) => setMsg(errText(e)));
  useEffect(() => void load(), []);

  const forget = async (p: VoicePerson) => {
    setBusy(true);
    try {
      await api.voicesForget(p.id);
      setMsg(`‘${p.name}’의 목소리를 지웠습니다.`);
      setAsking(null);
      await load();
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="voices" aria-labelledby="voices-title">
      <h2 id="voices-title">목소리</h2>
      <p className="field-hint">
        회의 화면에서 화자 이름을 바꿀 때 ‘이 목소리 기억하기’를 고르면 등록됩니다. 다음 전사부터 비슷한 목소리에 이름을 <b>제안</b>만 하고, 확정은 직접 합니다. 목소리는
        생체정보라 <code>{home.replace(/\/$/, "")}/voices.json</code>(이 Mac, 나만 읽을 수 있는 권한)에만 저장하고 이 Mac 밖으로 보내지 않습니다. 검색·요약·질문에도 쓰지 않습니다.
      </p>
      {list?.needs_reenroll && (
        <p className="record-warning" role="status">
          목소리 인식 모델이 바뀌어 지금 등록된 목소리로는 맞춰 보지 않습니다. 다시 등록하세요.
        </p>
      )}
      {list && list.people.length === 0 && <p className="voices-empty">아직 등록한 목소리가 없습니다.</p>}
      {list && list.people.length > 0 && (
        <ul className="voices-list">
          {list.people.map((p) => (
            <li key={p.id}>
              <span className="voices-name">{p.name}</span>
              <span className="voices-meta tnum">
                표본 {p.samples}개{p.created_at && ` · ${p.created_at.slice(0, 10)} 등록`}
              </span>
              <button className="text-button" disabled={busy} onClick={() => setAsking(p)} aria-label={`${p.name} 목소리 삭제`}>
                삭제
              </button>
            </li>
          ))}
        </ul>
      )}
      {asking && (
        <div className="speakers-confirm" role="alertdialog" aria-label="목소리 삭제">
          <p>
            <b>{asking.name}</b>의 목소리 표본 {asking.samples}개를 지웁니다. 회의에 붙인 이름은 그대로 남고, 새로 전사하는 회의부터 이 사람을 제안하지 않습니다.
          </p>
          <button className="primary-button" onClick={() => void forget(asking)} disabled={busy} autoFocus>
            지우기
          </button>
          <button className="text-button" onClick={() => setAsking(null)}>
            취소
          </button>
        </div>
      )}
      {msg && (
        <p className="field-hint" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
