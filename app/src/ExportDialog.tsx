import { useEffect, useRef, useState } from "react";
import { exportSelection, initialPick, loadPicks, savePicks, type ExportItem } from "./exportPick";
import { t } from "./i18n";
import { Button } from "@/components/ui/button";
import { DIALOG, DIALOG_BODY, DIALOG_FOOTER, DIALOG_TEXT, DIALOG_TITLE } from "@/components/ui/dialog";
import { checkClass } from "@/components/ui/switch";
import { cn } from "@/components/ui/utils";

export type ExportPick = ReturnType<typeof exportSelection>;

/**
 * Markdown·Word 내보내기에 넣을 내용을 고르는 창 (exportPick.ts). 네이티브 모달 `<dialog>`다.
 * 처음 선택은 지난번에 끈 종류만 뺀 전부이고, `내보내기`를 누르면 그 선택을 기억한 뒤 저장 대화상자로 간다. 아무것도 고르지 않으면 `내보내기`를 막는다. Esc는 취소.
 */
export function ExportDialog({ label, items, onDone }: { label: string; items: ExportItem[]; onDone: (pick: ExportPick | null) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [checked, setChecked] = useState(() => initialPick(items, loadPicks()));
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (!d.open) d.showModal();
    return () => d.close();
  }, []);
  const toggle = (id: string, on: boolean) => setChecked((s) => (on ? new Set(s).add(id) : new Set([...s].filter((x) => x !== id))));
  const done = () => {
    savePicks(items, checked);
    onDone(exportSelection(items, checked));
  };
  const firstPart = items.findIndex((i) => !i.summary);
  return (
    <dialog
      ref={dialog}
      className={DIALOG}
      aria-labelledby="export-pick-title"
      onCancel={(e) => {
        e.preventDefault();
        onDone(null);
      }}
    >
      <div className={DIALOG_BODY}>
        <h2 id="export-pick-title" className={DIALOG_TITLE}>
          {t("내보낼 내용 고르기")}
        </h2>
        <p className={DIALOG_TEXT}>{t("{format} 파일 하나에 위에서부터 차례로 담습니다.", { format: label })}</p>
        <ul className="m-0 mt-1 flex list-none flex-col p-0">
          {items.map((i, n) => (
            <li key={i.id} className={cn(n > 0 && n === firstPart && "mt-1.5 border-t border-border pt-1.5")}>
              <label className="flex h-8 items-center gap-2.5 rounded-md px-1 text-[13px] hover:bg-accent">
                <input type="checkbox" className={checkClass} checked={checked.has(i.id)} onChange={(e) => toggle(i.id, e.target.checked)} />
                <span className="min-w-0 flex-1 truncate">{i.label}</span>
                {i.summary && <small className="text-xs text-subtle-foreground">{t("요약")}</small>}
              </label>
            </li>
          ))}
        </ul>
      </div>
      <div className={DIALOG_FOOTER}>
        <Button variant="outline" onClick={() => onDone(null)}>
          {t("취소")}
        </Button>
        <Button autoFocus disabled={checked.size === 0} title={checked.size === 0 ? t("넣을 내용을 하나 이상 고르세요") : undefined} onClick={done}>
          {t("내보내기")}
        </Button>
      </div>
    </dialog>
  );
}
