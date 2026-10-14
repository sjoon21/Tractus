// 노트 머리의 정리 줄: ★ 즐겨찾기, 폴더 고르기, 태그 (docs/desktop.md §2.12). 상태는 사이드바와 같은 곳(useOrganize)에 있어 어느 쪽에서 바꿔도 같이 바뀐다.
import { useEffect, useId, useRef, useState } from "react";
import { FolderPicker } from "./FolderPicker";
import { isImeKey } from "./lib";
import { addTags, folderPath, removeTag, suggestTags } from "./organize";
import { useOrganize } from "./useOrganize";

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
    <div className="note-organize">
      <div className="note-organize-row">
        <button
          type="button"
          className={`organize-button favorite-button ${meta.favorite ? "is-on" : ""}`}
          aria-pressed={meta.favorite}
          title={meta.favorite ? "즐겨찾기에서 뺍니다" : "즐겨찾기에 추가합니다"}
          onClick={() => void org.setFavorite(id, !meta.favorite)}
        >
          <span aria-hidden>{meta.favorite ? "★" : "☆"}</span>
          <span>즐겨찾기</span>
        </button>
        <button
          type="button"
          className="organize-button folder-button"
          aria-haspopup="menu"
          aria-expanded={!!picking}
          aria-label={path ? `폴더: ${path} — 바꾸기` : "폴더 고르기 (지금은 폴더 없음)"}
          title="노트를 넣을 폴더 고르기"
          onClick={(e) => setPicking((p) => (p ? null : e.currentTarget))}
        >
          <span className="folder-glyph" aria-hidden />
          <span className="folder-path">{path || "폴더 없음"}</span>
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
    <div className="tag-editor" role="group" aria-label="태그">
      <ul className="tag-list">
        {tags.map((t) => (
          <li key={t} className="tag-chip">
            <span>{t}</span>
            <button type="button" aria-label={`태그 ${t} 빼기`} title="태그 빼기" onClick={() => void org.setTags(id, removeTag(tags, t))}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="tag-input-wrap">
        <input
          ref={input}
          className="tag-input"
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
          <ul id={list} className="tag-suggest" role="listbox" aria-label="이미 쓴 태그">
            {suggestions.map((s, i) => (
              <li
                key={s}
                id={`${list}-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? "is-active" : ""}
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
        <p id={`${list}-error`} className="inline-error tag-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
