//! 오래 걸리는 작업: 변환·요약·단어 싱크·가져오기("job"), 질문("ask"), 검색 정보 갱신.
//! 도는 동안 대상을 쓰는 중으로 표시하고(`hold`), 끝나면(exit 이벤트) 푼다.

use crate::i18n::tv;
use super::{ask, attach, blocking, cancel_index, hold, is_busy, is_meeting_id, last_error_line, meetings, procs, release, AppState, BusyGuard};
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::io::Write;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

/// 가져오기 작업이 쓰는 표시 대상 (노트 ID나 녹음 폴더가 아니므로 삭제를 막지 않는다)
const IMPORT_TARGET: &str = "<import>";
/// 백그라운드 검색 정보 갱신이 쓰는 표시 대상
const INDEX_TARGET: &str = "<index>";
/// 노트 하나에 묶이지 않는 질문(전체 범위)이 쓰는 표시 대상 (갱신이 비켜 간다. 삭제는 막지 않는다)
const ASK_TARGET: &str = "<ask>";

/// 작업 종류 → tractus 인수. 대상은 종류마다 검사한다
fn job_args(home: &Path, kind: &str, target: &str) -> Result<Vec<String>, String> {
    let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect();
    match kind {
        "transcribe" => {
            // 녹음 폴더만 받는다 (임의 경로 전사 방지. 성공하면 코어가 이 폴더를 지운다)
            if !meetings::is_recording_dir(home, Path::new(target)) {
                return Err(tv("녹음 폴더가 아닙니다: {path}", &[("path", target.to_string())]));
            }
            Ok(args(&["transcribe", "--recording", target, "--progress-json"]))
        }
        "summarize" if is_meeting_id(target) => Ok(args(&["summarize", target, "--progress-json"])),
        // 단어 타이밍 (Phase 6.1). words가 없는 세그먼트만 맞춘다. 정렬하는 동안 앱에서 고친 문장은 코어가 덮어쓰지 않는다
        "align" if is_meeting_id(target) => Ok(args(&["align", target, "--progress-json"])),
        // 파일 가져오기 (Phase 5.5). 원본 파일은 건드리지 않는다. 이미 전사한 파일이면 코어가 duplicate 경고 + done
        "import" => import_args(Path::new(target)),
        _ => Err(tv("잘못된 작업: {kind} {target}", &[("kind", kind.to_string()), ("target", target.to_string())])),
    }
}

/// 전사·요약·단어 타이밍 작업. 이벤트는 "job"으로 보내고 {job, kind}를 덧붙인다. job은 프론트엔드가 만든 ID.
/// append_to: 글만 있는 노트의 ID. 있으면(transcribe·import만) 새 노트를 만들지 않고 그 노트에 녹음을 덧붙인다 (`--append-to`, docs/desktop.md §2.11). 작업하는 동안 그 노트는 삭제할 수 없다
#[tauri::command]
pub fn job_start(app: AppHandle, state: State<'_, AppState>, kind: String, target: String, job: String, append_to: Option<String>, provider: Option<String>) -> Result<(), String> {
    let s = state.settings();
    let args = s.with_asr_engine(attach::with_target(job_args(&s.home(), &kind, &target)?, &kind, append_to.as_deref(), &s.home(), |t| is_busy(&state.busy, t))?);
    // provider: 요약에서 고른 AI 서비스 (없으면 기본 서비스). 다른 작업은 쓰지 않는다
    let cmd = match kind.as_str() {
        "summarize" => state.llm_cmd(&args, provider.as_deref())?,
        "transcribe" | "import" => s.tractus_embed(&args), // 끝나면 색인한다
        _ => s.tractus(&args),
    };
    let tag = json!({"job": job, "kind": kind}).as_object().unwrap().clone();
    // 노트·녹음을 쓰는 동안은 삭제를 거절한다. 가져오기는 대상이 아직 없어 IMPORT_TARGET으로 표시만 한다 (백그라운드 검색 정보 갱신이 비켜 간다)
    let held = if kind == "import" { IMPORT_TARGET } else { target.as_str() };
    let key = Some((state.busy.clone(), hold(&state.busy, held)));
    let note = append_to.as_deref().map(|id| (state.busy.clone(), hold(&state.busy, id)));
    cancel_index(&state.index);
    let (slot, note_slot) = (key.clone(), note.clone());
    // stdin은 쓰지 않으므로 바로 닫는다
    let started = procs::spawn_streaming(cmd, tag, move |ev| {
        if let (true, Some((busy, k))) = (ev["event"] == "exit", &slot) {
            release(busy, k);
        }
        if let (true, Some((busy, k))) = (ev["event"] == "exit", &note_slot) {
            release(busy, k);
        }
        let _ = app.emit("job", ev);
    });
    match (started, key) {
        (Ok(_), _) => Ok(()),
        (Err(e), key) => {
            for (busy, k) in key.into_iter().chain(note) {
                release(&busy, &k);
            }
            Err(e)
        }
    }
}

/// 회의 질의 (Phase 6.3). 이벤트는 "ask"로 보내고 {job}을 덧붙인다. meeting이 있으면 그 회의만 보고 chat.json에 남긴다
#[tauri::command]
#[allow(clippy::too_many_arguments)] // 프론트엔드 invoke 인수 그대로
pub fn ask_start(
    app: AppHandle,
    state: State<'_, AppState>,
    job: String,
    meeting: Option<String>,
    from: Option<String>,
    to: Option<String>,
    question: String,
    history: Vec<ask::ChatMessage>,
    provider: Option<String>,
) -> Result<(), String> {
    let args = ask::ask_args(meeting.as_deref(), from.as_deref(), to.as_deref())?;
    let input = ask::ask_input(&question, &history)?;
    let cmd = state.llm_cmd(&args, provider.as_deref())?;
    let tag = json!({ "job": job }).as_object().unwrap().clone();
    let (asks, key) = (state.asks.clone(), job.clone());
    // 한 노트에 묻는 동안은 그 노트 삭제를 거절한다
    // 전체 범위 질문도 표시한다 (검색 정보 갱신이 비켜 가고, 이미 돌고 있으면 멈춘다)
    let held = Some((state.busy.clone(), hold(&state.busy, meeting.as_deref().unwrap_or(ASK_TARGET))));
    cancel_index(&state.index);
    let slot = held.clone();
    // 넣기 전에 잠가 둔다: 바로 끝나는 프로세스의 exit가 넣기보다 먼저 지우지 않게
    let mut running = state.asks.lock().unwrap();
    let spawned = procs::spawn_streaming(cmd, tag, move |ev| {
        if ev["event"] == "exit" {
            asks.lock().unwrap().remove(&key);
            if let Some((busy, k)) = &slot {
                release(busy, k);
            }
        }
        let _ = app.emit("ask", ev);
    });
    let (mut stdin, child) = match spawned {
        Ok(p) => p,
        Err(e) => {
            if let Some((busy, k)) = &held {
                release(busy, k);
            }
            return Err(e);
        }
    };
    running.insert(job, child);
    // 코어는 stdin을 끝까지 읽고 시작한다. 파이썬이 뜨는 동안 UI 스레드가 파이프에 막히지 않게 따로 쓰고 닫는다
    std::thread::spawn(move || {
        if let Err(e) = stdin.write_all(input.as_bytes()) {
            eprintln!("질문을 넘기지 못했습니다: {e}"); // 코어가 입력 오류로 끝나고 exit가 간다
        }
    });
    Ok(())
}

/// 질문 멈추기. 이미 끝났으면 아무것도 하지 않는다 (exit 이벤트는 프로세스가 끝나며 간다)
#[tauri::command]
pub fn ask_cancel(state: State<'_, AppState>, job: String) {
    let child = state.asks.lock().unwrap().get(&job).cloned();
    if let Some(c) = child {
        let _ = c.lock().unwrap().kill();
    }
}

/// 수정한 문장을 검색에 반영한다: `tractus index` (바뀐 노트만 다시 읽고 임베딩한다). 앱이 한가할 때 조용히 부른다.
/// 다른 작업(변환·요약·단어 싱크·녹음·질문·수정·내보내기)이 하나라도 돌고 있거나 이미 갱신 중이면 하지 않고 false를 돌려준다.
/// 실행했으면 true. 도는 중에 변환·녹음·질문이 시작하면 갱신 프로세스를 멈추고 false (다음 갱신이 이어서 한다). 실패는 오류 문장(코어 마지막 줄)
#[tauri::command]
pub async fn index_refresh(state: State<'_, AppState>) -> Result<bool, String> {
    let s = state.settings();
    let Some(guard) = BusyGuard::new_if_idle(&state.busy, INDEX_TARGET) else { return Ok(false) };
    let (busy, slot) = (state.busy.clone(), state.index.clone());
    blocking(move || {
        let _guard = guard;
        let (tx, rx) = std::sync::mpsc::channel();
        let (stdin, child) = procs::spawn_streaming(s.tractus_embed(&["index".to_string()]), serde_json::Map::new(), move |ev| {
            if ev["event"] == "exit" {
                let _ = tx.send(ev);
            }
        })?;
        drop(stdin);
        *slot.lock().unwrap() = Some(child);
        // 시작하는 사이에 다른 작업이 표시를 하고 cancel_index를 지나갔을 수 있다: 내 표시 말고 다른 표시가 있으면 비켜 준다
        if busy.lock().unwrap().len() > 1 {
            cancel_index(&slot);
        }
        let exit = rx.recv().map_err(|e| e.to_string());
        *slot.lock().unwrap() = None;
        index_outcome(&exit?)
    })
    .await
}

/// 검색 정보 갱신 프로세스의 exit 이벤트 → 했으면 true, 다른 작업에 밀려 멈췄으면 false(신호로 끝나 종료 코드가 없다), 실패는 오류 문장
fn index_outcome(exit: &Value) -> Result<bool, String> {
    match exit["code"].as_i64() {
        Some(0) => Ok(true),
        None => Ok(false),
        Some(code) => Err(last_error_line(exit["stderr"].as_str().unwrap_or("")).unwrap_or_else(|| tv("스마트 검색 정보를 갱신하지 못했습니다 (종료 코드 {code})", &[("code", code.to_string())]))),
    }
}

/// 가져올 수 있는 파일 (lib.ts IMPORT_EXTS와 같다). 대소문자 무시
const IMPORT_EXTS: &[&str] = &["m4a", "mp3", "wav", "aac", "flac", "ogg", "opus", "webm", "mp4", "mov", "m4v"];

/// `tractus transcribe <파일> --progress-json`. 절대 경로의 기존 파일이고 확장자가 allowlist에 있을 때만
fn import_args(path: &Path) -> Result<Vec<String>, String> {
    let ext_ok = path.extension().and_then(OsStr::to_str).is_some_and(|e| IMPORT_EXTS.contains(&e.to_ascii_lowercase().as_str()));
    if !(path.is_absolute() && ext_ok && path.is_file()) {
        return Err(tv("가져올 수 없는 파일입니다: {path}", &[("path", path.display().to_string())]));
    }
    Ok(vec!["transcribe".into(), path.to_string_lossy().into_owned(), "--progress-json".into()])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Busy;
    use std::path::PathBuf;

    #[test]
    fn import_command_args() {
        let dir = std::env::temp_dir().join(format!("tractus-import-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("회의 녹음.MOV"); // 대소문자 무시
        std::fs::write(&file, b"x").unwrap();
        let args = import_args(&file).unwrap();
        assert_eq!(args, ["transcribe", file.to_str().unwrap(), "--progress-json"]);
        for bad in [dir.join("없음.m4a"), dir.clone(), PathBuf::from("rel/a.m4a")] {
            assert!(import_args(&bad).is_err(), "{bad:?}");
        }
        std::fs::write(dir.join("a.txt"), b"x").unwrap();
        assert!(import_args(&dir.join("a.txt")).is_err());
        std::fs::write(dir.join(".m4a"), b"x").unwrap();
        assert!(import_args(&dir.join(".m4a")).is_err()); // 확장자가 아니라 숨김 파일 이름
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn job_command_args() {
        let home = Path::new("/h");
        assert_eq!(job_args(home, "align", "01ABC").unwrap(), ["align", "01ABC", "--progress-json"]);
        assert_eq!(job_args(home, "summarize", "01ABC").unwrap(), ["summarize", "01ABC", "--progress-json"]);
        assert_eq!(job_args(home, "transcribe", "/h/recordings/01REC").unwrap(), ["transcribe", "--recording", "/h/recordings/01REC", "--progress-json"]);
        for (kind, target) in [("align", "../x"), ("align", ""), ("align", "01ABC --force"), ("summarize", "a/b"), ("transcribe", "/etc"), ("rm", "01ABC")] {
            assert!(job_args(home, kind, target).is_err(), "{kind} {target}");
        }
    }

    #[test]
    fn index_refresh_runs_only_when_nothing_else_is_busy_and_one_at_a_time() {
        let busy = Busy::default();
        let first = BusyGuard::new_if_idle(&busy, INDEX_TARGET).expect("한가하면 잡는다");
        assert!(BusyGuard::new_if_idle(&busy, INDEX_TARGET).is_none(), "이미 갱신 중이면 하나만");
        drop(first);
        // 변환·요약·수정·녹음·가져오기 같은 다른 표시가 있으면 비켜 간다
        for target in ["01AAA", "/h/recordings/01REC", IMPORT_TARGET] {
            let key = hold(&busy, target);
            assert!(BusyGuard::new_if_idle(&busy, INDEX_TARGET).is_none(), "{target}");
            release(&busy, &key);
        }
        assert!(BusyGuard::new_if_idle(&busy, INDEX_TARGET).is_some());
        // 갱신 표시는 어느 노트의 삭제도 막지 않는다
        let _g = BusyGuard::new(&busy, INDEX_TARGET);
        assert!(!is_busy(&busy, "01AAA"));
    }

    #[test]
    fn index_outcome_maps_exit_events() {
        assert_eq!(index_outcome(&json!({"code": 0, "stderr": ""})), Ok(true));
        assert_eq!(index_outcome(&json!({"code": null, "stderr": ""})), Ok(false)); // kill로 비켜 줬다
        assert_eq!(index_outcome(&json!({"code": 1, "stderr": "log\nError: 디스크가 가득 찼습니다"})), Err("디스크가 가득 찼습니다".into()));
        assert!(index_outcome(&json!({"code": 2, "stderr": ""})).unwrap_err().contains("종료 코드 2"));
    }

    #[test]
    fn global_ask_holds_a_busy_mark_that_blocks_index_but_not_delete() {
        let busy = Busy::default();
        let key = hold(&busy, ASK_TARGET);
        assert!(BusyGuard::new_if_idle(&busy, INDEX_TARGET).is_none());
        assert!(!is_busy(&busy, "01AAA"));
        release(&busy, &key);
    }
}
