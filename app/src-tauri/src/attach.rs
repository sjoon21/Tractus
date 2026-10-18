//! 글만 있는 노트에 녹음 추가 (docs/desktop.md §2.11).
//! 앱이 녹음을 시작할 때 `recordings/<ULID>/attach.json`(`{"meeting_id": "<노트 ID>"}`)을 써 두고, 변환은 `tractus transcribe … --append-to <노트 ID>`로 한다.
//! 녹음 헬퍼는 attach.json을 모른다. 코어는 변환이 끝나 녹음 폴더를 지울 때 이 파일도 함께 지운다.
//! 오류 문자열: 첫 줄은 화면 문장(WORDS.md).

use crate::i18n::{t, tv};
use crate::meetings;
use std::fs;
use std::path::Path;

pub const ATTACH_FILE: &str = "attach.json";

fn has_audio() -> String {
    t("이미 녹음이 있는 노트에는 녹음을 추가할 수 없습니다.")
}
fn busy_note() -> String {
    t("이 노트를 처리하는 중이라 지금은 녹음을 추가할 수 없습니다. 끝난 뒤에 다시 시도하세요.")
}
fn not_found() -> String {
    t("노트를 찾을 수 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.")
}

fn is_note_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// 녹음을 덧붙일 수 있는 노트인가: 있는 노트이고, 글만 있고(`kind: "memo"`, 오디오 파일 없음), 지금 쓰는 중이 아니다
pub fn check_target(home: &Path, id: &str, is_busy: impl Fn(&str) -> bool) -> Result<(), String> {
    if !is_note_id(id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    let dir = meetings::find_dir(home, id)?;
    let raw = fs::read_to_string(dir.join("transcript.json")).map_err(|_| not_found())?;
    let t: serde_json::Value = serde_json::from_str(&raw).map_err(|_| not_found())?;
    if t["meeting_id"].as_str() != Some(id) {
        return Err(not_found());
    }
    if t["kind"].as_str() != Some("memo") || t["audio"]["file"].as_str().is_some_and(|f| !f.is_empty()) {
        return Err(has_audio());
    }
    if is_busy(id) {
        return Err(busy_note());
    }
    Ok(())
}

/// 녹음 폴더에 대상 노트를 적어 둔다 (임시 파일에 쓴 뒤 이름을 바꾼다)
pub fn write_attach(rec_dir: &Path, id: &str) -> Result<(), String> {
    let tmp = rec_dir.join(format!("{ATTACH_FILE}.tmp"));
    let body = serde_json::json!({ "meeting_id": id }).to_string();
    fs::write(&tmp, body).and_then(|_| fs::rename(&tmp, rec_dir.join(ATTACH_FILE))).map_err(|e| tv("녹음 폴더를 준비하지 못했습니다\n{e}", &[("e", e.to_string())]))
}

/// 시작하지 못한 녹음 폴더 정리: attach.json과 (비어 있으면) 폴더만 지운다
pub fn discard(rec_dir: &Path) {
    let _ = fs::remove_file(rec_dir.join(ATTACH_FILE));
    let _ = fs::remove_file(rec_dir.join(format!("{ATTACH_FILE}.tmp")));
    let _ = fs::remove_dir(rec_dir);
}

/// 녹음 폴더가 기억하는 대상 노트 ID. 없거나 모양이 다르면 None (그 녹음은 새 노트로 변환한다)
pub fn read_attach(rec_dir: &Path) -> Option<String> {
    let t: serde_json::Value = serde_json::from_str(&fs::read_to_string(rec_dir.join(ATTACH_FILE)).ok()?).ok()?;
    t["meeting_id"].as_str().filter(|id| is_note_id(id)).map(str::to_string)
}

/// 변환·가져오기 인수에 `--append-to <노트 ID>`를 붙인다. 다른 작업에는 붙일 수 없다
pub fn with_target(mut args: Vec<String>, kind: &str, id: Option<&str>, home: &Path, is_busy: impl Fn(&str) -> bool) -> Result<Vec<String>, String> {
    let Some(id) = id else { return Ok(args) };
    if !matches!(kind, "transcribe" | "import") {
        return Err(tv("잘못된 작업: {kind} {id}", &[("kind", kind.to_string()), ("id", id.to_string())]));
    }
    check_target(home, id, is_busy)?;
    args.extend(["--append-to".to_string(), id.to_string()]);
    Ok(args)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_home(name: &str) -> PathBuf {
        let home = std::env::temp_dir().join(format!("tractus-attach-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&home);
        fs::create_dir_all(home.join("meetings")).unwrap();
        fs::create_dir_all(home.join("recordings")).unwrap();
        home
    }

    fn note(home: &Path, id: &str, transcript: &str) {
        let d = home.join(format!("meetings/2026-10-13_장보기_{id}"));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("transcript.json"), transcript).unwrap();
    }

    const MEMO: &str = r#"{"meeting_id":"01MEMO","kind":"memo","audio":{"file":null},"segments":[]}"#;

    #[test]
    fn only_a_text_note_that_is_not_busy_is_a_target() {
        let home = temp_home("target");
        note(&home, "01MEMO", MEMO);
        note(&home, "01REC", r#"{"meeting_id":"01REC","audio":{"file":"audio.ogg"},"segments":[]}"#);
        note(&home, "01ODD", r#"{"meeting_id":"01ODD","kind":"memo","audio":{"file":"audio.ogg"},"segments":[]}"#);
        assert!(check_target(&home, "01MEMO", |_| false).is_ok());
        assert_eq!(check_target(&home, "01REC", |_| false).unwrap_err(), has_audio());
        assert_eq!(check_target(&home, "01ODD", |_| false).unwrap_err(), has_audio());
        assert_eq!(check_target(&home, "01MEMO", |k| k == "01MEMO").unwrap_err(), busy_note());
        assert_eq!(check_target(&home, "01GONE", |_| false).unwrap_err(), not_found());
        for bad in ["", "../x", "01 MEMO", "a/b"] {
            assert!(check_target(&home, bad, |_| false).unwrap_err().starts_with("잘못된 노트 ID"), "{bad}");
        }
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn attach_file_round_trips_and_ignores_bad_content() {
        let home = temp_home("file");
        let rec = home.join("recordings/01REC");
        fs::create_dir_all(&rec).unwrap();
        assert_eq!(read_attach(&rec), None);
        write_attach(&rec, "01MEMO").unwrap();
        assert_eq!(read_attach(&rec), Some("01MEMO".into()));
        assert_eq!(fs::read_to_string(rec.join(ATTACH_FILE)).unwrap(), r#"{"meeting_id":"01MEMO"}"#);
        for bad in ["{oops", "[]", r#"{"meeting_id":5}"#, r#"{"meeting_id":"../x"}"#, r#"{"meeting_id":""}"#] {
            fs::write(rec.join(ATTACH_FILE), bad).unwrap();
            assert_eq!(read_attach(&rec), None, "{bad}");
        }
        discard(&rec);
        assert!(!rec.exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn leftover_recording_remembers_its_target_note() {
        let home = temp_home("pending");
        for (name, target) in [("01WITH", Some("01MEMO")), ("01PLAIN", None)] {
            let rec = home.join("recordings").join(name);
            fs::create_dir_all(&rec).unwrap();
            fs::write(rec.join("recording.json"), r#"{"started_at":"2026-10-13T10:00:00+09:00","duration":3.0}"#).unwrap();
            if let Some(id) = target {
                write_attach(&rec, id).unwrap();
            }
        }
        let mut got: Vec<_> = meetings::pending_recordings(&home).into_iter().map(|p| (p.dir.rsplit('/').next().unwrap().to_string(), p.attach_to)).collect();
        got.sort();
        assert_eq!(got, [("01PLAIN".to_string(), None), ("01WITH".to_string(), Some("01MEMO".to_string()))]);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn discard_keeps_a_recording_that_has_tracks() {
        let home = temp_home("discard");
        let rec = home.join("recordings/01REC");
        fs::create_dir_all(&rec).unwrap();
        write_attach(&rec, "01MEMO").unwrap();
        fs::write(rec.join("mic.wav"), b"RIFF").unwrap();
        discard(&rec);
        assert!(rec.join("mic.wav").exists() && !rec.join(ATTACH_FILE).exists());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn append_flag_is_added_only_for_transcribe_and_import_of_a_valid_target() {
        let home = temp_home("args");
        note(&home, "01MEMO", MEMO);
        let base = || vec!["transcribe".to_string(), "--recording".into(), "/h/recordings/01REC".into(), "--progress-json".into()];
        assert_eq!(with_target(base(), "transcribe", None, &home, |_| false).unwrap(), base());
        let with = with_target(base(), "transcribe", Some("01MEMO"), &home, |_| false).unwrap();
        assert_eq!(with[with.len() - 2..], ["--append-to", "01MEMO"]);
        assert!(with_target(base(), "import", Some("01MEMO"), &home, |_| false).is_ok());
        assert!(with_target(base(), "summarize", Some("01MEMO"), &home, |_| false).is_err());
        assert!(with_target(base(), "transcribe", Some("01GONE"), &home, |_| false).is_err());
        assert!(with_target(base(), "transcribe", Some("01MEMO --force"), &home, |_| false).is_err());
        let _ = fs::remove_dir_all(&home);
    }
}
