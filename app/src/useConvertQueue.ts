// 변환 전 노트의 변환 줄 (convertQueue.ts: 순수 상태 전이): 노트 하나를 변환하는 것도, 모두 변환도 같은 줄이다. 한 번에 하나씩.
// 이 훅은 줄의 상태와 동작(올리기·시작·끝났을 때 알림과 넘기기·새 녹음이 멈추기)만 맡는다.
// **언제 시작하는가**는 useWorkScheduler가 정한다 (jobSchedule.ts): 녹음 변환·가져오기와 한 번에 하나만 돌아야 해서다.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MeetingInfo } from "./api";
import type { Notify } from "./App";
import type { Decision } from "./caps";
import { attachConvertJobs, convertStore, useConvertJob } from "./convertJobs";
import { convertAdvance, convertEnqueue, convertProgress, convertSlot, IDLE_CONVERT, type ConvertQueue } from "./convertQueue";
import { t } from "./i18n";
import { errorView, JOB_ERROR, warningText } from "./lib";
import { CONVERT_FAIL, CONVERT_PAUSED, CONVERTED, isRecorded, recordedIds } from "./recorded";

export function useConvertQueue({
  meetings,
  convertGate,
  notify,
  notifyBlocked,
  refresh,
  openMeeting,
  isViewing,
}: {
  meetings: MeetingInfo[];
  /** 지금 변환할 수 있는지 (모델·도구가 있는지) */
  convertGate: () => Decision;
  notify: Notify;
  notifyBlocked: (gate: Decision) => void;
  refresh: () => Promise<unknown>;
  openMeeting: (id: string) => void;
  /** 지금 이 노트를 보고 있는가: 보고 있으면 끝났을 때 열기 단추를 주지 않는다 */
  isViewing: (noteId: string) => boolean;
}) {
  const [queue, setQueue] = useState<ConvertQueue>(IDLE_CONVERT);
  const job = useConvertJob(queue.current);
  const converting = queue.current !== null;
  const running = converting && job.running;
  const meetingsRef = useRef(meetings);
  meetingsRef.current = meetings;
  const preempted = useRef<string | null>(null); // 새 녹음이 멈춘 변환의 노트
  const started = useRef<string | null>(null); // 이미 시작한 줄의 첫 노트 (같은 노트를 두 번 시작하지 않는다)

  /**
   * 줄의 첫 노트를 시작한다. canStart는 스케줄러가 정한 "지금 시작해도 되는가".
   * 노트 목록을 읽기 전에는 아무것도 하지 않고, 지워졌거나 다른 곳에서 이미 변환한 노트는 시작하지 않고 줄을 넘긴다.
   */
  const tryStart = useCallback(
    (listLoaded: boolean, canStart: boolean) => {
      const id = queue.current;
      if (id === null) {
        started.current = null;
        return;
      }
      if (started.current === id || !listLoaded) return;
      const note = meetingsRef.current.find((m) => m.id === id);
      if (!note || !isRecorded(note)) return setQueue(convertAdvance);
      if (!canStart) return;
      started.current = id;
      void convertStore.start(id);
    },
    [queue],
  );

  // 변환이 끝나면(성공이든 실패든) 알리고 줄을 넘긴다. 실패해도 줄은 이어진다. 노트가 열려 있지 않아도 알린다
  useEffect(
    () =>
      attachConvertJobs(({ noteId, ok, state }) => {
        // 새 녹음이 멈춘 변환: 실패로 알리지 않고 줄도 넘기지 않는다. 녹음이 끝나면 같은 노트를 이어서 시작한다
        if (preempted.current === noteId) {
          preempted.current = null;
          if (!ok) {
            started.current = null;
            return;
          }
        }
        const title = meetingsRef.current.find((m) => m.id === noteId)?.title ?? "";
        if (ok) {
          notify({ text: CONVERTED(title), action: isViewing(noteId) ? undefined : { label: t("열기"), run: () => openMeeting(noteId) } });
          state.warnings.forEach((w) => notify({ text: warningText(w) }));
        } else {
          const e = errorView(state.error, state.errorCode, JOB_ERROR.convert);
          notify({ text: CONVERT_FAIL(title, e.text === JOB_ERROR.convert ? "" : `. ${e.text}`), detail: e.detail, error: true });
        }
        void refresh();
        setQueue((q) => (q.current === noteId ? convertAdvance(q) : q));
      }),
    [notify, refresh, openMeeting, isViewing],
  );

  /** 실시간 자막을 켠 녹음이 시작됐다: 도는 변환을 멈춘다 (멈춘 곳부터 이어서 할 수 있다). 줄은 그대로라 녹음이 끝나면 이어서 한다 */
  const preempt = useCallback(() => {
    if (!running || queue.current === null) return;
    preempted.current = queue.current;
    convertStore.cancel(queue.current);
    notify({ text: CONVERT_PAUSED });
  }, [running, queue, notify]);

  /** 변환 전 노트 하나를 줄에 올린다. 못 쓰면 이유와 고치는 길을 알린다 */
  const convertNote = useCallback(
    (id: string) => {
      const gate = convertGate();
      if (!gate.ok) return notifyBlocked(gate);
      setQueue((q) => convertEnqueue(q, [id]));
    },
    [convertGate, notifyBlocked],
  );
  const bulkIds = useMemo(() => recordedIds(meetings), [meetings]);
  const convertAll = useCallback(() => {
    const gate = convertGate();
    if (!gate.ok) return notifyBlocked(gate);
    setQueue((q) => convertEnqueue(q, bulkIds));
  }, [convertGate, notifyBlocked, bulkIds]);

  const slots = useMemo(() => {
    const m = new Map<string, "running" | "queued">();
    for (const id of [queue.current, ...queue.pending]) {
      const slot = id === null ? null : convertSlot(queue, id, running);
      if (id !== null && slot) m.set(id, slot);
    }
    return m;
  }, [queue, running]);
  const slotOf = useCallback((id: string) => convertSlot(queue, id, running), [queue, running]);
  const title = converting ? (meetings.find((m) => m.id === queue.current)?.title ?? "") : "";
  const pct = job.total ? job.done / job.total : null;
  const progress = convertProgress(queue);

  return { queue, job, converting, running, tryStart, preempt, convertNote, convertAll, bulkIds, slots, slotOf, title, pct, progress };
}
export type ConvertQueueApi = ReturnType<typeof useConvertQueue>;
