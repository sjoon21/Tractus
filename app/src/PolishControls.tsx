// AI 다듬기 화면 부품 (docs/design/transcript-polish.md): 실행(구간별 제안을 그때그때 모은다)·제안 막대(모두 받기·버리기)·줄 안의 diff.
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, Sparkles, X } from "lucide-react";
import { useJob } from "./api";
import type { Notify } from "./App";
import { t } from "./i18n";
import { llmErrorView } from "./llmKey";
import { useLlmServices } from "./LlmServicePicker";
import {
  ACCEPT,
  ACCEPT_ALL,
  ACCEPT_ALL_TITLE,
  ACCEPT_KEY_TITLE,
  bulkAcceptIds,
  bulkGroups,
  FLAG_LABEL,
  GO_SUGGESTION,
  GROUP_ACCEPT,
  groupAcceptTitle,
  NEXT_SUGGESTION,
  NEXT_SUGGESTION_TITLE,
  POLISH_AGAIN_TITLE,
  POLISH_LABEL,
  POLISH_TITLE,
  polishRunning,
  REJECT,
  REJECT_ALL,
  REJECT_KEY_TITLE,
  suggestionCount,
  wordDiff,
  type PolishSuggestion,
} from "./polish";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { isImeKey } from "./lib";

/** 실행 상태: 돌아가는 동안 끝난 구간의 제안(live)과 범위(ranges)를 모은다. 끝나면 onDone(노트를 다시 읽는다: polish.json이 원본). 실패는 알림으로 */
export function usePolish(id: string, notify: Notify, onDone: () => Promise<void>) {
  const services = useLlmServices("summary"); // 요약과 같은 AI 서비스 선택 (요약 탭에서 고른 것)
  const [live, setLive] = useState<PolishSuggestion[]>([]);
  const [ranges, setRanges] = useState<[string, string][]>([]);
  const clear = () => {
    setLive([]);
    setRanges([]);
  };
  const job = useJob(
    () => void onDone().then(clear),
    clear,
    (ev) => {
      if (ev.event !== "progress") return;
      const { suggestions: got, range } = ev;
      if (got?.length) setLive((l) => [...l, ...got]);
      if (range) setRanges((r) => [...r, range]);
    },
  );
  const { running, error, errorCode } = job.job;
  useEffect(() => {
    if (running || !error) return;
    const e = llmErrorView("polish", error, errorCode);
    notify({ text: e.text, detail: e.detail, error: true });
  }, [running, error, errorCode, notify]);
  const start = useCallback(
    async (prepare: () => Promise<boolean>) => {
      if (running || !(await prepare())) return;
      clear();
      void job.runJob("polish_start", { id, provider: services.provider });
    },
    [running, job, id, services.provider],
  );
  return { running, done: job.job.done, total: job.job.total, live, ranges, start, services };
}

/** 대화 내용 위쪽 툴바의 단추 */
export function PolishButton({ running, done, total, disabled, again, onClick }: { running: boolean; done: number; total: number; disabled: string | null; again: boolean; onClick: () => void }) {
  return (
    <Button variant="ghost" size="sm" disabled={running || !!disabled} title={disabled ?? (again ? `${POLISH_TITLE}\n${POLISH_AGAIN_TITLE}` : POLISH_TITLE)} onClick={onClick} aria-live="polite">
      <Sparkles aria-hidden className={running ? "polish-spin" : undefined} />
      {running ? polishRunning(done, total) : POLISH_LABEL}
    </Button>
  );
}

/** 제안이 있을 때 대화 내용 위에 붙는 막대: 개수 + 남은 제안의 위치 눈금(누르면 이동) + 다음 제안 + 모두 받기(표시 없는 것만)·모두 버리기.
 * 종류가 둘 이상이면 아래 줄에 종류별 한꺼번에 수락(문장 다듬기만 받고 용어·이름은 하나씩 보는 식, v3.116) */
export function PolishBar({ live, marks, running, busy, onDecide, onJump }: { live: Map<string, PolishSuggestion>; marks: { id: string; at: number }[]; running: boolean; busy: boolean; onDecide: (ids: string[], accept: boolean) => void; onJump: (id?: string) => void }) {
  if (live.size === 0) return null;
  const all = [...live.keys()];
  const bulk = bulkAcceptIds(live);
  const groups = bulkGroups(live);
  return (
    <div className="polish-bar sticky top-[52px] z-10 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 text-[13px] backdrop-blur-md" role="status">
      <Sparkles aria-hidden className="size-4 text-muted-foreground" />
      <span className="tabular-nums">{suggestionCount(live.size, live.size - bulk.length)}</span>
      <span className="polish-marks relative mr-auto h-3 min-w-20 flex-1 rounded-full bg-muted" aria-hidden>
        {marks.map((m) => (
          <button key={m.id} type="button" tabIndex={-1} title={GO_SUGGESTION} className="polish-mark absolute top-0 h-3 w-1.5 -translate-x-1/2 cursor-pointer rounded-full bg-ring p-0" style={{ left: `${m.at * 100}%` }} onClick={() => onJump(m.id)} />
        ))}
      </span>
      <Button variant="ghost" size="sm" title={NEXT_SUGGESTION_TITLE} onClick={() => onJump()}>
        <ChevronDown aria-hidden />
        {NEXT_SUGGESTION}
      </Button>
      <Button variant="outline" size="sm" disabled={running || busy || bulk.length === 0} title={ACCEPT_ALL_TITLE} onClick={() => onDecide(bulk, true)}>
        <Check aria-hidden />
        {ACCEPT_ALL}
        {bulk.length !== all.length && <span className="tabular-nums text-muted-foreground"> {bulk.length}</span>}
      </Button>
      <Button variant="ghost" size="sm" disabled={running || busy} onClick={() => onDecide(all, false)}>
        <X aria-hidden />
        {REJECT_ALL}
      </Button>
      {groups.length > 1 && (
        <div className="flex w-full flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="mr-0.5">{GROUP_ACCEPT}</span>
          {groups.map((g) => (
            <Button key={g.label} variant="outline" size="sm" className="h-6 px-2 text-xs" disabled={running || busy} title={groupAcceptTitle(g.label, g.ids.length)} onClick={() => onDecide(g.ids, true)}>
              <Check aria-hidden />
              {g.label}
              <span className="tabular-nums text-muted-foreground">{g.ids.length}</span>
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** 줄 안의 제안: 지운 말(줄 긋기) → 새 말, 표시, 받기·버리기.
 * 키보드로 넘기기(v3.116): 정하면 다음 제안의 수락 단추로 초점이 가므로(usePolishReview) Enter = 수락, ⌫ = 거절만 이어 누르면 된다. 키 안내는 초점이 있는 제안에만 */
export function PolishDiff({ s, busy, onDecide }: { s: PolishSuggestion; busy: boolean; onDecide: (ids: string[], accept: boolean) => void }) {
  return (
    <div
      className="seg-polish group/polish"
      role="group"
      aria-label={t("교정 제안")}
      onKeyDown={(e) => {
        if (busy || isImeKey(e.nativeEvent) || e.metaKey || e.ctrlKey || e.altKey || (e.key !== "Backspace" && e.key !== "Delete")) return;
        e.preventDefault();
        onDecide([s.id], false);
      }}
    >
      <p className="seg-polish-text m-0">
        {wordDiff(s.before, s.text).map((p, i) =>
          p.op === "same" ? (
            <span key={i}>{p.text} </span>
          ) : p.op === "del" ? (
            <del key={i}>{p.text}</del>
          ) : (
            <ins key={i}>{p.text}</ins>
          ),
        )}
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {s.flags.map((f) => FLAG_LABEL[f] && (
          <Badge key={f} variant="outline" title={FLAG_LABEL[f].title}>
            {FLAG_LABEL[f].text}
          </Badge>
        ))}
        <span className="ml-auto flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-7" disabled={busy} title={ACCEPT_KEY_TITLE} aria-keyshortcuts="Enter" onClick={() => onDecide([s.id], true)}>
            <Check aria-hidden />
            {ACCEPT}
            <Kbd className="hidden group-focus-within/polish:inline-flex">↵</Kbd>
          </Button>
          <Button variant="ghost" size="sm" className="h-7 text-muted-foreground" disabled={busy} title={REJECT_KEY_TITLE} aria-keyshortcuts="Backspace" onClick={() => onDecide([s.id], false)}>
            <X aria-hidden />
            {REJECT}
            <Kbd className="hidden group-focus-within/polish:inline-flex">⌫</Kbd>
          </Button>
        </span>
      </div>
    </div>
  );
}
