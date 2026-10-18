// 온보딩 ③: `data-tip="<ID>"`(또는 anchor 선택자) 요소 옆에 한 번 뜨는 안내 (tips.ts). 초점을 빼앗지 않고 Esc로 닫힌다
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { seeTip, TIP_OFF, TIP_OK, TIPS, tipsOff, useTip, useWanted, type TipId } from "./tips";

type Side = "bottom" | "top" | "right" | "left";
const GAP = 10;
const MARGIN = 12;

/** 보이고(숨은 탭 안이 아니고) 창 안에 있는가 */
function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

export function CoachMark({ id, ready = true, side = "bottom", anchor }: { id: TipId; ready?: boolean; side?: Side; anchor?: string }) {
  const selector = anchor ?? `[data-tip="${id}"]`;
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [rev, setRev] = useState(0); // 0.5초마다: 패널 접기·목록 로딩처럼 이벤트 없이 자리가 움직여도 따라간다
  const wanted = useWanted(id); // 이미 봤거나 안내를 껐으면 자리를 찾지 않는다 (타이머도 돌지 않는다)
  useEffect(() => {
    if (!ready || !wanted) return setTarget(null);
    // 보이는 자리만: 숨은 탭 안의 단추나 화면 밖으로 스크롤된 자리가 "한 번에 하나" 자리를 차지해 다른 안내를 막지 않게
    const find = () => {
      if (document.hidden) return; // 창이 숨어 있으면 쉰다
      const el = document.querySelector<HTMLElement>(selector);
      setTarget(el && onScreen(el) ? el : null);
      setRev((n) => n + 1);
    };
    find();
    const timer = window.setInterval(find, 500); // 늦게 그려지는 자리(목록·탭)도 잡는다
    return () => window.clearInterval(timer);
  }, [ready, selector, wanted]);
  const show = useTip(id, ready && !!target);
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; ax: number; ay: number } | null>(null);

  useLayoutEffect(() => {
    if (!show || !target) return setPos(null);
    const place = () => {
      const a = target.getBoundingClientRect();
      const b = box.current?.getBoundingClientRect();
      if (!b || (a.width === 0 && a.height === 0)) return setPos(null); // 자리가 숨었다
      const clampX = (x: number) => Math.max(MARGIN, Math.min(x, window.innerWidth - b.width - MARGIN));
      const clampY = (y: number) => Math.max(MARGIN, Math.min(y, window.innerHeight - b.height - MARGIN));
      const cx = a.left + a.width / 2;
      const cy = a.top + a.height / 2;
      const p =
        side === "right" ? { top: clampY(cy - b.height / 2), left: clampX(a.right + GAP) }
        : side === "left" ? { top: clampY(cy - b.height / 2), left: clampX(a.left - GAP - b.width) }
        : side === "top" ? { top: clampY(a.top - GAP - b.height), left: clampX(cx - b.width / 2) }
        : { top: clampY(a.bottom + GAP), left: clampX(cx - b.width / 2) };
      setPos({ ...p, ax: cx - p.left, ay: cy - p.top }); // 화살표: 상자 안에서 자리의 가운데
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [show, target, side, rev]);

  useEffect(() => {
    if (!show) return;
    // 다른 것을 닫는 Esc(편집 취소·검색 지우기·내보내기 메뉴 같은 열린 popover)는 안내를 본 것으로 치지 않는다
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
      if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing && !typing && !document.querySelector(":popover-open, dialog[open]")) seeTip(id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [show, id]);

  if (!show) return null;
  const vertical = side === "bottom" || side === "top";
  const arrow = vertical
    ? { left: Math.max(14, Math.min(pos?.ax ?? 0, (box.current?.offsetWidth ?? 0) - 14)), [side === "bottom" ? "top" : "bottom"]: -5 }
    : { top: Math.max(14, Math.min(pos?.ay ?? 0, (box.current?.offsetHeight ?? 0) - 14)), [side === "right" ? "left" : "right"]: -5 };
  return (
    <div
      ref={box}
      role="dialog"
      aria-modal="false"
      aria-label={t("안내")}
      className="fixed z-[60] w-[260px] rounded-lg bg-foreground px-3.5 py-3 text-background shadow-lg"
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, visibility: pos ? "visible" : "hidden" }}
    >
      <span className="absolute size-2.5 bg-foreground" style={{ ...arrow, transform: `${vertical ? "translateX(-50%)" : "translateY(-50%)"} rotate(45deg)` }} aria-hidden />
      <p className="m-0 text-[13px] leading-5">{TIPS[id]}</p>
      <div className="mt-2.5 flex items-center justify-end gap-3">
        <button type="button" className="text-xs text-background/70 underline-offset-2 outline-none hover:text-background hover:underline focus-visible:underline" onClick={() => tipsOff()}>
          {TIP_OFF}
        </button>
        <button
          type="button"
          className="h-6 rounded-md bg-background px-2.5 text-xs font-medium text-foreground outline-none hover:bg-background/90 focus-visible:ring-2 focus-visible:ring-background/60"
          onClick={() => seeTip(id)}
        >
          {TIP_OK}
        </button>
      </div>
    </div>
  );
}
