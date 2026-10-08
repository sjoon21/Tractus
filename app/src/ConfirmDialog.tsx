import { useEffect, useRef } from "react";

/**
 * 확인 대화상자. 브라우저 `<dialog>`의 모달(showModal)을 쓴다: 뒤 화면이 비활성이 되어 Tab이 안에서만 돌고, Esc는 취소다.
 * 처음 초점은 안전한 버튼(취소)이다. 화면에 올릴 때만 렌더하고(마운트 = 열림), 닫히면 초점이 누른 곳으로 돌아간다.
 * `busy`인 동안은 Esc도 취소 버튼도 듣지 않는다.
 */
export function ConfirmDialog({
  title,
  body,
  cancelLabel,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  cancelLabel: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const safe = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (!d.open) d.showModal();
    safe.current?.focus();
    return () => d.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="confirm"
      role="alertdialog"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      aria-busy={busy}
      onCancel={(e) => {
        e.preventDefault(); // Esc: 닫는 일은 상태가 한다
        if (!busy) onCancel();
      }}
    >
      <h2 id="confirm-title">{title}</h2>
      <p id="confirm-body">{body}</p>
      <div className="confirm-actions">
        <button ref={safe} className="ghost-button" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </button>
        <button className="danger-button" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
