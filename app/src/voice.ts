// 목소리 강조 (docs/roadmap.md §3 6.4): highpass 100 Hz → peaking 3 kHz +4 dB → 압축 → gain.
// wavesurfer.js examples/webaudio.js L19-50 @302fd210 (BSD-3-Clause) 참고.
//
// media:// 오디오도 crossOrigin 없이 Web Audio에서 소리가 난다 (WKWebView, macOS 26.6 실측: 페이지 오리진
// tauri://localhost와 http://localhost 모두 체인 출력 RMS 0.137, 1.5배속 유지). crossOrigin="anonymous"를 붙이면
// CORS 헤더가 없는 media.rs 응답은 재생 자체가 막힌다(NotSupportedError) → 붙이지 않는다.

/** 체인 끝의 음량. 압축으로 커진 소리를 귀로 맞출 때 고친다 */
const VOICE_GAIN = 1;

type Graph = { ctx: AudioContext; src: MediaElementAudioSourceNode; input: AudioNode; master: GainNode };
// MediaElementAudioSourceNode는 요소마다 한 번만 만들 수 있다 (두 번째는 InvalidStateError)
const graphs = new WeakMap<HTMLMediaElement, Graph>();

export const voiceBoostSupported = (): boolean => typeof AudioContext !== "undefined";

function graphFor(el: HTMLMediaElement): Graph {
  const had = graphs.get(el);
  if (had) return had;
  const ctx = new AudioContext();
  const src = ctx.createMediaElementSource(el);
  // 볼륨은 체인 끝(master)에서 정한다: Web Audio를 지나면 요소의 volume이 적용되는지가 엔진마다 달라 요소는 1로 둔다
  const master = new GainNode(ctx, { gain: el.muted ? 0 : el.volume });
  el.volume = 1;
  el.muted = false;
  master.connect(ctx.destination);
  const input = new BiquadFilterNode(ctx, { type: "highpass", frequency: 100 });
  input
    .connect(new BiquadFilterNode(ctx, { type: "peaking", frequency: 3000, Q: 1, gain: 4 }))
    .connect(new DynamicsCompressorNode(ctx, { threshold: -24, knee: 24, ratio: 4, attack: 0.003, release: 0.25 }))
    .connect(new GainNode(ctx, { gain: VOICE_GAIN }))
    .connect(master);
  const g = { ctx, src, input, master };
  graphs.set(el, g);
  return g;
}

/**
 * 켜고 끈다. 한 번 켜면 요소의 소리는 계속 Web Audio를 지난다(끄면 체인을 건너뛰어 바로 출력).
 * 사용자 동작(클릭) 안에서 불러야 AudioContext가 바로 돈다. 실패하면 예외 — 호출한 쪽이 토글을 끈다
 */
export function setVoiceBoost(el: HTMLMediaElement, on: boolean): void {
  const g = graphFor(el);
  g.src.disconnect();
  g.src.connect(on ? g.input : g.master);
  void g.ctx.resume();
}

/** 재생 볼륨 0..1. Web Audio를 지나는 요소(목소리 선명하게를 한 번이라도 켬)는 체인 끝에서, 아니면 요소에서 */
export function setPlaybackVolume(el: HTMLMediaElement, v: number): void {
  const g = graphs.get(el);
  if (g) g.master.gain.value = v;
  else el.volume = v;
}

/** 재생할 때 부른다: 잠자기 등으로 AudioContext가 멈춰 있으면 끈 상태에서도 소리가 나지 않는다 */
export function resumeVoiceBoost(el: HTMLMediaElement): void {
  const g = graphs.get(el);
  if (g?.ctx.state === "suspended") void g.ctx.resume();
}

/** 요소를 버릴 때 (회의 화면을 닫을 때) */
export function releaseVoiceBoost(el: HTMLMediaElement): void {
  const g = graphs.get(el);
  if (!g) return;
  graphs.delete(el);
  void g.ctx.close();
}
