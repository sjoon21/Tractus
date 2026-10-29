import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { DIALOG, DIALOG_BODY, DIALOG_FOOTER, DIALOG_TEXT, DIALOG_TITLE } from "@/components/ui/dialog";
import { api, errText } from "./api";
import { NEW_VERSION_DIALOG, NOTES_LABEL } from "./update";

/**
 * 시작 때 새 버전을 찾았을 때의 큰 창 (WORDS.md §4.21, docs/desktop.md §3.5). 받지도 설치하지도 않는다: `업데이트 보기`는 설정의 업데이트 절로 간다.
 * ConfirmDialog처럼 네이티브 모달 `<dialog>`이고, Esc는 `나중에`다. 처음 초점은 `업데이트 보기`.
 */
export function UpdateDialog({ version, notes, onOpen, onLater }: { version: string; notes: string | null; onOpen: () => void; onLater: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
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
      className={DIALOG}
      aria-labelledby="update-title"
      aria-describedby="update-body"
      onCancel={(e) => {
        e.preventDefault(); // Esc = 나중에
        onLater();
      }}
    >
      <div className={DIALOG_BODY}>
        <h2 id="update-title" className={DIALOG_TITLE}>
          {NEW_VERSION_DIALOG.title(version)}
        </h2>
        <p id="update-body" className={DIALOG_TEXT}>
          {NEW_VERSION_DIALOG.body}
        </p>
        {notes && <pre className="m-0 mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-secondary px-3 py-2 font-sans text-xs leading-relaxed text-muted-foreground">{notes}</pre>}
        <span className="text-xs">
          <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={() => void api.openReleaseNotes(version).then(() => setLinkError(null), (e) => setLinkError(errText(e)))}>
            {NOTES_LABEL} ({version})
          </Button>
          {linkError && <span className="ml-2 text-destructive">{linkError}</span>}
        </span>
      </div>
      <div className={DIALOG_FOOTER}>
        <Button variant="outline" onClick={onLater}>
          {NEW_VERSION_DIALOG.later}
        </Button>
        <Button ref={first} onClick={onOpen}>
          {NEW_VERSION_DIALOG.open}
        </Button>
      </div>
    </dialog>
  );
}
