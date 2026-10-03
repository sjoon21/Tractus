import { useEffect, useState } from "react";
import { api, errText, type McpStatus, type Settings } from "./api";
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
    </section>
  );
}
