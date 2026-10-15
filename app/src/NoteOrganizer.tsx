// 노트 머리의 정리 줄: ★ 즐겨찾기, 폴더 고르기, 태그 (docs/desktop.md §2.12). 상태는 사이드바와 같은 곳(useOrganize)에 있어 어느 쪽에서 바꿔도 같이 바뀐다.
import { useEffect, useId, useRef, useState } from "react";
import { FolderPicker } from "./FolderPicker";
import { isImeKey } from "./lib";
import { addTags, folderPath, removeTag, suggestTags } from "./organize";
import { useOrganize } from "./useOrganize";
import { Folder, Hash, Star, X } from "lucide-react";
import { cn } from "@/components/ui/utils";

const PILL = "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 [&_svg]:size-3.5";

const FRESH_MS = 3000; // 사이드바 줄 메뉴의 `태그 편집`이 노트를 여는 사이에 지나간 요청은 버린다
let handledFocus = 0; // 이미 처리한 초점 요청 (노트를 다시 열어도 같은 요청으로 또 초점을 달라고 하지 않게)

export function NoteOrganizer({ id }: { id: string }) {
  const org = useOrganize();
  const meta = org.metaOf(id);
  const [picking, setPicking] = useState<HTMLElement | null>(null);
  const known = new Set(org.folders.map((f) => f.id));
  const at = meta.folder && known.has(meta.folder) ? meta.folder : null;
  const path = at ? folderPath(org.folders, at) : "";

  return (
    <div className="note-organize flex min-w-0 flex-wrap items-center gap-0.5">
      <div className="contents">
        <button
          type="button"
          className={cn(PILL, "aria-pressed:text-memo")}
          aria-label="즐겨찾기"
          aria-pressed={meta.favorite}
          title={meta.favorite ? "즐겨찾기에서 뺍니다" : "즐겨찾기에 추가합니다"}
          onClick={() => void org.setFavorite(id, !meta.favorite)}
        >
          <Star aria-hidden className={meta.favorite ? "fill-memo" : ""} />
        </button>
        <button
          type="button"
          className={PILL}
          aria-haspopup="menu"
          aria-expanded={!!picking}
          aria-label={path ? `폴더: ${path} — 바꾸기` : "폴더 고르기 (지금은 폴더 없음)"}
          title="노트를 넣을 폴더 고르기"
          onClick={(e) => setPicking((p) => (p ? null : e.currentTarget))}
        >
          <Folder aria-hidden />
          <span className="max-w-[14rem] truncate">{path || "폴더 없음"}</span>
        </button>
        {picking && (
          <FolderPicker
            anchor={picking}
            current={at}
            onClose={() => setPicking(null)}
            onPick={(f) => {
              if (f !== at) void org.moveNote(id, f);
            }}
          />
        )}
      </div>
      <TagEditor id={id} />
    </div>
  );
}

/** 태그 칩과 입력창. Enter·쉼표로 더하고, 입력창이 비었을 때 Backspace로 마지막 태그를 뺀다. 기존 태그를 제안한다 (한글 조합 중에는 아무것도 하지 않는다) */
function TagEditor({ id }: { id: string }) {
  const org = useOrganize();
  const tags = org.metaOf(id).tags;
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useId();
  const suggestions = focused ? suggestTags(org.tags, tags, draft) : [];

  useEffect(() => {
    const f = org.tagFocus;
    if (f && f.id === id && f.nonce > handledFocus && Date.now() - f.nonce < FRESH_MS) {
      handledFocus = f.nonce;
      input.current?.focus();
      input.current?.scrollIntoView({ block: "nearest" });
    }
  }, [org.tagFocus, id]);

  const add = (raw: string): boolean => {
    const r = addTags(tags, raw);
    setError(r.error);
    if (r.error) return false;
    if (r.tags.length !== tags.length) void org.setTags(id, r.tags);
    return true;
  };
  /** 쉼표 앞의 글은 태그로 더하고 나머지는 입력창에 둔다 */
  const consume = (value: string) => {
    const at = Math.max(value.lastIndexOf(","), value.lastIndexOf("，"));
    if (at < 0) return setDraft(value);
    if (add(value.slice(0, at))) setDraft(value.slice(at + 1));
    else setDraft(value);
    setActive(-1);
  };

  return (
    <div className="relative flex min-w-0 flex-wrap items-center gap-0.5" role="group" aria-label="태그">
      <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
        {tags.map((t) => (
          <li key={t} className="inline-flex h-6 items-center gap-0.5 rounded-md bg-secondary pr-0.5 pl-2 text-xs text-secondary-foreground">
            <span className="before:text-subtle-foreground before:content-['#']">{t}</span>
            <button type="button" className="grid size-5 place-items-center rounded-[4px] text-subtle-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40" aria-label={`태그 ${t} 빼기`} title="태그 빼기" onClick={() => void org.setTags(id, removeTag(tags, t))}>
              <X className="size-3" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
      <div className="relative flex items-center">
        <Hash className="pointer-events-none absolute left-1.5 size-3.5 text-subtle-foreground" aria-hidden />
        <input
          ref={input}
          className={cn("h-6 rounded-md bg-transparent pr-1.5 pl-6 text-xs outline-none transition-[width,background-color] placeholder:text-subtle-foreground hover:bg-accent focus:w-52 focus:bg-accent", tags.length ? "w-24" : "w-52")}
          value={draft}
          placeholder={tags.length ? "태그 추가" : "태그 추가 (Enter 또는 쉼표)"}
          aria-label="태그 추가 (Enter 또는 쉼표로 더하고, 비어 있을 때 Backspace로 마지막 태그를 뺍니다)"
          aria-invalid={!!error}
          aria-describedby={error ? `${list}-error` : undefined}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={list}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && suggestions[active] ? `${list}-${active}` : undefined}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            setActive(-1);
            if (draft.trim() && add(draft)) setDraft("");
          }}
          onChange={(e) => {
            setError(null);
            setActive(-1);
            if (composing.current || (e.nativeEvent instanceof InputEvent && e.nativeEvent.isComposing)) return setDraft(e.target.value);
            consume(e.target.value);
          }}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={(e) => {
            composing.current = false;
            consume(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            if (isImeKey(e.nativeEvent, composing.current)) return;
            if (e.key === "ArrowDown" && suggestions.length) {
              e.preventDefault();
              setActive((a) => (a + 1) % suggestions.length);
            } else if (e.key === "ArrowUp" && suggestions.length) {
              e.preventDefault();
              setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (add(active >= 0 && suggestions[active] ? suggestions[active] : draft)) {
                setDraft("");
                setActive(-1);
              }
            } else if (e.key === "Backspace" && draft === "" && tags.length) {
              void org.setTags(id, tags.slice(0, -1));
            } else if (e.key === "Escape" && (draft || suggestions.length)) {
              e.preventDefault();
              e.stopPropagation(); // 입력 중인 글만 버린다 (다른 Esc 동작으로 넘기지 않는다)
              setDraft("");
              setActive(-1);
              setError(null);
            }
          }}
        />
        {suggestions.length > 0 && (
          <ul id={list} className="absolute top-full left-0 z-30 m-0 mt-1 flex min-w-40 list-none flex-col rounded-lg border border-border bg-popover p-1 text-[13px] shadow-pop" role="listbox" aria-label="이미 쓴 태그">
            {suggestions.map((s, i) => (
              <li
                key={s}
                id={`${list}-${i}`}
                role="option"
                aria-selected={i === active}
                className="cursor-default rounded-[5px] px-2 py-1 hover:bg-accent aria-selected:bg-accent"
                onMouseDown={(e) => {
                  e.preventDefault(); // 입력창을 벗어나지 않게
                  if (add(s)) setDraft("");
                }}
              >
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && (
        <p id={`${list}-error`} className="m-0 w-full text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
