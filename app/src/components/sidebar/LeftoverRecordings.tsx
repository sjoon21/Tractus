import type { Decision } from "../../caps";
import type { View } from "../../App";
import { type MeetingInfo, type PendingRecording } from "../../api";
import { GatedButton } from "../../GatedButton";
import { ADD_BADGE, pendingTarget, PENDING_LABEL, type AttachTarget } from "../../attach";
import { t } from "../../i18n";
import { fmtTime } from "../../lib";
import { recordingLabel, type DeleteTarget } from "../../remove";
import { SAVE_NOTE, SAVE_NOTE_TITLE } from "../../recorded";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NOTE_LINK, SIDE_HEAD } from "@/components/sidebar";

// 사이드바의 `변환 대기 중인 녹음` 목록 (App에서 옮김, 동작 그대로).
export function LeftoverRecordings({
  leftover,
  meetings,
  convertGate,
  transcribing,
  recording,
  startTranscribe,
  saveLeftover,
  askDelete,
  go,
}: {
  leftover: PendingRecording[];
  meetings: MeetingInfo[];
  convertGate: Decision;
  transcribing: boolean;
  recording: boolean;
  startTranscribe: (dir: string, target?: AttachTarget | null) => void;
  saveLeftover: (dir: string) => void;
  askDelete: (target: DeleteTarget) => void;
  go: (v: View) => Promise<void>;
}) {
  return (
    <>
      {leftover.length > 0 && (
        <section className="mb-2">
          <h2 className={SIDE_HEAD}>{t("변환 대기 중인 녹음")}</h2>
          <ul>
            {leftover.map((p) => {
              // 글만 있는 노트에 추가하려던 녹음이면 그 노트(아직 글만 있을 때)에 이어서 추가한다. 노트가 없어졌으면 새 노트로 변환한다
              const into = pendingTarget(p, meetings);
              const label = into ? PENDING_LABEL(into.title) : recordingLabel(p.started_at);
              return (
              <li key={p.dir} className="group relative">
                <GatedButton
                  gate={convertGate}
                  className={NOTE_LINK}
                  disabled={transcribing}
                  onClick={() => {
                    startTranscribe(p.dir, into);
                    void go({ kind: "record" });
                  }}
                >
                  <span className="block truncate text-[13px] font-medium tabular-nums">{label}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                    {p.duration === null ? t("끊긴 녹음") : fmtTime(p.duration)}
                    <Badge variant="rec">{into ? ADD_BADGE : t("변환하기")}</Badge>
                  </span>
                </GatedButton>
                <span className="absolute top-1.5 right-1.5 flex gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  {!into && (
                    <Button variant="outline" size="sm" className="h-6 px-2" disabled={transcribing || recording} aria-label={`${label} ${SAVE_NOTE}`} title={SAVE_NOTE_TITLE} onClick={() => saveLeftover(p.dir)}>
                      {SAVE_NOTE}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 hover:border-destructive hover:text-destructive"
                    disabled={transcribing}
                    aria-label={t("{label} 삭제", { label })}
                    title={t("삭제 (휴지통으로 이동)")}
                    onClick={() => askDelete({ kind: "recording", dir: p.dir, startedAt: p.started_at })}
                  >
                    {t("삭제")}
                  </Button>
                </span>
              </li>
              );
            })}
          </ul>
        </section>
      )}
    </>
  );
}
