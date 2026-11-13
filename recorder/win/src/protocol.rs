//! 계약 (docs/desktop.md §1): stdin 명령, 녹음 인수, 메모·일시정지, recording.json, stdout JSON Lines 이벤트.
//! Swift `RecorderKit/Recording.swift`와 같은 규칙이다. 운영체제와 상관없다.
use std::io::Write;
use std::path::Path;

use serde_json::{json, Map, Value};

#[derive(Debug, PartialEq)]
pub enum Command {
    Bookmark,
    Memo(String),
    Pause,
    Resume,
    Stop,
    EditMark(usize, String),
    DeleteMark(usize),
}

impl Command {
    pub fn parse(line: &str) -> Option<Command> {
        let s = line.trim();
        match s {
            "bookmark" => return Some(Command::Bookmark),
            "stop" => return Some(Command::Stop),
            "pause" => return Some(Command::Pause),
            "resume" => return Some(Command::Resume),
            _ => {}
        }
        if let Some(text) = s.strip_prefix("memo ") {
            let text = text.trim();
            return (!text.is_empty()).then(|| Command::Memo(text.to_string()));
        }
        if let Some(rest) = s.strip_prefix("mark_delete ") {
            return rest.trim().parse().ok().map(Command::DeleteMark);
        }
        if let Some(rest) = s.strip_prefix("mark_edit ") {
            let (i, text) = rest.split_once(' ')?;
            let text = text.trim();
            return (!text.is_empty()).then_some(Command::EditMark(i.parse().ok()?, text.to_string()));
        }
        None
    }
}

#[derive(Debug, PartialEq)]
pub struct RecordOptions {
    pub out: String,
    pub mic: bool,
    pub system: bool,
    pub fake: bool,
    /// macOS 음성 처리. Windows에는 같은 것이 없어 받기만 하고 `echo_cancel_failed` 경고 후 끈다
    pub echo_cancel: bool,
}

impl RecordOptions {
    pub fn parse(args: &[String]) -> Result<RecordOptions, String> {
        let mut o = RecordOptions { out: String::new(), mic: true, system: true, fake: false, echo_cancel: false };
        let mut out = None;
        let mut it = args.iter();
        while let Some(a) = it.next() {
            match a.as_str() {
                "--out" => out = Some(it.next().ok_or("--out에 디렉터리가 필요합니다")?.clone()),
                "--no-mic" => o.mic = false,
                "--no-system" => o.system = false,
                "--fake" => o.fake = true,
                "--echo-cancel" => o.echo_cancel = true,
                _ => return Err(format!("알 수 없는 인수: {a}")),
            }
        }
        o.out = out.ok_or("--out이 필요합니다")?;
        Ok(o)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mark {
    pub t: f64,
    pub kind: &'static str,
    pub text: Option<String>,
}

impl Mark {
    pub fn json(&self) -> Value {
        json!({ "t": self.t, "kind": self.kind, "text": self.text })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pause {
    pub at: f64,
    pub wall_start: String,
    pub wall_end: String,
}

/// recording.json. null 칸을 빠뜨리지 않는다
pub struct RecordingInfo {
    pub started_at: String,
    pub duration: Option<f64>,
    pub tracks: Vec<&'static str>,
    pub marks: Vec<Mark>,
    pub pauses: Vec<Pause>,
    pub echo_cancel: bool,
}

impl RecordingInfo {
    pub fn json(&self) -> Value {
        let tracks: Map<String, Value> = self.tracks.iter().map(|t| (t.to_string(), json!(format!("{t}.wav")))).collect();
        json!({
            "schema_version": 1,
            "started_at": self.started_at,
            "duration": self.duration,
            "tracks": tracks,
            "marks": self.marks.iter().map(Mark::json).collect::<Vec<_>>(),
            "pauses": self.pauses.iter().map(|p| json!({ "at": p.at, "wall_start": p.wall_start, "wall_end": p.wall_end })).collect::<Vec<_>>(),
            "echo_cancel": self.echo_cancel,
        })
    }

    /// 임시 파일에 쓰고 이름을 바꾼다 (원자적. Windows의 rename은 대상이 있어도 바꾼다)
    pub fn write(&self, dir: &Path) -> std::io::Result<()> {
        let tmp = dir.join("recording.json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&self.json())?)?;
        std::fs::rename(tmp, dir.join("recording.json"))
    }
}

/// 소수 둘째 자리 (이벤트·JSON의 시각)
pub fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}

/// "2026-10-02T14:00:00+09:00"
pub fn iso_local(t: chrono::DateTime<chrono::Local>) -> String {
    t.to_rfc3339_opts(chrono::SecondsFormat::Secs, false)
}

/// stdout에는 JSON Lines 이벤트만. 부모가 파이프를 닫았으면 조용히 버린다
pub fn emit(v: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{v}");
    let _ = out.flush();
}

pub fn warning(code: &str, message: &str) {
    emit(json!({ "event": "warning", "code": code, "message": message }));
}

pub fn fatal(message: &str) -> ! {
    emit(json!({ "event": "error", "message": message }));
    std::process::exit(1)
}

pub fn log(message: &str) {
    eprintln!("tractus-rec: {message}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(s: &str) -> Vec<String> {
        s.split_whitespace().map(String::from).collect()
    }

    #[test]
    fn commands_match_the_swift_recorder() {
        assert_eq!(Command::parse(" stop \n"), Some(Command::Stop));
        assert_eq!(Command::parse("memo  예산 다시 확인 "), Some(Command::Memo("예산 다시 확인".into())));
        assert_eq!(Command::parse("memo   "), None);
        assert_eq!(Command::parse("mark_edit 2 새 글"), Some(Command::EditMark(2, "새 글".into())));
        assert_eq!(Command::parse("mark_edit x 새 글"), None);
        assert_eq!(Command::parse("mark_delete 0"), Some(Command::DeleteMark(0)));
        assert_eq!(Command::parse("mark_delete -1"), None);
        assert_eq!(Command::parse("dance"), None);
    }

    #[test]
    fn record_options() {
        let o = RecordOptions::parse(&args("--out d --no-system --fake")).unwrap();
        assert_eq!((o.out.as_str(), o.mic, o.system, o.fake, o.echo_cancel), ("d", true, false, true, false));
        assert!(RecordOptions::parse(&args("--no-mic")).is_err());
        assert!(RecordOptions::parse(&args("--out d --what")).is_err());
    }

    #[test]
    fn recording_json_keeps_nulls_and_shape() {
        let info = RecordingInfo {
            started_at: "2026-11-13T14:00:00+09:00".into(),
            duration: None,
            tracks: vec!["mic", "system"],
            marks: vec![Mark { t: 0.24, kind: "bookmark", text: None }],
            pauses: vec![],
            echo_cancel: false,
        };
        let v = info.json();
        assert_eq!(v["duration"], Value::Null);
        assert_eq!(v["tracks"]["system"], "system.wav");
        assert_eq!(v["marks"][0]["text"], Value::Null);
        assert_eq!(v["marks"][0]["t"].to_string(), "0.24", "0.23999…로 쓰지 않는다");
        assert_eq!(round2(95.004), 95.0);
    }
}
