// 노트 머리 막대 (MeetingView에서 옮김, 동작 그대로): 날짜·시각, 단어 싱크 맞추기, 파일로 추가(메모 노트), 내보내기, 더 보기(삭제).
import { useState } from "react";
import { AudioLines, MoreHorizontal, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import type { useAlign } from "../../alignJobs";
import { OK, type Decision } from "../../caps";
import { ExportDialog } from "../../ExportDialog";
import { GatedButton } from "../../GatedButton";
import { clock, getLang, locale, t } from "../../i18n";
import { STAGE_LABEL } from "../../lib";
import { flushMemos, exportFormatsFor } from "../../memo";
import type { useNoteExport } from "../../note/useNoteExport";
import { ItemMenu, Popover } from "../../Popover";
import { ADD_FILE, ADD_FILE_TITLE, type AttachControls } from "../../attach";
import { RECORDED_BADGE } from "../../recorded";
import { ExportMenu } from "../../TranscriptTools";

export function NoteHeader({
  id,
  created,
  title,
  memoNote,
  recorded,
  hasSegments,
  hasWords,
  hasAudio,
  align,
  alignGate,
  attach,
  exp,
  deleteWhy,
  onDelete,
}: {
  id: string;
  created: Date | null;
  title: string;
  memoNote: boolean;
  recorded: boolean;
  hasSegments: boolean;
  hasWords: boolean;
  hasAudio: boolean;
  align: ReturnType<typeof useAlign>;
  alignGate: Decision;
  /** 글만 있는 노트에 녹음 추가 (attach.ts). 없으면 단추가 없다 */
  attach?: AttachControls;
  exp: ReturnType<typeof useNoteExport>;
  /** 노트를 지울 수 없는 이유 (없으면 지울 수 있다) */
  deleteWhy: string | null;
  onDelete: () => void;
}) {
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const ep = exp.exportPick;
  return (
    <div data-tauri-drag-region className="sticky top-0 z-20 flex h-[52px] shrink-0 items-center gap-2 bg-background/90 pr-3 pl-6 backdrop-blur-md">
      <p className="m-0 flex min-w-0 items-center gap-2 truncate text-xs text-muted-foreground tabular-nums" data-tauri-drag-region>
        {created?.toLocaleDateString(locale(), { year: "numeric", month: "long", day: "numeric", weekday: "short" })}
        {created && " · "}
        {created && (getLang() === "en" ? clock(created.getHours(), created.getMinutes()) : created.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }))}
        {recorded && <Badge variant="memo">{RECORDED_BADGE}</Badge>}
      </p>
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {!memoNote && hasSegments && !hasWords && hasAudio && (
          <GatedButton
            gate={alignGate}
            className={buttonVariants({ variant: "ghost", size: "sm" })}
            disabled={align.job.running}
            onClick={align.startAlign}
            title={t("음성과 대화 내용을 단어 단위로 맞춥니다. 재생 중인 단어가 강조되고, 단어를 누르면 그 단어부터 재생합니다")}
          >
            <AudioLines aria-hidden />
            {align.job.running
              ? (STAGE_LABEL[align.job.stage ?? ""] ?? t("시작하는 중…")) + (align.job.total ? ` ${Math.round((align.job.done / align.job.total) * 100)}%` : "")
              : t("단어 싱크 맞추기")}
          </GatedButton>
        )}
        {memoNote && attach && (
          <GatedButton gate={attach.convert ?? OK} className={buttonVariants({ variant: "ghost", size: "sm" })} disabled={!!attach.blocked} title={attach.blocked ?? ADD_FILE_TITLE} onClick={() => attach.onFile({ id, title })}>
            <Upload aria-hidden />
            {ADD_FILE}
          </GatedButton>
        )}
        <ExportMenu
          formats={exportFormatsFor(memoNote, recorded)}
          onPick={(f) => void exp.exportAs(f)}
          onObsidian={() => void exp.toObsidian()}
          onPrint={() => {
            // 메모는 쓰던 글까지 인쇄한다
            void flushMemos().then((ok) => ok && exp.setPrintNonce((n) => n + 1));
          }}
        />
        {ep && (
          <ExportDialog
            label={ep.f.label}
            items={ep.items}
            onDone={(pick) => {
              exp.setExportPick(null);
              if (pick) void exp.saveExport(ep.f, pick);
            }}
          />
        )}
        <Button variant="ghost" size="icon-sm" aria-label={t("더 보기")} title={t("더 보기")} aria-haspopup="menu" aria-expanded={!!moreAnchor} onClick={(e) => setMoreAnchor((a) => (a ? null : e.currentTarget))}>
          <MoreHorizontal aria-hidden />
        </Button>
        {moreAnchor && (
          <Popover anchor={moreAnchor} label={t("더 보기")} align="end" onClose={() => setMoreAnchor(null)}>
            {(close) => (
              <ItemMenu
                close={close}
                entries={[
                  {
                    id: "delete",
                    label: t("삭제…"),
                    danger: true,
                    disabled: deleteWhy ?? undefined,
                    onSelect: onDelete,
                  },
                ]}
              />
            )}
          </Popover>
        )}
      </div>
    </div>
  );
}
