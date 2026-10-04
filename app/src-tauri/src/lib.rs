//! Tractus 데스크톱 앱 (docs/desktop.md §3). 파일은 직접 읽고, 검색만 상주 `tractus mcp`로 한다.

mod mcp;
mod media;
mod meetings;
mod procs;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

/// 앱 설정. 앱 설정 폴더의 settings.json에 저장한다. GUI 앱은 셸 환경을 물려받지 않으므로 경로는 절대 경로로 둔다.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub tractus_bin: String,
    pub rec_bin: String,
    pub home: String,
    /// 비어 있으면 tractus 기본값($TRACTUS_HOME/models)
    pub models_dir: String,
    /// 개발용: tractus-rec record --fake (권한 없이 합성 신호로 녹음)
    pub fake_recorder: bool,
    /// 마지막으로 고른 녹음 방식: "in_person"(마이크만) | "hybrid"(마이크 + 시스템, 에코 제거). 앱이 해석한다
    pub rec_mode: String,
}

impl Default for Settings {
    fn default() -> Self {
        // 저장소에서 빌드한 앱의 기본값: <repo>/.venv/bin/tractus, <repo>/recorder/.build/release/tractus-rec
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().and_then(Path::parent).unwrap_or(Path::new("/"));
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Settings {
            tractus_bin: repo.join(".venv/bin/tractus").to_string_lossy().into_owned(),
            rec_bin: repo.join("recorder/.build/release/tractus-rec").to_string_lossy().into_owned(),
            home: var("TRACTUS_HOME").unwrap_or_else(|| "~/Tractus".into()),
            models_dir: var("TRACTUS_MODELS_DIR").unwrap_or_default(),
            fake_recorder: false,
            rec_mode: "in_person".into(),
        }
    }
}

fn expand(p: &str) -> PathBuf {
    match (p.strip_prefix("~/"), std::env::var_os("HOME")) {
        (Some(rest), Some(h)) => PathBuf::from(h).join(rest),
        _ => PathBuf::from(p),
    }
}

impl Settings {
    fn home(&self) -> PathBuf {
        expand(&self.home)
    }

    /// 하위 프로세스에 명시적으로 넘기는 환경변수.
    fn child_env(&self) -> Vec<(String, String)> {
        let mut env = vec![
            ("TRACTUS_HOME".into(), self.home().to_string_lossy().into_owned()),
            // GUI 앱의 PATH에는 Homebrew가 없다. ffmpeg를 찾으려면 넣어야 한다
            ("PATH".into(), "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".into()),
            ("PYTHONUNBUFFERED".into(), "1".into()), // 진행 이벤트가 버퍼에 묶이지 않게
            ("PYTHONIOENCODING".into(), "utf-8".into()),
            // 오류를 rich 상자 대신 평문 한 줄로 (stderr 마지막 줄을 그대로 보여 준다)
            ("TYPER_USE_RICH".into(), "0".into()),
        ];
        if !self.models_dir.is_empty() {
            env.push(("TRACTUS_MODELS_DIR".into(), expand(&self.models_dir).to_string_lossy().into_owned()));
        }
        env
    }

    /// tractus CLI는 현재 폴더의 .env/.env.local(API 키)을 읽는다. 저장소 .venv의 실행 파일이면 저장소 루트에서 실행한다.
    fn tractus_cwd(&self) -> PathBuf {
        let bin = expand(&self.tractus_bin);
        match bin.parent().filter(|p| p.ends_with(".venv/bin")).and_then(Path::parent).and_then(Path::parent) {
            Some(repo) => repo.to_path_buf(),
            None => self.home(),
        }
    }

    fn tractus<S: AsRef<OsStr>>(&self, args: &[S]) -> Command {
        let mut cmd = Command::new(expand(&self.tractus_bin));
        cmd.args(args).envs(self.child_env()).current_dir(self.tractus_cwd());
        cmd
    }

    fn mcp_spawn(&self) -> mcp::Spawn {
        mcp::Spawn {
            program: expand(&self.tractus_bin),
            args: vec!["mcp".into()],
            env: self.child_env(),
            cwd: Some(self.tractus_cwd()),
        }
    }
}

struct AppState {
    settings: Mutex<Settings>,
    config_path: PathBuf,
    mcp: Arc<mcp::McpClient>,
    rec: Arc<Mutex<Option<ChildStdin>>>,
}

impl AppState {
    fn settings(&self) -> Settings {
        self.settings.lock().unwrap().clone()
    }
}

/// 파일 읽기·MCP 대기를 블로킹 풀에서 돌린다 (UI·비동기 런타임 스레드를 막지 않게).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.settings()
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) -> Result<(), String> {
    if let Some(dir) = state.config_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    std::fs::write(&state.config_path, raw).map_err(|e| format!("설정을 저장할 수 없습니다: {e}"))?;
    state.mcp.set_spawn(settings.mcp_spawn());
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

/// 설정 파일의 rec_mode만 바꾼다. 파일이 없으면 rec_mode만 쓴다:
/// 모드 버튼 한 번에 환경변수에서 온 home 같은 기본값이 파일에 굳지 않게 한다.
fn merge_rec_mode(raw: Option<&str>, mode: &str) -> Result<String, String> {
    if !matches!(mode, "in_person" | "hybrid") {
        return Err(format!("알 수 없는 녹음 방식: {mode}"));
    }
    let mut v: Value = raw.and_then(|r| serde_json::from_str(r).ok()).filter(Value::is_object).unwrap_or_else(|| json!({}));
    v["rec_mode"] = json!(mode);
    serde_json::to_string_pretty(&v).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_rec_mode(state: State<'_, AppState>, mode: String) -> Result<(), String> {
    let raw = merge_rec_mode(std::fs::read_to_string(&state.config_path).ok().as_deref(), &mode)?;
    if let Some(dir) = state.config_path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&state.config_path, raw).map_err(|e| format!("설정을 저장할 수 없습니다: {e}"))?;
    state.settings.lock().unwrap().rec_mode = mode;
    Ok(())
}

#[tauri::command]
async fn list_meetings(state: State<'_, AppState>) -> Result<Vec<meetings::MeetingInfo>, String> {
    let home = state.settings().home();
    blocking(move || Ok(meetings::list(&home))).await
}

/// 전사되지 않은 녹음 (앱 종료로 끊긴 녹음, 전사 실패). 사이드바에서 다시 전사한다.
#[tauri::command]
async fn list_recordings(state: State<'_, AppState>) -> Result<Vec<meetings::PendingRecording>, String> {
    let home = state.settings().home();
    blocking(move || Ok(meetings::pending_recordings(&home))).await
}

#[tauri::command]
async fn load_meeting(state: State<'_, AppState>, id: String) -> Result<meetings::MeetingDetail, String> {
    let home = state.settings().home();
    blocking(move || meetings::load(&home, &id)).await
}

/// MCP 도구 호출. 결과는 JSON-RPC result 그대로 (프론트엔드 lib.ts의 parseToolResult가 해석).
#[tauri::command]
async fn mcp_call(state: State<'_, AppState>, name: String, arguments: Value) -> Result<Value, String> {
    if !matches!(name.as_str(), "search_meetings" | "status") {
        return Err(format!("허용하지 않는 도구: {name}"));
    }
    let client = state.mcp.clone();
    blocking(move || client.call_tool(&name, arguments)).await
}

/// 녹음 방식에 따라 앱이 넘기는 `record` 인수 (lib.ts recFlags). 그 밖의 인수는 받지 않는다.
const REC_FLAGS: &[&str] = &["--no-system", "--echo-cancel"];

fn check_rec_flags(flags: &[String]) -> Result<(), String> {
    match flags.iter().find(|f| !REC_FLAGS.contains(&f.as_str())) {
        Some(f) => Err(format!("허용하지 않는 녹음 인수: {f}")),
        None => Ok(()),
    }
}

/// 녹음 시작. 이벤트는 "rec"로 보낸다. 반환값은 녹음 폴더.
#[tauri::command]
fn rec_start(app: AppHandle, state: State<'_, AppState>, flags: Vec<String>) -> Result<String, String> {
    check_rec_flags(&flags)?;
    let mut rec = state.rec.lock().unwrap();
    if rec.is_some() {
        return Err("이미 녹음 중입니다".into());
    }
    let s = state.settings();
    let dir = s.home().join("recordings").join(ulid::Ulid::new().to_string());
    std::fs::create_dir_all(dir.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut cmd = Command::new(expand(&s.rec_bin));
    cmd.arg("record").arg("--out").arg(&dir).args(&flags).envs(s.child_env());
    if s.fake_recorder {
        cmd.arg("--fake");
    }
    let slot = state.rec.clone();
    let stdin = procs::spawn_streaming(cmd, serde_json::Map::new(), move |ev| {
        if ev["event"] == "exit" {
            slot.lock().unwrap().take();
        }
        let _ = app.emit("rec", ev);
    })?;
    *rec = Some(stdin);
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn rec_send(state: State<'_, AppState>, cmd: String, text: Option<String>) -> Result<(), String> {
    let line = procs::recorder_line(&cmd, text.as_deref())?;
    let mut rec = state.rec.lock().unwrap();
    let stdin = rec.as_mut().ok_or("녹음 중이 아닙니다")?;
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|e| format!("녹음 헬퍼에 보낼 수 없습니다: {e}"))
}

/// 전사·요약 작업. 이벤트는 "job"으로 보내고 {job, kind}를 덧붙인다. job은 프론트엔드가 만든 ID.
#[tauri::command]
fn job_start(app: AppHandle, state: State<'_, AppState>, kind: String, target: String, job: String) -> Result<(), String> {
    let s = state.settings();
    let cmd = match kind.as_str() {
        "transcribe" => {
            // 녹음 폴더만 받는다 (임의 경로 전사 방지. 성공하면 코어가 이 폴더를 지운다)
            if !meetings::is_recording_dir(&s.home(), Path::new(&target)) {
                return Err(format!("녹음 폴더가 아닙니다: {target}"));
            }
            s.tractus(&["transcribe", "--recording", &target, "--progress-json"])
        }
        "summarize" if is_meeting_id(&target) => {
            s.tractus(&["summarize", &target, "--progress-json"])
        }
        _ => return Err(format!("잘못된 작업: {kind} {target}")),
    };
    let tag = json!({"job": job, "kind": kind}).as_object().unwrap().clone();
    // stdin은 쓰지 않으므로 바로 닫는다
    drop(procs::spawn_streaming(cmd, tag, move |ev| {
        let _ = app.emit("job", ev);
    })?);
    Ok(())
}

fn is_meeting_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// "S1", "s0012" 꼴: 접두 글자 + 숫자
fn is_tagged(s: &str, prefix: char) -> bool {
    s.strip_prefix(prefix).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// 화자 편집 (docs/desktop.md §2.1). 프론트엔드가 {"op":"rename","label":"S1","name":"김민수"} 꼴로 보낸다
#[derive(Deserialize, Debug)]
#[serde(tag = "op", rename_all = "lowercase")]
enum SpeakerEdit {
    Rename { label: String, name: String },
    Set { segment: String, label: String },
    Merge { from: String, into: String },
}

/// `tractus speakers <회의> <명령> -- <인자…>`. 인자는 `--` 뒤에 둔다("-박" 같은 이름을 옵션으로 읽지 않게)
fn speakers_args(id: &str, edit: &SpeakerEdit) -> Result<Vec<String>, String> {
    let bad = || format!("잘못된 화자 편집: {edit:?}");
    if !is_meeting_id(id) {
        return Err(format!("잘못된 회의 ID: {id}"));
    }
    let (op, a, b) = match edit {
        SpeakerEdit::Rename { label, name } if is_tagged(label, 'S') && !name.contains(['\n', '\r']) => ("rename", label, name.trim()),
        SpeakerEdit::Set { segment, label } if is_tagged(segment, 's') && (is_tagged(label, 'S') || label == "new") => ("set", segment, label.as_str()),
        SpeakerEdit::Merge { from, into } if is_tagged(from, 'S') && is_tagged(into, 'S') && from != into => ("merge", from, into.as_str()),
        _ => return Err(bad()),
    };
    Ok(["speakers", id, op, "--", a, b].map(String::from).to_vec())
}

/// 화자 편집을 코어에 맡기고(transcript.json·md·vtt·검색 색인을 코어가 고친다) 고친 회의를 다시 읽어 돌려준다.
#[tauri::command]
async fn edit_speakers(state: State<'_, AppState>, id: String, edit: SpeakerEdit) -> Result<meetings::MeetingDetail, String> {
    let s = state.settings();
    let args = speakers_args(&id, &edit)?;
    blocking(move || {
        let out = s.tractus(&args).output().map_err(|e| format!("실행할 수 없습니다 ({}): {e}", s.tractus_bin))?;
        if !out.status.success() {
            // 코어는 이유를 stderr 마지막 줄에 쓴다 (없는 라벨 등)
            let err = String::from_utf8_lossy(&out.stderr);
            return Err(err.trim().lines().last().unwrap_or("화자를 고치지 못했습니다").to_string());
        }
        meetings::load(&s.home(), &id)
    })
    .await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 회의 오디오: media://localhost/<경로> (media.rs). 파일 읽기는 UI 스레드 밖에서
        .register_asynchronous_uri_scheme_protocol("media", |ctx, request, responder| {
            let home = ctx.app_handle().state::<AppState>().settings().home();
            std::thread::spawn(move || {
                let range = request.headers().get(tauri::http::header::RANGE).and_then(|v| v.to_str().ok());
                responder.respond(media::respond(&home.join("meetings"), request.uri().path(), range));
            });
        })
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("settings.json");
            let settings: Settings = std::fs::read_to_string(&config_path)
                .ok()
                .and_then(|raw| serde_json::from_str(&raw).ok())
                .unwrap_or_default();
            let mcp = Arc::new(mcp::McpClient::new(settings.mcp_spawn()));
            // 첫 검색이 빠르도록 미리 띄워 둔다 (실패해도 검색 때 다시 시도)
            let warm = mcp.clone();
            std::thread::spawn(move || {
                if let Err(e) = warm.call_tool("status", json!({})) {
                    eprintln!("MCP 예열 실패: {e}");
                }
            });
            app.manage(AppState { settings: Mutex::new(settings), config_path, mcp, rec: Arc::default() });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            set_rec_mode,
            list_meetings,
            list_recordings,
            load_meeting,
            edit_speakers,
            mcp_call,
            rec_start,
            rec_send,
            job_start
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 앱을 만들 수 없습니다")
        .run(|app, event| {
            // 앱을 닫으면 녹음을 정상 종료시킨다 (WAV 헤더 마무리)
            if let tauri::RunEvent::Exit = event {
                if let Some(stdin) = app.state::<AppState>().rec.lock().unwrap().as_mut() {
                    let _ = stdin.write_all(b"stop\n").and_then(|_| stdin.flush());
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_defaults_and_env() {
        let s = Settings { home: "~/Tractus".into(), models_dir: String::new(), ..Default::default() };
        assert!(s.tractus_bin.ends_with("/.venv/bin/tractus"));
        let env = s.child_env();
        assert!(env.iter().any(|(k, v)| k == "TRACTUS_HOME" && !v.starts_with('~')));
        assert!(!env.iter().any(|(k, _)| k == "TRACTUS_MODELS_DIR"));
        // typer의 rich 오류 상자 대신 평문 "Error: …" 한 줄 (앱은 stderr 마지막 줄을 보여 준다)
        assert!(env.iter().any(|(k, v)| k == "TYPER_USE_RICH" && v == "0"));
        // 저장소 .venv 실행 파일이면 저장소 루트에서 실행 (.env.local을 읽도록)
        assert!(s.tractus_cwd().join("pyproject.toml").exists());
        let partial: Settings = serde_json::from_str(r#"{"home":"/x"}"#).unwrap();
        assert_eq!(partial.home, "/x");
        assert!(!partial.rec_bin.is_empty());
        assert_eq!(partial.rec_mode, "in_person"); // 예전 설정 파일에는 녹음 방식이 없다
    }

    #[test]
    fn speakers_command_args() {
        let edit = |v: Value| serde_json::from_value::<SpeakerEdit>(v).unwrap();
        let args = |v: Value| speakers_args("01ABC", &edit(v));
        // 인자는 `--` 뒤에 둔다: "-박" 같은 이름을 옵션으로 읽지 않게
        assert_eq!(
            args(json!({"op":"rename","label":"S1","name":" 김민수 "})).unwrap(),
            ["speakers", "01ABC", "rename", "--", "S1", "김민수"]
        );
        assert_eq!(args(json!({"op":"rename","label":"S2","name":""})).unwrap()[5], ""); // 이름 지우기
        assert_eq!(args(json!({"op":"set","segment":"s0012","label":"new"})).unwrap(), ["speakers", "01ABC", "set", "--", "s0012", "new"]);
        assert_eq!(args(json!({"op":"set","segment":"s0012","label":"S2"})).unwrap()[5], "S2");
        assert_eq!(args(json!({"op":"merge","from":"S3","into":"S1"})).unwrap(), ["speakers", "01ABC", "merge", "--", "S3", "S1"]);

        for bad in [
            json!({"op":"rename","label":"S1; rm","name":"x"}),
            json!({"op":"rename","label":"S1","name":"a\nb"}),
            json!({"op":"set","segment":"../x","label":"S1"}),
            json!({"op":"set","segment":"s0001","label":"S"}),
            json!({"op":"merge","from":"S1","into":"S1"}),
            json!({"op":"merge","from":"new","into":"S1"}),
        ] {
            assert!(args(bad.clone()).is_err(), "{bad}");
        }
        assert!(speakers_args("../01ABC", &edit(json!({"op":"merge","from":"S2","into":"S1"}))).is_err());
        assert!(serde_json::from_value::<SpeakerEdit>(json!({"op":"list"})).is_err()); // 편집만 받는다
    }

    #[test]
    fn rec_flags_allowlist() {
        assert!(check_rec_flags(&["--no-system".into()]).is_ok());
        assert!(check_rec_flags(&["--echo-cancel".into()]).is_ok());
        assert!(check_rec_flags(&[]).is_ok());
        assert!(check_rec_flags(&["--out".into(), "/etc".into()]).is_err());
        assert!(check_rec_flags(&["--fake".into()]).is_err()); // --fake는 설정(fake_recorder)으로만
    }

    #[test]
    fn rec_mode_saves_only_its_key() {
        // 파일이 없으면 rec_mode만 쓴다 (home 등 기본값을 굳히지 않는다)
        let v: Value = serde_json::from_str(&merge_rec_mode(None, "hybrid").unwrap()).unwrap();
        assert_eq!(v, json!({"rec_mode": "hybrid"}));
        // 있으면 다른 값은 그대로 둔다
        let v: Value = serde_json::from_str(&merge_rec_mode(Some(r#"{"home":"/x","rec_mode":"hybrid"}"#), "in_person").unwrap()).unwrap();
        assert_eq!(v, json!({"home": "/x", "rec_mode": "in_person"}));
        assert!(merge_rec_mode(None, "../etc").is_err());
    }
}
