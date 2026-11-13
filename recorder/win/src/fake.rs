//! `--fake`: 장치 대신 만든 신호 (마이크 440 Hz, 시스템 660 Hz + 2초마다 0.5초 무음). Swift `FakeSource`와 같다.
//! 권한·장치 없이 앱·테스트를 돌리는 개발용이다. 벽시계 기준이라 타이머가 밀려도 길이가 맞는다.
use crate::wav::SAMPLE_RATE;

pub struct FakeSource {
    frequency: f64,
    gaps: bool,
    index: usize,
}

impl FakeSource {
    pub fn new(frequency: f64, gaps: bool) -> FakeSource {
        FakeSource { frequency, gaps, index: 0 }
    }

    /// 시작 뒤 `elapsed`초까지의 표본
    pub fn generate(&mut self, elapsed: f64) -> Vec<i16> {
        let target = (elapsed * SAMPLE_RATE as f64) as usize;
        if target <= self.index {
            return Vec::new();
        }
        let rate = SAMPLE_RATE as f64;
        let out = (self.index..target)
            .map(|i| {
                let t = i as f64 / rate;
                if self.gaps && (1.0..1.5).contains(&(t % 2.0)) {
                    0
                } else {
                    (0.3 * 32767.0 * (2.0 * std::f64::consts::PI * self.frequency * t).sin()) as i16
                }
            })
            .collect();
        self.index = target;
        out
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn generates_up_to_the_clock_with_gaps_on_system() {
        let mut s = super::FakeSource::new(660.0, true);
        assert_eq!(s.generate(0.5).len(), 24_000);
        assert!(s.generate(0.5).is_empty());
        let next = s.generate(1.25); // 1.0~1.25초는 무음
        assert!(next[24_000..].iter().all(|&x| x == 0));
    }
}
