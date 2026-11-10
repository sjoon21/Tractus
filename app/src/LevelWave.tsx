// 녹음 화면의 소리 크기 파형: 최근 HISTORY개 레벨(녹음 프로그램이 0.25초마다 보내는 dB)을 막대로 그리고 왼쪽으로 흘려보낸다(v3.108).
// 모양은 ElevenLabs UI Live Waveform(MIT)·음성 메모를 따르되, 브라우저 마이크가 아니라 tractus-rec의 level 이벤트로 그린다.
import { useEffect, useState } from "react";
import { cn } from "@/components/ui/utils";
import { t } from "./i18n";
import { levelFraction } from "./lib";

/** 약 15초 (0.25초 × 60) */
export const HISTORY = 60;
/** 조용할 때도 보이는 막대 높이 (비율) */
const FLOOR = 0.08;

/** 새 레벨을 끝에 붙이고 앞을 잘라 길이를 n으로 둔다 */
export function pushLevel(hist: readonly number[], db: number | null, n = HISTORY): number[] {
  return [...hist, levelFraction(db)].slice(-n);
}

/** tick이 바뀔 때(새 level 이벤트)마다 db를 쌓는다. 일시정지 중에는 이벤트가 없어 멈춘다 */
export function LevelWave({ label, db, tick, present, tone = "mic" }: { label: string; db: number | null; tick: number; present: boolean; tone?: "mic" | "system" }) {
  const [hist, setHist] = useState<number[]>(() => Array(HISTORY).fill(0));
  useEffect(() => {
    if (present) setHist((h) => pushLevel(h, db));
    // tick이 새 이벤트를 알린다 (같은 db가 연달아 와도 쌓는다)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);
  const now = present ? (db === null ? "—" : `${Math.round(db)} dB`) : t("꺼짐");
  return (
    <div className={cn("flex flex-col gap-1", !present && "opacity-50")}>
      <span className="text-xs text-muted-foreground">
        {label}
        {!present && <span className="ml-1.5 text-subtle-foreground">{t("꺼짐")}</span>}
      </span>
      <div className="h-9 overflow-hidden" role="meter" aria-label={label} aria-valuemin={-60} aria-valuemax={0} aria-valuenow={db ?? -60} title={now}>
        {/* 새 막대가 올 때마다 한 칸 오른쪽에서 밀려 들어온다 (key로 애니메이션을 다시 시작) */}
        <div key={tick} className={cn("flex h-full items-center gap-[2px]", present && "animate-in slide-in-from-right-[1.667%] duration-250 ease-linear motion-reduce:animate-none")}>
        {hist.map((f, i) => (
          <span
            key={i}
            className={cn(
              "min-w-px flex-1 rounded-full",
              tone === "mic" ? "bg-foreground/55" : "bg-muted-foreground/40",
              i === hist.length - 1 && present && "bg-rec",
            )}
            style={{ height: `${Math.max(FLOOR, f) * 100}%` }}
          />
        ))}
        </div>
      </div>
    </div>
  );
}
