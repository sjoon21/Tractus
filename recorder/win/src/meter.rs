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

/// 1분마다 트랙별 가장 큰 소리를 진단 로그(stderr) 한 줄로 낸다. "통화 상대 목소리가 녹음되지 않았다"는 신고 때
/// 시스템 오디오가 무엇이라도 들었는지 보려는 것이다: 소리 크기만 남고 내용은 남지 않는다 (Yogurt 8833360, #35)
#[derive(Default)]
pub struct LevelLog {
    since: Option<f64>,
    mic: Option<f64>,
    system: Option<f64>,
}

impl LevelLog {
    const EVERY: f64 = 60.0;
    /// 이보다 조용하면 상대 소리가 없었다고 적는다 (Yogurt의 -60..0 dB 눈금 0.05)
    const QUIET: f64 = -57.0;

    /// `t`: 오디오 시각(초). 트랙이 없으면 None. 1분이 차면 로그 줄을 돌려주고 다시 센다
    pub fn feed(&mut self, t: f64, mic: Option<f64>, system: Option<f64>) -> Option<String> {
        let since = *self.since.get_or_insert(t);
        let louder = |a: Option<f64>, b: Option<f64>| match (a, b) {
            (Some(x), Some(y)) => Some(x.max(y)),
            (x, y) => x.or(y),
        };
        self.mic = louder(self.mic, mic);
        self.system = louder(self.system, system);
        if t - since < Self::EVERY {
            return None;
        }
        let db = |v: Option<f64>| v.map_or("없음".to_string(), |x| format!("{x:.1} dBFS"));
        let quiet = if self.system.is_some_and(|x| x < Self::QUIET) { " (상대 소리 없음)" } else { "" };
        let line = format!("지난 {}초 가장 큰 소리: 마이크 {}, 시스템 오디오 {}{quiet}", (t - since).round(), db(self.mic), db(self.system));
        *self = LevelLog { since: Some(t), ..Default::default() };
        Some(line)
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
    fn level_log_once_a_minute_with_loudest_and_quiet_call() {
        let mut l = LevelLog::default();
        assert_eq!(l.feed(0.0, Some(-30.0), Some(-100.0)), None);
        assert_eq!(l.feed(30.0, Some(-12.5), Some(-80.0)), None);
        assert_eq!(l.feed(60.0, Some(-40.0), Some(-90.0)).unwrap(), "지난 60초 가장 큰 소리: 마이크 -12.5 dBFS, 시스템 오디오 -80.0 dBFS (상대 소리 없음)");
        assert_eq!(l.feed(90.0, None, Some(-20.0)), None, "다시 센다");
        assert_eq!(l.feed(120.0, None, Some(-50.0)).unwrap(), "지난 60초 가장 큰 소리: 마이크 없음, 시스템 오디오 -20.0 dBFS");
    }

    #[test]
    fn float_to_pcm16() {
        assert_eq!(to_i16(&[0.0, 1.0, -1.0, 2.0]), vec![0, 32767, -32767, 32767]);
    }
}
