// 통화 감지 (docs/desktop.md §3.9): 통화 앱이 마이크를 쓰기 시작하면 녹음 미니 창에서 `녹음할까요?`를 묻고,
// 그 통화로 시작한 녹음은 통화 앱이 마이크를 놓으면 끝낼지 묻거나(기본) 끝낸다(설정).
// 소리는 듣지 않는다: 3초마다 `tractus-rec mic-apps`로 어떤 프로세스가 마이크를 쓰는지만 본다.
// 판단 규칙(통화 앱 목록·도우미 프로세스·일정 맞추기·한 통화 한 번·마이크를 놓으면 닫은 것 잊기·10초 유예)은
// Yogurt(FrigadeHQ/yogurt, MIT, Copyright (c) Frigade) app/src/main/detect.ts·watch.ts를 옮겨 다시 썼다.
use std::collections::HashMap;
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::tray::{Phase, TrayState};
use crate::AppState;

const POLL: Duration = Duration::from_secs(3);
/// 묻는 카드는 이만큼 뒤에 닫는다 (닫은 것으로 친다: 한 통화에 한 번만 묻는다)
const ASK_FOR: Duration = Duration::from_secs(15);
/// 통화 앱이 마이크를 놓고 이만큼 지나야 통화가 끝났다고 본다 (다시 연결·헤드셋 바꾸기·잠깐 음소거)
pub const CALL_GONE: Duration = Duration::from_secs(10);
/// `계속`을 누르면 이만큼 다시 묻지 않는다
const SNOOZE: Duration = Duration::from_secs(5 * 60);
/// 녹음을 시작한 순간 이 안에 마이크를 쓴 통화 앱을 그 녹음의 통화로 본다
const BIND_WINDOW: Duration = Duration::from_secs(6);
const EVENTS_TTL: Duration = Duration::from_secs(60);

pub struct CallApp {
    pub id: &'static str,
    pub name: &'static str,
    /// 브라우저는 마이크만으로는 통화가 아니다 (음성 검색·녹음 사이트). 지금 일정이 있을 때만 묻는다
    pub browser: bool,
}

const fn app(id: &'static str, name: &'static str) -> CallApp {
    CallApp { id, name, browser: false }
}
const fn web(id: &'static str, name: &'static str) -> CallApp {
    CallApp { id, name, browser: true }
}

pub const APPS: &[CallApp] = &[
    app("us.zoom.xos", "Zoom"),
    app("com.microsoft.teams", "Teams"),
    app("com.microsoft.teams2", "Teams"),
    app("com.cisco.webexmeetingsapp", "Webex"),
    app("Cisco-Systems.Spark", "Webex"),
    app("com.apple.FaceTime", "FaceTime"),
    app("com.tinyspeck.slackmacgap", "Slack"),
    app("com.hnc.Discord", "Discord"),
    app("net.whatsapp.WhatsApp", "WhatsApp"),
    app("com.kakao.KakaoTalkMac", "카카오톡"), // i18n-ok: 앱 이름
    app("com.naver.works.mac", "NAVER WORKS"),
    web("com.google.Chrome", "Chrome"),
    web("company.thebrowser.Browser", "Arc"),
    web("company.thebrowser.dia", "Dia"),
    web("com.apple.Safari", "Safari"),
    web("com.microsoft.edgemac", "Edge"),
    web("org.mozilla.firefox", "Firefox"),
    web("com.brave.Browser", "Brave"),
    web("com.naver.Whale", "Whale"),
];

/// 마이크를 쥐는 도우미 프로세스 → 주인 앱. 주인 앱이 실행 중일 때만 그 앱으로 친다
const HELPERS: &[(&str, &str)] = &[
    ("us.zoom.CptHost", "us.zoom.xos"),
    ("com.apple.avconferenced", "com.apple.FaceTime"),
    ("org.mozilla.plugincontainer", "org.mozilla.firefox"),
    ("com.apple.WebKit.WebContent", "com.apple.Safari"),
    ("com.apple.WebKit.GPU", "com.apple.Safari"),
];

fn find(id: &str) -> Option<&'static CallApp> {
    APPS.iter().find(|a| id == a.id || id.strip_prefix(a.id).is_some_and(|rest| rest.starts_with('.')))
}

/// 마이크를 쓰는 프로세스(bundle id)의 통화 앱. 앱 자신이면 그대로, 도우미면 주인 앱이 실행 중일 때만 (Chrome 도우미 `com.google.Chrome.helper`는 접두어로 잡힌다)
pub fn owner(bundle: &str, running: &[String]) -> Option<&'static CallApp> {
    if let Some(a) = find(bundle) {
        return (bundle == a.id || running.iter().any(|r| r == a.id)).then_some(a);
    }
    let (_, own) = HELPERS.iter().find(|(h, _)| bundle == *h || bundle.strip_prefix(h).is_some_and(|r| r.starts_with('.')))?;
    let a = find(own)?;
    running.iter().any(|r| r == a.id).then_some(a)
}

/// 지금 마이크를 쓰는 통화 앱들 (같은 앱은 한 번)
pub fn on_mic(mic: &[String], running: &[String]) -> Vec<&'static CallApp> {
    let mut out: Vec<&'static CallApp> = Vec::new();
    for b in mic {
        if let Some(a) = owner(b, running) {
            if !out.iter().any(|o| o.id == a.id) {
                out.push(a);
            }
        }
    }
    out
}

/// 묻기: 녹음 중이 아니고, 통화 앱이 마이크를 쓰고(브라우저는 지금 일정이 있을 때만), 이 통화를 닫은 적이 없으면.
/// 한 통화는 키 하나: 일정이 있으면 일정의 것, 없으면 앱의 것
pub fn decide(apps: &[&'static CallApp], event: Option<&Value>, recording: bool, dismissed: &HashMap<String, String>) -> Option<(String, &'static CallApp)> {
    if recording {
        return None;
    }
    for a in apps {
        if a.browser && event.is_none() {
            continue;
        }
        let key = match event {
            Some(e) => format!("event:{}:{}", e["id"].as_str().unwrap_or(""), e["start"].as_str().unwrap_or("")),
            None => format!("app:{}", a.id),
        };
        if !dismissed.contains_key(&key) {
            return Some((key, a));
        }
    }
    None
}

/// 통화로 시작한 녹음을 끝낼 때인가: 그 통화 앱이 이 녹음 동안 마이크를 쓴 적이 있고, 놓은 지 유예 시간이 지났다.
/// 통화를 본 적 없는 녹음은 끝내지 않는다. 일정은 녹음을 끝내지 않는다 (회의는 늦게 끝난다) — words-ok
pub fn call_gone(bound: bool, seen: bool, off_for: Option<Duration>) -> bool {
    bound && seen && off_for.is_some_and(|d| d >= CALL_GONE)
}

/// `tractus-rec calendar next`의 일정들 중 지금 것: 시작이 앞뒤 10분 안이고 끝나지 않은 것, 시작이 가까운 것 먼저 (일정 시각은 로컬 ISO)
pub fn match_event(events: &[Value], now: chrono_like::Local) -> Option<Value> {
    let mut near: Vec<(i64, &Value)> = events
        .iter()
        .filter_map(|e| {
            let start = chrono_like::parse(e["start"].as_str()?)?;
            let end = chrono_like::parse(e["end"].as_str()?)?;
            ((start - now).abs() <= 600 && end > now).then_some(((start - now).abs(), e))
        })
        .collect();
    near.sort_by_key(|(d, _)| *d);
    near.first().map(|(_, e)| (*e).clone())
}

/// 로컬 ISO 시각(`2026-11-13T14:00:00`, 끝의 시간대는 무시) ↔ 초. 같은 쪽끼리만 비교하므로 날짜 계산만 맞으면 된다
pub mod chrono_like {
    pub type Local = i64;
    pub fn parse(s: &str) -> Option<Local> {
        let b = s.as_bytes();
        if b.len() < 19 {
            return None;
        }
        let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
        let (y, mo, d, h, mi, se) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
        // 1970-01-01부터의 날 수 (그레고리력, Howard Hinnant의 days_from_civil)
        let y = if mo <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        Some((era * 146097 + doe - 719468) * 86400 + h * 3600 + mi * 60 + se)
    }
}

/// 미니 창에 보일 카드
#[derive(Clone, Debug, PartialEq)]
pub struct Card {
    /// "start"(녹음할까요?) | "end"(녹음을 끝낼까요?)
    pub kind: &'static str,
    pub key: String,
    pub app_id: &'static str,
    pub app: &'static str,
    pub title: String,
    pub event: Option<Value>,
    since: Instant,
}

#[derive(Default)]
struct Inner {
    card: Option<Card>,
    /// 닫은 통화의 키 → 그 앱 (앱이 마이크를 놓으면 잊는다: 다음 통화는 다시 묻는다)
    dismissed: HashMap<String, String>,
    /// 지금 녹음이 묶인 통화 앱, 이 녹음 동안 마이크를 쓴 것을 보았는가, 놓은 시각
    bound: Option<&'static str>,
    seen: bool,
    off_since: Option<Instant>,
    snooze_until: Option<Instant>,
    recording: bool,
    /// 앱마다 마지막으로 마이크에서 본 시각
    last_on: HashMap<&'static str, Instant>,
    events: Option<(Instant, Vec<Value>)>,
    started: bool,
}

#[derive(Default)]
pub struct CallState(Mutex<Inner>);

impl CallState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// 미니 창에 실을 카드 (없으면 null)
    pub fn card_json(&self) -> Value {
        self.lock().card.as_ref().map_or(Value::Null, |c| json!({ "kind": c.kind, "app": c.app, "title": c.title }))
    }

}

/// 한 번의 관찰을 반영한다 (순수에 가깝게: 시각·관찰을 받아 상태만 바꾸고, 할 일을 돌려준다)
#[derive(Debug, PartialEq)]
enum Todo {
    None,
    Stop,
}

fn observe(g: &mut Inner, apps: &[&'static CallApp], event: Option<Value>, recording: bool, autostop: bool, now: Instant) -> Todo {
    for a in apps {
        g.last_on.insert(a.id, now);
    }
    // 앱이 마이크를 놓았다: 그 앱의 닫은 통화를 잊는다
    g.dismissed.retain(|_, app| apps.iter().any(|a| a.id == app));

    match (g.recording, recording) {
        (false, true) => {
            // 녹음이 시작됐다: 방금까지 마이크를 쓴 통화 앱에 묶는다 (카드의 `녹음`이면 이미 묶여 있다)
            if g.bound.is_none() {
                g.bound = g.last_on.iter().filter(|(_, t)| now.duration_since(**t) <= BIND_WINDOW).max_by_key(|(_, t)| **t).map(|(id, _)| *id);
            }
            g.seen = g.bound.is_some_and(|b| apps.iter().any(|a| a.id == b));
            g.off_since = None;
            g.snooze_until = None;
            if g.card.as_ref().is_some_and(|c| c.kind == "start") {
                g.card = None;
            }
        }
        (true, false) => {
            // 녹음이 끝났다: 아직 마이크를 쥔 통화는 다시 묻지 않는다 (끝내기를 누른 뒤 통화 앱이 몇 초 더 쥐고 있다)
            for a in apps {
                g.dismissed.insert(format!("app:{}", a.id), a.id.to_string());
            }
            if let Some(c) = g.card.take() {
                if c.kind == "start" {
                    g.dismissed.insert(c.key, c.app_id.to_string());
                }
            }
            g.bound = None;
            g.seen = false;
            g.off_since = None;
        }
        _ => {}
    }
    g.recording = recording;

    if recording {
        let Some(b) = g.bound else { return Todo::None };
        if apps.iter().any(|a| a.id == b) {
            g.seen = true;
            g.off_since = None;
            if g.card.as_ref().is_some_and(|c| c.kind == "end") {
                g.card = None; // 통화로 돌아왔다
            }
            return Todo::None;
        }
        let off = *g.off_since.get_or_insert(now);
        if !call_gone(true, g.seen, Some(now.duration_since(off))) {
            return Todo::None;
        }
        if autostop {
            g.card = None;
            return Todo::Stop;
        }
        let snoozed = g.snooze_until.is_some_and(|t| now < t);
        if g.card.is_none() && !snoozed {
            let a = find(b).expect("묶인 앱은 목록에 있다");
            g.card = Some(Card { kind: "end", key: format!("end:{b}"), app_id: a.id, app: a.name, title: String::new(), event: None, since: now });
        }
        return Todo::None;
    }

    // 녹음 중이 아니다: 묻는 카드가 오래됐으면 닫은 것으로 친다
    if let Some(c) = &g.card {
        let gone = !apps.iter().any(|a| a.id == c.app_id);
        if c.kind == "end" || gone || now.duration_since(c.since) >= ASK_FOR {
            let c = g.card.take().unwrap();
            if c.kind == "start" && !gone {
                g.dismissed.insert(c.key, c.app_id.to_string());
            }
        }
    }
    if g.card.is_none() {
        if let Some((key, a)) = decide(apps, event.as_ref(), false, &g.dismissed) {
            let title = event.as_ref().and_then(|e| e["title"].as_str()).unwrap_or("").to_string();
            g.card = Some(Card { kind: "start", key, app_id: a.id, app: a.name, title, event, since: now });
        }
    }
    Todo::None
}

/// 한 번 보기: 마이크 쓰는 앱 → 상태 → 미니 창. 녹음 프로그램이 없거나 실패하면 아무것도 바꾸지 않는다
fn poll(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else { return };
    let s = state.settings();
    let calls = app.state::<CallState>();
    if !s.call_detect {
        let mut g = calls.lock();
        if g.card.take().is_some() {
            drop(g);
            refresh_mini(app);
        }
        return;
    }
    let Ok(out) = Command::new(s.rec_path()).arg("mic-apps").envs(s.child_env()).stdin(Stdio::null()).stderr(Stdio::null()).output() else { return };
    let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) else { return };
    let list = |k: &str, f: fn(&Value) -> Option<&str>| v[k].as_array().map(|a| a.iter().filter_map(f).map(String::from).collect::<Vec<_>>()).unwrap_or_default();
    let (mic, running) = (list("mic", |x| x["bundle_id"].as_str()), list("running", Value::as_str));
    let apps = on_mic(&mic, &running);
    let recording = matches!(app.state::<TrayState>().phase(), Phase::Recording | Phase::Paused);

    // 통화 앱이 마이크를 쓸 때만 일정을 읽는다 (1분 저장). 일정 시각과 같은 꼴의 지금 시각은 녹음 프로그램이 준다
    let now = v["now"].as_str().and_then(chrono_like::parse);
    let event = match now {
        Some(now) if !recording && !apps.is_empty() && s.calendar_enabled => {
            let cached = calls.lock().events.as_ref().filter(|(t, _)| t.elapsed() < EVENTS_TTL).map(|(_, e)| e.clone());
            let events = cached.unwrap_or_else(|| {
                let e = crate::calendar::next_events(&s);
                calls.lock().events = Some((Instant::now(), e.clone()));
                e
            });
            match_event(&events, now)
        }
        _ => None,
    };

    let (todo, before, after) = {
        let mut g = calls.lock();
        let before = g.card.clone().map(|c| (c.kind, c.key));
        let todo = observe(&mut g, &apps, event, recording, s.call_autostop, Instant::now());
        (todo, before, g.card.clone().map(|c| (c.kind, c.key)))
    };
    if todo == Todo::Stop {
        let _ = app.emit_to("main", "tray-action", json!({ "action": "record_stop" }));
    }
    if before != after {
        refresh_mini(app);
    }
}

fn refresh_mini(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || handle.state::<TrayState>().sync_mini(&handle));
}

/// 앱이 뜰 때 한 번: 3초마다 보는 스레드. 설정이 꺼져 있으면 녹음 프로그램을 부르지 않는다
pub fn start(app: &AppHandle) {
    let calls = app.state::<CallState>();
    let mut g = calls.lock();
    if g.started {
        return;
    }
    g.started = true;
    drop(g);
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL);
        poll(&app);
    });
}

/// 미니 창의 카드 단추: `record`(이 통화를 녹음) | `dismiss`(닫기) | `stop`(녹음 종료) | `keep`(계속 녹음)
#[tauri::command]
pub fn call_action(app: AppHandle, calls: State<'_, CallState>, action: String) {
    let mut g = calls.lock();
    let Some(c) = g.card.take() else { return };
    match (c.kind, action.as_str()) {
        ("start", "record") => {
            g.bound = Some(c.app_id);
            g.seen = true;
            let _ = app.emit_to("main", "tray-action", json!({ "action": "record_call", "event": c.event }));
        }
        ("start", _) => {
            g.dismissed.insert(c.key, c.app_id.to_string());
        }
        ("end", "stop") => {
            let _ = app.emit_to("main", "tray-action", json!({ "action": "record_stop" }));
        }
        ("end", _) => g.snooze_until = Some(Instant::now() + SNOOZE),
        _ => {}
    }
    drop(g);
    app.state::<TrayState>().sync_mini(&app);
}

/// 설정 화면의 두 스위치. 바로 적용하고 그 두 키만 저장한다
#[tauri::command]
pub fn set_call_prefs(app: AppHandle, state: State<'_, AppState>, detect: bool, autostop: bool) -> Result<(), String> {
    crate::patch_settings(&state.config_path, |raw| {
        let raw = crate::merge_flag(raw, "call_detect", detect)?;
        crate::merge_flag(Some(&raw), "call_autostop", autostop)
    })?;
    {
        let mut s = state.settings.lock().unwrap();
        s.call_detect = detect;
        s.call_autostop = autostop;
    }
    start(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(ids: &[&str]) -> Vec<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }
    fn zoom() -> Vec<&'static CallApp> {
        vec![find("us.zoom.xos").unwrap()]
    }

    #[test]
    fn helpers_count_only_while_their_app_runs() {
        assert_eq!(owner("us.zoom.xos", &[]).map(|a| a.name), Some("Zoom"));
        assert_eq!(owner("us.zoom.CptHost", &run(&["us.zoom.xos"])).map(|a| a.name), Some("Zoom"));
        assert!(owner("us.zoom.CptHost", &[]).is_none(), "주인 앱이 없으면 도우미는 아무것도 아니다");
        assert_eq!(owner("com.google.Chrome.helper", &run(&["com.google.Chrome"])).map(|a| a.name), Some("Chrome"));
        assert!(owner("com.google.Chrome.helper", &[]).is_none());
        assert!(owner("com.apple.VoiceMemos", &[]).is_none());
        assert!(owner("", &[]).is_none(), "녹음 프로그램(bundle id 없음)은 통화가 아니다");
        assert_eq!(on_mic(&run(&["us.zoom.xos", "us.zoom.CptHost"]), &run(&["us.zoom.xos"])).len(), 1);
    }

    #[test]
    fn a_browser_needs_an_event_and_one_call_asks_once() {
        let chrome = vec![find("com.google.Chrome").unwrap()];
        let none = HashMap::new();
        assert!(decide(&chrome, None, false, &none).is_none(), "브라우저만으로는 묻지 않는다");
        let ev = json!({"id": "E1", "start": "2026-11-13T14:00:00", "title": "주간 동기화"});
        let (key, a) = decide(&chrome, Some(&ev), false, &none).unwrap();
        assert_eq!((key.as_str(), a.name), ("event:E1:2026-11-13T14:00:00", "Chrome"));
        assert!(decide(&zoom(), None, true, &none).is_none(), "녹음 중에는 묻지 않는다");
        let dismissed = HashMap::from([("app:us.zoom.xos".to_string(), "us.zoom.xos".to_string())]);
        assert!(decide(&zoom(), None, false, &dismissed).is_none());
    }

    #[test]
    fn events_match_within_ten_minutes_and_not_over() {
        let at = |s: &str| chrono_like::parse(s).unwrap();
        let now = at("2026-11-13T14:05:00");
        let evs = vec![
            json!({"id": "old", "start": "2026-11-13T13:00:00", "end": "2026-11-13T14:00:00"}),
            json!({"id": "far", "start": "2026-11-13T14:30:00", "end": "2026-11-13T15:00:00"}),
            json!({"id": "now", "start": "2026-11-13T14:00:00", "end": "2026-11-13T15:00:00"}),
        ];
        assert_eq!(match_event(&evs, now).unwrap()["id"], "now");
        assert_eq!(at("2026-01-01T00:00:00") - at("2025-12-31T23:59:00"), 60);
        assert!(match_event(&evs[..2], now).is_none());
    }

    #[test]
    fn asks_once_then_forgets_when_the_call_leaves_the_mic() {
        let mut g = Inner::default();
        let t0 = Instant::now();
        observe(&mut g, &zoom(), None, false, false, t0);
        assert_eq!(g.card.as_ref().map(|c| c.kind), Some("start"));
        observe(&mut g, &zoom(), None, false, false, t0 + ASK_FOR);
        assert!(g.card.is_none(), "15초 뒤 닫고");
        observe(&mut g, &zoom(), None, false, false, t0 + ASK_FOR * 2);
        assert!(g.card.is_none(), "같은 통화는 다시 묻지 않는다");
        observe(&mut g, &[], None, false, false, t0 + ASK_FOR * 3);
        observe(&mut g, &zoom(), None, false, false, t0 + ASK_FOR * 4);
        assert!(g.card.is_some(), "마이크를 놓았다 다시 쓰면 새 통화다");
    }

    #[test]
    fn a_call_recording_asks_or_stops_after_the_grace() {
        let t0 = Instant::now();
        let s = Duration::from_secs;
        for autostop in [false, true] {
            let mut g = Inner::default();
            observe(&mut g, &zoom(), None, false, autostop, t0);
            observe(&mut g, &zoom(), None, true, autostop, t0 + s(3)); // 녹음 시작 → Zoom에 묶임
            assert_eq!(g.bound, Some("us.zoom.xos"));
            assert!(g.card.is_none());
            assert_eq!(observe(&mut g, &[], None, true, autostop, t0 + s(6)), Todo::None, "놓은 직후는 기다린다");
            let todo = observe(&mut g, &[], None, true, autostop, t0 + s(6) + CALL_GONE);
            if autostop {
                assert_eq!(todo, Todo::Stop);
            } else {
                assert_eq!(g.card.as_ref().map(|c| c.kind), Some("end"));
                observe(&mut g, &zoom(), None, true, autostop, t0 + s(30));
                assert!(g.card.is_none(), "통화로 돌아오면 묻지 않는다");
            }
        }
    }

    #[test]
    fn a_recording_without_a_call_never_stops_and_finishing_does_not_reask() {
        let t0 = Instant::now();
        let mut g = Inner::default();
        observe(&mut g, &[], None, true, true, t0);
        assert_eq!(g.bound, None);
        assert_eq!(observe(&mut g, &[], None, true, true, t0 + Duration::from_secs(60)), Todo::None);
        // 통화 녹음을 끝냈는데 Zoom이 아직 마이크를 쥐고 있다: 다시 묻지 않는다
        let mut g = Inner::default();
        observe(&mut g, &zoom(), None, true, false, t0);
        observe(&mut g, &zoom(), None, false, false, t0 + Duration::from_secs(3));
        assert!(g.card.is_none());
    }
}
