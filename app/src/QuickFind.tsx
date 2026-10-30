// 사이드바 맨 위 검색창 (⌘K): 입력하면 제목이 맞는 노트가 바로 아래에 뜨고(↑↓·Enter로 열기), 목록에서 고르지 않고 Enter를 누르면 내용 검색(스마트 검색)으로 간다.
import { useId, useMemo, useState, type RefObject } from "react";
import type { MeetingInfo } from "./api";
import { t } from "./i18n";
import { quickMatches } from "./quickMatch";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/components/ui/utils";

export function QuickFind({ notes, inputRef, onOpen, onSearch }: { notes: readonly MeetingInfo[]; inputRef: RefObject<HTMLInputElement | null>; onOpen: (id: string) => void; onSearch: (q: string) => void }) {
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [pick, setPick] = useState(-1); // -1: 고른 노트 없음(Enter = 내용 검색)
  const id = useId();
  const query = q.trim();
  const hits = useMemo(() => quickMatches(notes, query), [notes, query]);
  const show = focused && query !== "";
  const finish = () => {
    setQ("");
    setPick(-1);
    inputRef.current?.blur();
  };
  const optionId = (i: number) => `${id}-opt-${i}`;

  return (
    <form
      className="relative mb-1 px-1"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        if (!query) return;
        if (pick >= 0 && hits[pick]) onOpen(hits[pick].id);
        else onSearch(query);
        finish();
      }}
    >
      <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-subtle-foreground" aria-hidden />
      <Input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={show}
        aria-controls={`${id}-list`}
        aria-activedescendant={show && pick >= 0 ? optionId(pick) : undefined}
        aria-autocomplete="list"
        placeholder={t("노트 검색")}
        aria-label={t("노트 검색")}
        className="h-7 bg-background/70 pr-10 pl-7"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setPick(-1);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // 글자 조합 중에는 키를 가로채지 않는다
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (!show || !hits.length) return;
            e.preventDefault();
            const last = hits.length - 1;
            setPick((p) => (e.key === "ArrowDown" ? (p >= last ? -1 : p + 1) : p <= -1 ? last : p - 1));
          } else if (e.key === "Escape" && q) {
            e.preventDefault();
            finish();
          }
        }}
      />
      <Kbd className="absolute top-1/2 right-2.5 -translate-y-1/2">⌘K</Kbd>
      {show && (
        <ul id={`${id}-list`} role="listbox" aria-label={t("노트 바로 열기")} className="absolute inset-x-1 top-full z-30 mt-1 overflow-hidden rounded-lg border border-border bg-background p-1 shadow-md">
          {hits.map((m, i) => (
            <li key={m.id} id={optionId(i)} role="option" aria-selected={i === pick} className={cn("cursor-default truncate rounded-md px-2 py-1.5 text-[13px]", i === pick ? "bg-accent" : "hover:bg-accent")} onMouseDown={(e) => e.preventDefault()} onClick={() => { onOpen(m.id); finish(); }}>
              {m.title || t("제목 없음")}
            </li>
          ))}
          <li role="presentation" className="truncate px-2 py-1.5 text-xs text-muted-foreground">
            {t("Enter: ‘{q}’ 내용으로 검색", { q: query })}
          </li>
        </ul>
      )}
    </form>
  );
}
