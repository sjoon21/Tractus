// macOS 권한 안내 (시작 점검·녹음 화면, docs/desktop.md §2.15): 마이크 권한 상태 읽기·묻기, 시스템 설정의 해당 칸 열기.
// 마이크 권한은 녹음 프로그램(tractus-rec, 앱의 하위 프로세스라 Tractus 이름으로 묻는다)이 읽는다.
use std::process::Stdio;

use serde_json::Value;
use tauri::State;

use crate::{blocking, procs, AppState};

/// 열 수 있는 시스템 설정 칸: 마이크, 화면 및 시스템 오디오 녹음
#[cfg(not(target_os = "macos"))]
pub fn privacy_url(pane: &str) -> Option<&'static str> {
    // Windows: 시스템 소리 녹음(loopback)에는 권한이 없다
    (pane == "mic").then_some("ms-settings:privacy-microphone")
}

#[cfg(target_os = "macos")]
pub fn privacy_url(pane: &str) -> Option<&'static str> {
    match pane {
        "mic" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"),
        "audio" => Some("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"),
        _ => None,
    }
}

/// "granted" | "denied" | "undetermined". request면 처음일 때 macOS가 묻는다 (답할 때까지 기다린다)
#[tauri::command]
pub async fn mic_permission(state: State<'_, AppState>, request: bool) -> Result<String, String> {
    let s = state.settings();
    blocking(move || {
        let rec = s.rec_path();
        let mut cmd = procs::command(&rec);
        cmd.arg("mic-permission").envs(s.child_env()).stdin(Stdio::null()).stderr(Stdio::null());
        if request {
            cmd.arg("--request");
        }
        let out = cmd.output().map_err(|e| procs::cannot_run(&rec.to_string_lossy(), e))?;
        let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
        Ok(v["mic"].as_str().unwrap_or("undetermined").to_string())
    })
    .await
}

#[tauri::command]
pub fn open_privacy(pane: String) -> Result<(), String> {
    let url = privacy_url(&pane).ok_or("unknown pane")?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    #[cfg(target_os = "macos")]
    #[test]
    fn only_known_panes_open() {
        assert!(super::privacy_url("mic").unwrap().ends_with("Privacy_Microphone"));
        assert!(super::privacy_url("audio").is_some());
        assert!(super::privacy_url("x-apple.systempreferences:evil").is_none());
    }

    #[cfg(windows)]
    #[test]
    fn windows_opens_only_the_microphone_page() {
        assert_eq!(super::privacy_url("mic"), Some("ms-settings:privacy-microphone"));
        assert!(super::privacy_url("audio").is_none() && super::privacy_url("ms-settings:evil").is_none());
    }
}
