// 사이드바의 노트 한 줄. 눌러서 열고, 끌어서 폴더에 놓고, `…` 메뉴(가리키거나 초점이 갈 때 보인다)로 즐겨찾기·폴더·태그를 바꾸거나 삭제한다.
// 트랙패드로 왼쪽으로 밀면 줄 끝에 `삭제` 단추가 나온다(noteSwipe). 어느 길이든 확인 창을 거친다(onDelete = App.askDelete).
// 줄 자체는 컨텍스트를 읽지 않는다: 2,000개 줄이 상태가 바뀔 때마다 다시 그려지지 않게 memo로 막고(props가 같으면 건너뜀), 메뉴는 열릴 때만 올린다.
import { memo, useState } from "react";
import type { MeetingInfo } from "./api";
import { FolderPicker } from "./FolderPicker";
import { t } from "./i18n";
import { isMemo, noteTime } from "./memo";
import { CONVERT_ROW, deleteBlockedWhileConverting, isRecorded, keptTitle, RECORDED_BADGE, ROW_QUEUED, ROW_RUNNING } from "./recorded";
import { startNoteDrag } from "./noteDrag";
import { setSwiped, swipeWheel, useSwiped } from "./noteSwipe";
import type { DeleteTarget } from "./remove";
import { ItemMenu, Popover } from "./Popover";
import { useOrganize } from "./useOrganize";
import { Ellipsis, Star } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/components/ui/utils";
import { SAMPLE_BADGE } from "./onboarding";
import { NOTE_LINK, ROW_MORE } from "@/components/sidebar";

const TAGS_SHOWN = 2;

export const NoteRow = memo(function NoteRow({
  m,
  active,
  onOpen,
  slot = null,
  onConvert,
  onDelete,
}: {
  m: MeetingInfo;
  active: boolean;
  onOpen: (id: string) => void;
  /** 변환 전 노트의 변환 차례 (변환 줄): 변환 중 | 기다리는 중 | 없음 */
  slot?: "running" | "queued" | null;
  /** 변환 전 노트를 변환 줄에 올린다 (`텍스트로 변환`) */
  onConvert?: (id: string) => void;
  /** 삭제 확인 창을 띄운다. 없으면 삭제 길(메뉴 항목·밀기)이 없다 */
  onDelete?: (target: DeleteTarget) => void;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const swiped = useSwiped(m.id) && !!onDelete;
  const title = m.title || t("제목 없음");
  const tags = m.tags ?? [];
  // 노트 머리의 `삭제…`와 같은 조건 중 목록에서 알 수 있는 것(변환 줄). 다른 작업 중이면 Rust가 거절하고 실패 토스트가 뜬다
  const deleteWhy = deleteBlockedWhileConverting(slot);
  // 사이드바에서는 메모가 있는지 모른다: 메모 여부는 확인 창의 주의 문장이 늘 말한다 (withMemo 없음)
  const askDelete = onDelete && (() => onDelete({ kind: "note", id: m.id, title: m.title, dir: m.dir, memo: isMemo(m) }));
  return (
    <li
      className="note-row group relative pb-px [contain-intrinsic-size:auto_48px] [content-visibility:auto]"
      onPointerDown={(e) => startNoteDrag(e, m.id, title)}
      onWheel={onDelete ? (e) => swipeWheel(m.id, e.deltaX, e.deltaY) : undefined}
    >
      <button className={cn(NOTE_LINK, swiped && "pr-20")} aria-current={active} onClick={() => onOpen(m.id)}>
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
      {swiped && askDelete && (
        <Button
          variant="destructive"
          size="sm"
          data-swipe-delete=""
          className="absolute top-1/2 right-1 h-7 -translate-y-1/2 animate-in fade-in-0 slide-in-from-right-2 duration-150 motion-reduce:animate-none"
          aria-label={t("{title} 노트 삭제", { title })}
          aria-disabled={deleteWhy ? true : undefined}
          title={deleteWhy ?? t("삭제 (휴지통으로 이동)")}
          onClick={() => {
            if (deleteWhy) return;
            setSwiped(null);
            askDelete();
          }}
        >
          {t("삭제")}
        </Button>
      )}
      <button
        type="button"
        className={cn(ROW_MORE, swiped && "invisible")}
        aria-label={t("{title} 노트 메뉴", { title })}
        aria-haspopup="menu"
        aria-expanded={!!anchor}
        title={t("즐겨찾기·폴더·태그·삭제")}
        onClick={(e) => setAnchor((a) => (a ? null : e.currentTarget))}
      >
        <Ellipsis aria-hidden />
      </button>
      {anchor && <RowMenu anchor={anchor} m={m} onClose={() => setAnchor(null)} onOpen={onOpen} convert={isRecorded(m) && !slot ? onConvert : undefined} onDelete={askDelete} deleteWhy={deleteWhy} />}
    </li>
  );
});

function RowMenu({
  anchor,
  m,
  onClose,
  onOpen,
  convert,
  onDelete,
  deleteWhy,
}: {
  anchor: HTMLElement;
  m: MeetingInfo;
  onClose: () => void;
  onOpen: (id: string) => void;
  convert?: (id: string) => void;
  onDelete?: () => void;
  deleteWhy: string | null;
}) {
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
            ...(onDelete ? [{ id: "delete", label: t("삭제…"), danger: true, divider: true, disabled: deleteWhy ?? undefined, onSelect: onDelete }] : []),
          ]}
        />
      )}
    </Popover>
  );
}
