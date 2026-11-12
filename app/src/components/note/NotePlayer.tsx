// 오디오 플레이어 막대 (MeetingView에서 옮김, 동작 그대로): 재생·위치·속도·볼륨·무음 건너뛰기·목소리 선명하게와 저장 상태 줄.
// 재생 상태는 usePlayback이 들고 있고 여기서는 그리기만 한다.
import { convertFileSrc } from "@tauri-apps/api/core";
import { AudioLines, FastForward, LocateFixed, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { selectClass } from "@/components/ui/select";
import { cn } from "@/components/ui/utils";
import { t } from "../../i18n";
import { fmtTime, RATES, silenceSkip, type Memo, type Segment } from "../../lib";
import type { Playback } from "../../note/usePlayback";
import { resumeVoiceBoost } from "../../voice";
import { TOGGLE } from "./styles";

export function NotePlayer({
  pb,
  audioPath,
  marks,
  visible,
  filter,
  editing,
  editError,
}: {
  pb: Playback;
  audioPath: string | null | undefined;
  /** 녹음 중 남긴 메모·북마크: 재생 위치 막대에 점으로 보인다 */
  marks: Memo[];
  /** 화면에 보이는 대화 (화자 필터 적용): 무음 건너뛰기의 대상 */
  visible: Segment[];
  filter: string | null;
  /** 대화 내용을 저장하는 중 */
  editing: boolean;
  editError: string | null;
}) {
  const { audio, pos, setT, duration, setDuration, playing, setPlaying, follow, setFollow, audioError, setAudioError, seekTo, rate, setRate, volume, setVolume, muted, setMuted, skip, setSkip, saved, setSaved, voice, voiceError, toggleVoice } = pb;
  return (
    <div className="player flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border bg-background/90 px-6 py-2.5 backdrop-blur-md" role="group" aria-label={t("오디오 플레이어")}>
      {audioPath ? (
        <audio
          ref={audio}
          src={convertFileSrc(audioPath, "media")}
          preload="metadata"
          onTimeUpdate={(e) => {
            const a = e.currentTarget;
            setT(a.currentTime);
            if (pb.stopAt.current !== null && a.currentTime >= pb.stopAt.current) {
              pb.stopAt.current = null;
              a.pause();
            }
            const to = skip && !a.paused ? silenceSkip(visible, a.currentTime) : null;
            if (to !== null) {
              setSaved((s) => s + (to - a.currentTime));
              seekTo(to, false);
            }
          }}
          onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
          onPlay={(e) => {
            setPlaying(true);
            resumeVoiceBoost(e.currentTarget);
          }}
          onPause={() => setPlaying(false)}
          onError={() => setAudioError(t("오디오를 재생할 수 없습니다"))}
        />
      ) : null}
      <button
        className="play-button grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground shadow-xs outline-none transition-transform hover:scale-105 focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:opacity-40 disabled:hover:scale-100 [&_svg]:size-3.5 [&_svg]:fill-current"
        onClick={() => (audio.current?.paused ? void audio.current.play().catch(() => {}) : audio.current?.pause())}
        disabled={!audioPath || !!audioError}
        aria-label={playing ? t("일시정지") : t("재생")}
      >
        {playing ? <Pause aria-hidden /> : <Play aria-hidden className="translate-x-px" />}
      </button>
      <time className="shrink-0 text-xs font-medium tabular-nums">
        {fmtTime(pos)} <span className="font-normal text-subtle-foreground">/ {fmtTime(duration)}</span>
      </time>
      <div className="scrub" hidden={!audioPath}>
        <input
          type="range"
          min={0}
          max={duration || 1}
          step={0.1}
          value={Math.min(pos, duration || 1)}
          onChange={(e) => seekTo(Number(e.target.value), playing)}
          aria-label={t("재생 위치")}
          style={{ "--p": `${duration ? (pos / duration) * 100 : 0}%` } as React.CSSProperties}
        />
        {marks.map((m, i) => (
          <span key={i} className={`scrub-mark is-${m.kind}`} style={{ left: `${duration ? (m.t / duration) * 100 : 0}%` }} aria-hidden />
        ))}
      </div>
      {audioPath && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            className={TOGGLE}
            aria-pressed={skip}
            onClick={() => setSkip((v) => !v)}
            title={filter ? t("이 참석자의 말만 듣습니다 (다른 참석자의 말과 1초 넘는 침묵을 건너뜀)") : t("침묵 구간 건너뛰기: 말 사이 1초 넘는 침묵을 건너뜁니다. 참석자를 고르면 그 참석자만 듣습니다")}
            aria-label={filter ? t("이 참석자만 듣기") : t("침묵 구간 건너뛰기")}
          >
            <FastForward aria-hidden />
            {filter ? t("이 참석자만 듣기") : t("침묵 건너뛰기")}
            {skip && saved >= 1 && <span className="font-normal tabular-nums opacity-70">−{fmtTime(saved)}</span>}
          </button>
          <button
            className={TOGGLE}
            aria-pressed={voice}
            aria-disabled={!!voiceError}
            onClick={toggleVoice}
            title={voiceError ?? t("말소리를 또렷하게 하고 낮은 웅웅거림을 줄입니다. 큰 소리와 작은 소리의 차이도 줄입니다")}
          >
            <AudioLines aria-hidden />
            {t("목소리 선명하게")}
          </button>
          <select className={cn(selectClass, "h-7 w-[4.25rem] border-transparent bg-transparent pr-6 pl-2 text-xs font-medium tabular-nums shadow-none hover:bg-accent")} value={rate} onChange={(e) => setRate(Number(e.target.value))} aria-label={t("재생 속도 (Shift+, 느리게 · Shift+. 빠르게)")} title={t("재생 속도 (Shift+, / Shift+.)")}>
            {RATES.map((r) => (
              <option key={r} value={r}>
                {r}×
              </option>
            ))}
          </select>
          <button className={TOGGLE} aria-pressed={muted} onClick={() => setMuted((m) => !m)} aria-label={muted ? t("소리 켜기") : t("음소거")} title={muted ? t("소리 켜기") : t("음소거")}>
            {muted || volume === 0 ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
          </button>
          <input
            type="range"
            className="h-1 w-16 accent-foreground"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              setVolume(Number(e.target.value));
              setMuted(false);
            }}
            aria-label={t("볼륨")}
            title={t("볼륨")}
          />
        </div>
      )}
      {!follow && playing && (
        <Button variant="outline" size="sm" className="h-7" onClick={() => setFollow(true)}>
          <LocateFixed aria-hidden />
          {t("현재 위치로")}
        </Button>
      )}
      {(audioError || !audioPath) && <span className="text-xs text-subtle-foreground">{audioError ?? t("오디오 파일이 없습니다")}</span>}
      <span className={cn("text-xs empty:hidden", editError ? "text-destructive" : "text-muted-foreground")} role="status">
        {editing ? t("저장하는 중…") : editError}
      </span>
    </div>
  );
}
