//! Windows loopback은 아무것도 재생되지 않으면 표본을 보내지 않는다. 시스템 트랙에 이 프로그램의 시계로 무음을 채워
//! macOS tap처럼 계속 흐르게 한다 (그래야 끊김 감시가 무음을 끊김으로 보지 않는다).
//! Yogurt(FrigadeHQ/yogurt, MIT, Copyright (c) 2026 Frigade) app/native/yogurt-audio-win/src/gap.rs에서 옮겼다 (NOTICE 12번).

/// 이만큼 소리가 없으면 무음을 넣기 시작한다 (ms)
const AFTER: f64 = 100.0;
/// 그리고 지금보다 이만큼 앞에서 멈춘다: 늦게 온 소리가 겹치지 않게
const MARGIN: f64 = 30.0;

pub struct GapFiller {
    /// 트랙이 닿은 시각 (ms)
    end: f64,
    /// 마지막 구간이 만든 무음이었다
    filled: bool,
}

impl GapFiller {
    pub fn new(start_ms: f64) -> GapFiller {
        GapFiller { end: start_ms, filled: false }
    }

    /// heard_ms에 들린 frames개(48 kHz): 앞의 몇 개가 이미 무음으로 준 시간과 겹치는가
    pub fn packet(&mut self, heard_ms: f64, frames: usize) -> usize {
        let skip = if self.filled { (((self.end - heard_ms) * 48.0).round().max(0.0) as usize).min(frames) } else { 0 };
        self.filled = false;
        self.end = self.end.max(heard_ms + frames as f64 / 48.0);
        skip
    }

    /// 아무것도 오지 않았다: 지금까지 넣어야 할 무음 (시작 시각, 표본 수)
    pub fn idle(&mut self, now_ms: f64) -> Option<(f64, usize)> {
        let upto = now_ms - MARGIN;
        if upto - self.end < AFTER {
            return None;
        }
        let frames = ((upto - self.end) * 48.0) as usize;
        let at = self.end;
        self.end += frames as f64 / 48.0;
        self.filled = true;
        Some((at, frames))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steady_audio_is_left_alone() {
        let mut g = GapFiller::new(0.0);
        for i in 0..100 {
            let jitter = if i % 2 == 0 { 0.4 } else { -0.4 };
            assert_eq!(g.packet(i as f64 * 10.0 + jitter, 480), 0);
            assert_eq!(g.idle(i as f64 * 10.0 + 20.0), None);
        }
    }

    #[test]
    fn quiet_time_becomes_silence_up_to_just_before_now() {
        let mut g = GapFiller::new(0.0);
        assert_eq!(g.idle(50.0), None);
        assert_eq!(g.idle(200.0), Some((0.0, 170 * 48)));
        assert_eq!(g.idle(250.0), None);
        assert_eq!(g.idle(400.0), Some((170.0, 200 * 48)));
    }

    #[test]
    fn audio_after_silence_skips_what_the_silence_covered() {
        let mut g = GapFiller::new(0.0);
        g.idle(1000.0).unwrap();
        assert_eq!(g.packet(960.0, 480), 480);
        assert_eq!(g.packet(970.0, 480), 0);
        let mut g = GapFiller::new(0.0);
        g.idle(1000.0).unwrap();
        assert_eq!(g.packet(985.0, 480), 0);
    }
}
