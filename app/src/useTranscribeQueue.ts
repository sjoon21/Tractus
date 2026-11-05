// 녹음 변환 줄: 녹음이 끝나면(또는 사이드바의 `변환 대기 중인 녹음`에서 다시 변환하면) 녹음 폴더를 줄에 세우고 하나씩 텍스트로 변환한다.
// 바로 시작하지 않는다: 앞선 변환·파일 가져오기·변환 전 노트의 변환이 끝난 뒤에 시작한다(변환 엔진이 한 번에 하나만 올라가게).
// 변환 중에도 녹음할 수 있으므로(recordBusy.ts) 변환이 도는 동안 다음 녹음이 끝나 줄에 설 수 있다.
// 이 훅은 줄의 상태와 동작만 맡는다. 언제 시작하는가는 useWorkScheduler가 정한다 (jobSchedule.ts)
import { useCallback, useEffect, useRef, useState } from "react";
import { useJob, type MeetingInfo } from "./api";
import type { Notify } from "./App";
import type { AttachTarget } from "./attach";
import { t } from "./i18n";
import { errorView, JOB_ERROR } from "./lib";
import { CONVERTED } from "./recorded";

/** 줄에 선 녹음 하나. target: 글만 있는 노트에 덧붙이는 녹음이면 그 노트 (--append-to) */
export type WaitItem = { dir: string; target: AttachTarget | null };

export function useTranscribeQueue({
  notify,
  refresh,
  openMeeting,
  markNoteStale,
  isRecording,
  failureHidden,
}: {
  notify: Notify;
  /** 노트 목록을 새로 읽는다 */
  refresh: () => Promise<MeetingInfo[] | undefined | void>;
  openMeeting: (id: string) => void;
  /** 열려 있는 노트를 다시 읽게 하고 요약이 낡았다고 알린다 (녹음을 덧붙인 노트) */
  markNoteStale: (id: string) => void;
  /** 다음 녹음을 하는 중인가: 그러면 끝난 노트를 열지 않고 알리기만 한다 (녹음 화면의 메모·북마크가 끊기지 않게) */
  isRecording: () => boolean;
  /** 녹음 화면이 변환 실패를 보여 주지 못하는가 (다음 녹음 중이거나 녹음 화면을 떠났다): 그러면 알림으로 알린다 */
  failureHidden: () => boolean;
}) {
  const current = useRef<WaitItem | null>(null); // 지금(마지막으로) 도는 변환: 다시 변환과 삭제가 본다
  const job = useJob((meetingId) => {
    const target = current.current?.target;
    if (target && target.id === meetingId) markNoteStale(meetingId);
    if (!isRecording()) return void refresh().then(() => openMeeting(meetingId));
    void refresh().then((ms) => notify({ text: CONVERTED((ms || []).find((m) => m.id === meetingId)?.title ?? ""), action: { label: t("열기"), run: () => openMeeting(meetingId) } }));
  });
  const [waitList, setWaitList] = useState<WaitItem[]>([]);

  /** 녹음 폴더를 줄에 세운다. 이미 줄에 있으면 다시 세우지 않는다 */
  const enqueue = useCallback((dir: string, target: AttachTarget | null = null) => {
    setWaitList((l) => (l.some((x) => x.dir === dir) ? l : [...l, { dir, target }]));
  }, []);

  /** 줄의 첫 녹음을 시작한다. 언제 시작하는지는 useWorkScheduler가 정한다 */
  const startNext = useCallback(() => {
    const [next, ...rest] = waitList;
    if (!next) return;
    setWaitList(rest);
    current.current = next;
    void job.startJob("transcribe", next.dir, next.target?.id);
  }, [waitList, job.startJob]);

  /** 지운 녹음이면 다시 변환할 대상에서 뺀다 */
  const forget = useCallback((dir: string) => {
    if (current.current?.dir === dir) current.current = null;
  }, []);

  // 실패가 녹음 화면에 보이지 않을 때 알린다: 다음 녹음 중이거나, 다음 녹음이 줄에 있어 곧 그 진행으로 바뀌거나, 녹음 화면을 떠났을 때.
  // 녹음은 `변환 대기 중인 녹음`에 남아 다시 변환할 수 있다. 줄·화면은 ref로 읽는다 (바뀔 때마다 지난 실패를 다시 알리지 않게)
  const waitRef = useRef(waitList);
  waitRef.current = waitList;
  const hidden = useRef(failureHidden);
  hidden.current = failureHidden;
  useEffect(() => {
    if (job.job.running || !job.job.error || !(waitRef.current.length > 0 || hidden.current())) return;
    const e = errorView(job.job.error, job.job.errorCode, JOB_ERROR.transcribe);
    notify({ text: e.text, detail: e.detail, error: true });
  }, [job.job.running, job.job.error, job.job.errorCode, notify]);

  return { job: job.job, waitList, waitDir: waitList[0]?.dir ?? null, enqueue, startNext, forget, current };
}
