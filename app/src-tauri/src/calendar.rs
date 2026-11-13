//! macOS 캘린더 (docs/design/calendar.md, docs/desktop.md §3.6). 읽기는 녹음 프로그램 `tractus-rec calendar …`(EventKit)가 하고,
//! 앱은 설정(`calendar_enabled`·`calendar_hidden`)과 녹음 폴더의 `event.json`만 다룬다.

use crate::i18n::{t, tv};
use crate::{blocking, procs, AppState, Settings};
use serde_json::{json, Value};
use std::path::Path;
use std::process::Stdio;
use tauri::State;

/// 홈 카드: 진행 중이거나 이 분 안에 시작하는 일정
const AHEAD_MIN: u32 = 15;
const EVENT_FILE: &str = "event.json";
const MAX_TITLE: usize = 200;
const MAX_NAME: usize = 80;
const MAX_ATTENDEES: usize = 50;
const MAX_ID: usize = 256;

/// `tractus-rec calendar <args>` → stdout 한 줄 JSON
fn run(s: &Settings, args: &[String]) -> Result<Value, String> {
    let rec = s.rec_path();
    let out = procs::command(&rec).arg("calendar").args(args).envs(s.child_env()).stdin(Stdio::null()).output().map_err(|e| procs::cannot_run(&rec.to_string_lossy(), e))?;
    if !out.status.success() {
        return Err(tv("캘린더를 읽지 못했습니다\n{detail}", &[("detail", String::from_utf8_lossy(&out.stderr).trim().to_string())]));
    }
    String::from_utf8_lossy(&out.stdout).lines().rev().find_map(|l| serde_json::from_str::<Value>(l).ok()).filter(Value::is_object).ok_or_else(|| t("캘린더를 읽지 못했습니다"))
}

/// 설정 파일의 캘린더 키만 바꾼다 (다른 키는 그대로)
pub fn merge_calendar(raw: Option<&str>, enabled: bool, hidden: &[String]) -> Result<String, String> {
    if hidden.len() > 200 || hidden.iter().any(|id| id.is_empty() || id.len() > 200 || id.starts_with('-')) {
        return Err(t("잘못된 캘린더 ID입니다"));
    }
    let mut v: Value = raw.and_then(|r| serde_json::from_str(r).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v["calendar_enabled"] = json!(enabled);
    v["calendar_hidden"] = json!(hidden);
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

fn save(state: &AppState, enabled: bool, hidden: Vec<String>) -> Result<(), String> {
    crate::patch_settings(&state.config_path, |raw| merge_calendar(raw, enabled, &hidden))?;
    let mut s = state.settings.lock().unwrap();
    (s.calendar_enabled, s.calendar_hidden) = (enabled, hidden);
    Ok(())
}

/// 설정 화면: 연결 여부·권한·캘린더 목록 → `{enabled, access, calendars: [{id, title, source}], hidden}`
#[tauri::command]
pub async fn calendar_status(state: State<'_, AppState>) -> Result<Value, String> {
    let s = state.settings();
    blocking(move || {
        let v = run(&s, &["list".into()])?;
        Ok(json!({"enabled": s.calendar_enabled, "access": v["access"], "calendars": v["calendars"], "hidden": s.calendar_hidden}))
    })
    .await
}

/// `캘린더 연결`: 권한을 묻고(처음이면 macOS 창), 허락되면 켠다. 결과 access를 돌려준다
#[tauri::command]
pub async fn calendar_connect(state: State<'_, AppState>) -> Result<String, String> {
    let s = state.settings();
    let access = blocking(move || Ok(run(&s, &["request".into()])?["access"].as_str().unwrap_or("denied").to_string())).await?;
    if access == "granted" {
        save(&state, true, state.settings().calendar_hidden)?;
    }
    Ok(access)
}

/// 연결 끊기 / 캘린더 켜고 끄기 (끈 캘린더 ID 목록을 통째로 받는다)
#[tauri::command]
pub fn calendar_set(state: State<'_, AppState>, enabled: bool, hidden: Vec<String>) -> Result<(), String> {
    save(&state, enabled, hidden)
}

/// `calendar next`의 인수. 끈 캘린더는 `--exclude ID` (`-`로 시작하는 ID는 merge_calendar가 저장하지 않는다)
fn next_args(hidden: &[String]) -> Vec<String> {
    let mut a = vec!["next".to_string(), "--ahead".into(), AHEAD_MIN.to_string()];
    for id in hidden {
        a.extend(["--exclude".to_string(), id.clone()]);
    }
    a
}

/// 지금·곧 시작하는 일정들 (통화 감지, calls.rs). 연결하지 않았거나 실패하면 빈 목록. 블로킹이라 UI 스레드에서 부르지 않는다
pub fn next_events(s: &Settings) -> Vec<Value> {
    if !s.calendar_enabled {
        return Vec::new();
    }
    run(s, &next_args(&s.calendar_hidden)).ok().and_then(|v| v["events"].as_array().cloned()).unwrap_or_default()
}

/// 홈 카드: 곧 시작하는 일정들 (시작 순). 연결하지 않았거나 권한이 없으면 빈 목록
#[tauri::command]
pub async fn calendar_next(state: State<'_, AppState>) -> Result<Value, String> {
    let s = state.settings();
    if !s.calendar_enabled {
        return Ok(json!([]));
    }
    blocking(move || Ok(run(&s, &next_args(&s.calendar_hidden))?["events"].as_array().cloned().map_or(json!([]), Value::Array))).await
}

/// `calendar range`의 인수: 첫날(YYYY-MM-DD)부터 7일, 끈 캘린더 제외. 날짜 꼴만 여기서 보고 달력에 있는 날인지는 녹음 프로그램이 본다
fn week_args(from: &str, hidden: &[String]) -> Result<Vec<String>, String> {
    let b = from.as_bytes();
    let ok = b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    if !ok {
        return Err(tv("잘못된 날짜입니다: {date}", &[("date", from.to_string())]));
    }
    let mut a = vec!["range".to_string(), "--from".into(), from.to_string(), "--days".into(), "7".into()];
    for id in hidden {
        a.extend(["--exclude".to_string(), id.clone()]);
    }
    Ok(a)
}

/// 홈의 `이번 주` 띠: 첫날부터 7일 동안의 일정 (시작 순, 종일 포함). 연결하지 않았거나 권한이 없으면 빈 목록
#[tauri::command]
pub async fn calendar_week(state: State<'_, AppState>, from: String) -> Result<Value, String> {
    let s = state.settings();
    let args = week_args(&from, &s.calendar_hidden)?;
    if !s.calendar_enabled {
        return Ok(json!([]));
    }
    blocking(move || Ok(run(&s, &args)?["events"].as_array().cloned().map_or(json!([]), Value::Array))).await
}

/// 시스템 설정의 캘린더 개인 정보 화면 (권한을 거부했을 때)
#[tauri::command]
pub fn calendar_privacy() -> Result<(), String> {
    tauri_plugin_opener::open_url("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars", None::<&str>).map_err(|e| e.to_string())
}

/// 녹음을 시작할 일정 → 녹음 폴더의 event.json 내용. 코어(calendar_event.clean_event)가 다시 검사한다
pub fn clean_event(v: &Value) -> Result<Value, String> {
    let text = |k: &str, max: usize| v[k].as_str().map(|x| x.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(max).collect::<String>()).filter(|x| !x.is_empty());
    let (Some(title), Some(start), Some(end)) = (text("title", MAX_TITLE), text("start", 40), text("end", 40)) else {
        return Err(t("일정 정보가 올바르지 않습니다"));
    };
    let mut names: Vec<String> = vec![];
    for n in v["attendees"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        let n = n.split_whitespace().collect::<Vec<_>>().join(" ");
        if !n.is_empty() && n.chars().count() <= MAX_NAME && !n.contains('@') && !names.contains(&n) && names.len() < MAX_ATTENDEES {
            names.push(n);
        }
    }
    let mut ev = json!({"title": title, "start": start, "end": end, "calendar": text("calendar", MAX_TITLE).unwrap_or_default(), "attendees": names});
    // 캘린더의 일정 ID: 이번 주 띠가 일정과 노트를 잇는다. 모양이 이상하면 버린다 (잇기만 못 할 뿐)
    if let Some(id) = v["id"].as_str().filter(|x| !x.is_empty() && x.len() <= MAX_ID && !x.chars().any(char::is_control)) {
        ev["id"] = json!(id);
    }
    Ok(ev)
}

/// 노트 폴더 event.json에서 일정과 노트를 잇는 데 쓰는 것만 (노트 목록 MeetingInfo.event). 없거나 깨졌으면 None
pub fn note_event(note_dir: &Path) -> Option<Value> {
    let v = clean_event(&serde_json::from_str::<Value>(&std::fs::read_to_string(note_dir.join(EVENT_FILE)).ok()?).ok()?).ok()?;
    let mut link = json!({"title": v["title"], "start": v["start"]});
    if v["id"].is_string() {
        link["id"] = v["id"].clone();
    }
    Some(link)
}

pub fn write_event(rec_dir: &Path, event: &Value) -> Result<(), String> {
    let tmp = rec_dir.join(format!("{EVENT_FILE}.tmp"));
    std::fs::write(&tmp, event.to_string()).and_then(|_| std::fs::rename(&tmp, rec_dir.join(EVENT_FILE))).map_err(|e| tv("녹음 폴더를 준비하지 못했습니다\n{e}", &[("e", e.to_string())]))
}

/// 시작하지 못한 녹음 폴더 정리: event.json과 (비어 있으면) 폴더만 지운다
pub fn discard(rec_dir: &Path) {
    let _ = std::fs::remove_file(rec_dir.join(EVENT_FILE));
    let _ = std::fs::remove_file(rec_dir.join(format!("{EVENT_FILE}.tmp")));
    let _ = std::fs::remove_dir(rec_dir);
}

/// 노트 폴더 event.json의 참석자 이름 (참석자 이름 고르기). 없거나 깨졌으면 빈 목록
pub fn attendees(note_dir: &Path) -> Vec<String> {
    std::fs::read_to_string(note_dir.join(EVENT_FILE))
        .ok()
        .and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .and_then(|v| clean_event(&v).ok())
        .map(|v| v["attendees"].as_array().into_iter().flatten().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_is_cleaned_and_bad_events_are_refused() {
        let v = clean_event(&json!({"title": " 주간\n개발 ", "start": "2026-10-16T10:00:00+09:00", "end": "2026-10-16T11:00:00+09:00", "attendees": ["김민수", "김민수", "", 3, " 이지은"]})).unwrap();
        assert_eq!(v, json!({"title": "주간 개발", "start": "2026-10-16T10:00:00+09:00", "end": "2026-10-16T11:00:00+09:00", "calendar": "", "attendees": ["김민수", "이지은"]}));
        assert!(clean_event(&json!({"title": "", "start": "a", "end": "b"})).is_err());
        assert_eq!(clean_event(&json!({"title": "x".repeat(300), "start": "a", "end": "b"})).unwrap()["title"].as_str().unwrap().len(), 200); // 긴 제목은 잘라 쓴다
        assert_eq!(clean_event(&json!({"title": "t", "start": "a", "end": "b", "attendees": ["guest@example.com", "김민수"]})).unwrap()["attendees"], json!(["김민수"])); // 이메일은 남기지 않는다
        assert_eq!(clean_event(&json!({"id": "E1:2", "title": "t", "start": "a", "end": "b"})).unwrap()["id"], "E1:2");
        assert!(clean_event(&json!({"id": "a\nb", "title": "t", "start": "a", "end": "b"})).unwrap().get("id").is_none());
    }

    #[test]
    fn note_event_keeps_only_what_links_a_note() {
        let d = std::env::temp_dir().join(format!("tractus-note-event-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        assert!(note_event(&d).is_none());
        std::fs::write(d.join(EVENT_FILE), r#"{"id": "E1", "title": "주간", "start": "2026-11-05T09:30:00+09:00", "end": "2026-11-05T10:00:00+09:00", "attendees": ["김민수"]}"#).unwrap();
        assert_eq!(note_event(&d), Some(json!({"id": "E1", "title": "주간", "start": "2026-11-05T09:30:00+09:00"})));
        std::fs::remove_dir_all(&d).unwrap();
    }

    #[test]
    fn calendar_settings_save_only_their_keys_and_reject_bad_ids() {
        let v: Value = serde_json::from_str(&merge_calendar(Some(r#"{"home":"/x"}"#), true, &["A".into()]).unwrap()).unwrap();
        assert_eq!(v, json!({"home": "/x", "calendar_enabled": true, "calendar_hidden": ["A"]}));
        assert!(merge_calendar(None, true, &["-x".into()]).is_err() && merge_calendar(None, true, &["".into()]).is_err());
        let s: crate::Settings = serde_json::from_str(r#"{"home":"/x"}"#).unwrap();
        assert!(!s.calendar_enabled && s.calendar_hidden.is_empty()); // 예전 설정 파일: 연결하지 않은 상태 (아무것도 묻지 않는다)
    }

    #[test]
    fn next_args_exclude_hidden_calendars() {
        assert_eq!(next_args(&["A".into(), "B".into()]), ["next", "--ahead", "15", "--exclude", "A", "--exclude", "B"]);
    }

    #[test]
    fn week_args_take_a_date_and_exclude_hidden_calendars() {
        assert_eq!(week_args("2026-11-02", &["A".into()]).unwrap(), ["range", "--from", "2026-11-02", "--days", "7", "--exclude", "A"]);
        for bad in ["2026-1-02", "--days", "2026/11/02", "", "2026-11-02x"] {
            assert!(week_args(bad, &[]).is_err(), "{bad}");
        }
    }

    #[test]
    fn attendees_come_from_the_note_event_file() {
        let d = std::env::temp_dir().join(format!("tractus-cal-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        assert!(attendees(&d).is_empty());
        std::fs::write(d.join(EVENT_FILE), r#"{"title":"t","start":"a","end":"b","attendees":["김민수"]}"#).unwrap();
        assert_eq!(attendees(&d), ["김민수"]);
        std::fs::remove_dir_all(&d).unwrap();
    }
}
