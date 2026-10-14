// 모델·도구가 없어 못 쓰는 기능의 단추 (WORDS.md §4.14). `disabled`가 아니라 `aria-disabled`라 키보드·화면 읽기 사용자도 닿고, 누르면 이유와 고치는 길을 보여 준다.
// 말 없이 죽은 단추를 만들지 않는다: 이 앱에서 모델·도구에 달린 단추는 모두 이 컴포넌트(또는 GateHint)를 쓴다.
import { useState, type ButtonHTMLAttributes } from "react";
import type { Decision } from "./caps";
import { useCapabilities } from "./useCapabilities";
import { Popover } from "./Popover";

type GateProps = { gate: Decision };

/** 이유 한 문장과 고치는 단추 (인라인). 설정의 체크 아래·노트 머리 안내 등 */
export function GateHint({ gate, className = "" }: GateProps & { className?: string }) {
  const { fixAction } = useCapabilities();
  if (gate.ok) return null;
  return (
    <p className={`gate-hint ${className}`} role="status">
      <span>{gate.reason}</span>{" "}
      <button type="button" className="text-button" onClick={() => fixAction(gate.fix)}>
        {gate.fix.label}
      </button>
    </p>
  );
}

export function GatedButton({ gate, onClick, className = "", disabled, children, ...rest }: GateProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  const { fixAction } = useCapabilities();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  if (gate.ok || disabled) {
    // 이미 다른 이유로 못 쓰는 단추(disabled)는 그 이유가 먼저다
    return (
      <button {...rest} type={rest.type ?? "button"} className={className} disabled={disabled} onClick={onClick}>
        {children}
      </button>
    );
  }
  return (
    <>
      <button
        {...rest}
        ref={setAnchor}
        type="button"
        className={`${className} is-gated`}
        aria-disabled
        aria-haspopup="dialog"
        aria-expanded={open}
        title={gate.reason}
        onClick={(e) => {
          e.preventDefault(); // 못 쓰는 동안 원래 동작은 하지 않는다
          setOpen((o) => !o);
        }}
      >
        {children}
      </button>
      {open && anchor && (
        <Popover anchor={anchor} label="지금 쓸 수 없는 이유" role="dialog" onClose={() => setOpen(false)}>
          {(close) => (
            <div className="gate-pop">
              <p>{gate.reason}</p>
              <button
                type="button"
                className="ghost-button"
                autoFocus
                onClick={() => {
                  close();
                  fixAction(gate.fix);
                }}
              >
                {gate.fix.label}
              </button>
            </div>
          )}
        </Popover>
      )}
    </>
  );
}
