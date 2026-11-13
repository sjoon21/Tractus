// 녹음 미니 창 (창 `mini`, mini.html): 녹음 중 다른 앱을 쓰는 동안 화면 구석에 떠 있는 작은 녹음 막대.
// 상태·단추는 메뉴 막대 팝오버와 같다 (tray.rs `popover_state`·`tray_popover_action`). 여기는 언제 보이는지와 창 만들기만 한다.
// 참고: Yogurt(FrigadeHQ/yogurt, MIT)의 떠 있는 녹음기. 코드는 가져오지 않았다.
use serde_json::Value;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use crate::tray::Phase;
use crate::AppState;

pub const MINI_WINDOW: &str = "mini";
const MAIN_WINDOW: &str = "main";
const WIDTH: f64 = 320.0;
const HEIGHT: f64 = 56.0;
/// 화면 오른쪽 위에서 떨어진 거리 (pt). 메뉴 막대(24pt) 아래
const MARGIN: f64 = 12.0;
const TOP: f64 = 36.0;

/// 미니 창을 보일까: 설정이 켜져 있고, 녹음(일시정지 포함) 중이고, 메인 창을 보고 있지 않을 때.
/// 메인 창에 초점이 있으면 녹음 화면이 같은 단추를 이미 보인다
/// 통화 감지의 카드(`녹음할까요?`·`끝낼까요?`)가 있으면 설정·초점과 상관없이 보인다 (calls.rs)
pub fn visible(enabled: bool, phase: Phase, main_focused: bool, card: bool) -> bool {
    card || enabled && matches!(phase, Phase::Recording | Phase::Paused) && !main_focused
}

fn build(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let win = WebviewWindowBuilder::new(app, MINI_WINDOW, WebviewUrl::App("mini.html".into()))
        .title("Tractus")
        .inner_size(WIDTH, HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false) // 그림자는 화면의 카드가 그린다 (팝오버와 같다)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible_on_all_workspaces(true)
        .focused(false) // 보일 때 다른 앱의 키 입력을 빼앗지 않는다
        .visible(false)
        .build()?;
    // 처음 한 번만 자리를 잡는다: 그 뒤에는 사용자가 끌어다 놓은 자리를 지킨다 (숨겨도 창은 남는다)
    if let Ok(Some(m)) = win.primary_monitor() {
        let s = m.scale_factor();
        let (x, w) = (f64::from(m.position().x) / s, f64::from(m.size().width) / s);
        let y = f64::from(m.position().y) / s;
        let _ = win.set_position(LogicalPosition::new(x + w - WIDTH - MARGIN, y + TOP));
    }
    Ok(win)
}

/// 상태·초점·설정이 바뀌었다: 미니 창을 보이거나 숨기고, 보이면 새 상태를 보낸다. 메인 스레드에서 부른다
pub fn sync(app: &AppHandle, phase: Phase, mut state: Value) {
    let enabled = app.try_state::<AppState>().is_none_or(|s| s.settings().mini_recorder);
    let main_focused = app.get_webview_window(MAIN_WINDOW).is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false) && w.is_focused().unwrap_or(false));
    let card = app.try_state::<crate::calls::CallState>().map_or(Value::Null, |c| c.card_json());
    let existing = app.get_webview_window(MINI_WINDOW);
    if !visible(enabled, phase, main_focused, !card.is_null()) {
        if let Some(w) = existing {
            let _ = w.hide();
        }
        return;
    }
    let win = match existing {
        Some(w) => w,
        None => match build(app) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("녹음 미니 창을 만들지 못했습니다: {e}");
                return;
            }
        },
    };
    state["call"] = card;
    let _ = win.emit("tray-popover", state);
    if !win.is_visible().unwrap_or(false) {
        let _ = win.show();
    }
}

/// 화면 언어가 바뀌었다: 문구는 창을 불러올 때 정해지므로 없애고 다음에 새로 만든다
pub fn relabel(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MINI_WINDOW) {
        let _ = w.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_only_while_recording_away_from_the_main_window() {
        assert!(visible(true, Phase::Recording, false, false));
        assert!(visible(true, Phase::Paused, false, false));
        assert!(!visible(true, Phase::Recording, true, false), "메인 창을 보고 있으면 녹음 화면이 같은 단추를 보인다");
        assert!(!visible(false, Phase::Recording, false, false), "설정을 끄면 보이지 않는다");
        for p in [Phase::Idle, Phase::Converting] {
            assert!(!visible(true, p, false, false));
        }
        assert!(visible(false, Phase::Idle, true, true), "통화 카드는 언제나 보인다");
    }
}
