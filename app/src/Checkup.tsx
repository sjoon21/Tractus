// 시작 점검 (docs/desktop.md §2.15): 처음 실행할 때 저절로 열리고, 설정·첫 화면에서 언제든 다시 연다. 행 구조는 checkupRows.ts.
// 점검은 앱을 막지 않는다: 닫기·Esc·`점검 마치기` 어느 쪽이든 닫고, 고치는 길(모델 화면·설정)로 가려면 먼저 닫는다.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errText } from "./api";
import type { Fix } from "./caps";
import { checkupHeadline, checkupSections, STATUS_LABEL, type CheckupRow } from "./checkupRows";
import { DownloadPanel, PresetButtons, useModelsList } from "./ModelsSettings";
import { isPathFix } from "./paths";
import { runPathFix } from "./pathFix";
import { useCapabilities } from "./useCapabilities";

const ICON: Record<CheckupRow["status"], string> = { ok: "✓", warn: "!", blocked: "✕", info: "i" };

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

  const loadKey = useCallback(() => api.llmKeyStatus().then((s) => setKeySaved(s.saved), () => setKeySaved(null)), []);
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
      className="confirm checkup"
      aria-labelledby="checkup-title"
      aria-busy={checking || caps.loading}
      onCancel={(e) => {
        e.preventDefault(); // Esc: 닫는 일은 상태가 한다
        onClose();
      }}
    >
      <h2 id="checkup-title" ref={title} tabIndex={-1}>
        시작 점검
      </h2>
      <p className="field-hint" aria-live="polite">
        {caps.loading || checking ? "확인하는 중…" : checkupHeadline(sections)} — 점검 결과와 상관없이 앱은 계속 쓸 수 있습니다. 설정이나 홈 화면에서 언제든 다시 열 수 있습니다.
      </p>
      {pathNote && (
        <p className="field-hint" role="status">
          {pathNote}
        </p>
      )}
      {sections.map((s) => (
        <section key={s.id} className="checkup-section" aria-labelledby={`checkup-${s.id}`}>
          <h3 id={`checkup-${s.id}`}>{s.title}</h3>
          <ul className="checkup-rows">
            {s.rows.map((r) => (
              <li key={r.id} className={`checkup-row is-${r.status}`}>
                <span className="checkup-icon" aria-hidden>
                  {ICON[r.status]}
                </span>
                <div className="checkup-body">
                  <p className="checkup-label">
                    {r.label} <span className="sr-only">{STATUS_LABEL[r.status]}</span>
                  </p>
                  <p className="checkup-detail">{r.detail}</p>
                  {r.copy && (
                    <p className="checkup-copy">
                      <code>{r.copy}</code>
                      <button type="button" className="text-button" onClick={() => void copy(r)}>
                        복사
                      </button>
                      {copied?.id === r.id && <span className="field-hint">{copied.ok ? "복사했습니다" : "복사하지 못했습니다. 직접 선택해 복사하세요"}</span>}
                    </p>
                  )}
                  {r.fix && (
                    <button type="button" className="text-button" onClick={() => fix(r.fix as Fix)}>
                      {r.fix.label}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {s.id === "models" && list && <PresetButtons list={list} dl={dl} />}
          {s.id === "models" && <DownloadPanel dl={dl} />}
        </section>
      ))}
      <div className="confirm-actions">
        <button type="button" className="ghost-button" disabled={checking} onClick={() => void recheck()}>
          다시 확인
        </button>
        <button type="button" className="primary-button" onClick={onClose}>
          점검 마치기
        </button>
      </div>
    </dialog>
  );
}
