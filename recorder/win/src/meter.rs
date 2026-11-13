//! 소리 크기(250ms 창의 RMS → dBFS)와 시스템 오디오 권한 징후 (Swift `RecorderKit/Meter.swift`와 같다)

pub const FLOOR: f64 = -100.0;

#[derive(Default)]
pub struct LevelMeter {
    sum_squares: f64,
    count: usize,
}

impl LevelMeter {
    pub fn add(&mut self, samples: &[i16]) {
        self.sum_squares += samples.iter().map(|&s| (s as f64) * (s as f64)).sum::<f64>();
        self.count += samples.len();
    }

    /// 모은 값의 dBFS (소수 첫째 자리)를 내고 비운다. 정확히 0이거나 표본이 없으면 FLOOR
    pub fn take(&mut self) -> f64 {
        let (s, n) = (self.sum_squares, self.count);
        self.sum_squares = 0.0;
        self.count = 0;
        if n == 0 || s <= 0.0 {
            return FLOOR;
        }
        let rms = (s / n as f64).sqrt() / 32768.0;
        FLOOR.max((20.0 * rms.log10() * 10.0).round() / 10.0)
    }
}

/// 표본이 정확히 0으로만 threshold개 이어지면 한 번 알린다 (권한이 없는 시스템 오디오의 증상).
/// 0이 아닌 표본이 한 번이라도 오면 그 뒤로는 보지 않는다 (통화 중 무음을 권한 문제로 보지 않게)
pub struct ZeroDetector {
    threshold: usize,
    run: usize,
    fired: bool,
    saw_signal: bool,
}

impl ZeroDetector {
    pub fn new(threshold: usize) -> ZeroDetector {
        ZeroDetector { threshold, run: 0, fired: false, saw_signal: false }
    }

    pub fn feed(&mut self, samples: &[i16]) -> bool {
        if self.saw_signal {
            return false;
        }
        if samples.iter().any(|&s| s != 0) {
            self.saw_signal = true;
            return false;
        }
        self.run += samples.len();
        if self.fired || self.run < self.threshold {
            return false;
        }
        self.fired = true;
        true
    }
}

/// WASAPI의 float(-1..1)을 16-bit로 (넘치면 자른다)
#[cfg_attr(not(windows), allow(dead_code))]
pub fn to_i16(samples: &[f32]) -> Vec<i16> {
    samples.iter().map(|&x| (x.clamp(-1.0, 1.0) * 32767.0).round() as i16).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_in_dbfs() {
        let mut m = LevelMeter::default();
        assert_eq!(m.take(), FLOOR);
        m.add(&[0; 100]);
        assert_eq!(m.take(), FLOOR);
        m.add(&[16384, -16384]);
        assert_eq!(m.take(), -6.0);
    }

    #[test]
    fn zero_detector_fires_once_and_only_before_any_signal() {
        let mut z = ZeroDetector::new(10);
        assert!(!z.feed(&[0; 9]));
        assert!(z.feed(&[0; 1]));
        assert!(!z.feed(&[0; 100]));
        let mut z = ZeroDetector::new(10);
        assert!(!z.feed(&[0, 1]));
        assert!(!z.feed(&[0; 100]));
    }

    #[test]
    fn float_to_pcm16() {
        assert_eq!(to_i16(&[0.0, 1.0, -1.0, 2.0]), vec![0, 32767, -32767, 32767]);
    }
}
