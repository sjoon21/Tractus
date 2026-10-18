//! Obsidian으로 보내기 (docs/design/obsidian-export.md, docs/desktop.md §2.18).
//! 설정 `obsidian_vault`(비면 아직 안 고름)·`obsidian_audio`와, 노트 하나를 볼트에 쓰는 `obsidian_send`(`tractus obsidian`).

use crate::{blocking, expand, is_meeting_id, run_tractus, stdout_json, summaries, AppState, BusyGuard};
use serde_json::{json, Value};
use std::path::Path;
use tauri::State;

/// 설정 파일의 두 키만 바꾼다 (다른 키·환경변수에서 온 기본값은 그대로). 볼트는 비우거나 있는 폴더의 절대 경로
pub fn merge_obsidian(raw: Option<&str>, vault: &str, audio: bool) -> Result<String, String> {
    if !vault.is_empty() && !(Path::new(vault).is_absolute() && Path::new(vault).is_dir()) {
        return Err(format!("볼트 폴더를 찾지 못했습니다: {vault}"));
    }
    let mut v: Value = raw.and_then(|r| serde_json::from_str(r).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v["obsidian_vault"] = json!(vault);
    v["obsidian_audio"] = json!(audio);
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_obsidian(state: State<'_, AppState>, vault: String, audio: bool) -> Result<(), String> {
    crate::patch_settings(&state.config_path, |raw| merge_obsidian(raw, &vault, audio))?;
    let mut s = state.settings.lock().unwrap();
    s.obsidian_vault = vault;
    s.obsidian_audio = audio;
    Ok(())
}

/// `tractus obsidian <id> --vault=<볼트> [--summary=K] [--audio] [--force]`. 값은 `=`로 붙인다 (`-`로 시작하는 경로를 옵션으로 읽지 않게)
fn send_args(id: &str, vault: &Path, summary: Option<&str>, audio: bool, force: bool) -> Result<Vec<String>, String> {
    if !is_meeting_id(id) || !vault.is_absolute() || summary.is_some_and(|k| !summaries::is_summary_key(k)) {
        return Err(format!("잘못된 보내기: {id} {}", vault.display()));
    }
    let mut args = vec!["obsidian".into(), id.into(), format!("--vault={}", vault.display())];
    args.extend(summary.map(|k| format!("--summary={k}")));
    args.extend(audio.then(|| "--audio".into()));
    args.extend(force.then(|| "--force".into()));
    Ok(args)
}

/// 노트를 설정의 볼트로 보낸다 → `{status: created|updated|unchanged|edited, path, audio}`. edited면 아무것도 쓰지 않았다 (화면이 묻고 force로 다시 부른다)
#[tauri::command]
pub async fn obsidian_send(state: State<'_, AppState>, id: String, summary: Option<String>, force: bool) -> Result<Value, String> {
    let s = state.settings();
    if s.obsidian_vault.is_empty() {
        return Err("Obsidian 볼트를 먼저 고르세요".into());
    }
    let args = send_args(&id, &expand(&s.obsidian_vault), summary.as_deref(), s.obsidian_audio, force)?;
    let guard = BusyGuard::new(&state.busy, &id);
    blocking(move || {
        let _guard = guard;
        stdout_json(&run_tractus(&s, &args, None, "Obsidian으로 보내지 못했습니다")?)
    })
    .await
}

/// `obsidian://open?path=…`의 경로 부분: 안전한 글자 말고는 모두 %XX
fn percent(path: &str) -> String {
    path.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~/".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// 보낸 파일을 Obsidian에서 연다. 설정한 볼트의 Tractus 폴더 안에 있는 .md만 받는다
#[tauri::command]
pub fn obsidian_open(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let root = expand(&state.settings().obsidian_vault).join("Tractus").canonicalize().map_err(|_| "볼트를 찾지 못했습니다".to_string())?;
    let p = Path::new(&path).canonicalize().map_err(|_| "보낸 파일을 찾지 못했습니다".to_string())?;
    if !p.starts_with(&root) || p.extension().is_none_or(|e| e != "md") {
        return Err(format!("열 수 없는 파일입니다: {path}"));
    }
    tauri_plugin_opener::open_url(format!("obsidian://open?path={}", percent(&p.to_string_lossy())), None::<&str>).map_err(|e| format!("Obsidian을 열지 못했습니다\n{e}"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn obsidian_url_path_is_percent_encoded() {
        assert_eq!(super::percent("/Users/me/볼트/a b&c.md"), "/Users/me/%EB%B3%BC%ED%8A%B8/a%20b%26c.md");
    }

    use super::*;

    #[test]
    fn send_args_pass_values_with_equals_and_reject_bad_input() {
        assert_eq!(send_args("01ABC", Path::new("/v"), None, false, false).unwrap(), ["obsidian", "01ABC", "--vault=/v"]);
        assert_eq!(send_args("01ABC", Path::new("/-v"), Some("brief"), true, true).unwrap(), ["obsidian", "01ABC", "--vault=/-v", "--summary=brief", "--audio", "--force"]);
        assert!(send_args("../x", Path::new("/v"), None, false, false).is_err());
        assert!(send_args("01ABC", Path::new("v"), None, false, false).is_err());
        assert!(send_args("01ABC", Path::new("/v"), Some("../x"), false, false).is_err());
    }

    #[test]
    fn obsidian_settings_save_only_their_keys() {
        let dir = std::env::temp_dir();
        let v: Value = serde_json::from_str(&merge_obsidian(Some(r#"{"home":"/x"}"#), dir.to_str().unwrap(), true).unwrap()).unwrap();
        assert_eq!(v, json!({"home": "/x", "obsidian_vault": dir.to_str().unwrap(), "obsidian_audio": true}));
        assert_eq!(serde_json::from_str::<Value>(&merge_obsidian(None, "", false).unwrap()).unwrap(), json!({"obsidian_vault": "", "obsidian_audio": false}));
        assert!(merge_obsidian(None, "relative", false).is_err() && merge_obsidian(None, "/no/such/vault/xyz", false).is_err());
        let s: crate::Settings = serde_json::from_str(r#"{"home":"/x"}"#).unwrap();
        assert!(s.obsidian_vault.is_empty() && !s.obsidian_audio); // 예전 설정 파일: 볼트를 안 고른 상태
    }
}
