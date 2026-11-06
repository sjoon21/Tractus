// ⌘K 빠른 실행 (WORDS.md §4.30): 화면 가운데 창에서 노트를 열거나 앱 동작을 실행하거나 내용으로 검색한다.
// 고르는 규칙은 palette.ts(테스트). 브라우저 `<dialog>` 모달이라 뒤 화면은 비활성이고 Esc·바깥 누르기는 닫기다
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FileText, Search } from "lucide-react";
import type { MeetingInfo } from "./api";
import { t } from "./i18n";
import { paletteSections, pickable, step, type PaletteAction, type PaletteItem } from "./palette";
import { DIALOG } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/components/ui/utils";

const NONE: readonly PaletteAction[] = [];

export function CommandPalette({ notes, actions, noteActions = NONE, jumps = NONE, onOpenNote, onSearch, onClose }: { notes: readonly MeetingInfo[]; actions: readonly PaletteAction[]; noteActions?: readonly PaletteAction[]; jumps?: readonly PaletteAction[]; onOpenNote: (id: string) => void; onSearch: (q: string) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [q, setQ] = useState("");
  const sections = useMemo(() => paletteSections(notes, actions, q, noteActions, jumps), [notes, actions, q, noteActions, jumps]);
  const items = useMemo(() => sections.flatMap((s) => s.items), [sections]);
  const [pick, setPick] = useState(0);
  const id = useId();
  const optionId = (i: number) => `${id}-opt-${i}`;
  // 입력이 바뀌면 첫 고를 수 있는 항목으로
  useEffect(() => {
    setPick(step(items, -1, 1));
  }, [items]);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  // 고른 항목이 보이게. 중괄호로 감싼다: 새 브라우저의 scrollIntoView는 Promise를 돌려주는데 effect가 그것을 돌려주면 React가 정리 함수로 부른다
  useEffect(() => {
    document.getElementById(`${id}-opt-${pick}`)?.scrollIntoView?.({ block: "nearest" });
  }, [id, pick]);

  const run = (item: PaletteItem | undefined) => {
    if (!item || !pickable(item)) return;
    onClose(); // 먼저 닫는다: 동작이 여는 창·화면이 이 모달 뒤에 깔리지 않게
    if (item.kind === "note") onOpenNote(item.note.id);
    else if (item.kind === "search") onSearch(item.q);
    else item.action.run();
  };

  let n = -1; // 묶음을 지나며 매기는 항목 번호
  return (
    <dialog
      ref={dialog}
      aria-label={t("빠른 실행")}
      className={cn(DIALOG, "mt-[12vh] mb-auto w-[min(600px,calc(100vw-48px))] overflow-hidden")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(e) => e.target === dialog.current && onClose()} // 뒤 화면(backdrop)을 누르면 닫는다
    >
      <div className="flex items-center gap-2 border-b border-border px-4">
        <Search className="size-4 shrink-0 text-subtle-foreground" aria-hidden />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={`${id}-list`}
          aria-activedescendant={pick >= 0 ? optionId(pick) : undefined}
          aria-autocomplete="list"
          aria-label={t("노트·동작 찾기")}
          placeholder={t("노트·동작 찾기")}
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-subtle-foreground"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return; // 글자 조합 중에는 키를 가로채지 않는다
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setPick((p) => step(items, p, e.key === "ArrowDown" ? 1 : -1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(items[pick]);
            }
          }}
        />
        <Kbd>Esc</Kbd>
      </div>
      <div id={`${id}-list`} role="listbox" aria-label={t("빠른 실행")} className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5">
        {!items.length && <p className="m-0 px-3 py-6 text-center text-[13px] text-muted-foreground">{t("맞는 것이 없습니다")}</p>}
        {sections.map((s) => (
          <div key={s.title} role="group" aria-label={s.title} className="pb-1">
            <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-subtle-foreground">{s.title}</div>
            {s.items.map((item) => {
              const i = ++n;
              const blocked = item.kind === "action" ? item.action.blocked : undefined;
              return (
                <div
                  key={i}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === pick}
                  aria-disabled={blocked ? true : undefined}
                  className={cn("flex h-9 cursor-default items-center gap-2.5 rounded-md px-2.5 text-[13px] [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground", i === pick && "bg-accent", blocked && "opacity-50")}
                  onMouseMove={() => !blocked && i !== pick && setPick(i)}
                  onMouseDown={(e) => e.preventDefault()} // 입력칸의 초점을 지킨다
                  onClick={() => run(item)}
                >
                  {item.kind === "note" ? (
                    <>
                      <FileText aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{item.note.title || t("제목 없음")}</span>
                    </>
                  ) : item.kind === "search" ? (
                    <>
                      <Search aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{t("내용에서 ‘{q}’ 찾기", { q: item.q })}</span>
                    </>
                  ) : (
                    <>
                      {item.action.icon}
                      <span className="min-w-0 flex-1 truncate">{item.action.label}</span>
                      {blocked ? <span className="shrink-0 text-xs text-muted-foreground">{blocked}</span> : item.action.kbd && <Kbd>{item.action.kbd}</Kbd>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </dialog>
  );
}
