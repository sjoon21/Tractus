//! 회의 폴더 읽기. 파일이 원본이다(ARCHITECTURE.md §4.1, §6). 쓰기는 하지 않는다.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Segment {
    pub id: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub text: String,
    #[serde(default)]
    pub corrected_text: Option<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
struct Audio {
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    duration_sec: f64,
}

#[derive(Deserialize, Debug)]
struct Transcript {
    meeting_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    audio: Audio,
    #[serde(default)]
    segments: Vec<Segment>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Topic {
    pub title: String,
    #[serde(default)]
    pub segment_ids: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Decision {
    pub text: String,
    #[serde(default)]
    pub segment_ids: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct ActionItem {
    pub task: String,
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub due: Option<String>,
    #[serde(default)]
    pub segment_ids: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Summary {
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub topics: Vec<Topic>,
    #[serde(default)]
    pub decisions: Vec<Decision>,
    #[serde(default)]
    pub action_items: Vec<ActionItem>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
}

/// memos.json 항목. kind는 "memo" | "bookmark".
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Memo {
    pub t: f64,
    pub kind: String,
    #[serde(default)]
    pub text: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct MeetingInfo {
    pub id: String,
    pub dir: String,
    pub title: String,
    pub created_at: String,
    pub duration_sec: f64,
    pub segments: usize,
    pub has_summary: bool,
}

#[derive(Serialize, Debug)]
pub struct MeetingDetail {
    pub info: MeetingInfo,
    pub segments: Vec<Segment>,
    pub summary: Option<Summary>,
    pub memos: Vec<Memo>,
    /// 오디오 절대 경로. 프론트엔드가 convertFileSrc(path, "media")로 URL을 만든다 (media.rs).
    pub audio_path: Option<String>,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("{}: {e}", path.display()))
}

fn info(dir: &Path, t: &Transcript) -> MeetingInfo {
    MeetingInfo {
        id: t.meeting_id.clone(),
        dir: dir.to_string_lossy().into_owned(),
        title: t.title.clone(),
        created_at: t.created_at.clone(),
        duration_sec: t.audio.duration_sec,
        segments: t.segments.len(),
        has_summary: dir.join("summary.json").is_file(),
    }
}

/// $TRACTUS_HOME/meetings/*/transcript.json, 최신순. 손상된 회의 하나 때문에 목록 전체가 실패하지 않게 건너뛴다.
pub fn list(home: &Path) -> Vec<MeetingInfo> {
    let Ok(entries) = fs::read_dir(home.join("meetings")) else { return vec![] };
    let mut out: Vec<MeetingInfo> = entries
        .flatten()
        .filter_map(|e| {
            let dir = e.path();
            match read_json::<Transcript>(&dir.join("transcript.json")) {
                Ok(t) => Some(info(&dir, &t)),
                Err(err) => {
                    if dir.join("transcript.json").exists() {
                        eprintln!("회의 건너뜀: {err}");
                    }
                    None // transcript.json이 없으면 전사 중인 폴더다
                }
            }
        })
        .collect();
    // ponytail: created_at 문자열 비교. 오프셋이 섞이면(+09:00/Z) 순서가 어긋날 수 있다. 그때 chrono로 파싱
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    out
}

/// 아직 전사되지 않은 녹음 ($TRACTUS_HOME/recordings/<ULID>/recording.json).
/// 전사에 성공하면 코어가 녹음 폴더를 지우므로, 남아 있는 폴더는 전사 전·실패·앱 종료로 끊긴 녹음이다.
#[derive(Serialize, Clone, Debug)]
pub struct PendingRecording {
    pub dir: String,
    pub started_at: String,
    /// 녹음 중이거나 비정상 종료된 녹음은 null. 트랙은 주기적으로 헤더를 갱신하므로 그래도 전사할 수 있다
    pub duration: Option<f64>,
}

#[derive(Deserialize)]
struct RecordingJson {
    #[serde(default)]
    started_at: String,
    #[serde(default)]
    duration: Option<f64>,
}

/// 녹음 폴더 이름은 tractus-rec이 만든 ULID(영숫자)만 받는다. `..`이나 다른 경로가 전사·삭제 대상이 되지 않게 한다.
pub fn is_recording_dir(home: &Path, dir: &Path) -> bool {
    dir.parent() == Some(home.join("recordings").as_path())
        && dir.file_name().and_then(|n| n.to_str()).is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric()))
}

pub fn pending_recordings(home: &Path) -> Vec<PendingRecording> {
    let Ok(entries) = fs::read_dir(home.join("recordings")) else { return vec![] };
    let mut out: Vec<PendingRecording> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|dir| is_recording_dir(home, dir))
        .filter_map(|dir| {
            let r: RecordingJson = read_json(&dir.join("recording.json")).ok()?;
            Some(PendingRecording { dir: dir.to_string_lossy().into_owned(), started_at: r.started_at, duration: r.duration })
        })
        .collect();
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    out
}

fn find_dir(home: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
        return Err(format!("잘못된 회의 ID: {id}"));
    }
    // 폴더 이름은 <날짜>_<제목>_<meeting_id> (store.meeting_dir_name)
    let suffix = format!("_{id}");
    fs::read_dir(home.join("meetings"))
        .map_err(|e| format!("회의 폴더를 읽을 수 없습니다: {e}"))?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(&suffix)))
        .ok_or_else(|| format!("회의를 찾을 수 없습니다: {id}"))
}

pub fn load(home: &Path, id: &str) -> Result<MeetingDetail, String> {
    let dir = find_dir(home, id)?;
    let t: Transcript = read_json(&dir.join("transcript.json"))?;
    let summary_path = dir.join("summary.json");
    let summary = if summary_path.is_file() { Some(read_json::<Summary>(&summary_path)?) } else { None };
    let mut memos: Vec<Memo> = read_json(&dir.join("memos.json")).unwrap_or_default();
    memos.sort_by(|a, b| a.t.total_cmp(&b.t));
    // audio.file은 파일 이름만 허용한다 (회의 폴더 밖을 가리키지 못하게)
    let audio_path = t
        .audio
        .file
        .as_deref()
        .filter(|f| !f.is_empty() && !f.contains(['/', '\\']) && *f != "..")
        .map(|f| dir.join(f))
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned());
    Ok(MeetingDetail { info: info(&dir, &t), segments: t.segments, summary, memos, audio_path })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가상 회의 코퍼스. TRACTUS_TEST_HOME으로 바꿀 수 있다 (예: Phase 4 합성 홈).
    fn fixture_home() -> PathBuf {
        std::env::var_os("TRACTUS_TEST_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/eval"))
    }

    fn temp_home(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tractus-app-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("meetings")).unwrap();
        d
    }

    #[test]
    fn lists_fixture_meetings_newest_first() {
        let list = list(&fixture_home());
        assert!(list.len() >= 5, "회의 {}개", list.len());
        assert!(list.windows(2).all(|w| w[0].created_at >= w[1].created_at));
        assert!(list.iter().all(|m| m.segments > 0 && m.has_summary));
    }

    #[test]
    fn loads_fixture_detail_with_summary() {
        let home = fixture_home();
        let first = &list(&home)[0];
        let d = load(&home, &first.id).unwrap();
        assert_eq!(d.info.id, first.id);
        assert!(!d.segments.is_empty() && d.segments[0].id.starts_with('s'));
        let s = d.summary.expect("summary.json");
        assert!(!s.summary.is_empty() && !s.decisions.is_empty());
        assert!(s.action_items.iter().all(|a| !a.segment_ids.is_empty()));
    }

    #[test]
    fn reads_memos_and_new_audio_ogg_and_skips_broken() {
        let home = temp_home("memos");
        let dir = home.join("meetings/2026-10-02_테스트_01TEST");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("transcript.json"),
            r#"{"schema_version":1,"meeting_id":"01TEST","title":"테스트","created_at":"2026-10-02T14:00:00+09:00",
               "audio":{"file":"audio.ogg","duration_sec":10.0},"segments":[{"id":"s0001","start":0,"end":5,"text":"안녕","lang":"ko","speaker":null,"corrected_text":null,"words":null}]}"#,
        )
        .unwrap();
        fs::write(dir.join("audio.ogg"), b"OggS").unwrap();
        fs::write(dir.join("memos.json"), r#"[{"t":8.5,"kind":"memo","text":"예산 확인"},{"t":2.0,"kind":"bookmark","text":null}]"#).unwrap();
        let broken = home.join("meetings/2026-10-01_깨짐_01BROKEN");
        fs::create_dir_all(&broken).unwrap();
        fs::write(broken.join("transcript.json"), "{not json").unwrap();
        fs::create_dir_all(home.join("meetings/전사중")).unwrap();

        assert_eq!(list(&home).len(), 1);
        let d = load(&home, "01TEST").unwrap();
        assert_eq!(d.memos.iter().map(|m| m.t).collect::<Vec<_>>(), vec![2.0, 8.5]);
        assert_eq!(d.memos[0].kind, "bookmark");
        assert!(d.summary.is_none());
        assert!(d.audio_path.unwrap().ends_with("audio.ogg"));
        assert!(load(&home, "../x").is_err());
        assert!(load(&home, "01NOPE").is_err());
    }

    #[test]
    fn pending_recordings_and_dir_guard() {
        let home = temp_home("rec");
        let rec = home.join("recordings");
        for (name, json) in [
            ("01OLD", r#"{"started_at":"2026-10-01T09:00:00+09:00","duration":12.5,"tracks":{},"marks":[]}"#),
            ("01NEW", r#"{"started_at":"2026-10-02T09:00:00+09:00","duration":null,"tracks":{},"marks":[]}"#),
            ("not-ulid", r#"{"started_at":"2026-10-03T09:00:00+09:00","duration":1}"#),
        ] {
            fs::create_dir_all(rec.join(name)).unwrap();
            fs::write(rec.join(name).join("recording.json"), json).unwrap();
        }
        fs::create_dir_all(rec.join("01EMPTY")).unwrap(); // recording.json 없음
        let got = pending_recordings(&home);
        assert_eq!(got.iter().map(|p| p.dir.rsplit('/').next().unwrap()).collect::<Vec<_>>(), vec!["01NEW", "01OLD"]);
        assert_eq!(got[0].duration, None);
        assert_eq!(got[1].duration, Some(12.5));

        assert!(is_recording_dir(&home, &rec.join("01OLD")));
        assert!(!is_recording_dir(&home, &rec.join("..")));
        assert!(!is_recording_dir(&home, &rec.join("../recordings")));
        assert!(!is_recording_dir(&home, &rec.join(".")));
        assert!(!is_recording_dir(&home, &rec.join("01OLD/..")));
        assert!(!is_recording_dir(&home, &home.join("meetings/01OLD")));
    }

    #[test]
    fn rejects_audio_file_outside_meeting_dir() {
        let home = temp_home("audio");
        let dir = home.join("meetings/2026-10-02_a_01EVIL");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("transcript.json"), r#"{"meeting_id":"01EVIL","audio":{"file":"../../secret"},"segments":[]}"#).unwrap();
        assert!(load(&home, "01EVIL").unwrap().audio_path.is_none());
    }
}
