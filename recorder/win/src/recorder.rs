//! 녹음 한 번의 상태 (Swift `tractus-rec/Recorder.swift`와 같은 규칙). 모든 상태 변경은 `run`의 한 스레드에서만 한다:
//! 오디오 스레드·stdin·타이머는 `Msg`를 채널로 보낸다. 운영체제와 상관없고, 실제 장치는 `Opener`가 연다 (Windows: win.rs).
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::fake::FakeSource;
use crate::meter::{LevelLog, LevelMeter, ZeroDetector};
use crate::protocol::{emit, fatal, iso_local, log, round2, warning, Command, Mark, Pause, RecordingInfo};
use crate::wav::{WavWriter, SAMPLE_RATE};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Track {
    Mic,
    System,
}

impl Track {
    pub fn name(self) -> &'static str {
        match self {
            Track::Mic => "mic",
            Track::System => "system",
        }
    }
    fn label(self) -> &'static str {
        match self {
            Track::Mic => "마이크",
            Track::System => "시스템 오디오",
        }
    }
}

#[cfg_attr(not(windows), allow(dead_code))] // 실제 장치(Windows)만 보낸다
pub enum Msg {
    Samples(Track, Vec<i16>),
    Cmd(String),
    Eof,
    /// 20ms마다: 가짜 신호를 만들고, 250ms마다 소리 크기를 낸다
    Tick,
    /// 장치가 끊겼거나 기본 장치가 바뀌었다: 알림이 멎고 `SETTLE` 뒤에 한 번 다시 연다
    Restart(Track, &'static str),
}

/// 실제 장치 하나. 멈추면 표본을 그만 보낸다
pub trait Source {
    fn stop(&mut self);
}

#[derive(Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
pub enum OpenError {
    /// 개인정보 설정에서 마이크가 꺼져 있다
    Denied,
    Failed(String),
}

/// 트랙의 장치를 연다. 표본은 `Msg::Samples`로 보낸다
pub type Opener = Box<dyn FnMut(Track, Sender<Msg>) -> Result<Box<dyn Source>, OpenError>>;

/// 표본이 이만큼 안 오면 끊긴 것으로 보고 다시 연다
const STALL: f64 = 2.0;
/// 장치 바뀜 알림은 몰려 온다(역할마다 하나, 블루투스 핸즈프리 전환). 마지막 알림 뒤 이만큼 조용하면 한 번만 다시 연다 (Yogurt record.rs SETTLE, #152)
const SETTLE: Duration = Duration::from_millis(300);

pub struct Recorder {
    dir: PathBuf,
    tx: Sender<Msg>,
    opener: Option<Opener>,
    t0: Instant,
    paused_since: Option<Instant>,
    paused_total: Duration,
    pause_wall_start: chrono::DateTime<chrono::Local>,
    pause_at: f64,
    info: Option<RecordingInfo>,
    writers: HashMap<Track, WavWriter>,
    meters: HashMap<Track, LevelMeter>,
    zero: ZeroDetector,
    /// Windows에는 시스템 오디오 권한이 없어 0만 오는 것은 권한 징후가 아니다 (아무것도 재생하지 않을 뿐)
    watch_zero: bool,
    fakes: HashMap<Track, FakeSource>,
    sources: HashMap<Track, Box<dyn Source>>,
    last_sample_at: HashMap<Track, f64>,
    realign: HashSet<Track>,
    failing: HashSet<Track>,
    /// 다시 열 트랙과 그 시각 (`SETTLE`로 묶은 알림)
    settling: HashMap<Track, (Instant, &'static str)>,
    last_level: Instant,
    level_log: LevelLog,
    stopping: bool,
}

impl Recorder {
    /// opener가 None이면 `--fake`
    pub fn new(dir: PathBuf, tx: Sender<Msg>, opener: Option<Opener>) -> Recorder {
        Recorder {
            dir,
            tx,
            opener,
            t0: Instant::now(),
            paused_since: None,
            paused_total: Duration::ZERO,
            pause_wall_start: chrono::Local::now(),
            pause_at: 0.0,
            info: None,
            writers: HashMap::new(),
            meters: HashMap::new(),
            zero: ZeroDetector::new(5 * SAMPLE_RATE),
            watch_zero: !cfg!(windows),
            fakes: HashMap::new(),
            sources: HashMap::new(),
            last_sample_at: HashMap::new(),
            realign: HashSet::new(),
            failing: HashSet::new(),
            settling: HashMap::new(),
            last_level: Instant::now(),
            level_log: LevelLog::default(),
            stopping: false,
        }
    }

    /// 오디오 시계 (초). 일시정지 시간을 뺀다
    fn elapsed(&self) -> f64 {
        (self.paused_since.unwrap_or_else(Instant::now) - self.t0 - self.paused_total).as_secs_f64()
    }

    /// 실패한 트랙은 경고 후 빼고, 남은 트랙이 없으면 종료 코드 1
    pub fn start(&mut self, requested: &[Track], echo_cancel: bool) {
        if let Err(e) = std::fs::create_dir_all(&self.dir) {
            fatal(&format!("폴더를 만들지 못했습니다: {e}"));
        }
        for name in requested.iter().map(|t| format!("{}.wav", t.name())).chain(["recording.json".to_string()]) {
            let p = self.dir.join(&name);
            if p.exists() {
                fatal(&format!("이미 녹음 파일이 있습니다: {}", p.display()));
            }
        }
        let started_at = chrono::Local::now();
        self.t0 = Instant::now();
        let mut active = Vec::new();
        let mut failed = Vec::new();
        for &track in requested {
            let path = self.dir.join(format!("{}.wav", track.name()));
            let writer = match WavWriter::create(&path) {
                Ok(w) => w,
                Err(e) => {
                    warning(&format!("{}_failed", track.name()), &format!("{} 녹음을 시작하지 못했습니다: {e}", track.label()));
                    continue;
                }
            };
            match self.open(track) {
                Ok(()) => {
                    self.writers.insert(track, writer);
                    self.meters.insert(track, LevelMeter::default());
                    active.push(track);
                }
                Err(e) => failed.push((track, writer, e)),
            }
        }
        for (track, writer, e) in failed {
            match e {
                // 화상회의 앱이 마이크를 잡는 중이면 시작에 실패할 수 있다. 다른 트랙이 돌면 마이크를 빼지 않고 감시가 2초마다 다시 연다
                // (열리면 첫 버퍼 앞을 0으로 메운다). 시스템 오디오 실패·권한 거절은 다시 열어도 나아지지 않아 뺀다. Swift판과 같다
                OpenError::Failed(m) if track == Track::Mic && !active.is_empty() => {
                    self.writers.insert(track, writer);
                    self.meters.insert(track, LevelMeter::default());
                    self.sources.insert(track, Box::new(Closed));
                    let now = self.elapsed();
                    self.last_sample_at.insert(track, now);
                    self.failing.insert(track); // restart가 같은 경고를 또 내지 않게
                    active.insert(0, track); // 요청 순서(마이크가 먼저) 그대로
                    warning("mic_failed", &format!("마이크 녹음을 시작하지 못했습니다. 계속 다시 연결을 시도합니다: {m}"));
                }
                e => {
                    drop(writer);
                    let _ = std::fs::remove_file(self.dir.join(format!("{}.wav", track.name())));
                    match e {
                        OpenError::Denied => warning("mic_denied", "마이크 권한이 없습니다"),
                        OpenError::Failed(m) => warning(&format!("{}_failed", track.name()), &format!("{} 녹음을 시작하지 못했습니다: {m}", track.label())),
                    }
                }
            }
        }
        if active.is_empty() {
            fatal("녹음할 수 있는 트랙이 없습니다");
        }
        // macOS 음성 처리(에코 제거)에 해당하는 것이 아직 없다: 받기만 하고 끈다 (실제 장치일 때만 알린다, 가짜는 Swift처럼 조용히 끈다)
        let echo = false;
        if echo_cancel && self.opener.is_some() && active.contains(&Track::Mic) {
            warning("echo_cancel_failed", "이 운영체제에서는 에코 제거를 아직 쓸 수 없어 끄고 녹음합니다");
        }
        self.info = Some(RecordingInfo { started_at: iso_local(started_at), duration: None, tracks: active.iter().map(|t| t.name()).collect(), marks: vec![], pauses: vec![], echo_cancel: echo });
        self.save_info();
        emit(json!({
            "event": "started",
            "dir": self.dir.to_string_lossy(),
            "tracks": active.iter().map(|t| t.name()).collect::<Vec<_>>(),
            "sample_rate": SAMPLE_RATE,
            "started_at": self.info.as_ref().unwrap().started_at,
            "echo_cancel": echo,
        }));
        self.last_level = Instant::now();
    }

    fn open(&mut self, track: Track) -> Result<(), OpenError> {
        match self.opener.as_mut() {
            None => {
                self.fakes.insert(track, FakeSource::new(if track == Track::Mic { 440.0 } else { 660.0 }, track == Track::System));
            }
            Some(open) => {
                let s = open(track, self.tx.clone())?;
                self.sources.insert(track, s);
            }
        }
        let now = self.elapsed();
        self.last_sample_at.insert(track, now);
        Ok(())
    }

    /// 메시지를 받아 처리한다. stop이 프로세스를 끝낸다
    pub fn run(&mut self, rx: Receiver<Msg>) -> ! {
        while let Ok(msg) = rx.recv() {
            match msg {
                Msg::Samples(track, s) => {
                    if !self.stopping {
                        let now = self.elapsed();
                        self.write(track, &s, now);
                    }
                }
                Msg::Cmd(line) => self.handle(&line),
                Msg::Eof => self.stop(None),
                Msg::Tick => self.tick(),
                Msg::Restart(track, reason) => self.settle(track, reason, Instant::now()),
            }
        }
        self.stop(None)
    }

    fn tick(&mut self) {
        let now = self.elapsed();
        self.flush_fakes(now);
        self.restart_settled(Instant::now());
        if self.last_level.elapsed() >= Duration::from_millis(250) {
            self.last_level = Instant::now();
            self.emit_level();
        }
    }

    /// 가짜 신호를 오디오 시각 `now`까지 만들고 같은 시각으로 쓴다
    fn flush_fakes(&mut self, now: f64) {
        let tracks: Vec<Track> = self.fakes.keys().copied().collect();
        for t in tracks {
            let s = self.fakes.get_mut(&t).unwrap().generate(now);
            self.write(t, &s, now);
        }
    }

    /// `now`: 이 버퍼의 마지막 표본의 오디오 시각
    fn write(&mut self, track: Track, samples: &[i16], now: f64) {
        // 일시정지 중에는 두 트랙 모두 표본을 버린다. 타임라인에 무음도 남기지 않는다
        if self.paused_since.is_some() || samples.is_empty() {
            return;
        }
        let end = (now * SAMPLE_RATE as f64) as usize;
        let realign = self.realign.remove(&track);
        let Some(w) = self.writers.get_mut(&track) else { return };
        if let Err(e) = w.append_at(samples, end, realign) {
            self.stop(Some(e));
        }
        self.last_sample_at.insert(track, now);
        if let Some(m) = self.meters.get_mut(&track) {
            m.add(samples);
        }
        if track == Track::System && self.watch_zero && self.zero.feed(samples) {
            warning("system_zero", "시스템 오디오가 5초 동안 정확히 0입니다. 시스템 설정 > 개인정보 보호 > 화면 및 시스템 오디오 녹음 권한을 확인하세요");
        }
    }

    fn emit_level(&mut self) {
        if self.paused_since.is_some() {
            return; // 일시정지 중에는 level을 내지 않는다
        }
        self.watchdog();
        let mut level = |t: Track| self.meters.get_mut(&t).map(LevelMeter::take);
        let (mic, system) = (level(Track::Mic), level(Track::System));
        if let Some(line) = self.level_log.feed(self.elapsed(), mic, system) {
            log(&line);
        }
        emit(json!({ "event": "level", "t": round2(self.elapsed()), "mic": mic, "system": system }));
    }

    /// 다시 열기를 마지막 알림에서 `SETTLE` 뒤로 미룬다
    fn settle(&mut self, track: Track, reason: &'static str, now: Instant) {
        self.settling.insert(track, (now + SETTLE, reason));
    }

    /// 알림이 `SETTLE` 동안 멎은 트랙만 다시 연다
    fn restart_settled(&mut self, now: Instant) {
        let due: Vec<(Track, &'static str)> = self.settling.iter().filter(|(_, (at, _))| *at <= now).map(|(t, (_, r))| (*t, *r)).collect();
        for (t, reason) in due {
            self.settling.remove(&t);
            self.restart(t, reason);
        }
    }

    fn watchdog(&mut self) {
        let now = self.elapsed();
        let stalled: Vec<Track> = self.sources.keys().copied().filter(|t| now - self.last_sample_at.get(t).copied().unwrap_or(0.0) > STALL).collect();
        for t in stalled {
            self.restart(t, "입력이 2초 넘게 끊겼습니다");
        }
    }

    /// 장치를 다시 연다. 끊긴 구간은 다음 첫 버퍼에서 0으로 메워 두 트랙 시각을 맞춘다
    fn restart(&mut self, track: Track, reason: &str) {
        if self.stopping {
            return;
        }
        let Some(mut old) = self.sources.remove(&track) else { return };
        old.stop();
        if self.paused_since.is_none() {
            self.realign.insert(track);
        }
        let now = self.elapsed();
        self.last_sample_at.insert(track, now); // 실패해도 STALL 뒤에 다시 시도한다
        let opened = match self.opener.as_mut() {
            Some(open) => open(track, self.tx.clone()),
            None => return,
        };
        match opened {
            Ok(s) => {
                self.sources.insert(track, s);
                self.failing.remove(&track);
                warning(&format!("{}_restarted", track.name()), &format!("{} 입력을 다시 연결했습니다 ({reason})", track.label()));
            }
            Err(e) => {
                log(&format!("{} 재연결 실패: {e:?}", track.label()));
                // 다시 시도할 수 있게 자리를 남긴다: 다음 감시 때 같은 길로 연다
                self.sources.insert(track, Box::new(Closed));
                if self.failing.insert(track) {
                    warning(&format!("{}_failed", track.name()), &format!("{} 입력이 끊겼고 다시 연결하지 못했습니다. 계속 재시도합니다: {e:?}", track.label()));
                }
            }
        }
    }

    fn handle(&mut self, line: &str) {
        let Some(cmd) = Command::parse(line) else {
            log(&format!("알 수 없는 명령: {line}"));
            return;
        };
        let t = round2(self.elapsed());
        match cmd {
            Command::Stop => self.stop(None),
            Command::Pause => self.pause(),
            Command::Resume => self.resume(),
            Command::Bookmark => self.add_mark(Mark { t, kind: "bookmark", text: None }),
            Command::Memo(text) => self.add_mark(Mark { t, kind: "memo", text: Some(text) }),
            Command::EditMark(i, text) => self.change_marks(|m| match m.get_mut(i) {
                Some(mark) if mark.kind == "memo" => {
                    mark.text = Some(text);
                    true
                }
                _ => false,
            }),
            Command::DeleteMark(i) => self.change_marks(|m| {
                if i < m.len() {
                    m.remove(i);
                    true
                } else {
                    false
                }
            }),
        }
    }

    /// 이미 일시정지 중이면 아무 일도 없다
    fn pause(&mut self) {
        if self.stopping || self.info.is_none() || self.paused_since.is_some() {
            return;
        }
        let at = self.elapsed();
        self.flush_fakes(at); // 가짜 신호: 일시정지 시각까지 쓴다
        for w in self.writers.values_mut() {
            if let Err(e) = w.update_header() {
                log(&e.to_string());
            }
        }
        for m in self.meters.values_mut() {
            m.take();
        }
        self.paused_since = Some(self.t0 + self.paused_total + Duration::from_secs_f64(at)); // 시계를 at에서 정확히 멈춘다. Swift판과 같다
        self.pause_wall_start = chrono::Local::now();
        self.pause_at = at;
        emit(json!({ "event": "paused", "elapsed": round2(at) }));
    }

    /// 일시정지 중이 아니면 아무 일도 없다. 멈춘 시각 그대로 이어 붙인다
    fn resume(&mut self) {
        if self.stopping || self.paused_since.is_none() {
            return;
        }
        self.end_pause();
        emit(json!({ "event": "resumed", "elapsed": round2(self.pause_at) }));
    }

    fn end_pause(&mut self) {
        let Some(since) = self.paused_since.take() else { return };
        self.paused_total += since.elapsed();
        let p = Pause { at: round2(self.pause_at), wall_start: iso_local(self.pause_wall_start), wall_end: iso_local(chrono::Local::now()) };
        if let Some(info) = self.info.as_mut() {
            info.pauses.push(p);
        }
        self.save_info();
    }

    fn add_mark(&mut self, mark: Mark) {
        if self.stopping {
            return;
        }
        let Some(info) = self.info.as_mut() else { return };
        info.marks.push(mark.clone());
        self.save_info();
        let mut ev = mark.json();
        ev["event"] = json!("mark");
        emit(ev);
    }

    /// 바뀌면 recording.json에 쓰고, 바뀌지 않아도 전체 목록을 `marks`로 다시 보낸다 (앱이 어긋난 화면을 바로잡게)
    fn change_marks(&mut self, change: impl FnOnce(&mut Vec<Mark>) -> bool) {
        if self.stopping {
            return;
        }
        let Some(info) = self.info.as_mut() else { return };
        if change(&mut info.marks) {
            self.save_info();
        } else {
            log("메모를 바꾸지 않았습니다: 없는 번호이거나 북마크입니다");
        }
        let marks: Vec<_> = self.info.as_ref().unwrap().marks.iter().map(Mark::json).collect();
        emit(json!({ "event": "marks", "marks": marks }));
    }

    /// stop·stdin EOF·쓰기 실패가 모두 여기로 온다. 파일을 닫고 프로세스를 끝낸다
    pub fn stop(&mut self, error: Option<String>) -> ! {
        if !self.stopping {
            self.stopping = true;
            // 종료 시각은 맨 먼저 한 번 읽는다: 소스를 닫는 시간이 duration에 들어가지 않게. 일시정지 중이면 멈춘 시각 그대로다
            let end = self.elapsed();
            self.flush_fakes(end);
            self.end_pause();
            for s in self.sources.values_mut() {
                s.stop();
            }
            for w in self.writers.values_mut() {
                // 아직 오는 중이던 마지막 버퍼는 버려지므로 끝을 0으로 메워 WAV 길이 = duration을 지킨다. 한 번도 열리지 않은 트랙(빈 WAV)은 그대로.
                // 메우기가 실패해도 헤더 크기를 고치도록 close는 늘 한다. Swift판과 같다
                if w.frames > 0 {
                    if let Err(e) = w.append_at(&[], (end * SAMPLE_RATE as f64) as usize, true) {
                        log(&e);
                    }
                }
                if let Err(e) = w.close() {
                    log(&e.to_string());
                }
            }
            let d = round2(end);
            if let Some(info) = self.info.as_mut() {
                info.duration = Some(d);
            }
            self.save_info();
        }
        if let Some(e) = error {
            fatal(&e);
        }
        let duration = self.info.as_ref().and_then(|i| i.duration).unwrap_or(0.0);
        emit(json!({ "event": "stopped", "dir": self.dir.to_string_lossy(), "duration": duration }));
        std::process::exit(0)
    }

    fn save_info(&self) {
        if let Some(info) = &self.info {
            if let Err(e) = info.write(&self.dir) {
                log(&format!("recording.json 저장 실패: {e}"));
            }
        }
    }
}

/// 다시 열지 못한 트랙의 자리 (감시가 계속 다시 연다)
struct Closed;

impl Source for Closed {
    fn stop(&mut self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;

    struct Open;
    impl Source for Open {
        fn stop(&mut self) {}
    }

    /// 시스템 오디오가 돌면 시작 때 못 연 마이크를 트랙으로 남기고, 다시 열리면 이어 쓴다
    #[test]
    fn mic_that_fails_at_start_is_kept_and_retried() {
        let dir = std::env::temp_dir().join(format!("tractus-rec-test-{}-micretry", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let mic_ok = Rc::new(Cell::new(false));
        let ok = mic_ok.clone();
        let opener: Opener = Box::new(move |t, _| if t == Track::Mic && !ok.get() { Err(OpenError::Failed("busy".into())) } else { Ok(Box::new(Open)) });
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut r = Recorder::new(dir.clone(), tx, Some(opener));
        r.start(&[Track::Mic, Track::System], false);
        assert_eq!(r.info.as_ref().unwrap().tracks, vec!["mic", "system"]);
        assert!(r.writers.contains_key(&Track::Mic) && r.sources.contains_key(&Track::Mic));
        assert!(r.failing.contains(&Track::Mic));

        r.restart(Track::Mic, "시험");
        assert!(r.failing.contains(&Track::Mic), "아직 못 열면 실패 상태 그대로");
        mic_ok.set(true);
        r.restart(Track::Mic, "시험");
        assert!(!r.failing.contains(&Track::Mic) && r.realign.contains(&Track::Mic), "열리면 다음 첫 버퍼에서 앞을 0으로 메운다");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 몰려 온 장치 바뀜 알림은 마지막 알림에서 SETTLE이 지난 뒤 한 번만 다시 연다
    #[test]
    fn device_change_bursts_reopen_once_after_they_settle() {
        let dir = std::env::temp_dir().join(format!("tractus-rec-test-{}-settle", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let opens = Rc::new(Cell::new(0));
        let n = opens.clone();
        let opener: Opener = Box::new(move |_, _| {
            n.set(n.get() + 1);
            Ok(Box::new(Open))
        });
        let (tx, _rx) = std::sync::mpsc::channel();
        let mut r = Recorder::new(dir.clone(), tx, Some(opener));
        r.start(&[Track::Mic, Track::System], false);
        assert_eq!(opens.get(), 2);

        let t0 = Instant::now();
        for i in 0..3 {
            let at = t0 + Duration::from_millis(i * 100);
            r.settle(Track::System, "시험", at);
            r.restart_settled(at);
        }
        assert_eq!(opens.get(), 2, "알림이 이어지는 동안은 다시 열지 않는다");
        r.restart_settled(t0 + SETTLE + Duration::from_millis(200));
        assert_eq!(opens.get(), 3, "멎은 뒤 한 번");
        r.restart_settled(t0 + SETTLE * 10);
        assert_eq!(opens.get(), 3);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
