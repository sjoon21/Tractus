import { useState } from "react";
import { pickPath } from "./pathFix";
import { AUTO_BADGE, BIN_LABEL, binView, BROWSE, CHECKING, CUSTOM_BADGE, FULL_PATH_HINT, PICK_CUSTOM, REVERT_AUTO, type BinKind } from "./paths";
import type { DoctorReport } from "./caps";

/** 실행 파일 경로 한 칸: 자동이면 찾은 경로를 읽기만 하고, 직접 지정이면 입력 + 찾아보기. 저장하는 값은 직접 지정한 것뿐이다 (비면 자동) */
export function BinField({ kind, value, onChange, report }: { kind: BinKind; value: string; onChange: (v: string) => void; report: DoctorReport | null }) {
  const [editing, setEditing] = useState(false);
  const custom = editing || value !== "";
  const view = binView(report, kind);
  const label = `${BIN_LABEL[kind]} ${custom ? CUSTOM_BADGE : AUTO_BADGE}`;
  return (
    <div className="field bin-field" role="group" aria-label={label}>
      <span className="field-label">
        {BIN_LABEL[kind]} <span className="badge">{custom ? CUSTOM_BADGE : AUTO_BADGE}</span>
      </span>
      {custom ? (
        <>
          <input aria-label={BIN_LABEL[kind]} value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
          <span className="bin-actions">
            <button type="button" className="ghost-button" onClick={() => void pickPath(false).then((p) => p && onChange(p))}>
              {BROWSE}
            </button>
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setEditing(false);
                onChange("");
              }}
            >
              {REVERT_AUTO}
            </button>
          </span>
          <span className="field-hint">{FULL_PATH_HINT}</span>
        </>
      ) : (
        <>
          <code className="bin-path">{view?.path ?? CHECKING}</code>
          <span className="bin-actions">
            <button type="button" className="text-button" onClick={() => setEditing(true)}>
              {PICK_CUSTOM}
            </button>
          </span>
          {view && <span className="field-hint">{view.note}</span>}
        </>
      )}
    </div>
  );
}
