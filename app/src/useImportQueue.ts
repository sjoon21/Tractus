// 파일 가져오기 줄 (Phase 5.5): 끌어 놓거나 고른 파일을 줄에 세우고 한 번에 하나씩 텍스트로 변환한다.
// 이 훅은 줄의 상태와 동작만 맡는다. 언제 시작하는가(녹음 변환·변환 전 노트의 변환이 모두 끝난 뒤)는 useWorkScheduler가 정한다 (jobSchedule.canStartImport).
// (vibe use-drop-target.ts, meetily layout.tsx — 둘 다 MIT — 참고)
import { useCallback, useEffect, useRef, useState } from "react";
import { useJob } from "./api";
import type { Notify } from "./App";
import { ADDED, failedFile, type AttachTarget } from "./attach";
import type { Decision } from "./caps";
import { t } from "./i18n";
import { baseName, errorView, isImportable, JOB_ERROR } from "./lib";

export function useImportQueue({
  convertGate,
  notify,
  notifyBlocked,
  refresh,
  openMeeting,
  markNoteStale,
}: {
  /** 지금 변환할 수 있는지 (모델·도구가 있는지): 끌어 놓은 파일은 실패하지 않고 이유를 알린다 */
  convertGate: () => Decision;
  notify: Notify;
  notifyBlocked: (gate: Decision) => void;
  /** 노트 목록을 새로 읽는다 */
  refresh: () => Promise<unknown>;
  openMeeting: (id: string) => void;
  /** 열려 있는 노트를 다시 읽게 하고 요약이 낡았다고 알린다 (녹음을 덧붙인 노트) */
  markNoteStale: (id: string) => void;
}) {
  const [queue, setQueue] = useState<string[]>([]);
  const [importing, setImporting] = useState<string | null>(null);
  const importTarget = useRef<AttachTarget | null>(null); // 이 노트에 추가하려고 고른 파일이면 그 노트 (파일에서 추가)
  const imp = useJob((meetingId, warnings) => {
    void refresh();
    const name = importing ? baseName(importing) : t("파일");
    // 화면은 바꾸지 않는다: 고치던 문장·찾기가 사라진다. 열기는 사용자가 고른다
    const dup = warnings.some((w) => w.code === "duplicate");
    const into = importTarget.current;
    if (into && !dup && into.id === meetingId) {
      markNoteStale(meetingId); // 열려 있는 노트는 녹음 노트로 다시 읽는다
      return notify({ text: ADDED(into.title, name) });
    }
    notify({ text: dup ? t("이미 텍스트로 변환한 파일입니다 — {name}", { name }) : t("텍스트 변환을 마쳤습니다 — {name}", { name }), action: { label: t("열기"), run: () => openMeeting(meetingId) } });
  });
  /** 줄의 첫 파일을 시작한다. 언제 시작하는지는 useWorkScheduler가 정한다 (jobSchedule.canStartImport) */
  const startNext = useCallback(() => {
    const [next, ...rest] = queue;
    if (next === undefined) return;
    setQueue(rest);
    setImporting(next);
    importTarget.current = null;
    void imp.startJob("import", next);
  }, [queue, imp.startJob]);

  // 실패는 알림으로 남긴다 (다음 파일이 시작되면 진행 표시는 그 파일로 바뀐다)
  useEffect(() => {
    if (!imp.job.running && imp.job.error && importing) {
      const e = errorView(imp.job.error, imp.job.errorCode, JOB_ERROR.import);
      const why = e.text === JOB_ERROR.import ? "" : `. ${e.text}`;
      notify({ text: failedFile(importing, why), detail: e.detail, error: true });
    }
  }, [imp.job.running, imp.job.error, imp.job.errorCode, importing, notify]);

  const gate = useRef(convertGate);
  gate.current = convertGate;
  /** 파일을 줄에 세운다: 못 쓰는 상태면 이유를 알리고, 가져올 수 없는 형식은 빼고 알리며, 이미 줄에 있는 파일은 다시 세우지 않는다 */
  const enqueue = useCallback(
    (paths: string[]) => {
      const g = gate.current();
      if (!g.ok) return notifyBlocked(g);
      const bad = paths.filter((p) => !isImportable(p));
      if (bad.length) notify({ text: t("가져올 수 없는 형식입니다: {files}", { files: bad.map(baseName).join(", ") }), error: true });
      setQueue((q) => [...q, ...paths.filter((p) => isImportable(p) && !q.includes(p))]);
    },
    [notify, notifyBlocked],
  );

  /** 글만 있는 노트에 추가할 파일을 바로 가져온다 (줄을 거치지 않는다: 그 노트의 흐름이 이미 다른 일을 막았다) */
  const startAttach = useCallback(
    (file: string, target: AttachTarget) => {
      importTarget.current = target;
      setImporting(file);
      void imp.startJob("import", file, target.id);
    },
    [imp.startJob],
  );

  const importPct = imp.job.total ? imp.job.done / imp.job.total : null;
  return { imp, queue, importing, importPct, enqueue, startAttach, startNext };
}
