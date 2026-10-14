// 사이드바의 노트 목록 전체 (docs/desktop.md §2.12): 제목 거르기·순서 → 즐겨찾기 → 폴더 → 태그 → 전체 노트.
// 폴더·태그를 고르면 `전체 노트`가 그 노트만 보인다 (태그를 여럿 고르면 모두 붙은 노트). 즐겨찾기·폴더·태그 구역은 접을 수 있고 접은 상태는 이 Mac의 브라우저 저장소에 둔다.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { MeetingInfo } from "./api";
import { FolderTree } from "./FolderTree";
import { dayParts } from "./lib";
import { NoteRow } from "./NoteRow";
import { DEFAULT_FOLD, filterNotes, folderPath, groupForList, isFiltered, parseFold, SORTS, sortNotes, type ListGroup, type SidebarFold, type SortKey } from "./organize";
import { useOrganize } from "./useOrganize";

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
    <h2 className="side-head">
      <button type="button" className="side-head-toggle" aria-expanded={open} aria-controls={id} onClick={onToggle}>
        <span className="side-chevron" aria-hidden>
          {open ? "▾" : "▸"}
        </span>
        <span>{title}</span>
        {count !== undefined && <span className="count tnum">{count}</span>}
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
  const folderLabel = org.filter.folder === "none" ? "폴더 없음" : org.filter.folder ? folderPath(org.folders, org.filter.folder) : "";

  const rows = (items: readonly MeetingInfo[]) => items.map((m) => <NoteRow key={m.id} m={m} active={m.id === activeId} onOpen={onOpen} slot={convertSlots?.get(m.id) ?? null} onConvert={onConvert} />);
  const renderGroup = (g: ListGroup<MeetingInfo>, i: number, all: ListGroup<MeetingInfo>[]) => {
    if (g.day === null)
      return (
        <ul key="flat" className="flat-list">
          {rows(g.items)}
        </ul>
      );
    const p = dayParts(g.day);
    const newMonth = i === 0 || dayParts(all[i - 1].day ?? "").month !== p.month;
    return (
      <section key={g.day} className="day-group">
        {newMonth && <h3 className="month-label">{p.month}</h3>}
        <div className="day-row">
          <div className="day-num" aria-label={`${p.day}일 ${p.weekday}요일`}>
            <span className="tnum">{p.day}</span>
            <small>{p.weekday}</small>
          </div>
          <ul>{rows(g.items)}</ul>
        </div>
      </section>
    );
  };

  if (notes.length === 0 && org.folders.length === 0) return null; // 아무것도 없을 때는 도구도 보이지 않는다 (App의 빈 상태 안내만)
  return (
    <>
      <div className="list-tools">
        <input
          type="search"
          className="list-filter"
          placeholder="목록에서 제목 찾기"
          aria-label="목록에서 제목으로 거르기"
          value={org.filter.query}
          onChange={(e) => org.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && org.filter.query && !e.nativeEvent.isComposing) {
              e.preventDefault();
              org.setQuery("");
            }
          }}
        />
        <div className="sort-control">
          <select aria-label="노트 순서" value={org.sort} onChange={(e) => org.setSort(e.target.value as SortKey)}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="sort-order"
            aria-label={org.order === "asc" ? "오름차순 (누르면 내림차순)" : "내림차순 (누르면 오름차순)"}
            title={org.order === "asc" ? "오름차순 — 누르면 내림차순" : "내림차순 — 누르면 오름차순"}
            onClick={org.toggleOrder}
          >
            <span aria-hidden>{org.order === "asc" ? "↑" : "↓"}</span>
          </button>
        </div>
      </div>

      {favorites.length > 0 && (
        <section className="side-section">
          <SectionHead id="side-favorites" title="즐겨찾기" count={favorites.length} open={fold.favorites} onToggle={() => toggle("favorites")} />
          {fold.favorites && (
            <ul id="side-favorites" className="flat-list" aria-label="즐겨찾기 노트">
              {rows(favorites)}
            </ul>
          )}
        </section>
      )}

      <section className="side-section">
        <SectionHead id="side-folders" title="폴더" count={org.folders.length || undefined} open={fold.folders} onToggle={() => toggle("folders")} />
        {fold.folders && (
          <div id="side-folders">
            <FolderTree expanded={expanded} onToggle={toggleFolder} onExpand={expandFolder} notes={notes} />
          </div>
        )}
      </section>

      {org.tags.length > 0 && (
        <section className="side-section">
          <SectionHead id="side-tags" title="태그" count={org.tags.length} open={fold.tags} onToggle={() => toggle("tags")} />
          {fold.tags && (
            <ul id="side-tags" className="tag-cloud" aria-label="태그 (여럿을 고르면 모두 붙은 노트)">
              {org.tags.map((t) => {
                const on = org.filter.tags.some((x) => x.toLowerCase() === t.tag.toLowerCase());
                return (
                  <li key={t.tag}>
                    <button type="button" className={`tag-chip is-filter ${on ? "is-on" : ""}`} aria-pressed={on} aria-label={`태그 ${t.tag}, 노트 ${t.count}개`} onClick={() => org.toggleTag(t.tag)}>
                      <span>{t.tag}</span>
                      <span className="count tnum">{t.count}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="side-section">
        <h2 className="side-head is-static">
          <span>전체 노트</span>
          <span className="count tnum">{filtered ? `${shown.length} / ${notes.length}` : notes.length}</span>
        </h2>
        {filtered && (
          <div className="filter-summary">
            {org.filter.folder && (
              <button type="button" className="filter-chip" aria-label={`폴더 걸러내기 해제: ${folderLabel}`} onClick={() => org.selectFolder(null)}>
                폴더: {folderLabel} <span aria-hidden>×</span>
              </button>
            )}
            {org.filter.tags.map((t) => (
              <button key={t} type="button" className="filter-chip" aria-label={`태그 걸러내기 해제: ${t}`} onClick={() => org.toggleTag(t)}>
                태그: {t} <span aria-hidden>×</span>
              </button>
            ))}
            <button type="button" className="text-button" onClick={org.clearFilters}>
              모두 해제
            </button>
          </div>
        )}
        {filtered && shown.length === 0 && <p className="nav-note">조건에 맞는 노트가 없습니다.</p>}
        {groups.map(renderGroup)}
      </section>
    </>
  );
}
