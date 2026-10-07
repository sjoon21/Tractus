//! Tractus 데스크톱 앱 (docs/desktop.md §3). 파일은 직접 읽고, 검색만 상주 `tractus mcp`로 한다.

mod ask;
mod mcp;
mod media;
mod meetings;
mod procs;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
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
    /// 진행 중인 질문 (작업 ID → 프로세스). 멈추기(ask_cancel)가 kill한다
    asks: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
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
    let (stdin, _) = procs::spawn_streaming(cmd, serde_json::Map::new(), move |ev| {
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

/// 작업 종류 → tractus 인수. 대상은 종류마다 검사한다
fn job_args(home: &Path, kind: &str, target: &str) -> Result<Vec<String>, String> {
    let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect();
    match kind {
        "transcribe" => {
            // 녹음 폴더만 받는다 (임의 경로 전사 방지. 성공하면 코어가 이 폴더를 지운다)
            if !meetings::is_recording_dir(home, Path::new(target)) {
                return Err(format!("녹음 폴더가 아닙니다: {target}"));
            }
            Ok(args(&["transcribe", "--recording", target, "--progress-json"]))
        }
        "summarize" if is_meeting_id(target) => Ok(args(&["summarize", target, "--progress-json"])),
        // 단어 타이밍 (Phase 6.1). words가 없는 세그먼트만 맞춘다. 정렬하는 동안 앱에서 고친 문장은 코어가 덮어쓰지 않는다
        "align" if is_meeting_id(target) => Ok(args(&["align", target, "--progress-json"])),
        // 파일 가져오기 (Phase 5.5). 원본 파일은 건드리지 않는다. 이미 전사한 파일이면 코어가 duplicate 경고 + done
        "import" => import_args(Path::new(target)),
        _ => Err(format!("잘못된 작업: {kind} {target}")),
    }
}

/// 전사·요약·단어 타이밍 작업. 이벤트는 "job"으로 보내고 {job, kind}를 덧붙인다. job은 프론트엔드가 만든 ID.
#[tauri::command]
fn job_start(app: AppHandle, state: State<'_, AppState>, kind: String, target: String, job: String) -> Result<(), String> {
    let s = state.settings();
    let cmd = s.tractus(&job_args(&s.home(), &kind, &target)?);
    let tag = json!({"job": job, "kind": kind}).as_object().unwrap().clone();
    // stdin은 쓰지 않으므로 바로 닫는다
    drop(procs::spawn_streaming(cmd, tag, move |ev| {
        let _ = app.emit("job", ev);
    })?);
    Ok(())
}

/// 회의 질의 (Phase 6.3). 이벤트는 "ask"로 보내고 {job}을 덧붙인다. meeting이 있으면 그 회의만 보고 chat.json에 남긴다
#[tauri::command]
#[allow(clippy::too_many_arguments)] // 프론트엔드 invoke 인수 그대로
fn ask_start(
    app: AppHandle,
    state: State<'_, AppState>,
    job: String,
    meeting: Option<String>,
    from: Option<String>,
    to: Option<String>,
    question: String,
    history: Vec<ask::ChatMessage>,
) -> Result<(), String> {
    let args = ask::ask_args(meeting.as_deref(), from.as_deref(), to.as_deref())?;
    let input = ask::ask_input(&question, &history)?;
    let cmd = state.settings().tractus(&args);
    let tag = json!({ "job": job }).as_object().unwrap().clone();
    let (asks, key) = (state.asks.clone(), job.clone());
    // 넣기 전에 잠가 둔다: 바로 끝나는 프로세스의 exit가 넣기보다 먼저 지우지 않게
    let mut running = state.asks.lock().unwrap();
    let (mut stdin, child) = procs::spawn_streaming(cmd, tag, move |ev| {
        if ev["event"] == "exit" {
            asks.lock().unwrap().remove(&key);
        }
        let _ = app.emit("ask", ev);
    })?;
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
fn ask_cancel(state: State<'_, AppState>, job: String) {
    let child = state.asks.lock().unwrap().get(&job).cloned();
    if let Some(c) = child {
        let _ = c.lock().unwrap().kill();
    }
}

/// 회의의 질문 기록 (chat.json)
#[tauri::command]
async fn load_chat(state: State<'_, AppState>, id: String) -> Result<Vec<meetings::ChatEntry>, String> {
    let home = state.settings().home();
    blocking(move || meetings::load_chat(&home, &id)).await
}

/// 질문을 보내기 전 '어디로 전송되는지' 안내에 쓸 공급자·모델 (API 키는 읽지 않는다)
#[tauri::command]
async fn llm_config(state: State<'_, AppState>) -> Result<ask::LlmConfig, String> {
    let s = state.settings();
    blocking(move || Ok(ask::llm_config(&[&s.tractus_cwd(), &s.home()], |k| std::env::var(k).ok()))).await
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

/// tractus 명령을 끝까지 실행하고 stdout을 돌려준다. input이 있으면 stdin으로 넘기고 닫는다.
/// 실패하면 코어가 stderr 마지막 줄에 쓴 이유(없는 세그먼트 등)를 오류로 돌려준다.
fn run_tractus(s: &Settings, args: &[String], input: Option<&str>, what: &str) -> Result<String, String> {
    let mut cmd = s.tractus(args);
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("실행할 수 없습니다 ({}): {e}", s.tractus_bin))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        // 코어는 stdin을 다 읽은 뒤에 출력하므로 먼저 쓰고 닫아도 막히지 않는다
        stdin.write_all(text.as_bytes()).map_err(|e| format!("{what}: 입력을 넘기지 못했습니다: {e}"))?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(err.trim().lines().last().map(str::to_string).unwrap_or_else(|| format!("{what}: 실패 (종료 코드 {:?})", out.status.code())));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// stdout 마지막 줄의 JSON 객체 ({"changed": N}, {"added": N}, {"path": …}).
fn stdout_json(out: &str) -> Result<Value, String> {
    out.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .and_then(|l| serde_json::from_str::<Value>(l).ok())
        .filter(Value::is_object)
        .ok_or_else(|| "tractus 출력을 읽을 수 없습니다".to_string())
}

/// 화자 편집을 코어에 맡기고(transcript.json·md·vtt·검색 색인을 코어가 고친다) 고친 회의를 다시 읽어 돌려준다.
#[tauri::command]
async fn edit_speakers(state: State<'_, AppState>, id: String, edit: SpeakerEdit) -> Result<meetings::MeetingDetail, String> {
    let s = state.settings();
    let args = speakers_args(&id, &edit)?;
    blocking(move || {
        run_tractus(&s, &args, None, "화자를 고치지 못했습니다")?;
        meetings::load(&s.home(), &id)
    })
    .await
}

/// 문장 편집 한 건 (Phase 5.3). text가 원문과 같으면 코어가 corrected_text를 해제한다
#[derive(Deserialize, Serialize, Debug)]
struct TextEdit {
    id: String,
    text: String,
}

/// `tractus segments <회의> edit` 인수와 stdin JSON. 문장은 인수가 아니라 stdin으로 넘긴다(길이·특수 문자 걱정 없이)
fn segments_edit(id: &str, edits: &[TextEdit]) -> Result<(Vec<String>, String), String> {
    if !is_meeting_id(id) {
        return Err(format!("잘못된 회의 ID: {id}"));
    }
    if edits.is_empty() || edits.iter().any(|e| !is_tagged(&e.id, 's') || e.text.trim().is_empty()) {
        return Err("잘못된 문장 편집입니다 (빈 문장은 저장할 수 없습니다)".into());
    }
    Ok((["segments", id, "edit"].map(String::from).to_vec(), json!({ "edits": edits }).to_string()))
}

/// 문장 편집 결과: 코어가 실제로 바꾼 세그먼트 수({"changed": N})와 고친 회의
#[derive(Serialize)]
struct EditResult {
    changed: u64,
    meeting: meetings::MeetingDetail,
}

/// 문장 편집 묶음을 한 번에 저장하고 고친 회의를 돌려준다. 바꾸기 200건도 호출 1회다
#[tauri::command]
async fn edit_segments(state: State<'_, AppState>, id: String, edits: Vec<TextEdit>) -> Result<EditResult, String> {
    let s = state.settings();
    let (args, input) = segments_edit(&id, &edits)?;
    blocking(move || {
        let changed = stdout_json(&run_tractus(&s, &args, Some(&input), "문장을 고치지 못했습니다")?)?["changed"].as_u64().unwrap_or(0);
        Ok(EditResult { changed, meeting: meetings::load(&s.home(), &id)? })
    })
    .await
}

/// `tractus glossary add -- <용어…>`. 다음 전사의 hotwords가 된다. 중복 제거는 코어가 한다
fn glossary_args(terms: &[String]) -> Result<Vec<String>, String> {
    let terms: Vec<&str> = terms.iter().map(|t| t.trim()).filter(|t| !t.is_empty()).collect();
    if terms.is_empty() || terms.iter().any(|t| t.contains(['\n', '\r'])) {
        return Err("용어집에 넣을 용어가 없습니다".into());
    }
    Ok(["glossary", "add", "--"].into_iter().chain(terms).map(String::from).collect())
}

/// 용어집에 더한 개수
#[tauri::command]
async fn glossary_add(state: State<'_, AppState>, terms: Vec<String>) -> Result<u64, String> {
    let s = state.settings();
    let args = glossary_args(&terms)?;
    blocking(move || Ok(stdout_json(&run_tractus(&s, &args, None, "용어집에 넣지 못했습니다")?)?["added"].as_u64().unwrap_or(0))).await
}

const EXPORT_FORMATS: &[&str] = &["txt", "md", "srt", "vtt", "csv", "docx", "bundle"];

/// `tractus export`. 경로는 저장 대화상자가 고른 절대 경로이고, 덮어쓰기는 대화상자가 이미 물었으므로 --force
fn export_args(id: &str, format: &str, out: &Path) -> Result<Vec<String>, String> {
    if !is_meeting_id(id) || !EXPORT_FORMATS.contains(&format) || !out.is_absolute() || out.file_name().is_none() {
        return Err(format!("잘못된 내보내기: {id} {format} {}", out.display()));
    }
    let out = out.to_string_lossy();
    Ok(["export", id, "--format", format, "--out", &out, "--force"].map(String::from).to_vec())
}

/// 내보내고 Finder에서 그 파일을 보여 준다. 반환값은 코어가 쓴 절대 경로
#[tauri::command]
async fn export_meeting(state: State<'_, AppState>, id: String, format: String, out: String) -> Result<String, String> {
    let s = state.settings();
    let args = export_args(&id, &format, Path::new(&out))?;
    blocking(move || {
        let v = stdout_json(&run_tractus(&s, &args, None, "내보내지 못했습니다")?)?;
        let path = v["path"].as_str().ok_or("내보내기 결과에 경로가 없습니다")?.to_string();
        // Finder 보여 주기가 실패해도 파일은 이미 저장됐다
        if let Err(e) = tauri_plugin_opener::reveal_item_in_dir(&path) {
            eprintln!("Finder에서 보여 주지 못했습니다: {e}");
        }
        Ok(path)
    })
    .await
}

/// 가져올 수 있는 파일 (lib.ts IMPORT_EXTS와 같다). 대소문자 무시
const IMPORT_EXTS: &[&str] = &["m4a", "mp3", "wav", "aac", "flac", "ogg", "opus", "webm", "mp4", "mov", "m4v"];

/// `tractus transcribe <파일> --progress-json`. 절대 경로의 기존 파일이고 확장자가 allowlist에 있을 때만
fn import_args(path: &Path) -> Result<Vec<String>, String> {
    let ext_ok = path.extension().and_then(OsStr::to_str).is_some_and(|e| IMPORT_EXTS.contains(&e.to_ascii_lowercase().as_str()));
    if !(path.is_absolute() && ext_ok && path.is_file()) {
        return Err(format!("가져올 수 없는 파일입니다: {}", path.display()));
    }
    Ok(vec!["transcribe".into(), path.to_string_lossy().into_owned(), "--progress-json".into()])
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
            app.manage(AppState { settings: Mutex::new(settings), config_path, mcp, rec: Arc::default(), asks: Arc::default() });
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            set_rec_mode,
            list_meetings,
            list_recordings,
            load_meeting,
            edit_speakers,
            edit_segments,
            glossary_add,
            export_meeting,
            mcp_call,
            rec_start,
            rec_send,
            job_start,
            ask_start,
            ask_cancel,
            load_chat,
            llm_config
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
    fn segments_edit_args_and_stdin() {
        let e = |id: &str, text: &str| TextEdit { id: id.into(), text: text.into() };
        let (args, input) = segments_edit("01ABC", &[e("s0012", "새 문장"), e("s0013", "-- $(rm) \"따옴표\"")]).unwrap();
        assert_eq!(args, ["segments", "01ABC", "edit"]); // 문장은 인수가 아니라 stdin JSON으로
        let v: Value = serde_json::from_str(&input).unwrap();
        assert_eq!(v, json!({"edits": [{"id": "s0012", "text": "새 문장"}, {"id": "s0013", "text": "-- $(rm) \"따옴표\""}]}));
        assert!(segments_edit("../x", &[e("s0001", "a")]).is_err());
        assert!(segments_edit("01ABC", &[]).is_err());
        assert!(segments_edit("01ABC", &[e("S1", "a")]).is_err());
        assert!(segments_edit("01ABC", &[e("s0001", "  ")]).is_err()); // 빈 문장은 코어도 거부한다
    }

    #[test]
    fn glossary_command_args() {
        let t = |v: &[&str]| glossary_args(&v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        assert_eq!(t(&[" budget ", "", "-WTO"]).unwrap(), ["glossary", "add", "--", "budget", "-WTO"]);
        assert!(t(&["  "]).is_err());
        assert!(t(&["a\nb"]).is_err());
    }

    #[test]
    fn export_command_args() {
        let out = Path::new("/Users/me/Desktop/2026-10-02_주간회의.docx");
        assert_eq!(
            export_args("01ABC", "docx", out).unwrap(),
            ["export", "01ABC", "--format", "docx", "--out", out.to_str().unwrap(), "--force"] // 덮어쓰기는 저장 대화상자가 이미 물었다
        );
        assert!(export_args("01ABC", "pdf", out).is_err());
        assert!(export_args("01ABC", "--force", out).is_err());
        assert!(export_args("01ABC", "txt", Path::new("rel.txt")).is_err());
        assert!(export_args("../x", "txt", out).is_err());
    }

    #[test]
    fn last_json_line() {
        assert_eq!(stdout_json("log\n{\"path\": \"/a b.txt\"}\n\n").unwrap()["path"], "/a b.txt");
        assert!(stdout_json("").is_err());
        assert!(stdout_json("done").is_err());
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
