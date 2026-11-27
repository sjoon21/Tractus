//! 출력 장치 여럿(기본 출력 + 기본 통신 장치, 둘이 다를 때)의 시스템 소리: 어느 장치를 녹음할지, 들린 시각대로 한 트랙으로 섞기.
//! 운영체제와 상관없어 Mac에서도 `cargo test`가 돈다. 쓰는 곳은 Windows `win.rs` `start_system`뿐이다.
//! Yogurt(FrigadeHQ/yogurt, MIT, Copyright (c) 2026 Frigade) app/native/yogurt-audio-win/src/mix.rs
//! (커밋 1b016b09a69407cbe32c02e2361c9e46f1156b09, #167)에서 그대로 옮겼다 (NOTICE 12번).

/// The outputs to record from: the default output, and the communication device when it is a different one
/// (Teams plays calls there). The same device twice is recorded once, so nothing is doubled.
pub fn outputs(console: Option<String>, comms: Option<String>) -> Vec<String> {
    let mut v: Vec<String> = Vec::new();
    for id in [console, comms].into_iter().flatten() {
        if !v.contains(&id) {
            v.push(id);
        }
    }
    v
}

/// A pause longer than this inside one output's audio is kept as silence (Track does the same)
const GAP_FRAMES: i64 = 250 * 48;
/// An output this far behind the others (a stalled stream) stops holding the mix back; it counts as silence
const LAG_FRAMES: i64 = 1000 * 48;

#[derive(Default)]
struct Lane {
    /// 48 kHz frame (meeting time) of buf[0]
    start: i64,
    buf: Vec<f32>,
    started: bool,
}

impl Lane {
    fn end(&self) -> i64 {
        self.start + self.buf.len() as i64
    }
}

/// Mixes several 48 kHz mono streams. Each stream is placed by the time its audio was heard and then runs on
/// sample by sample (device clocks jitter); the mix goes out as far as every stream has reached.
pub struct Mix {
    lanes: Vec<Lane>,
    /// the frame the mix has gone out to
    out: Option<i64>,
}

impl Mix {
    pub fn new(n: usize) -> Mix {
        Mix { lanes: (0..n).map(|_| Lane::default()).collect(), out: None }
    }

    /// Audio from output `lane`, heard at heard_ms. Returns mixed audio that is ready, and the meeting time it starts at.
    pub fn push(&mut self, lane: usize, samples: &[f32], heard_ms: f64) -> Option<(Vec<f32>, f64)> {
        let at = (heard_ms * 48.0).round() as i64;
        let out = *self.out.get_or_insert(at);
        let l = self.lanes.get_mut(lane)?;
        if !l.started {
            l.started = true;
            l.start = at.max(out);
            let skip = (out - at).clamp(0, samples.len() as i64) as usize;
            l.buf.extend_from_slice(&samples[skip..]);
        } else {
            if at - l.end() > GAP_FRAMES {
                l.buf.resize((at - l.start) as usize, 0.0);
            }
            l.buf.extend_from_slice(samples);
        }
        self.take()
    }

    fn take(&mut self) -> Option<(Vec<f32>, f64)> {
        let out = self.out?;
        let ends: Vec<i64> = self.lanes.iter().map(|l| if l.started { l.end() } else { out }).collect();
        let most = *ends.iter().max()?;
        let least = *ends.iter().min()?;
        let upto = least.max(most - LAG_FRAMES);
        if upto <= out {
            return None;
        }
        let n = (upto - out) as usize;
        let mut mixed = vec![0f32; n];
        for l in &mut self.lanes {
            if !l.started {
                continue;
            }
            // what this output has before upto, from out on (a lagging one is short: silence)
            let from = (out - l.start).max(0) as usize;
            let offset = (l.start - out).max(0) as usize;
            let avail = l.buf.len().saturating_sub(from);
            for i in 0..avail.min(n.saturating_sub(offset)) {
                mixed[offset + i] += l.buf[from + i];
            }
            // drop what went out
            let used = (upto - l.start).clamp(0, l.buf.len() as i64) as usize;
            l.buf.drain(..used);
            l.start += used as i64;
            // a stalled output was left behind: placed again by its time when it comes back
            if l.start < upto {
                *l = Lane::default();
            }
        }
        for x in &mut mixed {
            *x = x.clamp(-1.0, 1.0);
        }
        self.out = Some(upto);
        Some((mixed, out as f64 / 48.0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_communication_device_is_recorded_when_it_differs() {
        assert_eq!(outputs(Some("speakers".into()), Some("headset".into())), vec!["speakers", "headset"]);
        // one device for both: recorded once
        assert_eq!(outputs(Some("headset".into()), Some("headset".into())), vec!["headset"]);
        assert_eq!(outputs(None, Some("headset".into())), vec!["headset"]);
        assert_eq!(outputs(Some("speakers".into()), None), vec!["speakers"]);
        assert!(outputs(None, None).is_empty());
    }

    #[test]
    fn two_outputs_are_added_together_on_meeting_time() {
        let mut m = Mix::new(2);
        // speakers first: nothing goes out until the headset reaches the same time
        assert_eq!(m.push(0, &[0.1; 480], 0.0), None);
        let (s, at) = m.push(1, &[0.2; 480], 0.0).unwrap();
        assert_eq!(at, 0.0);
        assert_eq!(s.len(), 480);
        assert!(s.iter().all(|x| (x - 0.3).abs() < 1e-6));
        // the next 10 ms
        assert_eq!(m.push(1, &[0.5; 480], 10.0), None);
        let (s, at) = m.push(0, &[0.0; 480], 10.0).unwrap();
        assert_eq!(at, 10.0);
        assert!(s.iter().all(|x| (x - 0.5).abs() < 1e-6));
    }

    #[test]
    fn the_call_on_one_output_comes_through_whole() {
        // the headset carries the call, the speakers stay silent (as the gap filler sends it)
        let mut m = Mix::new(2);
        let mut got = Vec::new();
        for i in 0..100 {
            let t = i as f64 * 10.0;
            got.extend(m.push(0, &[0.0; 480], t).map(|x| x.0).unwrap_or_default());
            let tone: Vec<f32> = (0..480).map(|k| ((i * 480 + k) as f32 * 0.01).sin() * 0.5).collect();
            got.extend(m.push(1, &tone, t).map(|x| x.0).unwrap_or_default());
        }
        assert_eq!(got.len(), 48_000);
        let want: Vec<f32> = (0..48_000).map(|k| (k as f32 * 0.01).sin() * 0.5).collect();
        assert!(got.iter().zip(&want).all(|(a, b)| (a - b).abs() < 1e-6));
    }

    #[test]
    fn a_late_starting_output_joins_at_its_time() {
        let mut m = Mix::new(2);
        assert_eq!(m.push(0, &[0.1; 480], 0.0), None);
        // the headset starts 5 ms in: the first 5 ms are speakers only
        let (s, at) = m.push(1, &[0.2; 480], 5.0).unwrap();
        assert_eq!(at, 0.0);
        assert_eq!(s.len(), 480);
        assert!(s[..240].iter().all(|x| (x - 0.1).abs() < 1e-6));
        assert!(s[240..].iter().all(|x| (x - 0.3).abs() < 1e-6));
        // and audio from before the mix began is dropped
        let mut m = Mix::new(2);
        m.push(0, &[0.1; 480], 100.0);
        let (s, at) = m.push(1, &[0.2; 960], 90.0).unwrap();
        assert_eq!((at, s.len()), (100.0, 480));
        assert!(s.iter().all(|x| (x - 0.3).abs() < 1e-6));
    }

    #[test]
    fn a_stalled_output_does_not_hold_the_call_back() {
        let mut m = Mix::new(2);
        let mut total = 0;
        m.push(1, &[0.0; 480], 0.0);
        // the headset sends 2 s, the speakers nothing more
        for i in 0..200 {
            if let Some((s, _)) = m.push(0, &[0.4; 480], i as f64 * 10.0) {
                assert!(s.iter().all(|x| x.abs() <= 0.4 + 1e-6));
                total += s.len();
            }
        }
        // everything but the last second is out
        assert_eq!(total, 48_000);
        // the stalled one coming back late is not mixed into time already sent
        let (s, at) = m.push(1, &[0.2; 480], 1500.0).unwrap_or((vec![], 0.0));
        assert!(s.is_empty() || at >= 1000.0);
    }

    #[test]
    fn a_pause_inside_one_output_stays_silence() {
        let mut m = Mix::new(1);
        m.push(0, &[0.1; 480], 0.0).unwrap();
        // nothing for 500 ms: silence, then the audio at its time
        let (s, at) = m.push(0, &[0.2; 480], 510.0).unwrap();
        assert_eq!(at, 10.0);
        assert_eq!(s.len(), 500 * 48 + 480);
        assert!(s[..500 * 48].iter().all(|&x| x == 0.0));
        assert!(s[500 * 48..].iter().all(|x| (x - 0.2).abs() < 1e-6));
    }

    #[test]
    fn loud_sound_on_both_stays_in_range() {
        let mut m = Mix::new(2);
        m.push(0, &[0.9; 48], 0.0);
        let (s, _) = m.push(1, &[0.9; 48], 0.0).unwrap();
        assert!(s.iter().all(|&x| x == 1.0));
    }
}
