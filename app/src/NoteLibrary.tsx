// 사이드바의 노트 목록 전체 (docs/desktop.md §2.12): 제목 거르기·순서 → 즐겨찾기 → 폴더 → 태그 → 전체 노트.
// 폴더·태그를 고르면 `전체 노트`가 그 노트만 보인다 (태그를 여럿 고르면 모두 붙은 노트). 즐겨찾기·폴더·태그 구역은 접을 수 있고 접은 상태는 이 Mac의 브라우저 저장소에 둔다.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MeetingInfo } from "./api";
import { FolderTree } from "./FolderTree";
import { t } from "./i18n";
import { dayParts } from "./lib";
import { NoteRow } from "./NoteRow";
import { DEFAULT_FOLD, filterNotes, folderPath, groupForList, isFiltered, parseFold, SORTS, sortNotes, type ListGroup, type SidebarFold, type SortKey } from "./organize";
import { useOrganize } from "./useOrganize";
import { ArrowDown, ArrowUp, ChevronRight, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/components/ui/utils";
import { SIDE_HEAD } from "@/components/sidebar";

const COUNT = "ml-auto font-normal text-subtle-foreground tabular-nums";
const CHIP = "inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-xs hover:bg-accent [&_svg]:size-3";

const FOLD_KEY = "tractus.sidebar.fold";

function readFold(): SidebarFold {
  try {
    return parseFold(localStorage.getItem(FOLD_KEY));
  } catch {
    return DEFAULT_FOLD; // 저장소를 못 쓰면(비공개 창 등) 기본값
  }
}

function SectionHead({ id, title, count, open, onToggle, children }: { id: string; title: string; count?: number; open: boolean; onToggle: () => void; children?: ReactNode }) {
  return (
    <h2 className={cn(SIDE_HEAD, "group/head m-0")}>
      <button type="button" className="flex h-full flex-1 items-center gap-1 rounded-md outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span>{title}</span>
        <ChevronRight className={cn("size-3 opacity-0 transition group-hover/head:opacity-100", open && "rotate-90")} aria-hidden />
        {count !== undefined && <span className={COUNT}>{count}</span>}
      </button>
      {children}
    </h2>
  );
}

export function NoteLibrary({
  notes,
  activeId,
  onOpen,
  convertSlots,
  onConvert,
}: {
  notes: MeetingInfo[];
  activeId: string | null;
  onOpen: (id: string) => void;
  /** 변환 줄에 있는 노트의 차례 (변환 전 노트의 줄 배지). 없으면 아무 노트도 변환 중이 아니다 */
  convertSlots?: ReadonlyMap<string, "running" | "queued">;
  /** 변환 전 노트의 `텍스트로 변환` */
  onConvert?: (id: string) => void;
}) {
  const org = useOrganize();
  const [fold, setFold] = useState(readFold);
  useEffect(() => {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify(fold));
    } catch {
      /* 저장하지 못해도 이번 화면에서는 그대로 쓴다 */
    }
  }, [fold]);
  const toggle = (k: "favorites" | "folders" | "tags") => setFold((f) => ({ ...f, [k]: !f[k] }));
  const expanded = useMemo(() => new Set(fold.open), [fold.open]);
  const toggleFolder = (id: string) => setFold((f) => ({ ...f, open: f.open.includes(id) ? f.open.filter((x) => x !== id) : [...f.open, id] }));
  const expandFolder = (id: string) => setFold((f) => (f.open.includes(id) ? f : { ...f, open: [...f.open, id] }));

  const sorted = useMemo(() => sortNotes(notes, org.sort, org.order), [notes, org.sort, org.order]);
  const favorites = useMemo(() => sorted.filter((m) => m.favorite), [sorted]);
  const shown = useMemo(() => filterNotes(sorted, org.filter, org.folders), [sorted, org.filter, org.folders]);
  const groups = useMemo(() => groupForList(shown, org.sort), [shown, org.sort]);
  const filtered = isFiltered(org.filter);
  const folderLabel = org.filter.folder === "none" ? t("폴더 없음") : org.filter.folder ? folderPath(org.folders, org.filter.folder) : "";

  const rows = (items: readonly MeetingInfo[]) => items.map((m) => <NoteRow key={m.id} m={m} active={m.id === activeId} onOpen={onOpen} slot={convertSlots?.get(m.id) ?? null} onConvert={onConvert} />);
  const renderGroup = (g: ListGroup<MeetingInfo>, i: number, all: ListGroup<MeetingInfo>[]) => {
    if (g.day === null)
      return (
        <ul key="flat">
          {rows(g.items)}
        </ul>
      );
    const p = dayParts(g.day);
    const newMonth = i === 0 || dayParts(all[i - 1].day ?? "").month !== p.month;
    return (
      <section key={g.day}>
        {newMonth && <h3 className={cn(SIDE_HEAD, "m-0 mt-2")}>{p.month}</h3>}
        <div className="grid grid-cols-[30px_minmax(0,1fr)]">
          <div className="flex flex-col items-center pt-2 leading-none" aria-label={t("{day}일 {weekday}요일", { day: p.day, weekday: p.weekday })}>
            <span className="text-[13px] font-semibold tabular-nums">{p.day}</span>
            <small className="mt-1 text-[10px] text-subtle-foreground">{p.weekday}</small>
          </div>
          <ul>{rows(g.items)}</ul>
        </div>
      </section>
    );
  };

  if (notes.length === 0 && org.folders.length === 0) return null; // 아무것도 없을 때는 도구도 보이지 않는다 (App의 빈 상태 안내만)
  return (
    <>
      <div className="px-1 pb-1">
        <Input
          type="search"
          className="h-7 bg-background/70 text-xs"
          placeholder={t("목록에서 제목 찾기")}
          aria-label={t("목록에서 제목으로 거르기")}
          value={org.filter.query}
          onChange={(e) => org.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && org.filter.query && !e.nativeEvent.isComposing) {
              e.preventDefault();
              org.setQuery("");
            }
          }}
        />
      </div>

      {favorites.length > 0 && (
        <section className="mt-2">
          <SectionHead id="side-favorites" title={t("즐겨찾기")} count={favorites.length} open={fold.favorites} onToggle={() => toggle("favorites")} />
          {fold.favorites && (
            <ul id="side-favorites" aria-label={t("즐겨찾기 노트")}>
              {rows(favorites)}
            </ul>
          )}
        </section>
      )}

      <section className="mt-2">
        <SectionHead id="side-folders" title={t("폴더")} count={org.folders.length || undefined} open={fold.folders} onToggle={() => toggle("folders")} />
        {fold.folders && (
          <div id="side-folders">
            <FolderTree expanded={expanded} onToggle={toggleFolder} onExpand={expandFolder} notes={notes} />
          </div>
        )}
      </section>

      {org.tags.length > 0 && (
        <section className="mt-2">
          <SectionHead id="side-tags" title={t("태그")} count={org.tags.length} open={fold.tags} onToggle={() => toggle("tags")} />
          {fold.tags && (
            <ul id="side-tags" className="flex flex-wrap gap-1 px-2 py-1" aria-label={t("태그 (여럿을 고르면 모두 붙은 노트)")}>
              {org.tags.map((tc) => {
                const on = org.filter.tags.some((x) => x.toLowerCase() === tc.tag.toLowerCase());
                return (
                  <li key={tc.tag}>
                    <button type="button" className={cn(CHIP, "aria-pressed:border-foreground aria-pressed:bg-foreground aria-pressed:text-background")} aria-pressed={on} aria-label={t("태그 {tag}, 노트 {n}개", { tag: tc.tag, n: tc.count })} onClick={() => org.toggleTag(tc.tag)}>
                      <span>{tc.tag}</span>
                      <span className="opacity-60 tabular-nums">{tc.count}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="mt-2">
        <div className={cn(SIDE_HEAD, "pr-0")}>
          <h2 className="m-0 flex items-center gap-1.5 text-[11px] font-semibold">
            <span>{t("전체 노트")}</span>
            <span className="font-normal tabular-nums">{filtered ? `${shown.length} / ${notes.length}` : notes.length}</span>
          </h2>
          <div className="ml-auto flex items-center">
            <select className="h-6 max-w-[7.5rem] appearance-none rounded-md bg-transparent px-1.5 text-right text-[11px] font-medium text-subtle-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40" aria-label={t("노트 순서")} value={org.sort} onChange={(e) => org.setSort(e.target.value as SortKey)}>
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="grid size-6 place-items-center rounded-md text-subtle-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 [&_svg]:size-3"
              aria-label={org.order === "asc" ? t("오름차순 (누르면 내림차순)") : t("내림차순 (누르면 오름차순)")}
              title={org.order === "asc" ? t("오름차순 — 누르면 내림차순") : t("내림차순 — 누르면 오름차순")}
              onClick={org.toggleOrder}
            >
              {org.order === "asc" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
            </button>
          </div>
        </div>
        {filtered && (
          <div className="flex flex-wrap items-center gap-1 px-2 pb-1">
            {org.filter.folder && (
              <button type="button" className={CHIP} aria-label={t("폴더 걸러내기 해제: {folder}", { folder: folderLabel })} onClick={() => org.selectFolder(null)}>
                {t("폴더: {folder}", { folder: folderLabel })} <X aria-hidden />
              </button>
            )}
            {org.filter.tags.map((tag) => (
              <button key={tag} type="button" className={CHIP} aria-label={t("태그 걸러내기 해제: {tag}", { tag })} onClick={() => org.toggleTag(tag)}>
                {t("태그: {tag}", { tag })} <X aria-hidden />
              </button>
            ))}
            <button type="button" className="px-1 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={org.clearFilters}>
              {t("모두 해제")}
            </button>
          </div>
        )}
        {filtered && shown.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">{t("조건에 맞는 노트가 없습니다.")}</p>}
        {groups.map(renderGroup)}
      </section>
    </>
  );
}
