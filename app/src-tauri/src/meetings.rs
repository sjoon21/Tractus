//! 회의 폴더 읽기. 파일이 원본이다(ARCHITECTURE.md §4.1, §6). 쓰기는 하지 않는다.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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
    /// "S1"… schema_version 1이나 화자 분리를 끈 회의는 없거나 null
    #[serde(default)]
    pub speaker: Option<String>,
    /// 단어 타이밍 (Phase 6.1, `tractus align`). 정렬 전이거나 값이 이상하면 null
    #[serde(default, deserialize_with = "lenient")]
    pub words: Option<Vec<Word>>,
    /// 메모 노트: 본문의 줄 번호(1부터, 빈 줄 포함). 시각이 없어 인용 칩 `n번째 줄`에 쓴다. 녹음에는 없다
    #[serde(default, deserialize_with = "lenient", skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
}

/// 공백 토큰 하나. 시각은 회의 기준 절대 초. approx: 문장을 고친 뒤 보간한 시각
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Word {
    pub text: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub approx: bool,
}

/// 선택 필드(words, suggested)가 이상해도 회의 전체를 못 읽지 않게 null로 본다
/// (단어 강조만 빠지고 세그먼트 단위로 돈다 / 목소리 제안만 빠진다)
fn lenient<'de, D: serde::Deserializer<'de>, T: serde::de::DeserializeOwned>(d: D) -> Result<Option<T>, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).ok())
}

/// transcript.json `speakers` 값. 이름은 사용자가 붙인다 (`tractus speakers rename`).
/// suggested는 등록된 목소리와 맞춘 제안(Phase 7.1)이고 확정 전이다. 표시 이름으로 쓰지 않는다
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct Speaker {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub suggested: Option<Suggestion>,
}

/// 목소리 제안. score는 코사인 유사도 0..1 (화면에는 "자동 인식 82%")
#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Suggestion {
    pub person_id: String,
    pub name: String,
    pub score: f64,
}

/// 메모 노트는 `"audio": {"file": null, "duration_sec": 0, ...}`이고, 아주 오래된 파일은 audio가 없거나 null일 수 있다
#[derive(Deserialize, Clone, Debug, Default)]
struct Audio {
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    duration_sec: Option<f64>,
}

#[derive(Deserialize, Debug)]
struct Transcript {
    meeting_id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    created_at: String,
    #[serde(default)]
    audio: Option<Audio>,
    /// "memo": 녹음 없이 직접 쓴 노트. 없으면(옛 노트) 녹음이다
    #[serde(default)]
    kind: Option<String>,
    /// 메모 노트의 본문 (그대로). 녹음에는 없다
    #[serde(default)]
    body: Option<String>,
    /// 노트 정리 (organize.py, docs/desktop.md §2.12): 즐겨찾기·태그·폴더 ID·수정 시각. 모양이 달라도 없는 것으로 읽는다
    #[serde(default, deserialize_with = "lenient")]
    favorite: Option<bool>,
    #[serde(default, deserialize_with = "lenient_tags")]
    tags: Vec<String>,
    #[serde(default, deserialize_with = "lenient")]
    folder: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    updated_at: Option<String>,
    /// "recorded": 변환 전 노트 (녹음만 있고 아직 텍스트로 변환하지 않았다, docs/desktop.md §2.16). 없거나 다른 값이면 평범한 노트
    #[serde(default, deserialize_with = "lenient")]
    state: Option<String>,
    /// 녹음 노트에 사용자가 적은 메모 `{body, lines, seq}`. 값이 어떤 모양이어도 읽는다 (`parse_note_memo`가 이상하면 없는 것으로 본다)
    #[serde(default)]
    memo: Option<serde_json::Value>,
    #[serde(default)]
    segments: Vec<Segment>,
    /// schema_version 2. v1에는 없고, 화자 분리를 끄면 {} (null도 받는다)
    #[serde(default, deserialize_with = "lenient_speakers")]
    speakers: BTreeMap<String, Speaker>,
}

/// 태그 목록: 목록이 아니면 없는 것으로, 문자열이 아닌 항목·빈 항목은 건너뛴다
fn lenient_tags<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Array(a) => a.into_iter().filter_map(|v| v.as_str().filter(|s| !s.trim().is_empty()).map(String::from)).collect(),
        _ => vec![],
    })
}

/// 코어(store.speaker_name)처럼 너그럽게 읽는다. 이상한 값 하나로 회의 전체를 못 읽으면 목록에서 빠진다.
/// 객체가 아닌 speakers는 없는 것으로, 객체가 아닌 값은 이름 없는 화자로 본다.
fn lenient_speakers<'de, D: serde::Deserializer<'de>>(d: D) -> Result<BTreeMap<String, Speaker>, D::Error> {
    Ok(match serde_json::Value::deserialize(d)? {
        serde_json::Value::Object(m) => m.into_iter().map(|(k, v)| (k, serde_json::from_value(v).unwrap_or_default())).collect(),
        _ => BTreeMap::new(),
    })
}

/// 녹음 노트의 메모 한 줄 (본문의 비어 있지 않은 줄). id는 `m0003`: 녹음 대화(`s0012`)와 따로 센다. line은 본문의 줄 번호(1부터, 빈 줄 포함)
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NoteMemoLine {
    pub id: String,
    pub line: u64,
    pub text: String,
}

/// 녹음 노트에 사용자가 적은 메모 (transcript.json `memo`, docs/desktop.md §2.10). 녹음 중 남기는 메모·북마크(`Memo`)와 다르다
#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct NoteMemo {
    pub body: String,
    pub lines: Vec<NoteMemoLine>,
}

/// 너그럽게 읽는다: 객체가 아니거나 body가 문자열이 아니거나 비어 있으면 메모가 없는 것이다. 이상한 줄은 건너뛴다 (노트 전체를 못 읽지 않게)
fn parse_note_memo(v: Option<&serde_json::Value>) -> Option<NoteMemo> {
    let o = v?.as_object()?;
    let body = o.get("body")?.as_str()?;
    if body.trim().is_empty() {
        return None;
    }
    let lines = o
        .get("lines")
        .and_then(|l| l.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|l| {
                    let id = l.get("id")?.as_str().filter(|id| !id.is_empty())?;
                    Some(NoteMemoLine { id: id.to_string(), line: l.get("line")?.as_u64()?, text: l.get("text")?.as_str()?.to_string() })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(NoteMemo { body: body.to_string(), lines })
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
    /// "recording" | "memo"
    pub kind: String,
    /// 사용자가 정리한 정보 (없으면 즐겨찾기 아님·태그 없음·폴더 없음)
    pub favorite: bool,
    pub tags: Vec<String>,
    pub folder: Option<String>,
    /// 마지막으로 내용을 고친 시각. 옛 노트는 만든 시각
    pub updated_at: String,
    /// "recorded"(변환 전)일 때만 싣는다. 평범한 노트는 키가 없다
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<String>,
    /// 변환 전 노트가 보관 중인 원본 녹음(`tracks/`)의 바이트 수. 없으면 0. 변환 전 노트에만 싣는다 (D5, 변환하면 지워진다)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracks_bytes: Option<u64>,
}

#[derive(Serialize, Debug)]
pub struct MeetingDetail {
    pub info: MeetingInfo,
    pub segments: Vec<Segment>,
    /// 라벨 → 이름. 화자 없는 회의는 빈 객체
    pub speakers: BTreeMap<String, Speaker>,
    pub summary: Option<Summary>,
    pub memos: Vec<Memo>,
    /// 메모 노트의 본문. 녹음은 null
    pub body: Option<String>,
    /// 녹음 노트에 사용자가 적은 메모. 없으면(메모 노트이거나 아직 쓰지 않았거나 읽을 수 없음) null
    pub note_memo: Option<NoteMemo>,
    /// 오디오 절대 경로. 프론트엔드가 convertFileSrc(path, "media")로 URL을 만든다 (media.rs).
    pub audio_path: Option<String>,
    /// 캘린더 일정으로 시작한 녹음이면 그 일정의 참석자 이름 (참석자 이름 고르기). 아니면 빈 목록
    pub attendees: Vec<String>,
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("노트 파일을 읽지 못했습니다\n{}: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("노트 파일을 읽지 못했습니다\n{}: {e}", path.display()))
}

/// "memo"만 메모이고 없거나 모르는 값은 녹음이다 (옛 파일을 옮기지 않는다)
fn kind_of(t: &Transcript) -> &'static str {
    if t.kind.as_deref() == Some("memo") {
        "memo"
    } else {
        "recording"
    }
}

fn info(dir: &Path, t: &Transcript) -> MeetingInfo {
    MeetingInfo {
        id: t.meeting_id.clone(),
        dir: dir.to_string_lossy().into_owned(),
        title: t.title.clone(),
        created_at: t.created_at.clone(),
        duration_sec: t.audio.as_ref().and_then(|a| a.duration_sec).unwrap_or(0.0),
        segments: t.segments.len(),
        has_summary: crate::summaries::any_summary(dir),
        kind: kind_of(t).to_string(),
        favorite: t.favorite == Some(true),
        tags: t.tags.clone(),
        folder: t.folder.clone().filter(|f| !f.is_empty()),
        updated_at: t.updated_at.clone().filter(|u| !u.is_empty()).unwrap_or_else(|| t.created_at.clone()),
        state: recorded_state(t),
        tracks_bytes: recorded_state(t).map(|_| dir_bytes(&dir.join("tracks"))),
    }
}

/// 폴더 아래 파일 크기의 합. 없거나 읽을 수 없으면 0 (표시용이라 너그럽게). 링크는 따라가지 않는다
fn dir_bytes(dir: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_bytes(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map_or(0, |m| m.len()),
            _ => 0,
        })
        .sum()
}

/// 변환 전 노트만 "recorded". 메모 노트나 모르는 값은 평범한 노트다 (옛 파일을 옮기지 않는다)
fn recorded_state(t: &Transcript) -> Option<String> {
    (kind_of(t) == "recording" && t.state.as_deref() == Some("recorded")).then(|| "recorded".to_string())
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
    /// 글만 있는 노트에 추가하려고 녹음한 것이면 그 노트의 ID (attach.json, docs/desktop.md §2.11). 노트가 아직 있는지는 앱이 목록에서 본다
    pub attach_to: Option<String>,
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
            Some(PendingRecording { dir: dir.to_string_lossy().into_owned(), started_at: r.started_at, duration: r.duration, attach_to: crate::attach::read_attach(&dir) })
        })
        .collect();
    out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
    out
}

pub fn find_dir(home: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id.contains("..") {
        return Err(format!("잘못된 노트 ID: {id}"));
    }
    // 폴더 이름은 <날짜>_<제목>_<meeting_id> (store.meeting_dir_name)
    let suffix = format!("_{id}");
    fs::read_dir(home.join("meetings"))
        .map_err(|e| format!("노트 폴더를 읽을 수 없습니다\n{e}"))?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.ends_with(&suffix)))
        .ok_or_else(|| "노트를 찾을 수 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.".to_string())
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
        .as_ref()
        .and_then(|a| a.file.as_deref())
        .filter(|f| !f.is_empty() && !f.contains(['/', '\\']) && *f != "..")
        .map(|f| dir.join(f))
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned());
    let is_memo = kind_of(&t) == "memo";
    let body = if is_memo { Some(t.body.clone().unwrap_or_default()) } else { None };
    let note_memo = if is_memo { None } else { parse_note_memo(t.memo.as_ref()) };
    let attendees = crate::calendar::attendees(&dir);
    Ok(MeetingDetail { info: info(&dir, &t), speakers: t.speakers, segments: t.segments, summary, memos, body, note_memo, audio_path, attendees })
}

/// chat.json 항목 (`tractus ask --save`가 덧붙인다, 최근 50개). 없는 필드는 기본값으로 읽는다
#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ChatEntry {
    pub question: String,
    pub answer: String,
    pub citations: Vec<ChatCitation>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub created_at: String,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(default)]
pub struct ChatCitation {
    pub meeting_id: String,
    pub segment_id: String,
    pub start: f64,
    /// 메모 노트의 인용이면 줄 번호 (시각이 없다)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<u64>,
    /// "memo": 녹음 노트에 사용자가 적은 메모의 줄 (segment_id는 `m0003`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// 회의의 질문 기록. 파일이 없으면 빈 목록. 목록 또는 {"turns": [...]}을 받고, 읽지 못하는 항목은 건너뛴다
pub fn load_chat(home: &Path, id: &str) -> Result<Vec<ChatEntry>, String> {
    let path = find_dir(home, id)?.join("chat.json");
    if !path.is_file() {
        return Ok(vec![]);
    }
    let items = match read_json::<serde_json::Value>(&path)? {
        serde_json::Value::Array(a) => a,
        serde_json::Value::Object(mut o) => match o.remove("turns") {
            Some(serde_json::Value::Array(a)) => a,
            _ => vec![],
        },
        _ => vec![],
    };
    Ok(items.into_iter().filter_map(|v| serde_json::from_value::<ChatEntry>(v).ok()).filter(|e| !e.question.is_empty()).collect())
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
    fn reads_speakers_v2_and_v1_without() {
        let home = temp_home("speakers");
        let write = |id: &str, json: &str| {
            let dir = home.join(format!("meetings/2026-10-04_t_{id}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("transcript.json"), json).unwrap();
        };
        write(
            "01V2",
            r#"{"schema_version":2,"meeting_id":"01V2","speakers":{"S1":{"name":"김민수"},"S2":{"name":null}},
               "diarization":{"model":"m","revision":"r","params":{}},
               "segments":[{"id":"s0001","start":0,"end":1,"text":"a","speaker":"S1"},{"id":"s0002","start":1,"end":2,"text":"b","speaker":null}]}"#,
        );
        write("01V1", r#"{"schema_version":1,"meeting_id":"01V1","segments":[{"id":"s0001","start":0,"end":1,"text":"a"}]}"#);
        write("01OFF", r#"{"schema_version":2,"meeting_id":"01OFF","speakers":null,"diarization":null,"segments":[]}"#);
        // 코어처럼 너그럽게: 값이 객체가 아니면 이름 없는 화자, speakers가 객체가 아니면 없는 것으로
        write("01ODD", r#"{"schema_version":2,"meeting_id":"01ODD","speakers":{"S1":null,"S2":"x","S3":{"name":"박"}},"segments":[]}"#);
        write("01ARR", r#"{"schema_version":2,"meeting_id":"01ARR","speakers":[],"segments":[]}"#);

        let v2 = load(&home, "01V2").unwrap();
        assert_eq!(v2.speakers["S1"].name.as_deref(), Some("김민수"));
        assert_eq!(v2.speakers["S2"].name, None);
        assert_eq!(v2.segments.iter().map(|s| s.speaker.as_deref()).collect::<Vec<_>>(), vec![Some("S1"), None]);
        let v1 = load(&home, "01V1").unwrap();
        assert!(v1.speakers.is_empty() && v1.segments[0].speaker.is_none());
        assert!(load(&home, "01OFF").unwrap().speakers.is_empty());
        let odd = load(&home, "01ODD").unwrap();
        assert_eq!(odd.speakers.iter().map(|(k, v)| (k.as_str(), v.name.as_deref())).collect::<Vec<_>>(), vec![("S1", None), ("S2", None), ("S3", Some("박"))]);
        assert!(load(&home, "01ARR").unwrap().speakers.is_empty());
        assert_eq!(list(&home).len(), 5); // 목록에서 빠지지 않는다
        // 프론트엔드는 speakers를 항상 객체로 받는다
        assert_eq!(serde_json::to_value(&v1).unwrap()["speakers"], serde_json::json!({}));
    }

    #[test]
    fn reads_voice_suggestions_leniently() {
        let home = temp_home("suggest");
        let dir = home.join("meetings/2026-10-07_v_01VOICE");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("transcript.json"),
            r#"{"schema_version":2,"meeting_id":"01VOICE","speakers":{
                "S1":{"name":null,"suggested":{"person_id":"01P","name":"홍길동","score":0.82}},
                "S2":{"name":"김민수","suggested":null},
                "S3":{"name":"박","suggested":{"name":"깨짐"}},
                "S4":{"name":null,"suggested":"x"}},"segments":[]}"#,
        )
        .unwrap();
        let sp = load(&home, "01VOICE").unwrap().speakers;
        let s1 = sp["S1"].suggested.as_ref().unwrap();
        assert_eq!((s1.person_id.as_str(), s1.name.as_str(), s1.score), ("01P", "홍길동", 0.82));
        assert_eq!(sp["S1"].name, None, "제안은 이름이 아니다");
        assert!(sp["S2"].suggested.is_none());
        // 제안이 이상해도 이름은 남는다
        assert_eq!((sp["S3"].name.as_deref(), sp["S3"].suggested.is_none()), (Some("박"), true));
        assert!(sp["S4"].suggested.is_none());
        let v = serde_json::to_value(&sp).unwrap();
        assert_eq!(v["S1"]["suggested"], serde_json::json!({"person_id": "01P", "name": "홍길동", "score": 0.82}));
        assert!(v["S2"]["suggested"].is_null());
    }

    /// 실제 코어가 쓴 transcript.json (가상 `say` 회의, 세그먼트 1개만 남김): 제안 있는 화자, `suggested` 키가 없는 화자
    #[test]
    fn reads_real_core_transcript_with_suggestion() {
        let home = temp_home("real-suggest");
        let dir = home.join("meetings/2026-10-07_배포_01M4ABVPTZ4KVT6M6V9RDYRDHB");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("transcript.json"), r#"{"schema_version": 2, "meeting_id": "01M4ABVPTZ4KVT6M6V9RDYRDHB", "title": "배포", "created_at": "2026-10-07T14:01:46+09:00", "audio": {"file": "audio.ogg", "duration_sec": 37.66, "source": "m2.wav", "sha256": "549b73075ab3638e8fa5b50ae2b5f2e5e5aba9dd9d95679a5e3ca48c6581cb07"}, "asr": {"model": "mlx-community/Qwen3-ASR-1.7B-8bit", "track": "standard", "runtime": "mlx-audio", "language": "auto", "hotwords": []}, "speakers": {"S1": {"name": null, "suggested": {"person_id": "01M4ABVBAA6N46V7MCV8M7DC17", "name": "유나", "score": 0.96}}, "S2": {"name": null}}, "diarization": {"model": "mlx-community/Nemotron-3-Diarization", "revision": "59ed2dbfc1346dcea9d423c71306a3a2499c568f", "params": {"threshold": 0.5, "median_frames": 11, "min_turn_s": 1.0, "fill_gap_s": 1.0, "min_piece_s": 1.0, "max_speakers": null}}, "segments": [{"id": "s0001", "start": 0.0, "end": 4.97, "text": "이번 주 배포 일정에 대해 이야기해 보겠습니다. 테스트는 끝났나요?", "lang": "ko", "speaker": "S1", "corrected_text": null, "words": [{"text": "이번", "start": 0.0, "end": 0.32}, {"text": "주", "start": 0.32, "end": 0.48}]}]}"#).unwrap();
        let sp = load(&home, "01M4ABVPTZ4KVT6M6V9RDYRDHB").unwrap().speakers;
        let s1 = sp["S1"].suggested.as_ref().unwrap();
        assert_eq!((s1.name.as_str(), s1.score, sp["S1"].name.as_deref()), ("유나", 0.96, None));
        assert!(sp["S2"].suggested.is_none() && sp["S2"].name.is_none());
    }

    #[test]
    fn reads_words_leniently() {
        let home = temp_home("words");
        let dir = home.join("meetings/2026-10-06_w_01WORDS");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("transcript.json"),
            r#"{"schema_version":2,"meeting_id":"01WORDS","segments":[
                {"id":"s0001","start":0,"end":2,"text":"안녕 하세요","words":[{"text":"안녕","start":0.1,"end":0.5},{"text":"하세요","start":0.6,"end":1.2,"approx":true}]},
                {"id":"s0002","start":2,"end":3,"text":"a","words":null},
                {"id":"s0003","start":3,"end":4,"text":"b"},
                {"id":"s0004","start":4,"end":5,"text":"c","words":[{"text":"c","start":"x"}]},
                {"id":"s0005","start":5,"end":6,"text":"d","words":"깨짐"}]}"#,
        )
        .unwrap();
        let d = load(&home, "01WORDS").unwrap();
        let w = d.segments[0].words.as_ref().unwrap();
        assert_eq!((w[0].text.as_str(), w[0].start, w[0].approx), ("안녕", 0.1, false));
        assert!(w[1].approx);
        assert!(d.segments[1..].iter().all(|s| s.words.is_none()), "null·없음·이상한 값은 None");
        assert_eq!(list(&home).len(), 1); // 목록에서 빠지지 않는다
        let v = serde_json::to_value(&d.segments).unwrap();
        assert_eq!(v[0]["words"][1], serde_json::json!({"text": "하세요", "start": 0.6, "end": 1.2, "approx": true}));
        assert!(v[1]["words"].is_null());
    }

    /// 코어(`tractus note new/save`, `summarize`)가 실제로 만든 메모 폴더를 앱 파서로 읽는다 (tests/fixtures/memo_home)
    #[test]
    fn reads_memo_folder_written_by_the_real_core() {
        let home = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/memo_home");
        let id = "01M4SQKXTMEQ5BPCG841527FXK";
        let m = load(&home, id).unwrap();
        assert_eq!((m.info.kind.as_str(), m.info.duration_sec, m.info.segments), ("memo", 0.0, 4));
        assert_eq!(m.info.title, "이름 바꿈 ★");
        assert!(m.body.as_deref().unwrap().starts_with("쿠버네티스 도입 검토 메모\n결정:"));
        assert!(m.audio_path.is_none() && m.speakers.is_empty());
        assert_eq!(m.segments.iter().map(|s| s.line).collect::<Vec<_>>(), vec![Some(1), Some(2), Some(3), Some(4)]);
        assert!(m.summary.is_some());
        let l = list(&home);
        let mut kinds: Vec<_> = l.iter().map(|i| i.kind.as_str()).collect();
        kinds.sort();
        assert_eq!(kinds, vec!["memo", "recording"]);
    }

    /// 코어가 만든 녹음 노트(메모 + 요약의 m-ID 인용 + 질문 기록의 메모 인용)를 앱 파서로 읽는다
    #[test]
    fn reads_recording_note_with_memo_written_by_the_real_core() {
        let home = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/memo_home");
        let id = "01M4SV7KREWFM3MJPYR83JJD3M";
        let m = load(&home, id).unwrap();
        assert_eq!((m.info.kind.as_str(), m.info.segments), ("recording", 1));
        assert!(m.audio_path.is_some() && m.body.is_none());
        let memo = m.note_memo.unwrap();
        assert_eq!(memo.body, "서버 비용 20퍼센트 절감이 핵심\n\n견적은 하늘상사에서 받는다\n마감은 금요일");
        assert_eq!(
            memo.lines.iter().map(|l| (l.id.as_str(), l.line)).collect::<Vec<_>>(),
            vec![("m0001", 1), ("m0002", 3), ("m0003", 4)]
        );
        let sm = m.summary.unwrap();
        assert!(sm.decisions.iter().any(|d| d.segment_ids == vec!["m0002".to_string()]));
        assert!(sm.action_items[0].segment_ids.iter().any(|s| s == "m0003"));
        let chat = load_chat(&home, id).unwrap();
        let c = &chat[0].citations[0];
        assert_eq!((c.segment_id.as_str(), c.source.as_deref(), c.line, c.start), ("m0002", Some("memo"), Some(3), 0.0));
    }

    /// 세 기능이 함께 만든 홈(tests/fixtures/trio_home: 글 노트에 태그·즐겨찾기·폴더 → 녹음 추가 → 요약 유형별 요약)을 앱 파서로 읽는다.
    /// 목록 JSON은 list.json과 같아야 한다(웹 쪽 trio.test.ts가 같은 파일을 읽는다). 일부러 바꿨다면 UPDATE_TRIO_FIXTURE=1 cargo test로 다시 쓴다
    #[test]
    fn reads_the_trio_home_written_by_the_real_core() {
        let home = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/trio_home");
        let l = list(&home);
        let mut v = serde_json::to_value(&l).unwrap();
        for n in v.as_array_mut().unwrap() {
            let name = Path::new(n["dir"].as_str().unwrap()).file_name().unwrap().to_string_lossy().into_owned();
            n["dir"] = serde_json::json!(name); // 절대 경로는 기계마다 다르다
        }
        let json = serde_json::to_string_pretty(&v).unwrap() + "\n";
        let want = home.join("list.json");
        if std::env::var_os("UPDATE_TRIO_FIXTURE").is_some() {
            fs::write(&want, &json).unwrap();
        }
        assert_eq!(json, fs::read_to_string(&want).unwrap());

        let id = "01M4T7YEJWABPHP3GATPMX8MYT";
        let a = l.iter().find(|i| i.id == id).unwrap();
        assert_eq!((a.kind.as_str(), a.favorite, a.tags.clone(), a.folder.as_deref()), ("recording", true, vec!["장보기".to_string(), "급함".to_string()], Some("01M4T7YETDCCCY0Z1SZP4P098P")));
        assert!(a.updated_at.as_str() > a.created_at.as_str(), "녹음을 더하면 수정 시각이 올라간다");
        let old = l.iter().find(|i| i.id == "01LEGACY0000000000000000AB").unwrap();
        assert_eq!((old.favorite, old.tags.len(), old.folder.clone(), old.updated_at.as_str()), (false, 0, None, old.created_at.as_str()), "옛 노트: 정리 정보 없음, 수정 시각은 만든 시각");

        let m = load(&home, id).unwrap();
        assert_eq!(m.note_memo.as_ref().unwrap().lines.len(), 3);
        let docs = crate::summaries::read_docs(&find_dir(&home, id).unwrap());
        let keys: Vec<_> = docs.iter().map(|d| d["key"].as_str().unwrap().to_string()).collect();
        assert_eq!(keys, vec!["meeting", "todo", "brief", "u-83fc6d3d"], "기본 → 만든 시각 순 (화면이 기본 유형을 목록 순서로 다시 놓는다)");
        assert_eq!(docs[1]["schema_version"], 2);
        assert!(docs[1]["sections"][0]["items"][0]["segment_ids"].as_array().unwrap().iter().any(|x| x == "m0002"));
        let old_docs = crate::summaries::read_docs(&find_dir(&home, "01LEGACY0000000000000000AB").unwrap());
        assert_eq!(old_docs.len(), 1);
        assert!(old_docs[0]["schema_version"] == 1 && old_docs[0].get("sections").is_none());
        assert_eq!(crate::organize::load_folders(&home).iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["살림"]);
    }

    /// 메모 노트: 녹음 없음(audio.file null), kind·body. 옛 노트(kind 없음)는 녹음, audio가 null이어도 읽힌다
    #[test]
    fn reads_memo_notes_and_old_notes_without_kind() {
        let home = temp_home("memo-kind");
        let write = |id: &str, json: &str| {
            let dir = home.join(format!("meetings/2026-10-13_t_{id}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("transcript.json"), json).unwrap();
        };
        write(
            "01MEMO",
            r#"{"schema_version":2,"meeting_id":"01MEMO","title":"메모 14:05","created_at":"2026-10-13T14:05:00+09:00","kind":"memo",
               "audio":{"file":null,"duration_sec":0,"source":"memo","sha256":null},"body":"첫 줄\n\n둘째 줄",
               "segments":[{"id":"s0001","start":0,"end":0,"text":"첫 줄","speaker":null,"lang":null,"corrected_text":null,"words":null,"line":1},
                           {"id":"s0002","start":0,"end":0,"text":"둘째 줄","speaker":null,"line":"깨짐"}]}"#,
        );
        write("01OLD", r#"{"schema_version":2,"meeting_id":"01OLD","audio":{"file":"audio.ogg","duration_sec":9.5},"segments":[]}"#);
        write("01NOAUDIO", r#"{"meeting_id":"01NOAUDIO","segments":[]}"#);
        write("01NULLAUDIO", r#"{"meeting_id":"01NULLAUDIO","audio":null,"segments":[]}"#);
        write("01ODDKIND", r#"{"meeting_id":"01ODDKIND","kind":"voice","body":"x","audio":{"file":null,"duration_sec":null},"segments":[]}"#);

        let m = load(&home, "01MEMO").unwrap();
        assert_eq!((m.info.kind.as_str(), m.info.duration_sec, m.info.segments), ("memo", 0.0, 2));
        assert_eq!(m.body.as_deref(), Some("첫 줄\n\n둘째 줄"));
        assert!(m.audio_path.is_none() && m.speakers.is_empty());
        assert_eq!(m.segments.iter().map(|s| s.line).collect::<Vec<_>>(), vec![Some(1), None], "이상한 줄 번호는 None");
        assert!(serde_json::to_value(&m.segments[1]).unwrap().get("line").is_none(), "없으면 보내지 않는다");
        let old = load(&home, "01OLD").unwrap();
        assert_eq!((old.info.kind.as_str(), old.info.duration_sec), ("recording", 9.5));
        assert!(old.body.is_none());
        for id in ["01NOAUDIO", "01NULLAUDIO", "01ODDKIND"] {
            let d = load(&home, id).unwrap();
            assert_eq!((d.info.kind.as_str(), d.info.duration_sec), ("recording", 0.0), "{id}");
            assert!(d.body.is_none() && d.audio_path.is_none(), "{id}");
        }
        assert_eq!(list(&home).len(), 5, "목록에서 빠지지 않는다");
        let v = serde_json::to_value(&m).unwrap();
        assert_eq!((v["info"]["kind"].as_str(), v["body"].as_str()), (Some("memo"), Some("첫 줄\n\n둘째 줄")));
        assert!(serde_json::to_value(&old).unwrap()["body"].is_null());
    }

    /// 녹음 노트의 메모 (`memo` 블록): 있음·없음·이상함. 이상해도 노트는 읽히고 메모만 없는 것으로 본다
    #[test]
    fn reads_note_memo_of_recordings_leniently() {
        let home = temp_home("note-memo");
        let write = |id: &str, extra: &str| {
            let dir = home.join(format!("meetings/2026-10-13_t_{id}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("transcript.json"),
                format!(r#"{{"schema_version":2,"meeting_id":"{id}","audio":{{"file":null,"duration_sec":3}},"segments":[{{"id":"s0001","start":0,"end":1,"text":"안녕"}}]{extra}}}"#),
            )
            .unwrap();
        };
        write("01WITH", r#","memo":{"body":"첫 줄\n\n셋째 줄","lines":[{"id":"m0001","line":1,"text":"첫 줄"},{"id":"m0002","line":3,"text":"셋째 줄"}],"seq":2}"#);
        write("01NONE", "");
        write("01NULL", r#","memo":null"#);
        write("01STR", r#","memo":"깨짐""#);
        write("01NOBODY", r#","memo":{"lines":[]}"#);
        write("01BODYNUM", r#","memo":{"body":5,"lines":[]}"#);
        write("01EMPTY", r#","memo":{"body":"  \n","lines":[]}"#);
        write("01BADLINES", r#","memo":{"body":"a\nb","lines":[{"id":"m0001","line":1,"text":"a"},{"id":"m0002","line":"x","text":"b"},{"line":2,"text":"b"},3]}"#);
        write("01NOLINES", r#","memo":{"body":"a","lines":"깨짐"}"#);

        let m = load(&home, "01WITH").unwrap().note_memo.unwrap();
        assert_eq!(m.body, "첫 줄\n\n셋째 줄");
        assert_eq!(m.lines, vec![NoteMemoLine { id: "m0001".into(), line: 1, text: "첫 줄".into() }, NoteMemoLine { id: "m0002".into(), line: 3, text: "셋째 줄".into() }]);
        for id in ["01NONE", "01NULL", "01STR", "01NOBODY", "01BODYNUM", "01EMPTY"] {
            let d = load(&home, id).unwrap();
            assert!(d.note_memo.is_none(), "{id}");
            assert_eq!(d.segments.len(), 1, "{id}: 노트는 그대로 읽힌다");
        }
        // 이상한 줄만 건너뛴다. 줄 목록이 통째로 이상하면 본문만 남는다
        let bad = load(&home, "01BADLINES").unwrap().note_memo.unwrap();
        assert_eq!((bad.body.as_str(), bad.lines.iter().map(|l| l.id.as_str()).collect::<Vec<_>>()), ("a\nb", vec!["m0001"]));
        let nolines = load(&home, "01NOLINES").unwrap().note_memo.unwrap();
        assert_eq!((nolines.body.as_str(), nolines.lines.len()), ("a", 0));
        assert_eq!(list(&home).len(), 9, "목록에서 빠지지 않는다");
        // 앱은 note_memo를 항상 키로 받는다 (없으면 null). 목록 항목은 그대로다
        let v = serde_json::to_value(load(&home, "01WITH").unwrap()).unwrap();
        assert_eq!(v["note_memo"]["lines"][1], serde_json::json!({"id": "m0002", "line": 3, "text": "셋째 줄"}));
        assert!(serde_json::to_value(load(&home, "01NONE").unwrap()).unwrap()["note_memo"].is_null());
        assert!(serde_json::to_value(&list(&home)[0]).unwrap().get("note_memo").is_none());
    }

    /// 메모 노트(kind memo)는 `body`가 본문이고 `memo` 블록이 있어도 쓰지 않는다
    #[test]
    fn memo_note_ignores_a_memo_block() {
        let home = temp_home("memo-note-block");
        let dir = home.join("meetings/2026-10-13_t_01MN");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("transcript.json"), r#"{"meeting_id":"01MN","kind":"memo","body":"x","memo":{"body":"y","lines":[]},"segments":[]}"#).unwrap();
        let d = load(&home, "01MN").unwrap();
        assert_eq!((d.body.as_deref(), d.note_memo.is_none()), (Some("x"), true));
    }

    #[test]
    fn chat_citation_keeps_the_memo_source() {
        let c: ChatCitation = serde_json::from_str(r#"{"meeting_id":"M","segment_id":"m0003","source":"memo","line":3}"#).unwrap();
        assert_eq!((c.source.as_deref(), c.line, c.start), (Some("memo"), Some(3), 0.0));
        let v = serde_json::to_value(&c).unwrap();
        assert_eq!(v["source"], "memo");
        assert!(serde_json::to_value(ChatCitation::default()).unwrap().get("source").is_none());
    }

    #[test]
    fn rejects_audio_file_outside_meeting_dir() {
        let home = temp_home("audio");
        let dir = home.join("meetings/2026-10-02_a_01EVIL");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("transcript.json"), r#"{"meeting_id":"01EVIL","audio":{"file":"../../secret"},"segments":[]}"#).unwrap();
        assert!(load(&home, "01EVIL").unwrap().audio_path.is_none());
    }

    #[test]
    fn reads_chat_history_leniently() {
        let home = temp_home("chat");
        let dir = home.join("meetings/2026-10-05_q_01CHAT");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("transcript.json"), r#"{"meeting_id":"01CHAT","segments":[]}"#).unwrap();
        assert!(load_chat(&home, "01CHAT").unwrap().is_empty()); // 아직 질문 없음

        fs::write(
            dir.join("chat.json"),
            r#"[{"question":"예산?","answer":"3억 [s0012]","citations":[{"meeting_id":"01CHAT","segment_id":"s0012","start":331.5}],
                 "provider":"upstage","model":"solar-pro4","created_at":"2026-10-05T10:00:00+09:00"},
                {"question":"일정?","answer":"회의 기록에서 근거를 찾지 못했습니다","citations":[],"provider":null,"extra":1},
                {"answer":"질문 없음"}, 3, null]"#,
        )
        .unwrap();
        let got = load_chat(&home, "01CHAT").unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].citations[0].start, 331.5);
        assert_eq!(got[0].model.as_deref(), Some("solar-pro4"));
        assert!(got[1].citations.is_empty() && got[1].provider.is_none() && got[1].created_at.is_empty());

        fs::write(dir.join("chat.json"), r#"{"schema_version":1,"turns":[{"question":"a","answer":"b"}]}"#).unwrap();
        assert_eq!(load_chat(&home, "01CHAT").unwrap()[0].answer, "b");
        fs::write(dir.join("chat.json"), "{깨짐").unwrap();
        assert!(load_chat(&home, "01CHAT").is_err());
        assert!(load_chat(&home, "../01CHAT").is_err());
    }

    /// 변환 전 노트(state "recorded"): 목록·상세에 state가 실리고, 오디오·메모는 그대로 읽힌다. 모르는 값·메모 노트는 평범한 노트다
    #[test]
    fn reads_recorded_state_leniently() {
        let home = temp_home("recorded");
        let write = |id: &str, extra: &str| {
            let dir = home.join(format!("meetings/2026-10-14_녹음_{id}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("transcript.json"),
                format!(r#"{{"schema_version":2,"meeting_id":"{id}","title":"녹음 10:00","created_at":"2026-10-14T10:00:00+09:00","audio":{{"file":"audio.ogg","duration_sec":65.5}},"segments":[],"speakers":{{}}{extra}}}"#),
            )
            .unwrap();
            fs::write(dir.join("audio.ogg"), b"OggS").unwrap();
        };
        write("01REC", r#","kind":"recording","state":"recorded""#);
        write("01DONE", r#","kind":"recording""#);
        write("01ODD", r#","state":7"#);
        write("01WORD", r#","state":"queued""#);
        write("01MEMO", r#","kind":"memo","state":"recorded""#);
        let by_id = |id: &str| list(&home).into_iter().find(|m| m.id == id).unwrap();
        assert_eq!(by_id("01REC").state.as_deref(), Some("recorded"));
        assert_eq!((by_id("01REC").segments, by_id("01REC").duration_sec), (0, 65.5));
        for id in ["01DONE", "01ODD", "01WORD", "01MEMO"] {
            assert_eq!(by_id(id).state, None, "{id}");
        }
        let d = load(&home, "01REC").unwrap();
        assert_eq!(d.info.state.as_deref(), Some("recorded"));
        assert!(d.segments.is_empty() && d.audio_path.unwrap().ends_with("audio.ogg"));
        // 원본 녹음 크기: 변환 전 노트만, tracks/가 없으면 0
        assert_eq!(by_id("01REC").tracks_bytes, Some(0));
        let tracks = home.join("meetings/2026-10-14_녹음_01REC/tracks");
        fs::create_dir_all(tracks.join("part2")).unwrap();
        fs::write(tracks.join("mic.wav"), vec![0u8; 1000]).unwrap();
        fs::write(tracks.join("part2/system.wav"), vec![0u8; 500]).unwrap();
        assert_eq!(by_id("01REC").tracks_bytes, Some(1500));
        assert_eq!(by_id("01DONE").tracks_bytes, None);
        assert_eq!(serde_json::to_value(by_id("01REC")).unwrap()["tracks_bytes"], 1500);
        // 평범한 노트는 JSON에 state 키가 없다 (프런트엔드가 없으면 변환한 노트로 읽는다)
        assert!(serde_json::to_value(by_id("01DONE")).unwrap().get("state").is_none());
        assert_eq!(serde_json::to_value(by_id("01REC")).unwrap()["state"], "recorded");
    }

    /// 실제 `tractus recording finish`가 쓴 transcript.json과 `tractus-rec`가 쓴 recording.json(pauses 포함)을 그대로 읽는다 (2026-10-14): kind·asr 키가 없고 diarization은 null이다
    #[test]
    fn reads_real_core_and_recorder_output() {
        let home = temp_home("realjson");
        let note = home.join("meetings/2026-10-14_녹음_17_44_01M4WSBRKTBY3NXVZB3CPXM9MT");
        fs::create_dir_all(&note).unwrap();
        fs::write(
            note.join("transcript.json"),
            r#"{"schema_version": 2, "state": "recorded", "meeting_id": "01M4WSBRKTBY3NXVZB3CPXM9MT", "title": "녹음 17:44", "created_at": "2026-10-14T17:44:12+09:00",
 "audio": {"file": "audio.ogg", "duration_sec": 12.0, "source": "R1", "sha256": "ea1c"}, "speakers": {}, "diarization": null, "segments": []}"#,
        )
        .unwrap();
        fs::write(note.join("audio.ogg"), b"OggS").unwrap();
        let m = list(&home).into_iter().next().unwrap();
        assert_eq!((m.state.as_deref(), m.segments, m.duration_sec), (Some("recorded"), 0, 12.0));
        assert!(load(&home, "01M4WSBRKTBY3NXVZB3CPXM9MT").unwrap().segments.is_empty());

        let rec = home.join("recordings/01R1");
        fs::create_dir_all(&rec).unwrap();
        fs::write(
            rec.join("recording.json"),
            r#"{"duration" : 12.01, "echo_cancel" : false, "marks" : [{"kind" : "bookmark", "t" : 6, "text" : null}],
 "pauses" : [{"at" : 6, "wall_end" : "2026-10-14T17:44:21+09:00", "wall_start" : "2026-10-14T17:44:18+09:00"}],
 "schema_version" : 1, "started_at" : "2026-10-14T17:44:12+09:00", "tracks" : {"mic" : "mic.wav", "system" : "system.wav"}}"#,
        )
        .unwrap();
        let p = pending_recordings(&home);
        assert_eq!((p.len(), p[0].duration), (1, Some(12.01))); // 일시정지를 뺀 길이
    }
}
