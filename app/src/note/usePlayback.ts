// 재생 상태: 오디오 요소, 재생 위치·길이, 이동(seekTo), 속도·볼륨·음소거, 무음 건너뛰기, 목소리 선명하게 (MeetingView에서 옮김, 동작 그대로).
// audioPath가 바뀌면(다른 노트) 속도·볼륨·목소리 처리를 새 오디오에 다시 적용한다.
import { useCallback, useEffect, useRef, useState } from "react";
import { errText } from "../api";
import { t } from "../i18n";
import { parseRate } from "../lib";
import { releaseVoiceBoost, setPlaybackVolume, setVoiceBoost, voiceBoostSupported } from "../voice";

const RATE_KEY = "tractus.playbackRate";
const VOLUME_KEY = "tractus.volume";
/** 다음에 열 때도 같은 볼륨 (0..1). 음소거는 기억하지 않는다 */
const readVolume = () => {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY) ?? "1");
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
  } catch {
    return 1;
  }
};
const readRate = () => {
  try {
    return parseRate(localStorage.getItem(RATE_KEY));
  } catch {
    return 1;
  }
};

export function usePlayback(audioPath: string | null | undefined) {
  const audio = useRef<HTMLAudioElement>(null);
  const [pos, setT] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [follow, setFollow] = useState(true);
  const [audioError, setAudioError] = useState<string | null>(null);

  // 모든 이동은 여기를 거친다 (클릭, 단축키, 무음 건너뛰기, 검색 결과)
  const seekTo = useCallback((sec: number, play = true) => {
    const a = audio.current;
    const to = Math.max(0, Math.min(sec, a && Number.isFinite(a.duration) ? a.duration : Infinity));
    setT(to);
    setFollow(true);
    if (!a) return;
    a.currentTime = to;
    if (play) void a.play().catch(() => {});
  }, []);

  // 재생 속도 (5.1). 피치는 유지한다(preservesPitch 기본값). 다음에 열 때도 같은 속도
  const [rate, setRate] = useState(readRate);
  useEffect(() => {
    const a = audio.current;
    if (a) {
      a.defaultPlaybackRate = rate;
      a.playbackRate = rate;
      a.preservesPitch = true;
    }
    try {
      localStorage.setItem(RATE_KEY, String(rate));
    } catch {
      // 저장소를 못 쓰면 이번만 쓴다
    }
  }, [rate, audioPath]);

  // 볼륨: 목소리 선명하게(Web Audio)를 켰어도 같은 값이 되게 voice.setPlaybackVolume으로 정한다
  const [volume, setVolume] = useState(readVolume);
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    if (audio.current) setPlaybackVolume(audio.current, muted ? 0 : volume);
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {
      // 저장소를 못 쓰면 이번만 쓴다
    }
  }, [volume, muted, audioPath]);

  // 무음 건너뛰기 (5.2). 화자 필터와 함께 쓰면 '이 화자만 듣기'
  const [skip, setSkip] = useState(false);
  const [saved, setSaved] = useState(0);

  // 목소리 강조 (6.4). 켤 때 Web Audio 체인을 만든다(사용자 클릭 안에서). 못 만들면 토글을 막고 이유를 보인다
  const [voice, setVoice] = useState(false);
  const [voiceError, setVoiceError] = useState<string | null>(voiceBoostSupported() ? null : t("이 환경에서는 ‘목소리 선명하게’를 쓸 수 없습니다"));
  const toggleVoice = () => {
    const a = audio.current;
    if (!a || voiceError) return;
    try {
      setVoiceBoost(a, !voice);
      setVoice(!voice);
    } catch (e) {
      setVoiceError(t("‘목소리 선명하게’를 켜지 못했습니다: {error}", { error: errText(e) }));
    }
  };
  useEffect(() => {
    const a = audio.current;
    return () => void (a && releaseVoiceBoost(a));
  }, [audioPath]);

  return { audio, pos, setT, duration, setDuration, playing, setPlaying, follow, setFollow, audioError, setAudioError, seekTo, rate, setRate, volume, setVolume, muted, setMuted, skip, setSkip, saved, setSaved, voice, voiceError, toggleVoice };
}

export type Playback = ReturnType<typeof usePlayback>;
