//! ⌘Q·마지막 창 닫기 종료 흐름: 화면이 쓰던 메모를 저장할 때까지(최대 3초) 종료를 미룬다.
//! 녹음 중이면 시간 제한 없이 화면이 먼저 묻는다(`녹음을 끝내고 종료할까요?`, docs/desktop.md §3.10): 끝내기는 quit_ready, 계속은 quit_cancel.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// ⌘Q 종료 흐름: 화면이 쓰던 메모를 저장하는 동안 종료를 미룬다. QUIT_ASKED는 한 번만 묻게, QUIT_READY는 미룬 종료를 통과시킨다
static QUIT_ASKED: AtomicBool = AtomicBool::new(false);
static QUIT_READY: AtomicBool = AtomicBool::new(false);
/// 화면이 응답하지 않아도 이 시간 뒤에는 끝낸다
const QUIT_WAIT: Duration = Duration::from_secs(3);

/// 화면이 쓰던 메모를 저장했다: 미룬 종료를 이어 간다
#[tauri::command]
pub fn quit_ready(app: AppHandle) {
    QUIT_READY.store(true, Ordering::SeqCst);
    app.exit(0);
}

/// 녹음 중 종료를 묻는 창에서 `계속 녹음`을 골랐다: 다음 종료 요청을 다시 받는다
#[tauri::command]
pub fn quit_cancel() {
    QUIT_ASKED.store(false, Ordering::SeqCst);
}

/// 종료를 한 번만 미루고 화면에 저장하라고 알린다. 3초 안에 quit_ready가 오지 않아도 끝낸다.
/// 녹음 중이면 창을 보이고 화면이 묻게 한다(시간 제한 없음: 사람이 고를 때까지 기다린다)
pub(crate) fn begin_quit(app: &AppHandle) {
    if app.webview_windows().is_empty() {
        QUIT_READY.store(true, Ordering::SeqCst);
        return app.exit(0);
    }
    if QUIT_ASKED.swap(true, Ordering::SeqCst) {
        return;
    }
    let recording = app.state::<crate::AppState>().rec.lock().unwrap().is_some();
    let _ = app.emit("quit-requested", serde_json::json!({ "recording": recording }));
    if recording {
        crate::tray::show_main(app); // 메뉴 막대의 종료: 숨긴 창에 묻는 창이 뜬다
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(QUIT_WAIT);
        QUIT_READY.store(true, Ordering::SeqCst);
        handle.exit(0);
    });
}

/// 마지막 창이 닫혀 앱이 끝나려 할 때: 열린 창이 있으면 한 번 미룬다. 이미 통과시키기로 했거나 창이 없으면 그대로 둔다
pub(crate) fn defer_exit(app: &AppHandle, api: &tauri::ExitRequestApi) {
    if QUIT_READY.load(Ordering::SeqCst) || app.webview_windows().is_empty() {
        return;
    }
    api.prevent_exit();
    begin_quit(app);
}

/// macOS ⌘Q: 기본 메뉴의 종료 항목은 Cocoa `terminate:`라 ExitRequested를 거치지 않고 바로 끝난다(미룰 수 없다).
/// 그래서 그 항목을 직접 만든 항목으로 바꿔, 눌렀을 때 begin_quit을 부른다. (Dock의 종료는 여전히 `terminate:`다)
pub(crate) const QUIT_MENU_ID: &str = "quit-tractus";

#[cfg(target_os = "macos")]
pub(crate) fn app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    let menu = Menu::default(app)?;
    if let Some(MenuItemKind::Submenu(app_sub)) = menu.items()?.into_iter().next() {
        // 기본 앱 메뉴의 마지막 항목이 종료다 (tauri 2.12.1 menu.rs)
        if let Some(last) = app_sub.items()?.pop().filter(|k| matches!(k, MenuItemKind::Predefined(_))) {
            app_sub.remove(&last)?;
        }
        let name = app.package_info().name.clone();
        app_sub.append(&MenuItem::with_id(app, QUIT_MENU_ID, format!("Quit {name}"), true, Some("Cmd+Q"))?)?;
    }
    Ok(menu)
}
