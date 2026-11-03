import type { JobState } from "../../lib";
import { t } from "../../i18n";
import { baseName, STAGE_FALLBACK, STAGE_LABEL, warningText } from "../../lib";
import { CONVERT_ALL_LINE, noteLabel } from "../../recorded";
import { Progress } from "@/components/ui/progress";
import { JOB_CARD } from "@/components/sidebar";

// 사이드바의 진행 카드 (App에서 옮김, 동작 그대로): 파일 가져오기 · 녹음 변환 · 변환 전 노트 변환 진행.
export function SidebarJobs({
  importJob,
  importing,
  importPct,
  queue,
  transcribeJob,
  waitList,
  waitReason,
  txPct,
  converting,
  convertRunning,
  convStage,
  convPct,
  convProgress,
  convTitle,
}: {
  importJob: JobState;
  /** 지금 가져오는 파일 경로 */
  importing: string | null;
  importPct: number | null;
  /** 가져오기 대기 줄 */
  queue: string[];
  transcribeJob: JobState;
  waitList: unknown[];
  waitReason: string;
  txPct: number | null;
  converting: boolean;
  convertRunning: boolean;
  convStage: string | null | undefined;
  convPct: number | null;
  convProgress: { n: number; total: number } | null;
  convTitle: string;
}) {
  return (
    <>
    {(importJob.running || queue.length > 0) && (
      <section className={JOB_CARD} aria-live="polite" aria-label={t("가져오기 진행")}>
        <p className="truncate font-medium text-foreground">{importing ? baseName(importing) : t("대기 중")}</p>
        <p className="flex justify-between gap-2 tabular-nums">
          <span>{STAGE_LABEL[importJob.stage ?? ""] ?? STAGE_FALLBACK}</span>
          <span>{[importPct !== null && `${Math.round(importPct * 100)}%`, queue.length > 0 && t("대기 {n}개", { n: queue.length })].filter(Boolean).join(" · ")}</span>
        </p>
        <Progress value={importPct} />
        {importJob.warnings
          .filter((w) => w.code !== "duplicate")
          .map((w) => (
            <p key={w.code} className="text-memo">
              {warningText(w)}
            </p>
          ))}
      </section>
    )}
    {(transcribeJob.running || waitList.length > 0) && (
      <section className={JOB_CARD} aria-live="polite" aria-label={t("녹음 변환 진행")}>
        <p className="truncate font-medium text-foreground">{t("녹음을 텍스트로 변환")}</p>
        <p className="flex justify-between gap-2 tabular-nums">
          <span>{transcribeJob.running ? (STAGE_LABEL[transcribeJob.stage ?? ""] ?? STAGE_FALLBACK) : waitReason}</span>
          <span>{[txPct !== null && `${Math.round(txPct * 100)}%`, waitList.length > 0 && transcribeJob.running && t("대기 {n}개", { n: waitList.length })].filter(Boolean).join(" · ")}</span>
        </p>
        <Progress value={txPct} />
      </section>
    )}
    {converting && (
      <section className={JOB_CARD} aria-live="polite" aria-label={t("변환 전 노트 변환 진행")}>
        <p className="truncate font-medium text-foreground">{convProgress ? CONVERT_ALL_LINE(convProgress.n, convProgress.total, convTitle) : noteLabel(convTitle)}</p>
        <p className="flex justify-between gap-2 tabular-nums">
          <span>{convertRunning ? (STAGE_LABEL[convStage ?? ""] ?? STAGE_FALLBACK) : waitReason}</span>
          <span>{convertRunning && convPct !== null ? `${Math.round(convPct * 100)}%` : ""}</span>
        </p>
        <Progress value={convertRunning ? convPct : null} />
      </section>
    )}
    </>
  );
}
