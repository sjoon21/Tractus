// 사이드바의 노트 한 줄. 눌러서 열고, 끌어서 폴더에 놓고, `…` 메뉴(가리키거나 초점이 갈 때 보인다)로 즐겨찾기·폴더·태그를 바꾼다.
// 줄 자체는 컨텍스트를 읽지 않는다: 2,000개 줄이 상태가 바뀔 때마다 다시 그려지지 않게 memo로 막고(props가 같으면 건너뜀), 메뉴는 열릴 때만 올린다.
import { memo, useState } from "react";
import type { MeetingInfo } from "./api";
import { FolderPicker } from "./FolderPicker";
import { t } from "./i18n";
import { isMemo, noteTime } from "./memo";
import { CONVERT_ROW, isRecorded, keptTitle, RECORDED_BADGE, ROW_QUEUED, ROW_RUNNING } from "./recorded";
import { startNoteDrag } from "./noteDrag";
import { ItemMenu, Popover } from "./Popover";
import { useOrganize } from "./useOrganize";
import { Ellipsis, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SAMPLE_BADGE } from "./onboarding";
import { NOTE_LINK, ROW_MORE } from "@/components/sidebar";

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
  const title = m.title || t("제목 없음");
  const tags = m.tags ?? [];
  return (
    <li
      className="note-row group relative pb-px [contain-intrinsic-size:auto_48px] [content-visibility:auto]"
      onPointerDown={(e) => startNoteDrag(e, m.id, title)}
    >
      <button className={NOTE_LINK} aria-current={active} onClick={() => onOpen(m.id)}>
        <span className="flex items-center gap-1 truncate text-[13px] font-medium leading-5">
          {m.favorite && (
            <>
              <Star className="size-3 shrink-0 fill-memo text-memo" aria-hidden />
              <span className="sr-only">{t("즐겨찾기")} </span>
            </>
          )}
          <span className="truncate">{title}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground tabular-nums">
          {noteTime(m)}
          {m.sample ? <Badge>{SAMPLE_BADGE}</Badge> : isMemo(m) ? <Badge>{t("메모")}</Badge> : isRecorded(m) ? <Badge variant="memo" title={keptTitle(m.tracks_bytes)}>{slot === "running" ? ROW_RUNNING : slot === "queued" ? ROW_QUEUED : RECORDED_BADGE}</Badge> : !m.has_summary && <Badge>{t("요약 없음")}</Badge>}
          {tags.slice(0, TAGS_SHOWN).map((tag) => (
            <span key={tag} className="max-w-[6.5em] truncate before:text-subtle-foreground before:content-['#']">
              {tag}
            </span>
          ))}
          {tags.length > TAGS_SHOWN && <span>+{tags.length - TAGS_SHOWN}</span>}
        </span>
      </button>
      <button
        type="button"
        className={ROW_MORE}
        aria-label={t("{title} 노트 메뉴", { title })}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        title={t("즐겨찾기·폴더·태그")}
        onClick={(e) => setAnchor((a) => (a ? null : e.currentTarget))}
      >
        <Ellipsis aria-hidden />
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
    <Popover anchor={anchor} label={t("노트 메뉴")} onClose={onClose}>
      {(close) => (
        <ItemMenu
          close={close}
          entries={[
            ...(convert ? [{ id: "convert", label: CONVERT_ROW, onSelect: () => convert(m.id) }] : []),
            { id: "favorite", label: fav ? t("즐겨찾기에서 빼기") : t("즐겨찾기에 추가"), onSelect: () => void org.setFavorite(m.id, !fav) },
            { id: "folder", label: t("폴더로 이동…"), stay: true, onSelect: () => setPicking(true) },
            {
              id: "tags",
              label: t("태그 편집…"),
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
