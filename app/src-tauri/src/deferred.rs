//! 녹음과 변환의 분리 (docs/desktop.md §2.16 코어, §3.3 앱).
//! - `녹음을 끝내면` 설정(`after_record`): 매번 묻기 | 바로 변환 | 저장만 하고 나중에 변환.
//! - `recording_finish`: 끝난 녹음을 변환 전 노트로 저장한다 (`tractus recording finish`).
//! - `convert_note`: 변환 전 노트를 그 자리에서 텍스트로 변환한다 (`tractus transcribe --into`).
//!
//! 두 작업은 "job" 이벤트로 진행을 보낸다 (`{job, kind: "finish" | "convert"}`). 오류 문자열: 첫 줄은 화면 문장(WORDS.md), 둘째 줄부터는 원래 오류.

use crate::i18n::tv;
use crate::{cancel_index, clean_title, hold, is_meeting_id, meetings, procs, release, AppState};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

/// `after_record`가 받는 값. 화면(afterRecord.ts)이 모르는 값은 "ask"로 읽는다
const AFTER_RECORD: &[&str] = &["ask", "convert", "later"];

/// 설정 파일의 `after_record`만 바꾼다. 환경변수에서 온 기본값(home 등)이 파일에 굳지 않게 다른 키는 그대로 둔다
pub fn merge_after_record(raw: Option<&str>, value: &str) -> Result<String, String> {
    if !AFTER_RECORD.contains(&value) {
        return Err(tv("알 수 없는 설정입니다: {value}", &[("value", value.to_string())]));
    }
    let mut v: Value = raw.and_then(|r| serde_json::from_str(r).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v["after_record"] = json!(value);
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

/// 설정 화면의 `녹음을 끝내면`과 끝낼 때 묻는 창의 `다음부터 묻지 않기`가 바로 저장한다
#[tauri::command]
pub fn set_after_record(state: State<'_, AppState>, value: String) -> Result<(), String> {
    crate::patch_settings(&state.config_path, |raw| merge_after_record(raw, &value))?;
    state.settings.lock().unwrap().after_record = value;
    Ok(())
}

/// `tractus recording finish <녹음 폴더> [--title=T] --progress-json`. 이 앱이 만든 녹음 폴더만 받는다.
/// 제목은 `=`로 붙인다: `-`로 시작하는 제목을 옵션으로 읽지 않게
fn finish_args(home: &Path, dir: &Path, title: Option<&str>) -> Result<Vec<String>, String> {
    if !meetings::is_recording_dir(home, dir) {
        return Err(tv("녹음 폴더가 아닙니다: {path}", &[("path", dir.display().to_string())]));
    }
    let mut args = vec!["recording".to_string(), "finish".into(), dir.to_string_lossy().into_owned(), "--progress-json".into()];
    if let Some(t) = title.map(str::trim).filter(|t| !t.is_empty()) {
        args.push(format!("--title={}", clean_title(t)?));
    }
    Ok(args)
}

/// `tractus transcribe --into <노트 ID> --progress-json`. 노트가 변환 전인지는 코어가 본다 (`not_recorded`)
fn convert_args(id: &str) -> Result<Vec<String>, String> {
    if !is_meeting_id(id) {
        return Err(tv("잘못된 노트 ID: {id}", &[("id", id.to_string())]));
    }
    Ok(["transcribe", "--into", id, "--progress-json"].map(String::from).to_vec())
}

/// 작업 하나를 띄운다. `held`(노트 ID 또는 녹음 폴더)는 끝날 때까지 쓰는 중으로 표시해 삭제를 거절하게 한다.
/// 변환·저장은 모델·디스크를 쓰므로 돌고 있는 백그라운드 검색 정보 갱신은 멈춘다 (다음 갱신이 이어서 한다).
/// `cancellable`이면 프로세스를 작업 ID로 `asks` 표에 넣는다: `ask_cancel`이 kill한다 (새 녹음이 변환을 멈출 때. 변환은 멈춘 곳부터 이어 할 수 있다)
fn start(app: AppHandle, state: &AppState, args: Vec<String>, kind: &str, job: String, held: &str, cancellable: bool) -> Result<(), String> {
    let cmd = state.settings().tractus_embed(&args);
    let tag = json!({"job": job, "kind": kind}).as_object().unwrap().clone();
    let (busy, key) = (state.busy.clone(), hold(&state.busy, held));
    cancel_index(&state.index);
    let (exit_busy, exit_key) = (busy.clone(), key.clone());
    let (asks, job_key) = (state.asks.clone(), job.clone());
    // 넣기 전에 잠가 둔다: 바로 끝나는 프로세스의 exit가 넣기보다 먼저 지우지 않게 (ask_start와 같다)
    let mut running = cancellable.then(|| state.asks.lock().unwrap());
    let started = procs::spawn_streaming(cmd, tag, move |ev| {
        if ev["event"] == "exit" {
            if cancellable {
                asks.lock().unwrap().remove(&job_key);
            }
            release(&exit_busy, &exit_key);
        }
        let _ = app.emit("job", ev);
    });
    match started {
        Ok((_stdin, child)) => {
            // stdin은 쓰지 않으므로 핸들을 바로 버려 닫는다
            if let Some(r) = running.as_mut() {
                r.insert(job, child);
            }
            Ok(())
        }
        Err(e) => {
            release(&busy, &key);
            Err(e)
        }
    }
}

/// 끝난 녹음을 변환 전 노트로 저장한다. 성공하면 코어가 녹음 폴더를 비우고, 실패하면 녹음 폴더가 그대로 남는다 (`변환 대기 중인 녹음`)
#[tauri::command]
pub fn recording_finish(app: AppHandle, state: State<'_, AppState>, dir: String, title: Option<String>, job: String) -> Result<(), String> {
    let s = state.settings();
    let args = finish_args(&s.home(), Path::new(&dir), title.as_deref())?;
    start(app, &state, args, "finish", job, &dir, false)
}

/// 변환 전 노트를 그 자리에서 텍스트로 변환한다. 변환하는 동안 그 노트는 삭제할 수 없다
#[tauri::command]
pub fn convert_note(app: AppHandle, state: State<'_, AppState>, id: String, job: String) -> Result<(), String> {
    let args = state.settings().with_asr_engine(convert_args(&id)?);
    start(app, &state, args, "convert", job, &id, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finish_command_args() {
        let home = Path::new("/h");
        let dir = Path::new("/h/recordings/01REC");
        assert_eq!(finish_args(home, dir, None).unwrap(), ["recording", "finish", "/h/recordings/01REC", "--progress-json"]);
        assert_eq!(finish_args(home, dir, Some("  \n ")).unwrap().len(), 4); // 빈 제목은 코어의 기본 제목(`녹음 HH:MM`)
        // 제목은 한 줄로 줄이고 `=`로 붙인다 (`-`로 시작해도 옵션이 아니다)
        assert_eq!(finish_args(home, dir, Some(" -주간\n 회의 ")).unwrap().last().unwrap(), "--title=-주간 회의");
        assert!(finish_args(home, dir, Some(&"가".repeat(121))).is_err());
        for bad in ["/etc", "/h/recordings", "/h/recordings/../x", "/h/recordings/01REC/mic.wav", "/h/meetings/01ABC", "rel/01REC"] {
            assert!(finish_args(home, Path::new(bad), None).is_err(), "{bad}");
        }
    }

    #[test]
    fn convert_command_args() {
        assert_eq!(convert_args("01ABC").unwrap(), ["transcribe", "--into", "01ABC", "--progress-json"]);
        for bad in ["", "../x", "01ABC --force", "a/b", "-x", "01 ABC"] {
            assert!(convert_args(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn after_record_saves_only_its_key_and_rejects_unknown_values() {
        let v: Value = serde_json::from_str(&merge_after_record(None, "later").unwrap()).unwrap();
        assert_eq!(v, json!({"after_record": "later"}));
        let v: Value = serde_json::from_str(&merge_after_record(Some(r#"{"home":"/x","after_record":"ask"}"#), "convert").unwrap()).unwrap();
        assert_eq!(v, json!({"home": "/x", "after_record": "convert"}));
        assert_eq!(serde_json::from_str::<Value>(&merge_after_record(Some("깨진 파일"), "ask").unwrap()).unwrap(), json!({"after_record": "ask"}));
        assert!(merge_after_record(None, "never").is_err() && merge_after_record(None, "").is_err() && merge_after_record(None, "../x").is_err());
    }

    #[test]
    fn old_settings_files_ask_every_time() {
        let s: crate::Settings = serde_json::from_str(r#"{"home":"/x"}"#).unwrap();
        assert_eq!(s.after_record, "ask");
        let s: crate::Settings = serde_json::from_str(r#"{"after_record":"later"}"#).unwrap();
        assert_eq!(s.after_record, "later");
    }
}
