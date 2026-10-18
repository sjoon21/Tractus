//! 메뉴 막대(트레이) 아이콘 (docs/desktop.md §3.1, 이슈 #1).
//!
//! 화면(webview)이 상태를 `tray_update`로 밀어 주고, Rust는 메뉴·제목·아이콘만 그린다.
//! 녹음 시작·종료·북마크는 직접 하지 않는다: `tray-action` 이벤트를 화면에 보내고 화면이 창의 단추와 같은 길로 처리한다.
//! 경과 시간은 화면 타이머에 기대지 않는다 (숨은 webview는 타이머가 늦어진다): 화면이 녹음 시작 시각을 한 번 보내고 Rust가 1초마다 제목을 고친다.

use crate::{AppState, Settings};
use serde_json::{json, Value};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, State, Wry};

const TRAY_ID: &str = "tractus-tray";
const TOOLTIP: &str = "Tractus";
const MAIN_WINDOW: &str = "main";
/// 메뉴에 보이는 최근 노트 수와 제목 길이 (넘으면 `…`)
const RECENT_MAX: usize = 5;
const RECENT_TITLE_CHARS: usize = 40;
/// 화면이 보내는 목록의 상한 (잘못된 값이 와도 메뉴가 끝없이 커지지 않게)
const RECENT_WIRE_MAX: usize = 20;
const TICK: Duration = Duration::from_secs(1);
/// 녹음 중 아이콘 옆 글자 (예: `●12:34`)
const TITLE_DOT: &str = "●";
/// 일시정지 중 아이콘 옆 글자 (예: `‖12:34`)
const TITLE_PAUSE: &str = "‖";

const ID_START: &str = "tray:record_start";
const ID_PAUSE: &str = "tray:record_pause";
const ID_RESUME: &str = "tray:record_resume";
const ID_STOP: &str = "tray:record_stop";
const ID_BOOKMARK: &str = "tray:bookmark";
const ID_OPEN: &str = "tray:open";
const ID_QUIT: &str = "tray:quit";
const ID_RECENT: &str = "tray:recent";
const ID_STATUS: &str = "tray:status";
/// 최근 노트 항목 ID는 이 접두어 + 노트 ID
const ID_NOTE: &str = "tray:note:";

// 문구는 WORDS.md §4.16
const STATUS_IDLE: &str = "대기 중";
const STATUS_STARTING: &str = "녹음 준비 중…";
const STATUS_CONVERTING: &str = "변환 중…";
/// 뒤에 일시정지 시점의 경과가 붙는다 (예: `일시정지됨 12:34`)
const STATUS_PAUSED: &str = "일시정지됨";
const STATUS_NO_RECORDER: &str = "녹음 프로그램을 찾지 못해 녹음할 수 없습니다";
const LABEL_START: &str = "녹음 시작";
const LABEL_PAUSE: &str = "일시정지";
const LABEL_RESUME: &str = "계속";
const LABEL_STOP: &str = "녹음 종료";
const LABEL_BOOKMARK: &str = "북마크 남기기";
const LABEL_RECENT: &str = "최근 노트";
const LABEL_OPEN: &str = "Tractus 열기";
const LABEL_QUIT: &str = "종료";
const UNTITLED: &str = "제목 없음";

// 아이콘은 @2x(36 px)를 쓴다: tray-icon은 macOS에서 어떤 이미지든 높이 18pt로 맞추므로 18pt 격자로 그려 줄이지 않고 픽셀에 딱 맞춘다. 1x 파일은 디자이너가 바꿔 끼우기 쉽게 같이 둔다
const ICON_IDLE: &[u8] = include_bytes!("../icons/tray/tray-idle@2x.png");
const ICON_RECORDING: &[u8] = include_bytes!("../icons/tray/tray-recording@2x.png");

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Phase {
    #[default]
    Idle,
    Recording,
    /// 일시정지: 앱은 계속 떠 있고 소리만 받지 않는다. 경과 시간은 멈춘다
    Paused,
    Converting,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Recent {
    pub id: String,
    pub title: String,
}

/// 화면이 보낸 상태. `ready`는 첫 `tray_update`를 받았는가 (그 전에는 녹음 시작을 켜지 않는다: 화면이 아직 준비되지 않았다)
#[derive(Clone, PartialEq, Debug)]
pub struct Payload {
    pub ready: bool,
    pub phase: Phase,
    pub started_at_ms: Option<i64>,
    /// 일시정지 중의 경과 (ms). 일시정지한 시간은 세지 않는다
    pub elapsed_ms: Option<i64>,
    pub progress_pct: Option<u8>,
    pub can_record: bool,
    pub can_bookmark: bool,
    pub recent: Vec<Recent>,
}

impl Default for Payload {
    fn default() -> Self {
        Payload { ready: false, phase: Phase::Idle, started_at_ms: None, elapsed_ms: None, progress_pct: None, can_record: false, can_bookmark: false, recent: Vec::new() }
    }
}

fn as_millis(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f as i64)).filter(|ms| *ms > 0)
}

/// 0 이상의 ms (경과는 0부터 센다). 음수·NaN은 없는 것으로 본다
fn as_elapsed_ms(v: &Value) -> Option<i64> {
    v.as_i64().or_else(|| v.as_f64().filter(|f| f.is_finite()).map(|f| f as i64)).filter(|ms| *ms >= 0)
}

fn parse_recent(v: &Value) -> Vec<Recent> {
    let Some(list) = v.as_array() else { return Vec::new() };
    list.iter()
        .filter_map(|n| {
            let id = n.get("id")?.as_str().filter(|s| !s.is_empty())?;
            let title = n.get("title").and_then(Value::as_str).unwrap_or("");
            Some(Recent { id: id.to_string(), title: title.to_string() })
        })
        .take(RECENT_WIRE_MAX)
        .collect()
}

/// 화면의 payload를 읽는다. 무엇이 와도 실패하지 않는다 (옛 화면·잘못된 값): 모르는 값은 기본값으로 읽는다.
/// `recent`가 없으면 `prev`를 그대로 둔다 (화면은 목록이 바뀔 때만 보낸다)
pub fn parse_payload(v: &Value, prev: &[Recent]) -> Payload {
    let phase = match v.get("phase").and_then(Value::as_str) {
        Some("recording") => Phase::Recording,
        Some("paused") => Phase::Paused,
        Some("converting") => Phase::Converting,
        _ => Phase::Idle,
    };
    Payload {
        ready: true,
        phase,
        started_at_ms: v.get("started_at_ms").and_then(as_millis),
        elapsed_ms: v.get("elapsed_ms").and_then(as_elapsed_ms),
        progress_pct: v.get("progress_pct").and_then(Value::as_f64).filter(|f| f.is_finite()).map(|f| f.clamp(0.0, 100.0).round() as u8),
        can_record: v.get("can_record").and_then(Value::as_bool).unwrap_or(true),
        can_bookmark: v.get("can_bookmark").and_then(Value::as_bool).unwrap_or(false),
        recent: v.get("recent").map(parse_recent).unwrap_or_else(|| prev.to_vec()),
    }
}

/// 초 → `12:34`, 한 시간이 넘으면 `1:02:03`
pub fn fmt_elapsed(secs: u64) -> String {
    let (h, m, s) = (secs / 3600, secs % 3600 / 60, secs % 60);
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// 시작 시각(epoch ms)에서 지금까지 흐른 초. 시계가 거꾸로 가면 0
pub fn elapsed_secs(started_ms: i64, now_ms: i64) -> u64 {
    (now_ms.saturating_sub(started_ms).max(0) / 1000) as u64
}

/// 최근 노트 메뉴 글자: 줄바꿈은 공백 하나로, 비면 `제목 없음`, 40자를 넘으면 `…`
pub fn recent_label(title: &str) -> String {
    let one_line = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.is_empty() {
        return UNTITLED.into();
    }
    if one_line.chars().count() <= RECENT_TITLE_CHARS {
        return one_line;
    }
    format!("{}…", one_line.chars().take(RECENT_TITLE_CHARS).collect::<String>().trim_end())
}

/// 메뉴 한 줄. 상태 줄은 따로 둔다 (경과 시간이 1초마다 바뀌므로 메뉴를 다시 만들지 않고 글자만 고친다)
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Entry {
    Item { id: &'static str, label: &'static str, enabled: bool },
    Separator,
    /// (메뉴 항목 ID, 글자). 비어 있으면 `최근 노트`는 못 누른다
    Recent(Vec<(String, String)>),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct View {
    pub status: String,
    /// 아이콘 옆 글자. 녹음 중일 때만
    pub title: Option<String>,
    pub recording_icon: bool,
    /// 1초마다 글자를 고쳐야 하는가
    pub ticking: bool,
    pub entries: Vec<Entry>,
}

/// 상태 → 메뉴·제목·아이콘 (순수 함수)
pub fn render(p: &Payload, now_ms: i64) -> View {
    let live = p.phase == Phase::Recording && p.started_at_ms.is_some();
    let elapsed = p.started_at_ms.map(|t| fmt_elapsed(elapsed_secs(t, now_ms)));
    // 일시정지: 화면이 일시정지한 순간의 경과를 보낸다. 시계를 읽지 않으므로 멈춰 있고 타이머도 필요 없다
    let paused = (p.phase == Phase::Paused).then(|| fmt_elapsed(p.elapsed_ms.map_or(0, |ms| (ms / 1000) as u64)));
    let status = match (p.phase, &elapsed) {
        (Phase::Recording, Some(e)) => format!("녹음 중 {e}"),
        (Phase::Recording, None) => STATUS_STARTING.into(),
        (Phase::Paused, _) => format!("{STATUS_PAUSED} {}", paused.as_deref().unwrap_or("00:00")),
        (Phase::Converting, _) => p.progress_pct.map_or_else(|| STATUS_CONVERTING.into(), |n| format!("변환 중 {n}%")),
        (Phase::Idle, _) if p.ready && !p.can_record => STATUS_NO_RECORDER.into(),
        (Phase::Idle, _) => STATUS_IDLE.into(),
    };
    let recent = p.recent.iter().take(RECENT_MAX).map(|n| (format!("{ID_NOTE}{}", n.id), recent_label(&n.title))).collect();
    View {
        status,
        title: if live { elapsed.map(|e| format!("{TITLE_DOT}{e}")) } else { paused.map(|e| format!("{TITLE_PAUSE}{e}")) },
        recording_icon: p.phase == Phase::Recording,
        ticking: live,
        entries: vec![
            Entry::Item { id: ID_START, label: LABEL_START, enabled: p.ready && !matches!(p.phase, Phase::Recording | Phase::Paused) && p.can_record },
            // 일시정지 중에는 같은 자리가 `계속`이 된다
            if p.phase == Phase::Paused { Entry::Item { id: ID_RESUME, label: LABEL_RESUME, enabled: true } } else { Entry::Item { id: ID_PAUSE, label: LABEL_PAUSE, enabled: live } },
            Entry::Item { id: ID_STOP, label: LABEL_STOP, enabled: live || p.phase == Phase::Paused },
            Entry::Item { id: ID_BOOKMARK, label: LABEL_BOOKMARK, enabled: (live || p.phase == Phase::Paused) && p.can_bookmark },
            Entry::Separator,
            Entry::Recent(recent),
            Entry::Separator,
            Entry::Item { id: ID_OPEN, label: LABEL_OPEN, enabled: true },
            Entry::Item { id: ID_QUIT, label: LABEL_QUIT, enabled: true },
        ],
    }
}

/// 창을 닫을 때 끝내지 않고 숨기는가: 두 설정이 모두 켜져 있고 아이콘이 실제로 떠 있을 때만
pub fn should_hide_on_close(s: &Settings, tray_exists: bool) -> bool {
    s.tray_enabled && s.keep_in_tray && tray_exists
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

// ── 아이콘·메뉴 (tauri) ──

fn icon(recording: bool) -> tauri::Result<Image<'static>> {
    Image::from_bytes(if recording { ICON_RECORDING } else { ICON_IDLE })
}

fn build_menu(app: &AppHandle, view: &View) -> tauri::Result<(Menu<Wry>, MenuItem<Wry>)> {
    let status = MenuItem::with_id(app, ID_STATUS, &view.status, false, None::<&str>)?;
    let menu = Menu::new(app)?;
    menu.append(&status)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for entry in &view.entries {
        match entry {
            Entry::Item { id, label, enabled } => menu.append(&MenuItem::with_id(app, *id, *label, *enabled, None::<&str>)?)?,
            Entry::Separator => menu.append(&PredefinedMenuItem::separator(app)?)?,
            Entry::Recent(notes) => {
                let sub = Submenu::with_id(app, ID_RECENT, LABEL_RECENT, !notes.is_empty())?;
                for (id, label) in notes {
                    sub.append(&MenuItem::with_id(app, id.as_str(), label, true, None::<&str>)?)?;
                }
                menu.append(&sub)?;
            }
        }
    }
    Ok((menu, status))
}

fn create_tray(app: &AppHandle) -> tauri::Result<TrayIcon<Wry>> {
    // 메뉴 이벤트는 앱 전체 핸들러(lib.rs `on_menu_event`)가 받는다: 트레이를 다시 만들 때마다 핸들러가 쌓이지 않게
    TrayIconBuilder::with_id(TRAY_ID).icon(icon(false)?).icon_as_template(true).tooltip(TOOLTIP).show_menu_on_left_click(true).build(app)
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// 화면이 아직 준비되지 않았거나 닫혔으면 이벤트는 조용히 버려진다
fn emit_action(app: &AppHandle, action: &str, id: Option<&str>) {
    let mut payload = json!({ "action": action });
    if let Some(id) = id {
        payload["id"] = json!(id);
    }
    let _ = app.emit_to(MAIN_WINDOW, "tray-action", payload);
}

/// 메뉴 항목을 눌렀다 (lib.rs의 앱 전체 메뉴 핸들러가 부른다). 트레이 항목이 아니면 아무것도 하지 않는다
pub fn on_menu_event(app: &AppHandle, id: &str) {
    match id {
        ID_START => emit_action(app, "record_start", None),
        ID_PAUSE => emit_action(app, "record_pause", None),
        ID_RESUME => emit_action(app, "record_resume", None),
        ID_STOP => emit_action(app, "record_stop", None),
        ID_BOOKMARK => emit_action(app, "bookmark", None),
        ID_OPEN => show_main(app),
        ID_QUIT => crate::begin_quit(app), // ⌘Q와 같은 길: 쓰던 메모를 저장하고, 3초 안에 끝낸다
        _ => {
            if let Some(note) = id.strip_prefix(ID_NOTE) {
                show_main(app);
                emit_action(app, "open_note", Some(note));
            }
        }
    }
}

// ── 상태 ──

#[derive(Default)]
struct Inner {
    payload: Payload,
    tray: Option<TrayIcon<Wry>>,
    /// 지금 화면(메뉴 막대)에 보이는 것. 바뀐 것만 고친다
    shown_entries: Option<Vec<Entry>>,
    shown_status: String,
    shown_title: Option<String>,
    shown_recording_icon: Option<bool>,
    status_item: Option<MenuItem<Wry>>,
    /// 경과 시간 타이머. 보내는 쪽을 버리면 스레드가 바로 끝난다 (단계가 바뀜·아이콘을 끔·앱 종료)
    ticker: Option<Sender<()>>,
}

impl Inner {
    fn forget_shown(&mut self) {
        self.shown_entries = None;
        self.shown_status.clear();
        self.shown_title = None;
        self.shown_recording_icon = None;
        self.status_item = None;
        self.ticker = None;
    }

    /// 상태에 맞게 메뉴 막대를 고친다. 메뉴는 줄이 바뀔 때만 다시 만든다. 메인 스레드에서만 부른다 (잠금을 쥔 채 UI를 고친다)
    fn sync(&mut self, app: &AppHandle) {
        let Some(tray) = self.tray.clone() else {
            self.ticker = None;
            return;
        };
        let view = render(&self.payload, now_ms());
        if self.shown_entries.as_ref() != Some(&view.entries) {
            match build_menu(app, &view) {
                Ok((menu, status)) => {
                    if let Err(e) = tray.set_menu(Some(menu)) {
                        eprintln!("메뉴 막대 메뉴를 바꾸지 못했습니다: {e}");
                    }
                    self.status_item = Some(status);
                    self.shown_status = view.status.clone();
                    self.shown_entries = Some(view.entries.clone());
                }
                Err(e) => eprintln!("메뉴 막대 메뉴를 만들지 못했습니다: {e}"),
            }
        }
        if self.shown_status != view.status {
            if let Some(item) = &self.status_item {
                let _ = item.set_text(&view.status);
            }
            self.shown_status = view.status.clone();
        }
        if self.shown_title != view.title {
            let _ = tray.set_title(view.title.as_deref());
            self.shown_title = view.title.clone();
        }
        if self.shown_recording_icon != Some(view.recording_icon) {
            match icon(view.recording_icon) {
                // macOS의 set_icon은 템플릿 표시를 지운다: 바로 다시 건다
                Ok(img) => {
                    let _ = tray.set_icon(Some(img));
                    let _ = tray.set_icon_as_template(true);
                    self.shown_recording_icon = Some(view.recording_icon);
                }
                Err(e) => eprintln!("메뉴 막대 아이콘을 읽지 못했습니다: {e}"),
            }
        }
        match (view.ticking, self.ticker.is_some()) {
            (true, false) => self.ticker = Some(spawn_ticker(app.clone())),
            (false, true) => self.ticker = None,
            _ => {}
        }
    }
}

/// 1초마다 메인 스레드에서 `sync`를 부른다. 보내는 쪽(Sender)이 사라지면 끝난다.
/// 스레드는 UI를 직접 만지지 않는다 (트레이 핸들을 메인 스레드 밖에서 버리지 않게)
fn spawn_ticker(app: AppHandle) -> Sender<()> {
    let (tx, rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        while let Err(RecvTimeoutError::Timeout) = rx.recv_timeout(TICK) {
            let handle = app.clone();
            if app.run_on_main_thread(move || handle.state::<TrayState>().tick(&handle)).is_err() {
                break; // 앱이 끝나는 중
            }
        }
    });
    tx
}

#[derive(Default)]
pub struct TrayState(Mutex<Inner>);

impl TrayState {
    /// 화면이 오래된 채로 죽어도(잠금 오염) 패닉하지 않는다
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub fn exists(&self) -> bool {
        self.lock().tray.is_some()
    }

    fn tick(&self, app: &AppHandle) {
        self.lock().sync(app);
    }

    /// 화면이 상태를 보냈다. 같은 값이면 아무것도 하지 않는다
    pub fn update(&self, app: &AppHandle, payload: &Value) {
        let mut g = self.lock();
        let next = parse_payload(payload, &g.payload.recent);
        if next == g.payload {
            return;
        }
        g.payload = next;
        g.sync(app);
    }

    /// 설정대로 아이콘을 만들거나 없앤다 (다시 시작하지 않아도 된다). 만들지 못하면 기록만 하고 계속한다
    pub fn apply(&self, app: &AppHandle, s: &Settings) {
        let mut g = self.lock();
        match (s.tray_enabled, g.tray.is_some()) {
            (true, false) => match create_tray(app) {
                Ok(t) => {
                    g.tray = Some(t);
                    g.forget_shown();
                    g.sync(app);
                }
                Err(e) => eprintln!("메뉴 막대 아이콘을 만들 수 없습니다: {e}"),
            },
            (false, true) => {
                let tray = g.tray.take();
                g.forget_shown();
                drop(g);
                app.remove_tray_by_id(TRAY_ID);
                drop(tray);
                show_main(app); // 창이 숨어 있었다면 다시 찾을 길이 Dock뿐이다
            }
            _ => {}
        }
    }

    /// 앱이 끝난다: 타이머를 멈춘다
    pub fn shutdown(&self) {
        self.lock().ticker = None;
    }
}

/// 창을 닫으려 한다: 숨기고 앱은 계속 돈다. lib.rs의 창 이벤트 핸들러와 화면이 같은 판단을 쓴다
pub fn hides_on_close(app: &AppHandle) -> bool {
    let (Some(state), Some(tray)) = (app.try_state::<AppState>(), app.try_state::<TrayState>()) else { return false };
    should_hide_on_close(&state.settings(), tray.exists())
}

/// Dock 아이콘을 눌렀을 때(macOS) 숨은 창을 다시 보인다
pub fn reopen(app: &AppHandle, has_visible_windows: bool) {
    if !has_visible_windows {
        show_main(app);
    }
}

// ── 명령 ──

/// 화면이 메뉴 막대에 보일 상태를 보낸다. 오래된 화면이 이상한 값을 보내도 패닉하지 않는다
#[tauri::command]
pub fn tray_update(app: AppHandle, tray: State<'_, TrayState>, payload: Value) {
    tray.update(&app, &payload);
}

/// 지금 창을 닫으면 숨기기만 하는가 (화면의 닫기 확인이 이 답으로 묻지 않고 넘어간다)
#[tauri::command]
pub fn tray_hides_on_close(app: AppHandle) -> bool {
    hides_on_close(&app)
}

/// 화면이 보여야 할 일(숨은 창에서 녹음이 시작되지 못함·녹음 경고)이 생겼다: 창이 숨었거나 최소화돼 있으면 꺼낸다. 이미 보이면 아무것도 하지 않는다
#[tauri::command]
pub fn tray_show_if_hidden(app: AppHandle) {
    let Some(w) = app.get_webview_window(MAIN_WINDOW) else { return };
    if !w.is_visible().unwrap_or(true) || w.is_minimized().unwrap_or(false) {
        show_main(&app);
    }
}

/// 설정 화면의 두 스위치. 바로 적용하고 설정 파일의 그 두 키만 바꾼다 (환경변수 기본값이 파일에 굳지 않게)
#[tauri::command]
pub fn set_tray_prefs(app: AppHandle, state: State<'_, AppState>, tray: State<'_, TrayState>, tray_enabled: bool, keep_in_tray: bool) -> Result<(), String> {
    crate::patch_settings(&state.config_path, |raw| {
        let raw = crate::merge_flag(raw, "tray_enabled", tray_enabled)?;
        crate::merge_flag(Some(&raw), "keep_in_tray", keep_in_tray)
    })?;
    {
        let mut s = state.settings.lock().unwrap();
        s.tray_enabled = tray_enabled;
        s.keep_in_tray = keep_in_tray;
    }
    tray.apply(&app, &state.settings());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn recording(started: i64) -> Payload {
        Payload { ready: true, phase: Phase::Recording, started_at_ms: Some(started), can_bookmark: true, ..Payload::default() }
    }

    fn idle() -> Payload {
        Payload { ready: true, can_record: true, ..Payload::default() }
    }

    fn item(view: &View, id: &str) -> (&'static str, bool) {
        view.entries
            .iter()
            .find_map(|e| match e {
                Entry::Item { id: i, label, enabled } if *i == id => Some((*label, *enabled)),
                _ => None,
            })
            .unwrap()
    }

    #[test]
    fn elapsed_is_mm_ss_then_h_mm_ss() {
        assert_eq!(fmt_elapsed(0), "00:00");
        assert_eq!(fmt_elapsed(9), "00:09");
        assert_eq!(fmt_elapsed(754), "12:34");
        assert_eq!(fmt_elapsed(3599), "59:59");
        assert_eq!(fmt_elapsed(3600), "1:00:00");
        assert_eq!(fmt_elapsed(3723), "1:02:03");
        assert_eq!(elapsed_secs(1_000, 13_999), 12);
        assert_eq!(elapsed_secs(5_000, 1_000), 0); // 시계가 거꾸로 가도 음수가 되지 않는다
        assert_eq!(elapsed_secs(i64::MIN, i64::MAX), (i64::MAX / 1000) as u64); // 넘쳐도 패닉하지 않는다
    }

    #[test]
    fn idle_menu_enables_start_only() {
        let v = render(&idle(), 0);
        assert_eq!(v.status, "대기 중");
        assert_eq!(v.title, None);
        assert!(!v.recording_icon && !v.ticking);
        assert_eq!(item(&v, ID_START), ("녹음 시작", true));
        assert_eq!(item(&v, ID_STOP), ("녹음 종료", false));
        assert_eq!(item(&v, ID_PAUSE), ("일시정지", false));
        assert_eq!(item(&v, ID_BOOKMARK), ("북마크 남기기", false));
        assert_eq!(item(&v, ID_OPEN), ("Tractus 열기", true));
        assert_eq!(item(&v, ID_QUIT), ("종료", true));
    }

    #[test]
    fn recording_menu_shows_elapsed_and_enables_stop_and_bookmark() {
        let v = render(&recording(1_000_000), 1_000_000 + 754_000);
        assert_eq!(v.status, "녹음 중 12:34");
        assert_eq!(v.title.as_deref(), Some("●12:34"));
        assert!(v.recording_icon && v.ticking);
        assert!(!item(&v, ID_START).1);
        assert!(item(&v, ID_STOP).1 && item(&v, ID_BOOKMARK).1);
        // 경과 시간이 흘러도 메뉴 줄은 같다 (다시 만들지 않는다)
        assert_eq!(v.entries, render(&recording(1_000_000), 1_000_000 + 99_000).entries);
        // 북마크를 못 남기는 상태면 눌리지 않는다
        let p = Payload { can_bookmark: false, ..recording(0) };
        assert!(!item(&render(&p, 0), ID_BOOKMARK).1);
    }

    #[test]
    fn recording_menu_offers_pause() {
        let v = render(&recording(0), 5_000);
        assert_eq!(item(&v, ID_PAUSE), ("일시정지", true));
        // 준비 중(시작 시각 없음)에는 일시정지도 못 누른다
        assert!(!item(&render(&Payload { started_at_ms: None, ..recording(0) }, 0), ID_PAUSE).1);
    }

    #[test]
    fn paused_menu_freezes_the_clock_and_swaps_pause_for_resume() {
        // 경과는 화면이 보낸 값이다: 시계(now)가 아무리 흘러도 같다. 일시정지한 시간은 세지 않는다
        let p = Payload { ready: true, phase: Phase::Paused, elapsed_ms: Some(754_900), can_bookmark: true, ..Payload::default() };
        let (a, b) = (render(&p, 0), render(&p, 99_000_000));
        assert_eq!(a, b);
        assert_eq!(a.status, "일시정지됨 12:34");
        assert_eq!(a.title.as_deref(), Some("‖12:34"));
        assert!(!a.ticking, "타이머는 멈춘다");
        assert!(!a.recording_icon, "붉은 점 아이콘은 녹음 중에만");
        assert_eq!(item(&a, ID_RESUME), ("계속", true));
        assert!(!a.entries.iter().any(|e| matches!(e, Entry::Item { id, .. } if *id == ID_PAUSE)), "같은 자리에서 일시정지가 계속으로 바뀐다");
        assert!(!item(&a, ID_START).1, "일시정지 중에는 새 녹음을 시작하지 않는다");
        assert!(item(&a, ID_STOP).1 && item(&a, ID_BOOKMARK).1, "끝내기·북마크는 일시정지 중에도 된다");
        assert!(!item(&render(&Payload { can_bookmark: false, ..p.clone() }, 0), ID_BOOKMARK).1);
        // 경과를 모르면 처음부터 센 것으로 본다 (옛 화면)
        assert_eq!(render(&Payload { elapsed_ms: None, ..p.clone() }, 0).status, "일시정지됨 00:00");
        // 한 시간이 넘어도 같은 모양이다
        assert_eq!(render(&Payload { elapsed_ms: Some(3_723_000), ..p }, 0).title.as_deref(), Some("‖1:02:03"));
        // 계속하면 다시 녹음 중이다: 화면이 시작 시각을 일시정지한 시간만큼 뒤로 옮겨 보낸다
        let resumed = render(&recording(1_000_000), 1_000_000 + 754_000);
        assert_eq!(resumed.status, "녹음 중 12:34");
        assert!(resumed.ticking && resumed.recording_icon);
        assert_eq!(item(&resumed, ID_PAUSE), ("일시정지", true));
    }

    #[test]
    fn recording_without_start_time_is_not_ready_to_stop() {
        let p = Payload { started_at_ms: None, ..recording(0) };
        let v = render(&p, 0);
        assert_eq!(v.status, "녹음 준비 중…");
        assert!(v.recording_icon && !v.ticking && v.title.is_none());
        assert!(!item(&v, ID_START).1 && !item(&v, ID_STOP).1 && !item(&v, ID_BOOKMARK).1);
    }

    #[test]
    fn converting_shows_progress_and_blocks_start() {
        let p = Payload { ready: true, phase: Phase::Converting, progress_pct: Some(45), can_record: false, ..Payload::default() };
        let v = render(&p, 0);
        assert_eq!(v.status, "변환 중 45%");
        assert!(!item(&v, ID_START).1 && !item(&v, ID_STOP).1 && !v.ticking && v.title.is_none() && !v.recording_icon);
        assert_eq!(render(&Payload { progress_pct: None, ..p.clone() }, 0).status, "변환 중…");
        // 파일 가져오기 변환은 녹음을 막지 않는다 (창의 녹음 단추와 같다): 화면이 can_record로 정한다
        assert!(item(&render(&Payload { can_record: true, ..p }, 0), ID_START).1);
    }

    #[test]
    fn missing_recorder_disables_start_and_says_why() {
        let v = render(&Payload { can_record: false, ..idle() }, 0);
        assert_eq!(v.status, "녹음 프로그램을 찾지 못해 녹음할 수 없습니다");
        assert!(!item(&v, ID_START).1);
        // 화면이 아직 아무것도 보내지 않았다: 녹음은 막지만 이유를 말하지는 않는다
        let v = render(&Payload::default(), 0);
        assert_eq!(v.status, "대기 중");
        assert!(!item(&v, ID_START).1);
    }

    #[test]
    fn recent_list_is_capped_truncated_and_keeps_order() {
        let notes: Vec<Recent> = (1..=7).map(|i| Recent { id: format!("n{i}"), title: format!("노트 {i}") }).collect();
        let v = render(&Payload { recent: notes, ..idle() }, 0);
        let Some(Entry::Recent(items)) = v.entries.iter().find(|e| matches!(e, Entry::Recent(_))) else { panic!("최근 노트 줄이 없다") };
        assert_eq!(items.len(), 5);
        assert_eq!(items[0], ("tray:note:n1".to_string(), "노트 1".to_string()));
        assert_eq!(items[4].0, "tray:note:n5");

        assert_eq!(recent_label("짧은 제목"), "짧은 제목");
        assert_eq!(recent_label("  줄\n바꿈\t제목  "), "줄 바꿈 제목");
        assert_eq!(recent_label(" \n "), "제목 없음");
        let exactly = "가".repeat(40);
        assert_eq!(recent_label(&exactly), exactly);
        let long = "가".repeat(41);
        assert_eq!(recent_label(&long), format!("{}…", "가".repeat(40)));
        assert!(recent_label(&"😀".repeat(100)).chars().count() <= 41); // 글자 단위로 자른다 (바이트 경계에서 패닉하지 않는다)

        // 비어 있으면 `최근 노트`는 못 누르는 빈 항목
        let empty = render(&idle(), 0);
        assert!(empty.entries.contains(&Entry::Recent(vec![])));
    }

    #[test]
    fn payload_parsing_is_lenient() {
        let prev = vec![Recent { id: "a".into(), title: "이전".into() }];
        let p = parse_payload(
            &json!({"phase": "recording", "started_at_ms": 1.7e12, "progress_pct": 250, "can_record": false, "can_bookmark": true, "recent": [{"id": "x", "title": "새 노트"}, {"id": ""}, {"title": "id 없음"}, 7]}),
            &prev,
        );
        assert!(p.ready && p.phase == Phase::Recording && !p.can_record && p.can_bookmark);
        // 일시정지: 경과(ms)를 싣는다. 음수·문자열은 없는 것으로, 0은 받는다
        let paused = parse_payload(&json!({"phase": "paused", "elapsed_ms": 754_000.4}), &[]);
        assert_eq!((paused.phase, paused.elapsed_ms), (Phase::Paused, Some(754_000)));
        assert_eq!(parse_payload(&json!({"phase": "paused", "elapsed_ms": 0}), &[]).elapsed_ms, Some(0));
        for bad in [json!(-1), json!("12"), json!(null), json!(f64::MAX / 1e300)] {
            let got = parse_payload(&json!({"phase": "paused", "elapsed_ms": bad}), &[]).elapsed_ms;
            assert!(got.is_none_or(|ms| ms >= 0), "{bad}");
        }
        assert_eq!(p.started_at_ms, Some(1_700_000_000_000));
        assert_eq!(p.progress_pct, Some(100)); // 범위 밖은 끌어 넣는다
        assert_eq!(p.recent, vec![Recent { id: "x".into(), title: "새 노트".into() }]);

        // recent가 없으면 이전 목록을 그대로 둔다. 빈 배열은 비우라는 뜻이다
        assert_eq!(parse_payload(&json!({"phase": "idle"}), &prev).recent, prev);
        assert!(parse_payload(&json!({"recent": []}), &prev).recent.is_empty());

        // 모르는 단계·이상한 타입·객체가 아닌 값도 패닉하지 않는다
        let p = parse_payload(&json!({"phase": 3, "started_at_ms": "soon", "progress_pct": null, "can_record": "yes"}), &[]);
        assert_eq!((p.phase, p.started_at_ms, p.progress_pct, p.can_record, p.can_bookmark), (Phase::Idle, None, None, true, false));
        for junk in [json!(null), json!(5), json!("x"), json!([1, 2]), json!({"started_at_ms": -5}), json!({"started_at_ms": f64::MAX})] {
            let p = parse_payload(&junk, &[]);
            assert!(p.ready && p.started_at_ms.is_none_or(|ms| ms > 0));
        }
        let many: Vec<Value> = (0..100).map(|i| json!({"id": format!("n{i}"), "title": "t"})).collect();
        assert_eq!(parse_payload(&json!({"recent": many}), &[]).recent.len(), RECENT_WIRE_MAX);
    }

    #[test]
    fn close_hides_only_when_both_settings_are_on_and_the_icon_exists() {
        let on = Settings::default();
        assert!(on.tray_enabled && on.keep_in_tray); // 기본값은 둘 다 켜짐
        assert!(should_hide_on_close(&on, true));
        assert!(!should_hide_on_close(&on, false)); // 아이콘을 못 만들었다: 숨으면 다시 찾을 수 없다
        assert!(!should_hide_on_close(&Settings { keep_in_tray: false, ..on.clone() }, true));
        assert!(!should_hide_on_close(&Settings { tray_enabled: false, ..on.clone() }, true));
        assert!(!should_hide_on_close(&Settings { tray_enabled: false, keep_in_tray: false, ..on }, true));
    }

    #[test]
    fn old_settings_files_get_tray_defaults() {
        let s: Settings = serde_json::from_str(r#"{"home":"/x"}"#).unwrap();
        assert!(s.tray_enabled && s.keep_in_tray);
        let s: Settings = serde_json::from_str(r#"{"tray_enabled":false}"#).unwrap();
        assert!(!s.tray_enabled && s.keep_in_tray);
    }

    #[test]
    fn icons_are_png_template_sizes() {
        for (bytes, size) in [(ICON_IDLE, 36), (ICON_RECORDING, 36)] {
            assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n");
            assert_eq!(u32::from_be_bytes(bytes[16..20].try_into().unwrap()), size);
            assert_eq!(u32::from_be_bytes(bytes[20..24].try_into().unwrap()), size);
        }
    }
}
