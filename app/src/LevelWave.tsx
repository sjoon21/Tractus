// 녹음 화면의 소리 크기 파형 (v3.108): 가는 막대가 오른쪽에서 왼쪽으로 쉬지 않고 흐르고, 오래된 쪽은 흐려진다.
// 모양은 음성 메모·ElevenLabs UI Live Waveform(MIT)을 따르되, 브라우저 마이크가 아니라 tractus-rec의 level 이벤트(0.25초마다 dB)로 그린다.
// 값이 4Hz라 그대로 그리면 뚝뚝 끊긴다: 화면 시각을 한 간격(DELAY) 늦춰 언제나 두 값 사이를 부드럽게 이어 그리고, canvas에 매 프레임 그린다.
import { useEffect, useRef } from "react";
import { cn } from "@/components/ui/utils";
import { t } from "./i18n";
import { levelFraction } from "./lib";

/** 초당 막대 수, 막대 굵기·간격 (CSS px) */
const BARS_PER_SEC = 14;
const BAR = 2;
const PITCH = 5;
/** 값 사이를 이어 그리려고 화면을 늦추는 시간 (level 간격 0.25초 + 여유) */
const DELAY = 0.3;
/** 조용할 때도 보이는 높이 (비율) */
const FLOOR = 0.05;
/** 오래 쌓지 않는다 (화면 폭을 넘는 값은 버린다) */
const KEEP_SEC = 30;

export type Sample = { at: number; v: number };

/** dB → 막대 높이 비율. 말소리(-30~-14 dB)와 쉼(-50 dB)의 차이가 잘 보이게 곡선을 준다 */
export const levelHeight = (db: number | null): number => Math.max(FLOOR, levelFraction(db) ** 1.6);

/** 시각 at의 높이: 앞뒤 값 사이를 부드럽게(smoothstep) 잇는다. 첫 값 전은 FLOOR, 마지막 값 뒤는 마지막 값 */
export function waveValue(samples: readonly Sample[], at: number): number {
  if (!samples.length || at < samples[0].at) return FLOOR;
  for (let i = samples.length - 1; i >= 0; i--) {
    const a = samples[i];
    if (a.at > at) continue;
    const b = samples[i + 1];
    if (!b) return a.v;
    const x = (at - a.at) / (b.at - a.at);
    const s = x * x * (3 - 2 * x);
    return a.v + (b.v - a.v) * s;
  }
  return FLOOR;
}

/** live: 시계가 흐르는 중(녹음 중). 일시정지·시작 전에는 파형이 멈춘다. tick이 바뀌면 새 level 이벤트다 */
export function LevelWave({ label, db, tick, present, live, tone = "mic" }: { label: string; db: number | null; tick: number; present: boolean; live: boolean; tone?: "mic" | "system" }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const samples = useRef<Sample[]>([]);
  const clock = useRef(0); // 녹음이 흐른 시간만 센다 (일시정지 중에는 멈춘다)
  const liveRef = useRef(live);
  liveRef.current = live;

  useEffect(() => {
    if (!present) return;
    const s = samples.current;
    s.push({ at: clock.current, v: levelHeight(db) });
    while (s.length > 2 && s[1].at < clock.current - KEEP_SEC) s.shift();
    // tick이 새 이벤트를 알린다 (같은 db가 연달아 와도 쌓는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let raf = 0;
    let last = performance.now();
    let color = "";
    let frame = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (liveRef.current) clock.current += Math.min(0.1, (now - last) / 1000); // 창이 숨었다 돌아와도 크게 튀지 않게
      last = now;
      const dpr = window.devicePixelRatio || 1;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (el.width !== Math.round(w * dpr) || el.height !== Math.round(h * dpr)) {
        el.width = Math.round(w * dpr);
        el.height = Math.round(h * dpr);
      }
      if (frame++ % 30 === 0) color = getComputedStyle(el).color; // 테마가 바뀌면 따라간다
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = color;
      const shown = clock.current - DELAY;
      const speed = BARS_PER_SEC * PITCH; // px/초
      // 막대는 절대 시각의 칸에 붙어 있어 화면이 흐르면 함께 흐른다
      const newest = Math.floor(shown * BARS_PER_SEC);
      for (let k = newest; ; k--) {
        const at = k / BARS_PER_SEC;
        const x = w - (shown - at) * speed - BAR;
        if (x < -BAR) break;
        const bh = Math.max(BAR, waveValue(samples.current, at) * h);
        ctx.beginPath();
        ctx.roundRect(x, (h - bh) / 2, BAR, bh, BAR / 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  const now = present ? (db === null ? "—" : `${Math.round(db)} dB`) : t("꺼짐");
  return (
    <div className={cn("flex flex-col gap-1", !present && "opacity-50")}>
      <span className="text-xs text-muted-foreground">
        {label}
        {!present && <span className="ml-1.5 text-subtle-foreground">{t("꺼짐")}</span>}
      </span>
      <div role="meter" aria-label={label} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={db ?? -60} title={now}>
        <canvas
          ref={canvas}
          className={cn("block h-10 w-full [mask-image:linear-gradient(to_right,transparent,black_35%)]", tone === "mic" ? "text-foreground/80" : "text-muted-foreground/60")}
          aria-hidden
        />
      </div>
    </div>
  );
}
