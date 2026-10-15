import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
    <div className="px-4 py-3" role="group" aria-label={label}>
      <div className="flex items-center justify-between gap-4">
        <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
          {BIN_LABEL[kind]} <Badge variant={custom ? "memo" : "default"}>{custom ? CUSTOM_BADGE : AUTO_BADGE}</Badge>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {custom ? (
            <>
              <Button variant="outline" size="sm" onClick={() => void pickPath(false).then((p) => p && onChange(p))}>
                {BROWSE}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(false);
                  onChange("");
                }}
              >
                {REVERT_AUTO}
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {PICK_CUSTOM}
            </Button>
          )}
        </span>
      </div>
      {custom ? (
        <>
          <Input aria-label={BIN_LABEL[kind]} className="mt-2 font-mono text-xs" value={value} onChange={(e) => onChange(e.target.value)} spellCheck={false} />
          <p className="m-0 mt-1 text-xs text-muted-foreground">{FULL_PATH_HINT}</p>
        </>
      ) : (
        <>
          <code className="mt-2 block truncate rounded-md bg-secondary px-2.5 py-1.5 font-mono text-xs text-muted-foreground" title={view?.path}>
            {view?.path ?? CHECKING}
          </code>
          {view && <p className="m-0 mt-1 text-xs text-muted-foreground">{view.note}</p>}
        </>
      )}
    </div>
  );
}
