// 설정 › AI 요약·질문: Upstage API 키 등록 (docs/desktop.md §2.14). 키는 입력창에서 Rust로 한 번 가고, 화면에 다시 채우지 않는다.
import { useEffect, useRef, useState } from "react";
import { api, errDetail, errText } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorDetail } from "./ErrorDetail";
import { isImeKey } from "./lib";
import { KEY_CHANGED, keyProblem, keyStatusText } from "./llmKey";

export function LlmKeySection() {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState<{ text: string; detail: string | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const composing = useRef(false);

  const fail = (e: unknown) => setMsg({ text: errText(e), detail: errDetail(e) });
  const load = () => api.llmKeyStatus().then((s) => setSaved(s.saved), fail);
  const changed = () => window.dispatchEvent(new Event(KEY_CHANGED));
  useEffect(() => void load(), []);

  const save = async () => {
    const problem = keyProblem(key);
    if (problem) return setMsg({ text: problem, detail: null });
    setBusy(true);
    try {
      await api.llmKeySave(key);
      setKey(""); // 저장한 키는 화면에 남기지 않는다
      setMsg({ text: "API 키를 저장했습니다.", detail: null });
      changed();
      await load();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.llmKeyDelete();
      setAsking(false);
      setMsg({ text: "API 키를 삭제했습니다.", detail: null });
      changed();
      await load();
    } catch (e) {
      setAsking(false);
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="voices" aria-labelledby="llm-key-title">
      <h2 id="llm-key-title">AI 요약·질문</h2>
      <p className="field-hint">
        요약·질문에 쓰는 AI 서비스는 Upstage입니다. 키는 이 Mac의 앱 설정 폴더에만 저장되고 노트 폴더에는 저장되지 않습니다. 요약과 질문을 요청할 때 해당 노트의 대화 내용이 Upstage로 전송됩니다.
        키는 https://console.upstage.ai 에서 받을 수 있습니다.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span className="field-label">Upstage API 키</span>
          <input
            type="password"
            name="upstage-api-key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && isImeKey(e.nativeEvent, composing.current)) e.preventDefault(); // 한글 조합 중 Enter는 저장이 아니다
            }}
            autoComplete="new-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <div className="settings-actions">
          <button className="primary-button" type="submit" disabled={busy || !key}>
            저장
          </button>
          <button className="ghost-button" type="button" disabled={busy || !saved} onClick={() => setAsking(true)}>
            삭제
          </button>
          <span className="field-hint" role="status">
            {keyStatusText(saved)}
          </span>
        </div>
      </form>
      {msg && (
        <p className="field-hint" role="status">
          {msg.text}
          <ErrorDetail detail={msg.detail} />
        </p>
      )}
      {asking && (
        <ConfirmDialog
          title="API 키를 삭제할까요?"
          body="이 Mac에 저장된 키를 지웁니다. 키를 다시 등록하기 전에는 요약과 질문을 쓸 수 없습니다."
          cancelLabel="취소"
          confirmLabel="삭제"
          busy={busy}
          onCancel={() => setAsking(false)}
          onConfirm={() => void remove()}
        />
      )}
    </section>
  );
}
