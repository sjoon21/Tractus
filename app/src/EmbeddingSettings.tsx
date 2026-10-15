// 설정 › 스마트 검색 방식: 이 Mac(기본) 또는 Upstage solar-embedding-2 (docs/desktop.md §2.14).
// Upstage를 고르면 노트 내용(스마트 검색 정보를 만들 때)과 검색어(검색할 때)가 Upstage로 전송된다: Upstage 키가 있어야 고를 수 있고, 고르기 전에 무엇이 가는지 한 번 확인한다.
// 바꾸면(어느 쪽이든) 스마트 검색 정보를 새로 만든다: 고친 문장을 반영하는 조용한 갱신(indexer)이 한가할 때 이어서 한다.
import { useState } from "react";
import { api, errDetail, errText, type LlmSettings } from "./api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorDetail } from "./ErrorDetail";
import { indexer } from "./indexer";
import { EMBED_CONFIRM, EMBED_LABEL, EMBED_LOCAL_ONLY, EMBED_NO_KEY, EMBED_NOTE, EMBED_OPTIONS, EMBED_SAVED, type EmbeddingChoice } from "./llmKey";

export function EmbeddingSection({ cfg, onChanged }: { cfg: LlmSettings; onChanged: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; detail: string | null; ok?: boolean } | null>(null);
  const hasKey = !!cfg.saved.upstage;
  const canUpstage = hasKey && !cfg.local_only; // 로컬 전용 모드에서는 코어가 Upstage를 쓰지 않는다

  const apply = async (choice: EmbeddingChoice) => {
    setBusy(true);
    try {
      await api.embeddingProviderSave(choice);
      indexer.touch();
      await onChanged();
      setMsg({ text: EMBED_SAVED[choice], detail: null, ok: true });
    } catch (e) {
      setMsg({ text: errText(e), detail: errDetail(e) });
    } finally {
      setAsking(false);
      setBusy(false);
    }
  };

  return (
    <div className="embed-choice">
      <label className="field">
        <span className="field-label">{EMBED_LABEL}</span>
        <select
          value={cfg.embedding_provider}
          disabled={busy}
          onChange={(e) => (e.target.value === "upstage" ? setAsking(true) : void apply("local"))}
        >
          <option value="local">{EMBED_OPTIONS.local}</option>
          <option value="upstage" disabled={!canUpstage}>
            {EMBED_OPTIONS.upstage}
          </option>
        </select>
        <span className="field-hint">{cfg.local_only ? EMBED_LOCAL_ONLY : hasKey ? EMBED_NOTE : `${EMBED_NO_KEY} ${EMBED_NOTE}`}</span>
      </label>
      {msg && (
        <p className="field-hint" role="status">
          {msg.text}
          <ErrorDetail detail={msg.detail} />
        </p>
      )}
      {asking && (
        <ConfirmDialog title={EMBED_CONFIRM.title} body={EMBED_CONFIRM.body} cancelLabel={EMBED_CONFIRM.cancel} confirmLabel={EMBED_CONFIRM.confirm} busy={busy} onCancel={() => setAsking(false)} onConfirm={() => void apply("upstage")} />
      )}
    </div>
  );
}
