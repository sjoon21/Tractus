//! 노트·미변환 녹음 삭제. 지우지 않고 휴지통으로 옮긴다 (되돌릴 수 있다).
//! 대상은 `$TRACTUS_HOME/meetings/<폴더>` 또는 `recordings/<ULID>` 폴더 하나뿐이다. 그 밖의 경로는 건드리지 않는다.
//! 오류 문자열: 첫 줄은 화면 문장(WORDS.md), 둘째 줄부터는 원래 오류('자세히').

use crate::i18n::{t, tv};
use crate::meetings;
use std::fs;
use std::path::{Path, PathBuf};

fn busy_note() -> String {
    t("이 노트를 처리하는 중이라 지금은 삭제할 수 없습니다. 끝난 뒤에 다시 시도하세요.")
}
fn busy_recording() -> String {
    t("이 녹음을 사용하는 중이라 지금은 삭제할 수 없습니다. 끝난 뒤에 다시 시도하세요.")
}
fn not_ours() -> String {
    t("Tractus 데이터 폴더가 아니라서 삭제하지 않았습니다.")
}

/// `dir`이 `parent` 바로 아래의 진짜 폴더인지 (심볼릭 링크로 바깥을 가리키면 안 된다). 없으면 None
fn directly_under(parent: &Path, dir: &Path) -> Result<bool, String> {
    let meta = match fs::symlink_metadata(dir) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(tv("폴더를 확인하지 못했습니다\n{path}: {e}", &[("path", dir.display().to_string()), ("e", e.to_string())])),
    };
    if !meta.is_dir() {
        return Err(not_ours()); // 심볼릭 링크·파일
    }
    let (Ok(real), Ok(base)) = (dir.canonicalize(), parent.canonicalize()) else { return Err(not_ours()) };
    if real.parent() != Some(base.as_path()) {
        return Err(not_ours());
    }
    Ok(true)
}

/// 노트 폴더를 검사해 돌려준다. 실패: 잘못된 ID, 없음, 변환이 끝나지 않음, 처리 중, 폴더 밖
pub fn note_dir(home: &Path, id: &str, is_busy: impl Fn(&str) -> bool) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    let dir = meetings::find_dir(home, id)?;
    if !directly_under(&home.join("meetings"), &dir)? {
        return Err(t("노트를 찾을 수 없습니다. 삭제되었거나 옮겨졌을 수 있습니다."));
    }
    // 변환이 끝나지 않은 노트(.job.json만 있고 transcript.json이 없는 것)는 이어하기에 쓰므로 옮기지 않는다.
    // transcript.json이 있으면 끝난 노트다: 변환 마지막에 끊겨 .job.json이 남았어도 지울 수 있다 (코어가 transcript.json을 이긴 것으로 본다, docs/desktop.md §2.7.2)
    if dir.join(".job.json").exists() && !dir.join("transcript.json").exists() {
        return Err(t("이 노트는 아직 텍스트 변환이 끝나지 않아 삭제할 수 없습니다."));
    }
    if is_busy(id) {
        return Err(busy_note());
    }
    // 폴더 이름 끝이 같은 다른 폴더가 아니라 이 노트인지 transcript.json으로 확인한다
    let raw = fs::read_to_string(dir.join("transcript.json")).map_err(|_| t("노트를 찾을 수 없습니다. 삭제되었거나 옮겨졌을 수 있습니다."))?;
    let same = serde_json::from_str::<serde_json::Value>(&raw).is_ok_and(|t| t["meeting_id"].as_str() == Some(id));
    if !same {
        return Err(t("노트를 찾을 수 없습니다. 삭제되었거나 옮겨졌을 수 있습니다."));
    }
    Ok(dir)
}

/// 변환 전 녹음 폴더를 검사해 돌려준다 (`recordings/<ULID>`). 녹음 중이거나 변환 중이면 거절한다
pub fn recording_dir(home: &Path, dir: &Path, is_busy: impl Fn(&str) -> bool) -> Result<PathBuf, String> {
    if !meetings::is_recording_dir(home, dir) {
        return Err(not_ours());
    }
    if !directly_under(&home.join("recordings"), dir)? {
        return Err(t("녹음을 찾을 수 없습니다. 삭제되었거나 옮겨졌을 수 있습니다."));
    }
    if is_busy(&dir.to_string_lossy()) {
        return Err(busy_recording());
    }
    Ok(dir.to_path_buf())
}

/// 노트를 휴지통으로. `trash`는 실제 휴지통 호출(`to_trash`)이고 테스트에서는 가짜를 넣는다
pub fn trash_note(home: &Path, id: &str, is_busy: impl Fn(&str) -> bool, trash: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
    trash(&note_dir(home, id, is_busy)?)
}

pub fn trash_recording(home: &Path, dir: &Path, is_busy: impl Fn(&str) -> bool, trash: impl FnOnce(&Path) -> Result<(), String>) -> Result<(), String> {
    trash(&recording_dir(home, dir, is_busy)?)
}

/// 실제 휴지통 호출. macOS는 NSFileManager(`trashItemAtURL`)를 쓴다: Finder 자동화 권한 없이 동작하고,
/// 'Put Back'은 일부 시스템에서 안 보일 수 있지만 휴지통에서 꺼내 되돌릴 수 있다.
pub fn to_trash(path: &Path) -> Result<(), String> {
    let mut ctx = ::trash::TrashContext::default();
    #[cfg(target_os = "macos")]
    {
        use ::trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete(path).map_err(|e| tv("휴지통으로 옮기지 못했습니다\n{e}", &[("e", e.to_string())]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn temp_home(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tractus-removal-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("meetings")).unwrap();
        fs::create_dir_all(d.join("recordings")).unwrap();
        d
    }

    fn note(home: &Path, id: &str) -> PathBuf {
        let dir = home.join(format!("meetings/2026-10-08_테스트_{id}"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("transcript.json"), format!(r#"{{"meeting_id":"{id}","segments":[]}}"#)).unwrap();
        dir
    }

    /// 가짜 휴지통: 받은 경로를 기록만 한다 (아무것도 옮기지 않는다)
    type Seen = Rc<RefCell<Vec<PathBuf>>>;

    fn spy() -> (Seen, impl Fn(&Path) -> Result<(), String>) {
        let seen = Rc::new(RefCell::new(vec![]));
        let log = seen.clone();
        (seen, move |p: &Path| {
            log.borrow_mut().push(p.to_path_buf());
            Ok(())
        })
    }

    #[test]
    fn trashes_only_the_matching_note_folder() {
        let home = temp_home("ok");
        let a = note(&home, "01AAA");
        let _b = note(&home, "01BBB");
        let seen = RefCell::new(vec![]);
        trash_note(&home, "01AAA", |_| false, |p| { seen.borrow_mut().push(p.to_path_buf()); Ok(()) }).unwrap();
        assert_eq!(*seen.borrow(), vec![a]);
    }

    #[test]
    fn accepts_memo_folder_without_audio_written_by_the_core() {
        let home = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/memo_home");
        let dir = note_dir(&home, "01M4SQKXTMEQ5BPCG841527FXK", |_| false).unwrap();
        assert!(dir.join("transcript.json").is_file() && !dir.join("audio.ogg").exists());
    }

    #[test]
    fn accepts_recording_note_with_memo_written_by_the_core() {
        let home = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/memo_home");
        let dir = note_dir(&home, "01M4SV7KREWFM3MJPYR83JJD3M", |_| false).unwrap();
        assert!(dir.join("transcript.json").is_file() && dir.join("audio.ogg").exists());
    }

    #[test]
    fn rejects_bad_ids_without_trashing() {
        let home = temp_home("ids");
        note(&home, "01AAA");
        fs::write(home.join("secret.txt"), "x").unwrap();
        for id in ["", "..", "../meetings", "a/b", "a\\b", "01AAA/..", ".", "01 AAA", "01AAA\n"] {
            let called = RefCell::new(false);
            let r = trash_note(&home, id, |_| false, |_| { *called.borrow_mut() = true; Ok(()) });
            assert!(r.is_err(), "{id:?}");
            assert!(!*called.borrow(), "{id:?}");
        }
        assert!(home.join("secret.txt").exists());
    }

    #[test]
    fn refuses_missing_note_with_a_sentence() {
        let home = temp_home("missing");
        let (seen, f) = spy();
        let e = trash_note(&home, "01NOPE", |_| false, f).unwrap_err();
        assert!(e.contains("찾을 수 없습니다") && !e.contains('\n'));
        assert!(seen.borrow().is_empty());
        // 폴더는 있지만 transcript.json이 없는 것(변환 중에 만든 폴더)도 노트가 아니다
        fs::create_dir_all(home.join("meetings/2026-10-08_x_01HALF")).unwrap();
        assert!(note_dir(&home, "01HALF", |_| false).unwrap_err().contains("찾을 수 없습니다"));
    }

    #[test]
    fn refuses_unfinished_job_and_busy_note() {
        let home = temp_home("busy");
        let dir = note(&home, "01JOB");
        // 변환 중인 폴더: .job.json만 있고 transcript.json이 아직 없다
        fs::write(dir.join(".job.json"), "{}").unwrap();
        fs::rename(dir.join("transcript.json"), dir.join("transcript.json.bak")).unwrap();
        assert!(note_dir(&home, "01JOB", |_| false).unwrap_err().contains("변환이 끝나지 않아"));
        fs::rename(dir.join("transcript.json.bak"), dir.join("transcript.json")).unwrap();
        // 끝난 노트에 .job.json이 남았어도(transcript.json이 이긴다) 지울 수 있다
        assert!(note_dir(&home, "01JOB", |_| false).is_ok());
        fs::remove_file(dir.join(".job.json")).unwrap();
        assert!(note_dir(&home, "01JOB", |_| false).is_ok());
        let e = note_dir(&home, "01JOB", |k| k == "01JOB").unwrap_err();
        assert!(e.contains("처리하는 중") && dir.exists());
        assert!(note_dir(&home, "01JOB", |k| k == "01OTHER").is_ok());
    }

    #[test]
    fn refuses_folder_whose_transcript_has_another_id() {
        let home = temp_home("otherid");
        let dir = home.join("meetings/2026-10-08_t_01XYZ");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("transcript.json"), r#"{"meeting_id":"01ZZZ","segments":[]}"#).unwrap();
        assert!(note_dir(&home, "01XYZ", |_| false).is_err());
        fs::write(dir.join("transcript.json"), "{깨짐").unwrap();
        assert!(note_dir(&home, "01XYZ", |_| false).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_folder_that_escapes_home() {
        let home = temp_home("symlink");
        let outside = std::env::temp_dir().join(format!("tractus-removal-outside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&outside);
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("transcript.json"), r#"{"meeting_id":"01LINK","segments":[]}"#).unwrap();
        std::os::unix::fs::symlink(&outside, home.join("meetings/2026-10-08_링크_01LINK")).unwrap();
        let (seen, f) = spy();
        assert_eq!(trash_note(&home, "01LINK", |_| false, f).unwrap_err(), not_ours());
        assert!(seen.borrow().is_empty() && outside.join("transcript.json").exists());
        // 녹음 폴더도 같다
        std::os::unix::fs::symlink(&outside, home.join("recordings/01LINKREC")).unwrap();
        assert_eq!(recording_dir(&home, &home.join("recordings/01LINKREC"), |_| false).unwrap_err(), not_ours());
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn meetings_dir_itself_may_be_a_symlink_to_another_volume() {
        // 데이터를 다른 곳에 두고 meetings를 링크로 연결한 경우: 그 아래 폴더는 진짜 폴더이므로 허용한다
        let home = temp_home("linked-meetings");
        let real = std::env::temp_dir().join(format!("tractus-removal-real-{}", std::process::id()));
        let _ = fs::remove_dir_all(&real);
        fs::create_dir_all(&real).unwrap();
        fs::remove_dir_all(home.join("meetings")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&real, home.join("meetings")).unwrap();
        note(&home, "01REAL");
        assert!(note_dir(&home, "01REAL", |_| false).is_ok());
        let _ = fs::remove_dir_all(&real);
    }

    #[test]
    fn recording_dir_guards() {
        let home = temp_home("rec");
        let rec = home.join("recordings/01REC");
        fs::create_dir_all(&rec).unwrap();
        assert_eq!(recording_dir(&home, &rec, |_| false).unwrap(), rec);
        let busy_key = rec.to_string_lossy().into_owned();
        assert!(recording_dir(&home, &rec, |k| k == busy_key).unwrap_err().contains("사용하는 중"));
        for bad in [home.join("recordings"), home.join("recordings/.."), home.join("meetings"), home.join("recordings/01REC/.."), PathBuf::from("/"), home.clone()] {
            assert_eq!(recording_dir(&home, &bad, |_| false).unwrap_err(), not_ours(), "{bad:?}");
        }
        assert!(recording_dir(&home, &home.join("recordings/01GONE"), |_| false).unwrap_err().contains("찾을 수 없습니다"));
    }

    #[test]
    fn fake_trash_move_removes_only_the_note() {
        let home = temp_home("move");
        let a = note(&home, "01AAA");
        let b = note(&home, "01BBB");
        let bin = home.join("fake-bin");
        fs::create_dir_all(&bin).unwrap();
        trash_note(&home, "01AAA", |_| false, |p| fs::rename(p, bin.join(p.file_name().unwrap())).map_err(|e| e.to_string())).unwrap();
        assert!(!a.exists() && b.exists() && bin.join(a.file_name().unwrap()).join("transcript.json").exists());
        assert_eq!(meetings::list(&home).len(), 1);
    }

    #[test]
    fn trash_failure_keeps_sentence_and_detail_on_separate_lines() {
        let home = temp_home("fail");
        let dir = note(&home, "01AAA");
        let e = trash_note(&home, "01AAA", |_| false, |_| Err("휴지통으로 옮기지 못했습니다\n권한 없음".into())).unwrap_err();
        assert_eq!(e.split_once('\n'), Some(("휴지통으로 옮기지 못했습니다", "권한 없음")));
        assert!(dir.exists());
    }

    /// 실제 휴지통 호출 (`cargo test -- --ignored real_trash`). 임시 폴더 하나만 옮기고, 휴지통에 간 그 항목만 이름으로 지운다
    #[test]
    #[ignore = "실제 휴지통을 쓴다"]
    fn real_trash_moves_throwaway_note_into_user_trash() {
        let home = temp_home("real");
        let id = format!("01REAL{}", std::process::id());
        let dir = note(&home, &id);
        let name = dir.file_name().unwrap().to_owned();
        let other = note(&home, "01KEEP");
        trash_note(&home, &id, |_| false, to_trash).unwrap();
        assert!(!dir.exists() && other.exists());
        let in_trash = Path::new(&std::env::var("HOME").unwrap()).join(".Trash").join(&name);
        assert!(in_trash.join("transcript.json").is_file(), "휴지통에 없음: {in_trash:?}");
        fs::remove_dir_all(&in_trash).unwrap();
        assert_eq!(meetings::list(&home).len(), 1);
    }
}
