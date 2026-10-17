// 전사 편집 도구 (docs/roadmap.md §2, Phase 5): 문장 편집기, 찾기·바꾸기 막대, 내보내기 메뉴.
import { useLayoutEffect, useRef } from "react";
import { EXPORT_FORMATS, isImeKey } from "./lib";
import { OBSIDIAN_ITEM } from "./obsidian";
import { ObsidianLogo } from "@/components/ui/obsidian-logo";
import { ChevronDown, ChevronUp, Share, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { checkClass } from "@/components/ui/switch";
import { cn } from "@/components/ui/utils";

/**
 * 세그먼트 문장 편집기. contentEditable="plaintext-only"라 붙여 넣어도 서식이 따라오지 않는다.
 * Enter(⌘Enter 포함)·포커스 이탈은 저장, Esc는 취소. 한글 조합 중 Enter는 조합만 끝낸다(isImeKey).
 * (fastrepl/anarlog segment.tsx L234-330, MIT 참고)
 */
export function SegmentEditor({ initial, onDone }: { initial: string; onDone: (raw: string | null, viaKey: boolean) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  const composing = useRef(false);
  const finished = useRef(false);
  const finish = (raw: string | null, viaKey: boolean) => {
    if (finished.current) return;
    finished.current = true;
    onDone(raw, viaKey);
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = initial;
    el.focus();
    const sel = window.getSelection();
    sel?.selectAllChildren(el);
    sel?.collapseToEnd();
  }, []); // 열 때 한 번만 채운다 (입력 중에 다시 채우지 않는다)

  return (
    <span
      ref={ref}
      className="seg-text seg-editor"
      contentEditable="plaintext-only"
      role="textbox"
      aria-label="대화 내용 수정 (Enter 저장, Esc 취소)"
      spellCheck={false}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => (composing.current = false)}
      onKeyDown={(e) => {
        if (isImeKey(e.nativeEvent, composing.current)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(ref.current?.textContent ?? "", true);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(null, true);
        }
      }}
      onBlur={() => finish(ref.current?.textContent ?? "", false)}
    />
  );
}

export interface FindState {
  q: string;
  r: string;
  glossary: boolean;
}

/** 찾기·바꾸기 막대 (⌘F). 바꾸기는 편집 묶음 1회, 되돌리기 1그룹 */
export function FindBar({
  state,
  onChange,
  count,
  current,
  onStep,
  onReplace,
  onReplaceAll,
  onClose,
  inputRef,
}: {
  state: FindState;
  onChange: (s: FindState) => void;
  count: number;
  current: number;
  onStep: (dir: 1 | -1) => void;
  onReplace: () => void;
  onReplaceAll: () => void;
  onClose: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const composing = useRef(false);
  const keys = (enter: (shift: boolean) => void) => ({
    onCompositionStart: () => (composing.current = true),
    onCompositionEnd: () => (composing.current = false),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (isImeKey(e.nativeEvent, composing.current)) return;
      if (e.key === "Enter") {
        e.preventDefault();
        enter(e.shiftKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    },
  });
  const canReplace = count > 0;

  return (
    <div className="find-bar sticky top-[52px] z-20 mx-auto grid w-full max-w-[860px] gap-2 border-b border-border bg-background/95 px-6 pt-1 pb-3 backdrop-blur-md" role="search" aria-label="대화 내용에서 찾기">
      <div className="flex items-center gap-1.5">
        <input
          ref={inputRef}
          autoFocus
          className={cn(inputClass, "h-7 flex-1")}
          value={state.q}
          placeholder="찾기"
          aria-label="찾을 말"
          onChange={(e) => onChange({ ...state, q: e.target.value })}
          {...keys((shift) => onStep(shift ? -1 : 1))}
        />
        <span className="min-w-[4.5em] text-right text-xs text-muted-foreground tabular-nums" aria-live="polite">
          {state.q ? (count ? `${current + 1} / ${count}` : "없음") : ""}
        </span>
        <Button variant="ghost" size="icon-sm" onClick={() => onStep(-1)} disabled={!count} aria-label="이전 (Shift+Enter)">
          <ChevronUp aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={() => onStep(1)} disabled={!count} aria-label="다음 (Enter)">
          <ChevronDown aria-hidden />
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="찾기 닫기 (Esc)">
          <X aria-hidden />
        </Button>
      </div>
      <div className="flex items-center gap-1.5">
        <input
          className={cn(inputClass, "h-7 flex-1")}
          value={state.r}
          placeholder="바꿀 말"
          aria-label="바꿀 말"
          onChange={(e) => onChange({ ...state, r: e.target.value })}
          {...keys(() => canReplace && onReplace())}
        />
        <Button variant="outline" size="sm" onClick={onReplace} disabled={!canReplace}>
          바꾸기
        </Button>
        <Button variant="outline" size="sm" onClick={onReplaceAll} disabled={!canReplace}>
          모두 바꾸기{count > 0 && <span className="tabular-nums"> {count}</span>}
        </Button>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" className={checkClass} checked={state.glossary} onChange={(e) => onChange({ ...state, glossary: e.target.checked })} />
        <span className="text-foreground">바꾼 말을 자주 쓰는 단어에 추가</span> <span>다음 녹음부터 이 단어를 더 정확하게 인식합니다</span>
      </label>
    </div>
  );
}

/** 머리말의 '내보내기' 메뉴. 네이티브 popover라 Esc·바깥 클릭으로 닫힌다. PDF는 코어가 아니라 인쇄 대화상자로 만든다 */
export function ExportMenu({ onPick, onPrint, onObsidian, formats = EXPORT_FORMATS }: { onPick: (f: (typeof EXPORT_FORMATS)[number]) => void; onPrint: () => void; onObsidian: () => void; formats?: typeof EXPORT_FORMATS }) {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const pick = (run: () => void) => {
    menu.current?.hidePopover();
    button.current?.focus();
    run();
  };
  return (
    <>
      <button ref={button} className={buttonVariants({ variant: "ghost", size: "sm" })} popoverTarget="export-menu" aria-haspopup="menu" data-tip="export">
        <Share aria-hidden />
        내보내기
      </button>
      <div
        ref={menu}
        id="export-menu"
        popover="auto"
        className="spk-menu export-menu"
        role="menu"
        aria-label="내보내기 형식"
        onBeforeToggle={(e) => {
          const a = button.current?.getBoundingClientRect();
          const el = menu.current;
          if (e.newState !== "open" || !a || !el) return;
          el.style.top = `${a.bottom + 6}px`;
          el.style.right = `${Math.max(12, window.innerWidth - a.right)}px`; // 머리 오른쪽 끝의 단추라 오른쪽을 맞춘다
        }}
        onToggle={(e) => e.newState === "open" && menu.current?.querySelector<HTMLElement>("button")?.focus()}
      >
        {formats.map((f) => (
          <button
            key={f.format}
            role="menuitem"
            onClick={() => pick(() => onPick(f))}
          >
            <span>{f.label}</span>
            <small className="tnum">
              .{f.ext} · {f.note}
            </small>
          </button>
        ))}
        <button role="menuitem" onClick={() => pick(onPrint)}>
          <span>PDF</span>
          <small className="tnum">.pdf · 인쇄 → PDF로 저장</small>
        </button>
        <button role="menuitem" onClick={() => pick(onObsidian)}>
          <span className="flex items-center gap-1.5">
            <ObsidianLogo />
            {OBSIDIAN_ITEM.label}
          </span>
          <small>{OBSIDIAN_ITEM.note}</small>
        </button>
      </div>
    </>
  );
}
