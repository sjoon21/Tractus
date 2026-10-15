// 깜빡이는 점 격자 배경 (Magic UI FlickeringGrid의 동작을 옮긴 것, 의존성 없음).
// 색은 CSS 변수에서 읽어 테마가 바뀌면 따라가고, 화면 밖이거나 '동작 줄이기'면 그리기만 하고 움직이지 않는다
import { useEffect, useRef } from "react";
import { cn } from "./utils";

type Props = {
  className?: string;
  /** 점 한 변(px) */
  squareSize?: number;
  /** 점 사이(px) */
  gridGap?: number;
  /** 초당 한 점이 바뀔 확률 */
  flickerChance?: number;
  /** 점 색을 읽을 CSS 변수 */
  colorVar?: string;
  maxOpacity?: number;
};

export function FlickeringGrid({ className, squareSize = 3, gridGap = 6, flickerChance = 0.25, colorVar = "--foreground", maxOpacity = 0.18 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = box.current;
    const cv = canvas.current;
    const ctx = cv?.getContext("2d");
    if (!wrap || !cv || !ctx) return;

    const still = window.matchMedia("(prefers-reduced-motion: reduce)");
    const readColor = () => getComputedStyle(document.documentElement).getPropertyValue(colorVar).trim() || "#888";
    let color = readColor();
    let cols = 0;
    let rows = 0;
    let dpr = 1;
    let alpha = new Float32Array(0);

    const layout = () => {
      dpr = window.devicePixelRatio || 1;
      const { width, height } = wrap.getBoundingClientRect();
      cv.width = Math.round(width * dpr);
      cv.height = Math.round(height * dpr);
      cv.style.width = `${width}px`;
      cv.style.height = `${height}px`;
      cols = Math.ceil(width / (squareSize + gridGap));
      rows = Math.ceil(height / (squareSize + gridGap));
      alpha = Float32Array.from({ length: cols * rows }, () => Math.random() * maxOpacity);
    };

    const draw = () => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.fillStyle = color;
      const step = (squareSize + gridGap) * dpr;
      const size = squareSize * dpr;
      for (let x = 0; x < cols; x++) {
        for (let y = 0; y < rows; y++) {
          ctx.globalAlpha = alpha[x * rows + y];
          ctx.fillRect(x * step, y * step, size, size);
        }
      }
      ctx.globalAlpha = 1;
    };

    let raf = 0;
    let last = 0;
    let visible = false;
    const tick = (now: number) => {
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      const p = flickerChance * dt;
      for (let i = 0; i < alpha.length; i++) if (Math.random() < p) alpha[i] = Math.random() * maxOpacity;
      draw();
      raf = requestAnimationFrame(tick);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      last = 0;
      if (visible && !still.matches) raf = requestAnimationFrame(tick);
      else draw();
    };

    layout();
    draw();
    const resize = new ResizeObserver(() => {
      layout();
      draw();
    });
    resize.observe(wrap);
    const seen = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      run();
    });
    seen.observe(cv);
    // 테마(themePref.ts의 data-theme)가 바뀌면 색을 다시 읽는다
    const theme = new MutationObserver(() => {
      color = readColor();
      draw();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    still.addEventListener("change", run);

    return () => {
      cancelAnimationFrame(raf);
      resize.disconnect();
      seen.disconnect();
      theme.disconnect();
      still.removeEventListener("change", run);
    };
  }, [squareSize, gridGap, flickerChance, colorVar, maxOpacity]);

  return (
    <div ref={box} className={cn("pointer-events-none", className)} aria-hidden>
      <canvas ref={canvas} className="block" />
    </div>
  );
}
