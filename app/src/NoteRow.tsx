// 사이드바의 노트 한 줄. 눌러서 열고, 끌어서 폴더에 놓고, `…` 메뉴(가리키거나 초점이 갈 때 보인다)로 즐겨찾기·폴더·태그를 바꾼다.
// 줄 자체는 컨텍스트를 읽지 않는다: 2,000개 줄이 상태가 바뀔 때마다 다시 그려지지 않게 memo로 막고(props가 같으면 건너뜀), 메뉴는 열릴 때만 올린다.
import { memo, useState } from "react";
import type { MeetingInfo } from "./api";
import { FolderPicker } from "./FolderPicker";
import { isMemo, noteTime } from "./memo";
import { CONVERT_ROW, isRecorded, RECORDED_BADGE, ROW_QUEUED, ROW_RUNNING } from "./recorded";
import { startNoteDrag } from "./noteDrag";
import { ItemMenu, Popover } from "./Popover";
import { useOrganize } from "./useOrganize";

const TAGS_SHOWN = 2;

export const NoteRow = memo(function NoteRow({
  m,
  active,
  onOpen,
  slot = null,
  onConvert,
}: {
  m: MeetingInfo;
  active: boolean;
  onOpen: (id: string) => void;
  /** 변환 전 노트의 변환 차례 (변환 줄): 변환 중 | 기다리는 중 | 없음 */
  slot?: "running" | "queued" | null;
  /** 변환 전 노트를 변환 줄에 올린다 (`텍스트로 변환`) */
  onConvert?: (id: string) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const title = m.title || "제목 없음";
  const tags = m.tags ?? [];
  return (
    <li
      className="note-row"
      onPointerDown={(e) => startNoteDrag(e, m.id, title)}
    >
      <button className="meeting-link" aria-current={active} onClick={() => onOpen(m.id)}>
        <span className="meeting-link-title">
          {m.favorite && (
            <>
              <span className="row-star" aria-hidden>
                ★
              </span>
              <span className="sr-only">즐겨찾기 </span>
            </>
          )}
          {title}
        </span>
        <span className="meeting-link-meta tnum">
          {noteTime(m)}
          {isMemo(m) ? <span className="badge">메모</span> : isRecorded(m) ? <span className="badge is-pending">{slot === "running" ? ROW_RUNNING : slot === "queued" ? ROW_QUEUED : RECORDED_BADGE}</span> : !m.has_summary && <span className="badge">요약 없음</span>}
          {tags.slice(0, TAGS_SHOWN).map((t) => (
            <span key={t} className="row-tag">
              {t}
            </span>
          ))}
          {tags.length > TAGS_SHOWN && <span className="row-tag">+{tags.length - TAGS_SHOWN}</span>}
        </span>
      </button>
      <button
        type="button"
        className="row-more"
        aria-label={`${title} 노트 메뉴`}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        title="즐겨찾기·폴더·태그"
        onClick={(e) => setAnchor((a) => (a ? null : e.currentTarget))}
      >
        …
      </button>
      {anchor && <RowMenu anchor={anchor} m={m} onClose={() => setAnchor(null)} onOpen={onOpen} convert={isRecorded(m) && !slot ? onConvert : undefined} />}
    </li>
  );
});

function RowMenu({ anchor, m, onClose, onOpen, convert }: { anchor: HTMLElement; m: MeetingInfo; onClose: () => void; onOpen: (id: string) => void; convert?: (id: string) => void }) {
  const org = useOrganize();
  const [picking, setPicking] = useState(false);
  if (picking) return <FolderPicker anchor={anchor} current={m.folder ?? null} onClose={onClose} onPick={(f) => void org.moveNote(m.id, f)} />;
  const fav = m.favorite === true;
  return (
    <Popover anchor={anchor} label="노트 메뉴" onClose={onClose}>
      {(close) => (
        <ItemMenu
          close={close}
          entries={[
            ...(convert ? [{ id: "convert", label: CONVERT_ROW, onSelect: () => convert(m.id) }] : []),
            { id: "favorite", label: fav ? "즐겨찾기에서 빼기" : "즐겨찾기에 추가", onSelect: () => void org.setFavorite(m.id, !fav) },
            { id: "folder", label: "폴더로 이동…", stay: true, onSelect: () => setPicking(true) },
            {
              id: "tags",
              label: "태그 편집…",
              onSelect: () => {
                onOpen(m.id); // 노트를 열고 태그 입력창에 초점을 둔다
                org.requestTagFocus(m.id);
              },
            },
          ]}
        />
      )}
    </Popover>
  );
}
