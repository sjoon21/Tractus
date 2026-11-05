//! 녹음(`tractus-rec record`)과 녹음 중 실시간 자막(`tractus live`) (docs/desktop.md §2.8).

use crate::i18n::{t, tv};
use super::{attach, calendar, cancel_index, hold, is_busy, meetings, procs, release, AppState, LiveSlot, Settings};
use serde_json::{json, Value};
use std::io::Write;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// 녹음 방식에 따라 앱이 넘기는 `record` 인수 (lib.ts recFlags). 그 밖의 인수는 받지 않는다.
const REC_FLAGS: &[&str] = &["--no-system", "--echo-cancel"];

fn check_rec_flags(flags: &[String]) -> Result<(), String> {
    match flags.iter().find(|f| !REC_FLAGS.contains(&f.as_str())) {
        Some(f) => Err(tv("허용하지 않는 녹음 설정입니다: {f}", &[("f", f.to_string())])),
        None => Ok(()),
    }
}

/// 실시간 자막이 정지 명령을 받고 끝나기를 기다리는 시간. 넘으면 kill한다 (자막은 저장하지 않으므로 잃을 것이 없다)
const LIVE_STOP_WAIT: Duration = Duration::from_secs(5);

/// `tractus live --recording <녹음 폴더> --progress-json` (docs/desktop.md §2.8). 이 앱이 만든 녹음 폴더만 받는다
fn live_args(home: &Path, dir: &Path) -> Result<Vec<String>, String> {
    if !meetings::is_recording_dir(home, dir) {
        return Err(tv("녹음 폴더가 아닙니다: {path}", &[("path", dir.display().to_string())]));
    }
    Ok(vec!["live".into(), "--recording".into(), dir.to_string_lossy().into_owned(), "--progress-json".into()])
}

/// 실시간 자막 시작. 이벤트는 "live"로 보낸다 (작업 "job"이 아니므로 회의를 열지 않는다).
/// 실행조차 못 하면 error + exit를 대신 보내 화면이 "자막이 멈췄습니다"를 보이게 한다. 녹음은 그대로 계속된다
fn start_live(app: &AppHandle, s: &Settings, dir: &Path, live: &LiveSlot) {
    let forward = app.clone();
    let spawned = live_args(&s.home(), dir).and_then(|args| {
        procs::spawn_stoppable(s.tractus(&args), serde_json::Map::new(), move |ev| {
            let _ = forward.emit("live", ev);
        })
    });
    match spawned {
        Ok(p) => {
            let old = live.lock().unwrap().replace(p);
            if let Some(old) = old {
                old.kill();
            }
        }
        Err(e) => {
            let _ = app.emit("live", json!({"event": "error", "message": e}));
            let _ = app.emit("live", json!({"event": "exit", "code": null, "stderr": ""}));
        }
    }
}

/// 정지 명령을 보내고 끝나기를 기다린다 (LIVE_STOP_WAIT, 넘으면 kill). 잠금은 기다리기 전에 푼다
fn stop_live(live: &LiveSlot) {
    let running = live.lock().unwrap().take();
    if let Some(p) = running {
        p.stop(LIVE_STOP_WAIT);
    }
}

/// 녹음 시작. 이벤트는 "rec"로 보낸다. 반환값은 녹음 폴더.
/// target: 글만 있는 노트의 ID. 있으면 그 노트에 녹음을 추가하는 녹음이다 (녹음 폴더에 attach.json을 쓰고, 녹음하는 동안 노트를 쓰는 중으로 표시한다. docs/desktop.md §2.11)
#[tauri::command]
pub fn rec_start(app: AppHandle, state: State<'_, AppState>, flags: Vec<String>, target: Option<String>, event: Option<Value>) -> Result<String, String> {
    check_rec_flags(&flags)?;
    let event = event.as_ref().map(calendar::clean_event).transpose()?; // 캘린더 일정으로 시작한 녹음 (docs/design/calendar.md)
    let mut rec = state.rec.lock().unwrap();
    if rec.is_some() {
        return Err(t("이미 녹음 중입니다"));
    }
    let s = state.settings();
    if let Some(id) = &target {
        attach::check_target(&s.home(), id, |t| is_busy(&state.busy, t))?;
    }
    let dir = s.home().join("recordings").join(ulid::Ulid::new().to_string());
    std::fs::create_dir_all(dir.parent().unwrap()).map_err(|e| e.to_string())?;
    if let Some(id) = &target {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        attach::write_attach(&dir, id).inspect_err(|_| attach::discard(&dir))?;
    }
    if let Some(ev) = &event {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        calendar::write_event(&dir, ev).inspect_err(|_| {
            attach::discard(&dir); // 먼저 쓴 attach.json이 있으면 폴더가 남지 않게
            calendar::discard(&dir);
        })?;
    }
    let mut cmd = Command::new(s.rec_path());
    cmd.arg("record").arg("--out").arg(&dir).args(&flags).envs(s.child_env());
    if s.fake_recorder {
        cmd.arg("--fake");
    }
    let (slot, live, live_dir) = (state.rec.clone(), state.live.clone(), dir.clone());
    let (busy, busy_key) = (state.busy.clone(), hold(&state.busy, &dir.to_string_lossy()));
    let note_key = target.as_deref().map(|id| hold(&state.busy, id)); // 녹음하는 동안 그 노트는 삭제할 수 없다
    cancel_index(&state.index); // 실시간 변환 모델과 임베딩 모델이 함께 올라가지 않게
    let release_key = busy_key.clone();
    let release_note = note_key.clone();
    // 실시간 자막은 녹음 헬퍼가 트랙 파일을 만든 뒤(started)에 띄운다. 설정은 녹음을 시작할 때의 값을 쓴다
    let live_settings = s.live_captions.then(|| s.clone());
    let started = procs::spawn_streaming(cmd, serde_json::Map::new(), move |ev| {
        match (ev["event"].as_str(), &live_settings) {
            (Some("started"), Some(ls)) => start_live(&app, ls, &live_dir, &live),
            // stopped를 화면에 보내기 전에 자막 프로세스를 끝낸다: 프론트엔드는 stopped를 받고 정식 전사를 시작하므로
            // 작은 모델(0.6B)과 정식 전사 모델이 메모리에 같이 올라가지 않는다. 녹음 헬퍼가 죽어도(exit) 자막을 남기지 않는다
            (Some("stopped" | "exit"), _) => stop_live(&live),
            _ => {}
        }
        if ev["event"] == "exit" {
            slot.lock().unwrap().take();
            release(&busy, &busy_key);
            if let Some(k) = &note_key {
                release(&busy, k);
            }
        }
        let _ = app.emit("rec", ev);
    });
    let (stdin, _) = match started {
        Ok(s) => s,
        Err(e) => {
            release(&state.busy, &release_key);
            if let Some(k) = &release_note {
                release(&state.busy, k);
            }
            if target.is_some() {
                attach::discard(&dir);
            }
            if event.is_some() {
                calendar::discard(&dir);
            }
            return Err(e);
        }
    };
    *rec = Some(stdin);
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn rec_send(state: State<'_, AppState>, cmd: String, text: Option<String>, index: Option<u32>) -> Result<(), String> {
    let line = procs::recorder_line(&cmd, text.as_deref(), index)?;
    let mut rec = state.rec.lock().unwrap();
    let stdin = rec.as_mut().ok_or_else(|| t("녹음 중이 아닙니다"))?;
    stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush()).map_err(|e| tv("녹음 프로그램에 명령을 보내지 못했습니다\n{e}", &[("e", e.to_string())]))?;
    // 자막도 지금 멈추기 시작한다 (녹음 헬퍼가 파일을 마무리하는 동안). 끝나기를 기다리는 것은 stopped 때(stop_live)
    if cmd == "stop" {
        if let Some(p) = state.live.lock().unwrap().as_mut() {
            p.send_stop();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn live_command_args() {
        let home = Path::new("/h");
        assert_eq!(live_args(home, Path::new("/h/recordings/01REC")).unwrap(), ["live", "--recording", "/h/recordings/01REC", "--progress-json"]);
        for bad in ["/etc", "/h/recordings", "/h/recordings/../x", "/h/recordings/01REC/mic.wav", "/h/meetings/01ABC"] {
            assert!(live_args(home, Path::new(bad)).is_err(), "{bad}");
        }
        let partial: Settings = serde_json::from_str(r#"{"home":"/x"}"#).unwrap();
        assert!(!partial.live_captions); // 기본 꺼짐 (예전 설정 파일에는 없다)
    }

    /// 실제 `tractus live`(저장소 .venv + 0.6B·VAD 모델)를 앱과 같은 명령·환경으로 띄우고 stop으로 끝낸다.
    /// 모델이 필요해 기본에서는 빠진다: `cargo test -- --ignored real_live`
    #[test]
    #[ignore]
    fn real_live_starts_and_stops_through_app_command() {
        let home = std::env::temp_dir().join(format!("tractus-live-{}", std::process::id()));
        let dir = home.join("recordings").join("01LIVETEST");
        std::fs::create_dir_all(&dir).unwrap();
        // tractus-rec 레이아웃: 48 kHz mono 16-bit mic.wav (무음 1초) + recording.json
        let data = vec![0u8; 96000];
        let mut wav = b"RIFF".to_vec();
        wav.extend((36 + data.len() as u32).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend([1u16, 1].iter().flat_map(|v| v.to_le_bytes()));
        wav.extend([48000u32, 96000].iter().flat_map(|v| v.to_le_bytes()));
        wav.extend([2u16, 16].iter().flat_map(|v| v.to_le_bytes()));
        wav.extend(b"data");
        wav.extend((data.len() as u32).to_le_bytes());
        wav.extend(data);
        std::fs::write(dir.join("mic.wav"), wav).unwrap();
        std::fs::write(dir.join("recording.json"), r#"{"schema_version":1,"started_at":"2026-10-07T10:00:00+09:00","duration":null,"tracks":{"mic":"mic.wav"},"marks":[]}"#).unwrap();

        let s = Settings { home: home.to_string_lossy().into_owned(), ..Default::default() };
        let (tx, rx) = std::sync::mpsc::channel();
        let p = procs::spawn_stoppable(s.tractus(&live_args(&s.home(), &dir).unwrap()), serde_json::Map::new(), move |v| tx.send(v).unwrap()).unwrap();
        let wait_live = std::time::Instant::now();
        loop {
            let ev = rx.recv_timeout(Duration::from_secs(60)).expect("no event from tractus live");
            assert_ne!(ev["event"], "exit", "tractus live exited early: {ev}");
            if ev["stage"] == "live" {
                break;
            }
        }
        assert!(wait_live.elapsed() < Duration::from_secs(60));
        let t = std::time::Instant::now();
        assert!(p.stop(LIVE_STOP_WAIT), "not stopped by the stop line");
        assert!(t.elapsed() < Duration::from_secs(2), "stop took {:?}", t.elapsed());
        let rest: Vec<Value> = rx.try_iter().collect();
        let kinds: Vec<&str> = rest.iter().filter_map(|v| v["event"].as_str()).collect();
        assert_eq!(kinds[kinds.len() - 2..], ["done", "exit"], "{rest:?}");
        assert_eq!(rest.last().unwrap()["code"], 0);
        std::fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn rec_flags_allowlist() {
        assert!(check_rec_flags(&["--no-system".into()]).is_ok());
        assert!(check_rec_flags(&["--echo-cancel".into()]).is_ok());
        assert!(check_rec_flags(&[]).is_ok());
        assert!(check_rec_flags(&["--out".into(), "/etc".into()]).is_err());
        assert!(check_rec_flags(&["--fake".into()]).is_err()); // --fake는 설정(fake_recorder)으로만
    }
}
