// 메모 본문 편집기와 노트 제목 편집기 (MeetingView가 쓴다). 메모 노트는 화면 가운데(page), 녹음 노트는 오른쪽 패널의 메모 탭(rail)에 같은 편집기를 둔다.
// 순수 로직(자동 저장·제목 검사·줄 위치)은 memo.ts.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errDetail, errText, type MeetingDetail } from "./api";
import type { Notify } from "./App";
import { editQueue } from "./editQueue";
import { t } from "./i18n";
import { isImeKey, type Segment } from "./lib";
import { checkTitle, citedRange, createAutosave, registerMemo, SAVE_STATUS, TITLE_MAX, type Autosave, type SaveState } from "./memo";
import { checkAtClick, continueList, toggleCheck, wrapSelection, type Edit } from "./memoEdit";
import { EDIT_BLOCKED } from "./remove";
import { Pencil } from "lucide-react";
import { cn } from "@/components/ui/utils";

/** 노트 제목 (보기·입력 모두 같은 크기, DESIGN.md §2) */
const TITLE = "m-0 text-[22px] font-semibold leading-tight tracking-tight";

export interface MemoTarget {
  /** 고를 줄. null이면 줄을 고르지 않고 본문 끝에 초점만 둔다 (탭을 눌러 연 경우) */
  segId: string | null;
  nonce: number;
}

export function MemoEditor({
  id,
  initial,
  savedBody,
  segments,
  target,
  notify,
  onSaved,
  onState,
  variant = "page",
  locked = null,
}: {
  id: string;
  /** 처음 디스크에 있던 본문 */
  initial: string;
  /** 코어가 마지막으로 확인한 본문과 줄 (인용 줄 위치 계산용) */
  savedBody: string;
  segments: Segment[];
  /** 검색·인용·요약 칩이 가리키는 줄: 그 줄을 골라 둔다 */
  target: MemoTarget | null;
  notify: Notify;
  onSaved: (m: MeetingDetail) => void;
  onState: (s: SaveState) => void;
  /** page: 메모 노트의 본문(처음 열 때 초점을 둔다). rail: 녹음 노트의 메모 탭(탭 키보드가 초점을 가지므로 줄을 가리킬 때만 초점을 옮긴다) */
  variant?: "page" | "rail";
  /** 값이 있으면 읽기 전용이고 상태 줄에 이 문장을 보인다 (녹음 추가 중, attach.LOCK_NOTICE) */
  locked?: string | null;
}) {
  const [text, setText] = useState(initial);
  const [state, setState] = useState<SaveState>({ status: "saved" });
  const box = useRef<HTMLTextAreaElement>(null);
  const textRef = useRef(text);
  textRef.current = text;
  const live = useRef({ notify, onSaved, onState });
  live.current = { notify, onSaved, onState };
  // 저장 실패를 알린 뒤에는 성공할 때까지 다시 알리지 않는다 (입력할 때마다 다시 시도하므로)
  const settled = useRef<SaveState["status"]>("saved");

  const auto = useRef<Autosave | null>(null);
  if (!auto.current) {
    auto.current = createAutosave({
      initial,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      // 노트마다 한 줄(editQueue)에 세운다: 제목 바꾸기·내보내기·삭제와 순서가 맞는다. 삭제를 기다리는 중이면 저장하지 않고 실패로 둔다
      save: async (body) => {
        const r = await editQueue.run(id, () => api.noteSave(id, body));
        if (!r) throw new Error(EDIT_BLOCKED);
        live.current.onSaved(r.meeting);
      },
      onState: (s) => {
        setState(s);
        live.current.onState(s);
        if (s.status === "failed" && settled.current !== "failed") live.current.notify({ text: errText(s.error), detail: errDetail(s.error), error: true });
        if (s.status !== "saving") settled.current = s.status;
      },
    });
  }
  const a = auto.current;

  // 화면을 옮기거나 창을 닫기 전에 저장을 마칠 수 있게 등록한다. 떠날 때(언마운트)에도 남은 글을 저장한다
  useEffect(() => registerMemo(id, { flush: () => a.flush(), drop: () => a.dispose() }), [id, a]);
  useEffect(() => () => void a.flush(), [a]);
  useEffect(() => {
    const hide = () => document.visibilityState === "hidden" && void a.flush();
    document.addEventListener("visibilitychange", hide);
    return () => document.removeEventListener("visibilitychange", hide);
  }, [a]);

  // 처음 열 때 본문에 초점을 둔다. 줄을 가리키면(target) 그 줄을 고른다 (focus가 고른 곳이 보이게 스크롤한다)
  const place = useCallback(() => {
    const el = box.current;
    if (!el) return;
    const r = target?.segId ? citedRange(textRef.current, savedBody, segments, target.segId) : null;
    if (r) el.setSelectionRange(r.start, r.end);
    else el.setSelectionRange(textRef.current.length, textRef.current.length);
    el.focus();
  }, [target, savedBody, segments]);
  const placed = useRef<number | null>(null);
  useEffect(() => {
    const key = target?.nonce ?? 0;
    if (placed.current === key) return;
    placed.current = key;
    if (variant === "rail" && !target) return; // 탭 키보드(←→)로 지나가는 중이면 초점을 빼앗지 않는다
    place();
  }, [target, place, variant]);

  const flushSoon = () => void a.flush();
  // 편집 도움(memoEdit.ts)의 결과를 넣는다: 바뀐 부분만 insertText로 넣어 ⌘Z가 그대로 되게 한다 (못 하면 값을 바로 바꾼다)
  const apply = (el: HTMLTextAreaElement, e: Edit) => {
    const old = el.value;
    let p = 0;
    while (p < old.length && p < e.text.length && old[p] === e.text[p]) p++;
    let s = 0;
    while (s < old.length - p && s < e.text.length - p && old[old.length - 1 - s] === e.text[e.text.length - 1 - s]) s++;
    el.setSelectionRange(p, old.length - s);
    const inserted = e.text.slice(p, e.text.length - s);
    const ok = inserted ? document.execCommand("insertText", false, inserted) : document.execCommand("delete");
    if (ok && el.value === e.text) {
      el.setSelectionRange(e.start, e.end); // 값이 이미 바뀌었다: 바로 고른다 (다음 화면까지 기다리면 그사이 친 글자 뒤로 캐럿이 돌아간다)
      return;
    }
    setText(e.text);
    a.change(e.text);
    requestAnimationFrame(() => el.setSelectionRange(e.start, e.end)); // 값을 React가 다시 그린 뒤에
  };
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", variant === "rail" ? "pb-2" : "max-w-[46rem] pb-7")}>
      <textarea
        ref={box}
        // 종이 위에 바로 쓰는 글상자: 테두리·초점 상자 없이 캐럿이 초점을 보인다
        className={cn(
          "w-full flex-1 resize-none border-0 bg-transparent p-0 text-foreground outline-none placeholder:text-subtle-foreground read-only:text-muted-foreground",
          variant === "rail" ? "min-h-[50vh] text-[14px] leading-6" : "min-h-[55vh] text-[15px] leading-7",
        )}
        value={text}
        placeholder={t("여기에 메모를 쓰세요. 쓰는 대로 자동으로 저장됩니다")}
        aria-label={t("메모 내용")}
        aria-keyshortcuts="Meta+S Meta+Enter Meta+B Meta+I"
        readOnly={!!locked}
        onChange={(e) => {
          setText(e.target.value);
          a.change(e.target.value);
        }}
        onBlur={flushSoon}
        onClick={(e) => {
          const el = e.currentTarget;
          if (locked || el.selectionStart !== el.selectionEnd) return;
          const r = checkAtClick(el.value, el.selectionStart); // [ ] 안을 누르면 체크
          if (r) apply(el, r);
        }}
        onKeyDown={(e) => {
          // 한글 조합 중에는 아무것도 하지 않는다 (lib.isImeKey)
          if (isImeKey(e.nativeEvent) || locked) return;
          const el = e.currentTarget;
          const { selectionStart: s, selectionEnd: end, value } = el;
          if (e.metaKey && e.code === "KeyS") {
            e.preventDefault();
            flushSoon();
            return;
          }
          let r: Edit | null = null;
          if (e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey) r = e.metaKey ? toggleCheck(value, s, end) : continueList(value, s, end);
          else if (e.metaKey && !e.shiftKey && !e.altKey && (e.code === "KeyB" || e.code === "KeyI")) r = wrapSelection(value, s, end, e.code === "KeyB" ? "**" : "*");
          if (!r) return; // ⌘B에 고른 글이 없으면 노트 목록 접기로 간다
          e.preventDefault();
          e.stopPropagation();
          apply(el, r);
        }}
      />
      <p className={cn("sticky bottom-0 m-0 bg-background pt-2 text-xs", state.status === "failed" ? "text-destructive" : "text-subtle-foreground")} role="status">
        {locked ?? SAVE_STATUS[state.status]}
      </p>
    </div>
  );
}

/**
 * 노트 제목. 제목이나 `제목 수정` 단추를 누르면 입력창이 된다. Enter 저장, Esc 취소, 입력창을 벗어나면 저장.
 * 한글 조합 중 Enter·Esc는 조합만 끝낸다 (lib.isImeKey). 빈 제목·너무 긴 제목은 저장하지 않고 이유를 보인다.
 */
export function TitleEditor({ title, onSave, onReject }: { title: string; onSave: (title: string) => void; onReject: (error: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false); // Esc·Enter 뒤에 따라오는 blur가 다시 저장하지 않게

  const start = () => {
    done.current = false;
    setError(null);
    setDraft(title);
  };
  useEffect(() => {
    if (draft !== null && !done.current) input.current?.select();
  }, [draft === null]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 저장을 시도한다. 고칠 수 있는 오류면 입력창에 남고(Enter), 벗어나는 중(blur)이면 원래 제목으로 돌아가며 알린다 */
  const commit = (leaving: boolean) => {
    if (draft === null || done.current) return;
    const c = checkTitle(draft);
    if (!c.ok) {
      if (!leaving) return setError(c.error);
      done.current = true;
      setDraft(null);
      return onReject(c.error);
    }
    done.current = true;
    setDraft(null);
    if (c.title !== title) onSave(c.title);
  };

  if (draft === null)
    return (
      <h1 className={TITLE}>
        <button className="group inline-flex max-w-full cursor-text items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40" onClick={start} title={t("제목 수정")} aria-label={t("제목 수정: {title}", { title: title || t("제목 없음") })}>
          <span className="[overflow-wrap:anywhere]">{title || t("제목 없음")}</span>
          <span className="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:bg-accent group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden>
            <Pencil className="size-3.5" />
          </span>
        </button>
      </h1>
    );
  return (
    <div>
      <h1 className={TITLE}>
        <input
          ref={input}
          className="-mx-1.5 -my-0.5 w-[calc(100%+0.75rem)] rounded-md border-0 bg-foreground/[0.05] px-1.5 py-0.5 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 aria-invalid:ring-[3px] aria-invalid:ring-destructive/30"
          value={draft}
          maxLength={TITLE_MAX + 40} // 붙여 넣은 긴 글을 잘라 버리지 않고 문장으로 알린다
          autoFocus
          aria-label={t("노트 제목 (Enter 저장, Esc 취소)")}
          aria-invalid={!!error}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          onKeyDown={(e) => {
            if (isImeKey(e.nativeEvent, composing.current)) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commit(false);
            } else if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              done.current = true;
              setDraft(null);
            }
          }}
          onBlur={() => commit(true)}
        />
      </h1>
      {error && (
        <p className="m-0 mt-2 text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
