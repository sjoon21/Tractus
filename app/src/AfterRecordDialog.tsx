import { useEffect, useRef, useState } from "react";
import type { Decision } from "./caps";
import { AFTER_ASK, askView, type AskChoice } from "./afterRecord";
import { useCapabilities } from "./useCapabilities";

/**
 * 녹음을 끝낸 뒤 묻는 창 (WORDS.md §4.18): 바로 변환하기 | 나중에 변환하기. ConfirmDialog처럼 네이티브 모달 `<dialog>`다(뒤 화면이 비활성이 되고 Tab이 안에서만 돈다).
 * - 처음 초점은 안전한 `바로 변환하기`. 변환할 수 없으면(`convert`가 못 쓰는 상태) 그 단추는 `aria-disabled`이고 이유와 고치는 길이 보이며, 초점은 `나중에 변환하기`다.
 * - Esc는 `나중에 변환하기`다 (녹음을 버리는 길은 없다). 이때 `다음부터 묻지 않기`는 무시한다: Esc로 설정을 바꾸지 않는다.
 * - `다음부터 묻지 않기`를 체크하고 고르면 그 선택이 설정에 남는다 (부르는 쪽이 저장한다).
 */
export function AfterRecordDialog({ seconds, convert, onChoose }: { seconds: number; convert: Decision; onChoose: (choice: AskChoice, remember: boolean) => void }) {
  const { fixAction } = useCapabilities();
  const view = askView(convert);
  const dialog = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const [remember, setRemember] = useState(false);
  const done = useRef(false); // 한 번만 고른다 (두 번 눌러도 변환·저장이 겹치지 않게)
  const pick = (choice: AskChoice, keep: boolean) => {
    if (done.current) return;
    done.current = true;
    onChoose(choice, keep);
  };
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (!d.open) d.showModal();
    first.current?.focus();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="confirm after-record"
      role="alertdialog"
      aria-labelledby="after-title"
      aria-describedby="after-body"
      onCancel={(e) => {
        e.preventDefault(); // Esc = 나중에 변환하기
        pick("later", false);
      }}
    >
      <h2 id="after-title">{AFTER_ASK.title}</h2>
      <p id="after-body">{AFTER_ASK.body(seconds)}</p>
      {view.reason && !convert.ok && (
        <p className="gate-hint" role="status">
          <span>{view.reason}</span>{" "}
          <button type="button" className="text-button" onClick={() => fixAction(convert.fix)}>
            {convert.fix.label}
          </button>
        </p>
      )}
      <label className="check after-remember">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
        <span>
          {AFTER_ASK.remember}
          <small>{AFTER_ASK.rememberHint}</small>
        </span>
      </label>
      <div className="confirm-actions">
        <button ref={view.focus === "later" ? first : undefined} type="button" className="ghost-button" onClick={() => pick("later", remember)}>
          {AFTER_ASK.later}
        </button>
        <button
          ref={view.focus === "convert" ? first : undefined}
          type="button"
          className="primary-button"
          aria-disabled={view.convertEnabled ? undefined : true}
          title={view.reason ?? undefined}
          onClick={() => view.convertEnabled && pick("convert", remember)}
        >
          {AFTER_ASK.convert}
        </button>
      </div>
    </dialog>
  );
}
