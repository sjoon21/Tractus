// 시작 점검 (docs/desktop.md §2.15): 처음 실행할 때 저절로 열리고, 설정·첫 화면에서 언제든 다시 연다. 행 구조는 checkupRows.ts.
// 점검은 앱을 막지 않는다: 닫기·Esc·`점검 마치기` 어느 쪽이든 닫고, 고치는 길(모델 화면·설정)로 가려면 먼저 닫는다.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle, type LucideIcon } from "lucide-react";
import { OK_TEXT, WARN_TEXT } from "@/components/settings/tone";
import { Button } from "@/components/ui/button";
import { DIALOG, DIALOG_FOOTER, DIALOG_TEXT, DIALOG_TITLE } from "@/components/ui/dialog";
import { cn } from "@/components/ui/utils";
import { api, errText } from "./api";
import type { Fix } from "./caps";
import { checkupHeadline, checkupSections, STATUS_LABEL, type CheckupRow } from "./checkupRows";
import { DownloadPanel, PresetButtons, useModelsList } from "./ModelsSettings";
import { isPathFix } from "./paths";
import { runPathFix } from "./pathFix";
import { useCapabilities } from "./useCapabilities";

const ICON: Record<CheckupRow["status"], { Icon: LucideIcon; tone: string }> = {
  ok: { Icon: CheckCircle2, tone: OK_TEXT },
  warn: { Icon: AlertTriangle, tone: WARN_TEXT },
  blocked: { Icon: XCircle, tone: "text-destructive" },
  info: { Icon: Info, tone: "text-muted-foreground" },
};

export function Checkup({ onClose }: { onClose: () => void }) {
  const caps = useCapabilities();
  const { list, load, dl } = useModelsList();
  const [keySaved, setKeySaved] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [pathNote, setPathNote] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (!d.open) d.showModal();
    title.current?.focus(); // 첫 단추(목록 한가운데)가 아니라 제목에서 시작한다: 위에서부터 읽는다
    return () => d.close();
  }, []);

  // 쓸 수 있는 AI 서비스(키가 등록돼 있거나 이 Mac 주소의 직접 입력)가 하나라도 있는가
  const loadKey = useCallback(() => api.llmSettings().then((s) => setKeySaved(s.registered.length > 0), () => setKeySaved(null)), []);
  useEffect(() => void loadKey(), [loadKey]);
  // 받기가 끝나면 점검도 다시 한다 (필수 모델 행이 바뀐다)
  const wasRunning = useRef(dl.running);
  useEffect(() => {
    if (wasRunning.current && !dl.running) void caps.refresh();
    wasRunning.current = dl.running;
  }, [dl.running, caps]);

  const recheck = async () => {
    setChecking(true);
    await Promise.all([caps.refresh(), load(), loadKey()]);
    setChecking(false);
  };
  const fix = (f: Fix) => {
    if (isPathFix(f.kind)) {
      // 경로 고르기는 점검 안에서 끝낸다 (닫지 않는다). 고른 뒤 바로 다시 점검한다
      runPathFix(f.kind).then(
        (done) => {
          setPathNote(done);
          if (done) void caps.refresh();
        },
        (e) => setPathNote(errText(e)),
      );
      return;
    }
    onClose();
    caps.fixAction(f);
  };
  const copy = (row: CheckupRow) =>
    navigator.clipboard.writeText(row.copy ?? "").then(
      () => setCopied({ id: row.id, ok: true }),
      () => setCopied({ id: row.id, ok: false }),
    );

  const sections = checkupSections({ report: caps.report, models: list, keySaved });
  return (
    <dialog
      ref={dialog}
      className={cn(DIALOG, "max-h-[min(780px,calc(100vh-48px))] w-[min(620px,calc(100vw-32px))] flex-col overflow-hidden open:flex")}
      aria-labelledby="checkup-title"
      aria-busy={checking || caps.loading}
      onCancel={(e) => {
        e.preventDefault(); // Esc: 닫는 일은 상태가 한다
        onClose();
      }}
    >
      <header className="flex flex-col gap-1 border-b border-border px-5 pt-5 pb-4">
        <h2 id="checkup-title" ref={title} tabIndex={-1} className={cn(DIALOG_TITLE, "outline-none")}>
          시작 점검
        </h2>
        <p className={cn(DIALOG_TEXT, "text-foreground")} aria-live="polite">
          {caps.loading || checking ? "확인하는 중…" : checkupHeadline(sections)}
          <span className="mt-0.5 block text-xs text-muted-foreground">점검 결과와 상관없이 앱은 계속 쓸 수 있습니다. 설정이나 홈 화면에서 언제든 다시 열 수 있습니다.</span>
        </p>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
        {pathNote && (
          <p className="m-0 text-xs text-muted-foreground" role="status">
            {pathNote}
          </p>
        )}
        {sections.map((s) => (
          <section key={s.id} className="flex flex-col gap-2" aria-labelledby={`checkup-${s.id}`}>
            <h3 id={`checkup-${s.id}`} className="m-0 px-1 text-xs font-semibold text-muted-foreground">
              {s.title}
            </h3>
            <ul className="m-0 list-none divide-y divide-border overflow-hidden rounded-lg border border-border bg-card p-0">
              {s.rows.map((r) => {
                const { Icon, tone } = ICON[r.status];
                return (
                  <li key={r.id} className="flex items-start gap-3 px-3 py-2">
                    <Icon className={cn("mt-0.5 size-4 shrink-0", tone)} aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="m-0 text-[13px]">
                        {r.label} <span className="sr-only">{STATUS_LABEL[r.status]}</span>
                      </p>
                      <p className="m-0 mt-0.5 text-xs leading-relaxed break-words text-muted-foreground">{r.detail}</p>
                      {r.copy && (
                        <p className="m-0 mt-1.5 flex flex-wrap items-center gap-1.5">
                          <code className="min-w-0 rounded-md bg-secondary px-2 py-1 font-mono text-[11px] break-all">{r.copy}</code>
                          <Button variant="ghost" size="sm" className="h-6 px-2" onClick={() => void copy(r)}>
                            복사
                          </Button>
                          {copied?.id === r.id && <span className="text-xs text-muted-foreground">{copied.ok ? "복사했습니다" : "복사하지 못했습니다. 직접 선택해 복사하세요"}</span>}
                        </p>
                      )}
                    </div>
                    {r.fix && (
                      <Button variant="outline" size="sm" className="-my-0.5" onClick={() => fix(r.fix as Fix)}>
                        {r.fix.label}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {s.id === "models" && list && <PresetButtons list={list} dl={dl} />}
            {s.id === "models" && <DownloadPanel dl={dl} />}
          </section>
        ))}
      </div>
      <div className={DIALOG_FOOTER}>
        <Button variant="outline" disabled={checking} onClick={() => void recheck()}>
          다시 확인
        </Button>
        <Button onClick={onClose}>점검 마치기</Button>
      </div>
    </dialog>
  );
}
