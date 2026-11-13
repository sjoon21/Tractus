//! 녹음 한 번의 상태 (Swift `tractus-rec/Recorder.swift`와 같은 규칙). 모든 상태 변경은 `run`의 한 스레드에서만 한다:
//! 오디오 스레드·stdin·타이머는 `Msg`를 채널로 보낸다. 운영체제와 상관없고, 실제 장치는 `Opener`가 연다 (Windows: win.rs).
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::mpsc::{Receiver, Sender};
use std::time::{Duration, Instant};

use serde_json::json;

use crate::fake::FakeSource;
use crate::meter::{LevelMeter, ZeroDetector};
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
    /// 장치가 끊겼거나 기본 장치가 바뀌었다: 다시 연다
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
    last_level: Instant,
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
            last_level: Instant::now(),
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
                Err(e) => {
                    drop(writer);
                    let _ = std::fs::remove_file(&path);
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
                        self.write(track, &s);
                    }
                }
                Msg::Cmd(line) => self.handle(&line),
                Msg::Eof => self.stop(None),
                Msg::Tick => self.tick(),
                Msg::Restart(track, reason) => self.restart(track, reason),
            }
        }
        self.stop(None)
    }

    fn tick(&mut self) {
        self.flush_fakes();
        if self.last_level.elapsed() >= Duration::from_millis(250) {
            self.last_level = Instant::now();
            self.emit_level();
        }
    }

    fn flush_fakes(&mut self) {
        let now = self.elapsed();
        let tracks: Vec<Track> = self.fakes.keys().copied().collect();
        for t in tracks {
            let s = self.fakes.get_mut(&t).unwrap().generate(now);
            self.write(t, &s);
        }
    }

    fn write(&mut self, track: Track, samples: &[i16]) {
        // 일시정지 중에는 두 트랙 모두 표본을 버린다. 타임라인에 무음도 남기지 않는다
        if self.paused_since.is_some() || samples.is_empty() {
            return;
        }
        let end = (self.elapsed() * SAMPLE_RATE as f64) as usize;
        let realign = self.realign.remove(&track);
        let Some(w) = self.writers.get_mut(&track) else { return };
        if let Err(e) = w.append_at(samples, end, realign) {
            self.stop(Some(e));
        }
        let now = self.elapsed();
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
        emit(json!({ "event": "level", "t": round2(self.elapsed()), "mic": mic, "system": system }));
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
        self.flush_fakes(); // 가짜 신호: 일시정지 시각까지 쓴다
        for w in self.writers.values_mut() {
            if let Err(e) = w.update_header() {
                log(&e.to_string());
            }
        }
        for m in self.meters.values_mut() {
            m.take();
        }
        let at = self.elapsed();
        self.paused_since = Some(Instant::now());
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
            self.flush_fakes();
            self.end_pause();
            for s in self.sources.values_mut() {
                s.stop();
            }
            for w in self.writers.values_mut() {
                if let Err(e) = w.close() {
                    log(&e.to_string());
                }
            }
            let d = round2(self.elapsed());
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
