import { useEffect, useState } from "react";
import { api, errDetail, errText, type McpStatus, type Settings, type VoiceList, type VoicePerson } from "./api";
import { ErrorDetail } from "./ErrorDetail";
import { recMode, statusLine, withRecMode } from "./lib";

const FIELDS: { key: keyof Omit<Settings, "fake_recorder" | "rec_mode" | "live_captions">; label: string; hint: string }[] = [
  { key: "home", label: "데이터 위치 (TRACTUS_HOME)", hint: "meetings/와 recordings/가 들어 있는 폴더" },
  { key: "models_dir", label: "변환 엔진 위치 (TRACTUS_MODELS_DIR)", hint: "비우면 데이터 위치의 models/" },
  { key: "tractus_bin", label: "tractus 실행 파일", hint: "전체 경로로 적습니다 (앱은 터미널의 PATH를 읽지 않습니다)" },
  { key: "rec_bin", label: "tractus-rec 실행 파일", hint: "recorder/.build/release/tractus-rec" },
];

export function SettingsView({ onSaved }: { onSaved: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<McpStatus | { text: string; detail: string | null } | null>(null);

  useEffect(() => {
    api.getSettings().then(setS, (e) => setMsg(errText(e)));
  }, []);

  const checkStatus = () => {
    setStatus({ text: "확인 중…", detail: null });
    api.status().then(setStatus, (e) => setStatus({ text: errText(e), detail: errDetail(e) }));
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
            테스트용 모의 녹음 (가상 신호) — 마이크 권한 없이 녹음 과정을 시험합니다
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={s.live_captions} onChange={(e) => setS({ ...s, live_captions: e.target.checked })} />
          <span>
            녹음 중 실시간 텍스트 변환 (미리보기) — 말하는 동안 내용을 바로 보여 줍니다. 녹음 종료 후 고품질 텍스트로 정돈되며, 실시간 변환 내용은 저장하지 않습니다.
            녹음하는 동안 메모리를 약 2 GB 더 씁니다 (메모리 16 GB 미만 Mac에서는 켜지지 않습니다). 다음 녹음부터 적용됩니다.
          </span>
        </label>
        <div className="settings-actions">
          <button className="primary-button" type="submit">
            저장
          </button>
          <button className="ghost-button" type="button" onClick={checkStatus}>
            스마트 검색 상태
          </button>
          {msg && <span className="field-hint">{msg}</span>}
        </div>
      </form>

      {status && (
        <div className="status-box tnum">
          {"text" in status ? (
            <div>
              {status.text}
              <ErrorDetail detail={status.detail} />
            </div>
          ) : (
            <p>{statusLine(status)}</p>
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
      <h2 id="voices-title">참석자 목소리 프로필</h2>
      <p className="field-hint">
        회의 화면에서 참석자 이름을 바꿀 때 ‘이 참석자 목소리 등록’을 고르면 등록됩니다. 다음 회의부터 비슷한 목소리에 이름을 <b>제안</b>만 하고, 맞는지는 직접 고릅니다.
        목소리는 생체정보라 <code>{home.replace(/\/$/, "")}/voices.json</code>(이 Mac, 나만 읽을 수 있는 권한)에만 저장하고 이 Mac 밖으로 보내지 않습니다. 검색·요약·AI 질문에도 쓰지
        않습니다.
      </p>
      {list?.needs_reenroll && (
        <p className="record-warning" role="status">
          목소리 인식 방식이 바뀌어 지금 등록된 목소리로는 참석자를 알아보지 않습니다. 다시 등록하세요.
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
            <b>{asking.name}</b>의 목소리 표본 {asking.samples}개를 지웁니다. 회의에 붙인 이름은 그대로 남고, 다음 회의부터 이 사람을 제안하지 않습니다.
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
