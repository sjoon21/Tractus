// 내보내기·인쇄·Obsidian으로 보내기 (MeetingView에서 옮김, 동작 그대로). 저장 중인 편집이 끝난 뒤에 보내도록 편집 줄(serial)에 선다.
import { save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { api, errText, type MeetingDetail } from "../api";
import type { Notify } from "../App";
import type { ExportPick } from "../ExportDialog";
import { exportItems, PICK_FORMATS, type ExportItem } from "../exportPick";
import { t } from "../i18n";
import { baseName, exportFilename, segText, type EXPORT_FORMATS } from "../lib";
import { flushMemos } from "../memo";
import { sendToObsidian } from "../obsidian";
import { printDoc } from "../print";
import type { SummaryDoc } from "../summaries";

export function useNoteExport({ id, detail, memoNote, selectedSummary, serial, notify }: { id: string; detail: MeetingDetail | null; memoNote: boolean; selectedSummary: SummaryDoc | null; serial: (task: () => Promise<void>) => Promise<void>; notify: Notify }) {
  // PDF (6.5): 인쇄용 문서를 body 아래에 두고 macOS 인쇄 대화상자를 연다. 대화상자의 미리보기가 나중에 그리므로
  // 한 번 만든 인쇄 문서는 회의 화면을 닫을 때까지 둔다 (화면에는 보이지 않는다)
  const [printNonce, setPrintNonce] = useState(0);
  useEffect(() => {
    if (!printNonce) return;
    const id = requestAnimationFrame(() =>
      // Tauri는 macOS에서 window.print()를 webview print 명령(Promise)으로 바꿔 둔다
      Promise.resolve(window.print() as unknown).catch((e) => notify({ text: t("인쇄 창을 열지 못했습니다: {error}", { error: errText(e) }), error: true })),
    );
    return () => cancelAnimationFrame(id);
  }, [printNonce, notify]);
  const printable = useMemo(() => (printNonce && detail ? printDoc(detail, selectedSummary) : null), [printNonce > 0, detail, selectedSummary]);

  // Markdown·Word는 넣을 내용을 고르는 창을 먼저 연다 (exportPick.ts). 다른 형식은 바로 저장 대화상자
  const [exportPick, setExportPick] = useState<{ f: (typeof EXPORT_FORMATS)[number]; items: ExportItem[] } | null>(null);
  const exportAs = async (f: (typeof EXPORT_FORMATS)[number]) => {
    if (!detail) return;
    if (!PICK_FORMATS.includes(f.format)) return saveExport(f, null);
    let items: ExportItem[];
    try {
      const [docs, templates] = await Promise.all([api.summariesList(id), api.templatesList().catch(() => [])]);
      items = exportItems(docs, templates, {
        memoNote,
        transcript: detail.segments.some((s) => segText(s).trim()),
        memo: !memoNote && (detail.note_memo?.lines ?? []).some((l) => l.text.trim()),
        marks: detail.memos.length > 0,
      });
    } catch (e) {
      return notify({ text: t("내보내지 못했습니다: {error}", { error: errText(e) }), error: true });
    }
    if (items.length === 0) return saveExport(f, { summaries: [], parts: [] }); // 고를 것이 없다 (빈 변환 전 노트): 제목만
    setExportPick({ f, items });
  };
  const saveExport = async (f: (typeof EXPORT_FORMATS)[number], pick: ExportPick | null) => {
    if (!detail) return;
    let out: string | null;
    try {
      out = await save({ defaultPath: exportFilename(detail.info.created_at, detail.info.title, f.ext), filters: [{ name: f.label, extensions: [f.ext] }] });
    } catch (e) {
      return notify({ text: t("저장 위치를 고르지 못했습니다: {error}", { error: errText(e) }), error: true });
    }
    if (!out) return;
    const target = out;
    if (!(await flushMemos())) return; // 쓰던 글까지 내보낸다. 저장하지 못하면 내보내지 않는다 (오류는 편집기가 보인다)
    // 저장 중인 편집이 끝난 뒤에 내보낸다
    void serial(async () => {
      try {
        const path = await api.exportMeeting(id, f.format, target, pick);
        notify({ text: t("내보냈습니다 — {file}", { file: baseName(path) }) });
      } catch (e) {
        notify({ text: t("내보내지 못했습니다: {error}", { error: errText(e) }), error: true });
      }
    });
  };

  const toObsidian = async () => {
    if (!(await flushMemos())) return; // 쓰던 글까지 보낸다
    void serial(() => sendToObsidian(id, selectedSummary?.key, notify)); // 요약 탭에서 고른 요약이 들어간다
  };

  return { printNonce, setPrintNonce, printable, exportPick, setExportPick, exportAs, saveExport, toObsidian };
}
