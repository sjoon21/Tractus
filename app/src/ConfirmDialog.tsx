import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { DIALOG, DIALOG_BODY, DIALOG_FOOTER, DIALOG_TEXT, DIALOG_TITLE, DIALOG_WARN } from "@/components/ui/dialog";

/**
 * 확인 대화상자. 브라우저 `<dialog>`의 모달(showModal)을 쓴다: 뒤 화면이 비활성이 되어 Tab이 안에서만 돌고, Esc는 취소다.
 * 처음 초점은 안전한 버튼(취소)이다. 화면에 올릴 때만 렌더하고(마운트 = 열림), 닫히면 초점이 누른 곳으로 돌아간다.
 * `busy`인 동안은 Esc도 취소 버튼도 듣지 않는다.
 */
export function ConfirmDialog({
  title,
  body,
  warning = null,
  cancelLabel,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  body: string;
  /** 본문 위에 강조해 보이는 주의 문장 (함께 사라지는 것 등) */
  warning?: string | null;
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
      className={DIALOG}
      role="alertdialog"
      aria-labelledby="confirm-title"
      aria-describedby={warning ? "confirm-warning confirm-body" : "confirm-body"}
      aria-busy={busy}
      onCancel={(e) => {
        e.preventDefault(); // Esc: 닫는 일은 상태가 한다
        if (!busy) onCancel();
      }}
    >
      <div className={DIALOG_BODY}>
        <h2 id="confirm-title" className={DIALOG_TITLE}>{title}</h2>
        {warning && (
          <p id="confirm-warning" className={DIALOG_WARN}>
            {warning}
          </p>
        )}
        <p id="confirm-body" className={DIALOG_TEXT}>{body}</p>
      </div>
      <div className={DIALOG_FOOTER}>
        <Button ref={safe} variant="outline" disabled={busy} onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="destructive" disabled={busy} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
