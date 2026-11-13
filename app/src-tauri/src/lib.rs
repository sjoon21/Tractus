//! Tractus 데스크톱 앱 (docs/desktop.md §3). 파일은 직접 읽고, 검색만 상주 `tractus mcp`로 한다.
//! 여기에는 앱 상태(`AppState`)·쓰는 중 표시(`hold`·`BusyGuard`)·코어 실행(`run_tractus`)과 읽기 명령·`run()`만 둔다.
//! 명령은 영역 모듈에 둔다: 설정 `settings`, 녹음 `recording`, 오래 걸리는 작업 `jobs`, 노트 고치기 `edits`, 사전 `glossary`, 종료 `quit` 등.

mod ask;
mod attach;
mod calendar;
mod deferred;
mod edits;
mod glossary;
mod jobs;
mod llm_key;
mod i18n;
mod mcp;
mod media;
mod meetings;
mod models;
mod obsidian;
mod organize;
mod paths;
mod procs;
mod quit;
mod recording;
mod removal;
mod settings;
mod summaries;
mod tray;
mod voices;

use crate::i18n::{t, tv};
// 여러 모듈이 `super::Settings`·`crate::patch_settings`로 쓰는 설정 이름
use settings::{expand, merge_flag, patch_settings, Settings};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Manager, State};

struct AppState {
    settings: Mutex<Settings>,
    config_path: PathBuf,
    mcp: Arc<mcp::McpClient>,
    rec: Arc<Mutex<Option<ChildStdin>>>,
    /// 진행 중인 질문과 변환 전 노트의 변환 (작업 ID → 프로세스). 멈추기(ask_cancel)가 kill한다
    asks: Arc<Mutex<HashMap<String, Arc<Mutex<Child>>>>>,
    /// 녹음 중 실시간 자막 프로세스. 녹음이 끝나면(stopped·exit) 정식 전사보다 먼저 끝낸다
    live: LiveSlot,
    /// 지금 쓰는 중인 대상 (작업·질문·녹음 ID → 노트 ID 또는 녹음 폴더). 삭제가 이 대상을 거절한다
    busy: Busy,
    /// 돌고 있는 백그라운드 검색 정보 갱신 프로세스. 변환·녹음·질문이 시작하면 kill해 임베딩 모델이 겹쳐 올라가지 않게 한다 (다음 갱신이 이어서 한다)
    index: IndexSlot,
}

type IndexSlot = Arc<Mutex<Option<Arc<Mutex<Child>>>>>;

/// 갱신 중인 검색 정보 프로세스를 멈춘다. 없으면 아무 일도 없다. 먼저 `hold`로 자기 표시를 한 뒤 부른다
/// (그 뒤에 시작하는 갱신은 `new_if_idle`에서 비켜 가고, 이미 시작한 갱신은 아래에서 멈춘다)
fn cancel_index(slot: &IndexSlot) {
    if let Some(child) = slot.lock().unwrap().as_ref() {
        // 대기 스레드가 이미 wait 중이면 끝나는 중이다
        if let Ok(mut c) = child.try_lock() {
            let _ = c.kill();
        }
    }
}

type Busy = Arc<Mutex<HashMap<String, String>>>;

/// 대상이 지금 쓰이는 중인지
fn is_busy(busy: &Busy, target: &str) -> bool {
    busy.lock().unwrap().values().any(|t| t == target)
}

/// 대상을 쓰는 중으로 표시하고 풀 때 쓸 키를 돌려준다 (프로세스가 끝나는 exit 이벤트나 시작 실패 때 `release`)
fn hold(busy: &Busy, target: &str) -> String {
    let key = ulid::Ulid::new().to_string();
    busy.lock().unwrap().insert(key.clone(), target.to_string());
    key
}

fn release(busy: &Busy, key: &str) {
    busy.lock().unwrap().remove(key);
}

/// 짧은 명령(문장 수정·참석자 편집·내보내기·목소리 등록)이 노트를 쓰는 동안 노트를 쓰는 중으로 표시한다. 놓으면(Drop) 풀린다.
/// 삭제는 이 표시가 있으면 거절한다 (앱은 먼저 수정 줄을 비우지만, 그 사이를 뚫은 호출이 폴더가 사라진 뒤에 '노트 없음'으로 실패하지 않게)
struct BusyGuard {
    busy: Busy,
    key: String,
}

impl BusyGuard {
    fn new(busy: &Busy, target: &str) -> Self {
        BusyGuard { busy: busy.clone(), key: hold(busy, target) }
    }

    /// 아무것도 쓰이지 않을 때만 잡는다. 확인과 표시를 한 번의 잠금 안에서 하므로 동시에 둘이 잡을 수 없다
    fn new_if_idle(busy: &Busy, target: &str) -> Option<Self> {
        let mut m = busy.lock().unwrap();
        if !m.is_empty() {
            return None;
        }
        let key = ulid::Ulid::new().to_string();
        m.insert(key.clone(), target.to_string());
        Some(BusyGuard { busy: busy.clone(), key })
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        release(&self.busy, &self.key);
    }
}

type LiveSlot = Arc<Mutex<Option<procs::Stoppable>>>;

impl AppState {
    fn settings(&self) -> Settings {
        Settings { config_dir: self.config_path.parent().map(Path::to_path_buf), ..self.settings.lock().unwrap().clone() }
    }

    /// 요약·질문 프로세스 (고른 서비스의 API 키 포함)
    fn llm_cmd<S: AsRef<OsStr>>(&self, args: &[S], provider: Option<&str>) -> Result<Command, String> {
        self.settings().tractus_llm(args, provider)
    }
}

/// 파일 읽기·MCP 대기를 블로킹 풀에서 돌린다 (UI·비동기 런타임 스레드를 막지 않게).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// 버전의 릴리스 노트 페이지를 브라우저로 연다 (설정 › 업데이트). 주소는 paths::release_notes_url이 만든다
#[tauri::command]
fn open_release_notes(version: String) -> Result<(), String> {
    let url = paths::release_notes_url(&version, i18n::lang()).ok_or_else(|| tv("잘못된 버전입니다: {version}", &[("version", version.clone())]))?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// 클립보드에 글 쓰기. WKWebView의 navigator.clipboard는 창이 막 활성화된 클릭 등에서 NotAllowedError를 내므로 화면이 이것으로 물러난다.
/// 앱 환경에는 LANG이 없어 pbcopy가 한글을 깨뜨린다: UTF-8을 명시한다
#[tauri::command]
fn copy_text(text: String) -> Result<(), String> {
    pipe_to("/usr/bin/pbcopy", &[], text.as_bytes())
}

/// 서식(HTML)과 글(Markdown)을 함께 클립보드에 쓴다: 메일·문서는 HTML을, 글만 받는 곳은 Markdown을 가져간다.
/// pbcopy는 HTML을 못 쓰므로 osascript(JXA)로 NSPasteboard에 쓴다. 스크립트는 고정이고 내용은 stdin JSON으로만 넘긴다(코드에 끼워 넣지 않는다)
const COPY_RICH_JXA: &str = r#"ObjC.import("AppKit");
var o = JSON.parse($.NSString.alloc.initWithDataEncoding($.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile, $.NSUTF8StringEncoding).js);
var pb = $.NSPasteboard.generalPasteboard;
pb.clearContents;
if (!(pb.setStringForType($(o.html), $.NSPasteboardTypeHTML) && pb.setStringForType($(o.text), $.NSPasteboardTypeString))) throw new Error("pasteboard");"#;

#[tauri::command]
async fn copy_rich(text: String, html: String) -> Result<(), String> {
    let input = serde_json::json!({ "text": text, "html": html }).to_string();
    // osascript는 띄우는 데 0.1초 남짓 걸린다: 화면 스레드를 막지 않게
    blocking(move || pipe_to("/usr/bin/osascript", &["-l", "JavaScript", "-e", COPY_RICH_JXA], input.as_bytes())).await
}

/// 프로그램을 띄워 stdin에 쓰고 끝나기를 기다린다 (클립보드 쓰기용)
fn pipe_to(program: &str, args: &[&str], input: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut child = std::process::Command::new(program)
        .args(args)
        .env("LANG", "en_US.UTF-8")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    child.stdin.take().ok_or("stdin")?.write_all(input).map_err(|e| e.to_string())?;
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err(format!("{program}: {status}")) }
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
        return Err(tv("허용하지 않는 검색 요청입니다: {name}", &[("name", name.to_string())]));
    }
    let client = state.mcp.clone();
    blocking(move || client.call_tool(&name, arguments)).await
}

/// 회의의 질문 기록 (chat.json)
#[tauri::command]
async fn load_chat(state: State<'_, AppState>, id: String) -> Result<Vec<meetings::ChatEntry>, String> {
    let home = state.settings().home();
    blocking(move || meetings::load_chat(&home, &id)).await
}

/// 노트를 휴지통으로 옮긴다 (docs/desktop.md §2.8). 처리 중인 노트·변환이 끝나지 않은 노트·폴더 밖은 거절한다.
/// 검색 색인은 사라진 폴더를 스스로 지운다: 백그라운드로 MCP `status`(= `sync(embed=False)`)를 불러 바로 맞춘다
/// (실패해도 검색·질문이 매번 먼저 동기화하므로 지워진 노트는 나오지 않는다)
#[tauri::command]
async fn delete_meeting(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let (home, busy, mcp) = (state.settings().home(), state.busy.clone(), state.mcp.clone());
    blocking(move || removal::trash_note(&home, &id, |k| is_busy(&busy, k), removal::to_trash)).await?;
    sync_index_later(mcp);
    Ok(())
}

/// 변환하지 않은 녹음을 휴지통으로 옮긴다. 녹음 중이거나 변환 중인 폴더는 거절한다
#[tauri::command]
async fn delete_recording(state: State<'_, AppState>, dir: String) -> Result<(), String> {
    let (home, busy) = (state.settings().home(), state.busy.clone());
    blocking(move || removal::trash_recording(&home, Path::new(&dir), |k| is_busy(&busy, k), removal::to_trash)).await
}

fn sync_index_later(mcp: Arc<mcp::McpClient>) {
    std::thread::spawn(move || {
        if let Err(e) = mcp.call_tool("status", json!({})) {
            eprintln!("검색 색인 정리 실패: {e}");
        }
    });
}

/// 질문을 보내기 전 '어디로 전송되는지' 안내에 쓸 서비스·AI 모델·호스트 (API 키는 읽지 않고 등록 여부만 본다). provider: 고른 서비스 (없으면 기본)
#[tauri::command]
async fn llm_config(state: State<'_, AppState>, provider: Option<String>) -> Result<ask::LlmConfig, String> {
    let s = state.settings();
    blocking(move || {
        let c = s.llm_choice(provider.as_deref())?;
        let cfg = ask::llm_config(&[&s.tractus_cwd(), &s.home()], |k| std::env::var(k).ok());
        Ok(llm_key::effective(cfg, &c, s.key_saved(c.provider)))
    })
    .await
}

fn is_meeting_id(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric())
}

/// "S1", "s0012" 꼴: 접두 글자 + 숫자
fn is_tagged(s: &str, prefix: char) -> bool {
    s.strip_prefix(prefix).is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// tractus 명령을 끝까지 실행하고 stdout을 돌려준다. input이 있으면 stdin으로 넘기고 닫는다.
/// 실패하면 코어가 stderr 마지막 줄에 쓴 이유(없는 세그먼트 등)를 오류로 돌려준다.
fn run_tractus(s: &Settings, args: &[String], input: Option<&str>, what: &str) -> Result<String, String> {
    let mut cmd = s.tractus(args);
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| procs::cannot_run(&s.tractus_resolved().path, e))?;
    if let (Some(text), Some(mut stdin)) = (input, child.stdin.take()) {
        // 코어는 stdin을 다 읽은 뒤에 출력하므로 먼저 쓰고 닫아도 막히지 않는다
        stdin.write_all(text.as_bytes()).map_err(|e| tv("{what}\n입력을 넘기지 못했습니다: {e}", &[("what", what.to_string()), ("e", e.to_string())]))?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(last_error_line(&err).unwrap_or_else(|| tv("{what} (종료 코드 {code})", &[("what", what.to_string()), ("code", out.status.code().map_or(t("없음"), |c| c.to_string()))])));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// stderr 마지막 줄 (코어가 WORDS.md 문장으로 쓴다). typer 접두어 `Error: `·`Error: Invalid value for MEETING: `는 뗀다
/// (param_hint를 문자열로 주면 click은 따옴표 없이 찍는다. 자동 이름이면 `'--x'`처럼 따옴표가 붙는다)
fn last_error_line(stderr: &str) -> Option<String> {
    let line = stderr.trim().lines().last()?.trim();
    let line = line.strip_prefix("Error: ").unwrap_or(line);
    let line = match line.strip_prefix("Invalid value for ").and_then(|r| r.split_once(": ")) {
        Some((_, rest)) => rest,
        None => line,
    };
    (!line.is_empty()).then(|| line.to_string())
}

/// stdout 마지막 줄의 JSON 객체 ({"changed": N}, {"added": N}, {"path": …}).
fn stdout_json(out: &str) -> Result<Value, String> {
    out.lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .and_then(|l| serde_json::from_str::<Value>(l).ok())
        .filter(Value::is_object)
        .ok_or_else(|| t("결과를 읽지 못했습니다"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(quit::app_menu);
    builder
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if id == quit::QUIT_MENU_ID {
                quit::begin_quit(app);
            } else {
                tray::on_menu_event(app, id); // 메뉴 막대 아이콘의 메뉴 (트레이 항목이 아니면 아무것도 하지 않는다)
            }
        })
        // 창을 닫아도 메뉴 막대에 남기는 설정이면 끝내지 않고 숨긴다. 끄면 마지막 창이 닫히며 기존 종료 흐름(defer_exit)이 돈다
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" && tray::hides_on_close(window.app_handle()) => {
                api.prevent_close();
                let _ = window.hide();
            }
            // 메뉴 막대 팝오버는 다른 곳을 누르면 닫힌다
            tauri::WindowEvent::Focused(false) if window.label() == tray::POPOVER_WINDOW => tray::popover_blurred(window.app_handle()),
            _ => {}
        })
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
            let mut settings = Settings::load(std::fs::read_to_string(&config_path).ok().as_deref());
            settings.config_dir = config_path.parent().map(Path::to_path_buf);
            i18n::set(i18n::resolve(&settings.ui_lang, i18n::system_lang().as_deref()));
            let mcp = Arc::new(mcp::McpClient::new(settings.mcp_spawn()));
            // 첫 검색이 빠르도록 미리 띄워 둔다 (실패해도 검색 때 다시 시도)
            let warm = mcp.clone();
            std::thread::spawn(move || {
                if let Err(e) = warm.call_tool("status", json!({})) {
                    eprintln!("MCP 예열 실패: {e}");
                }
            });
            app.manage(AppState { settings: Mutex::new(settings.clone()), config_path, mcp, rec: Arc::default(), asks: Arc::default(), live: Arc::default(), busy: Arc::default(), index: Arc::default() });
            app.manage(tray::TrayState::default());
            app.state::<tray::TrayState>().apply(app.handle(), &settings); // 아이콘을 못 만들어도(OS가 거절) 앱은 계속 뜬다
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        // 업데이트: 플러그인은 늘 등록하지만 확인·설치는 화면이 update_available(번들)일 때만 부른다. 받기는 Rust가 하므로 CSP는 그대로다
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            settings::get_settings,
            settings::ui_lang,
            settings::set_ui_lang,
            paths::update_available,
            open_release_notes,
            copy_text,
            copy_rich,
            settings::save_settings,
            settings::set_rec_mode,
            settings::set_asr_engine,
            edits::marks_save,
            settings::set_checkup_done,
            tray::tray_update,
            tray::tray_popover_state,
            tray::tray_popover_action,
            tray::tray_popover_hide,
            tray::tray_hides_on_close,
            tray::tray_show_if_hidden,
            tray::set_tray_prefs,
            deferred::set_after_record,
            edits::note_sample,
            obsidian::set_obsidian,
            obsidian::obsidian_send,
            obsidian::obsidian_open,
            calendar::calendar_status,
            calendar::calendar_connect,
            calendar::calendar_set,
            calendar::calendar_next,
            calendar::calendar_week,
            calendar::calendar_privacy,
            deferred::recording_finish,
            deferred::convert_note,
            models::models_list,
            models::doctor,
            models::models_download,
            models::models_cancel,
            models::models_remove,
            models::models_add,
            models::models_move,
            models::models_prune,
            list_meetings,
            list_recordings,
            load_meeting,
            edits::edit_speakers,
            edits::edit_segments,
            glossary::glossary_add,
            glossary::glossary_list,
            glossary::glossary_remove,
            glossary::glossary_rename,
            glossary::glossary_corrections,
            jobs::index_refresh,
            edits::export_meeting,
            edits::note_new,
            edits::note_save,
            edits::note_title,
            organize::list_folders,
            organize::note_meta,
            organize::folders_create,
            organize::folders_rename,
            organize::folders_move,
            organize::folders_delete,
            organize::set_list_prefs,
            mcp_call,
            recording::rec_start,
            recording::rec_send,
            jobs::job_start,
            summaries::summary_start,
            summaries::polish_start,
            edits::polish_resolve,
            summaries::summaries_list,
            summaries::summaries_delete,
            summaries::minutes_show,
            summaries::minutes_save,
            summaries::templates_list,
            summaries::templates_save,
            summaries::templates_delete,
            jobs::ask_start,
            jobs::ask_cancel,
            load_chat,
            delete_meeting,
            delete_recording,
            quit::quit_ready,
            llm_config,
            llm_key::llm_key_status,
            llm_key::llm_key_save,
            llm_key::llm_key_delete,
            llm_key::llm_settings,
            llm_key::llm_settings_save,
            llm_key::llm_default_save,
            llm_key::embedding_provider_save,
            llm_key::llm_test,
            llm_key::llm_models,
            voices::voices_list,
            voices::voices_enroll,
            voices::voices_forget
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 앱을 만들 수 없습니다")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = &event {
                quit::defer_exit(app, api);
            }
            // macOS Dock 아이콘: 창을 숨겨 둔 채(메뉴 막대에 남기기) 눌러도 다시 보인다
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = &event {
                tray::reopen(app, *has_visible_windows);
            }
            // 앱을 닫으면 녹음을 정상 종료시킨다 (WAV 헤더 마무리). 실시간 자막은 저장할 것이 없으므로 바로 끝낸다
            if let tauri::RunEvent::Exit = event {
                app.state::<tray::TrayState>().shutdown(); // 메뉴 막대 시계 타이머를 멈춘다
                let state = app.state::<AppState>();
                if let Some(stdin) = state.rec.lock().unwrap().as_mut() {
                    let _ = stdin.write_all(b"stop\n").and_then(|_| stdin.flush());
                }
                let live = state.live.lock().unwrap().take();
                if let Some(p) = live {
                    p.kill();
                }
                models::stop_download(); // 모델 받기는 멈추고 받은 부분은 남긴다 (다시 받으면 이어서)
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn busy_target_is_held_until_released() {
        let busy = Busy::default();
        let a = hold(&busy, "01AAA");
        let b = hold(&busy, "01AAA"); // 같은 노트를 쓰는 작업이 둘이면 둘 다 끝나야 풀린다
        assert!(is_busy(&busy, "01AAA") && !is_busy(&busy, "01BBB"));
        release(&busy, &a);
        assert!(is_busy(&busy, "01AAA"));
        release(&busy, &b);
        release(&busy, &b); // 두 번 풀어도 무해하다
        assert!(!is_busy(&busy, "01AAA"));
    }

    #[test]
    fn quick_edit_guard_marks_the_note_busy_and_blocks_delete_until_dropped() {
        let busy = Busy::default();
        let guard = BusyGuard::new(&busy, "01AAA");
        assert!(is_busy(&busy, "01AAA") && !is_busy(&busy, "01BBB"));
        // 삭제는 처리 중이라는 문장으로 깨끗하게 거절된다 (없는 노트로 실패하지 않는다)
        let home = std::env::temp_dir().join(format!("tractus-guard-{}", std::process::id()));
        let dir = home.join("meetings/2026-10-08_t_01AAA");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("transcript.json"), r#"{"meeting_id":"01AAA","segments":[]}"#).unwrap();
        std::fs::create_dir_all(home.join("recordings")).unwrap();
        let e = removal::note_dir(&home, "01AAA", |k| is_busy(&busy, k)).unwrap_err();
        assert!(e.contains("처리하는 중") && dir.exists());
        drop(guard);
        assert!(!is_busy(&busy, "01AAA"));
        assert!(removal::note_dir(&home, "01AAA", |k| is_busy(&busy, k)).is_ok());
        std::fs::remove_dir_all(&home).unwrap();
        // 다른 노트의 표시는 서로 영향이 없다
        let (a, b) = (BusyGuard::new(&busy, "01AAA"), BusyGuard::new(&busy, "01BBB"));
        drop(a);
        assert!(!is_busy(&busy, "01AAA") && is_busy(&busy, "01BBB"));
        drop(b);
    }

    #[test]
    fn cancel_index_kills_a_running_refresh_and_ignores_an_empty_slot() {
        let slot = IndexSlot::default();
        cancel_index(&slot);
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let child = Arc::new(Mutex::new(child));
        *slot.lock().unwrap() = Some(child.clone());
        cancel_index(&slot);
        let status = child.lock().unwrap().wait().unwrap();
        assert!(status.code().is_none(), "신호로 끝났다");
    }

    #[test]
    fn last_json_line() {
        assert_eq!(stdout_json("log\n{\"path\": \"/a b.txt\"}\n\n").unwrap()["path"], "/a b.txt");
        assert!(stdout_json("").is_err());
        assert!(stdout_json("done").is_err());
    }

    #[test]
    fn last_error_line_strips_typer_prefix() {
        assert_eq!(last_error_line("로그\n같은 참석자끼리는 합칠 수 없습니다.\n").as_deref(), Some("같은 참석자끼리는 합칠 수 없습니다."));
        assert_eq!(last_error_line("Error: 이름을 입력하세요.").as_deref(), Some("이름을 입력하세요."));
        // resolve_meeting의 실제 출력 (TYPER_USE_RICH=0, param_hint="MEETING"이라 따옴표 없음)
        assert_eq!(
            last_error_line("Try 'tractus speakers --help' for help.\n\nError: Invalid value for MEETING: ‘x’에 해당하는 노트가 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.\n").as_deref(),
            Some("‘x’에 해당하는 노트가 없습니다. 삭제되었거나 옮겨졌을 수 있습니다.")
        );
        assert_eq!(last_error_line("Error: Invalid value for '--recording': 녹음된 소리가 없습니다").as_deref(), Some("녹음된 소리가 없습니다"));
        assert_eq!(last_error_line(" \n"), None);
    }

    #[test]
    fn cannot_run_names_the_program() {
        assert!(procs::cannot_run("/x/recorder/.build/release/tractus-rec", "없음").starts_with("녹음 프로그램을 실행할 수 없습니다"));
        assert!(procs::cannot_run("~/.local/bin/tractus", "없음").starts_with("Tractus 엔진을 실행할 수 없습니다"));
    }

    #[test]
    fn cannot_run_keeps_the_os_text_out_of_the_sentence() {
        let e = procs::cannot_run("/x/.venv/bin/tractus", "No such file or directory (os error 2)");
        let (sentence, detail) = e.split_once('\n').expect("문장과 자세히가 줄로 갈린다");
        assert!(!sentence.contains("os error") && !sentence.contains("No such file"), "{sentence}");
        assert!(sentence.ends_with("(/x/.venv/bin/tractus)"));
        assert_eq!(detail, "No such file or directory (os error 2)");
        // 실행해 보면 실제 OS 오류도 같은 꼴이다
        let real = procs::cannot_run("/nonexistent/tractus", Command::new("/nonexistent/tractus").spawn().unwrap_err());
        assert!(real.lines().next().is_some_and(|l| !l.contains("os error")) && real.contains("os error 2"), "{real}");
    }
}
