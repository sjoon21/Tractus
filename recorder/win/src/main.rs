//! tractus-rec (Windows) — 녹음 도우미. 계약은 docs/desktop.md §1 (macOS Swift판과 같다), 진행 상황은 docs/windows/README.md.
//! Mac에서도 빌드되고 `record --fake`가 돈다 (계약 시험용). 실제 장치는 Windows에서만 연다 (src/win.rs).
mod fake;
#[cfg_attr(not(windows), allow(dead_code))] // Windows loopback만 쓴다 (테스트는 어디서나 돈다)
mod gap;
mod meter;
mod protocol;
mod recorder;
mod wav;
#[cfg(windows)]
mod win;

use std::io::BufRead;
use std::path::PathBuf;
use std::sync::mpsc::channel;
use std::time::Duration;

#[cfg(windows)]
use protocol::emit;
use protocol::{fatal, RecordOptions};
use recorder::{Msg, Recorder, Track};
#[cfg(windows)]
use serde_json::json;

const USAGE: &str = "사용법:
  tractus-rec record --out <dir> [--no-mic] [--no-system] [--echo-cancel] [--fake]
  tractus-rec check
  tractus-rec mic-permission [--request]";

fn run_record(args: &[String]) -> ! {
    let o = RecordOptions::parse(args).unwrap_or_else(|e| fatal(&format!("{e}\n{USAGE}")));
    let tracks: Vec<Track> = [(o.mic, Track::Mic), (o.system, Track::System)].into_iter().filter(|(on, _)| *on).map(|(_, t)| t).collect();
    let (tx, rx) = channel();

    #[cfg(windows)]
    let (opener, _watch) = if o.fake {
        (None, None)
    } else {
        win::com();
        (Some(win::opener()), win::watch(tx.clone()))
    };
    #[cfg(not(windows))]
    let opener = if o.fake { None } else { fatal("이 운영체제에서는 --fake만 됩니다 (실제 장치는 Windows판, macOS는 Swift판 recorder/)") };

    let mut rec = Recorder::new(PathBuf::from(&o.out), tx.clone(), opener);
    rec.start(&tracks, o.echo_cancel);

    // stdin 한 줄 = 명령 하나. 닫히면(부모 앱이 죽음) stop과 같다: 고아 녹음이 남지 않게
    let stdin_tx = tx.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(l) => {
                    if stdin_tx.send(Msg::Cmd(l)).is_err() {
                        return;
                    }
                }
                Err(_) => break,
            }
        }
        let _ = stdin_tx.send(Msg::Eof);
    });
    // 20ms 틱: 가짜 신호, 250ms마다 소리 크기·끊김 감시
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(20));
        if tx.send(Msg::Tick).is_err() {
            return;
        }
    });
    rec.run(rx)
}

fn run_check() -> ! {
    #[cfg(windows)]
    {
        let mic = match win::mic_permission() {
            "granted" => "granted",
            "denied" => "denied",
            _ => "undetermined",
        };
        emit(json!({ "mic": mic, "system": win::system_check(), "os": "windows" }));
        std::process::exit(0)
    }
    #[cfg(not(windows))]
    fatal("check는 Windows판만 합니다 (macOS는 Swift판)")
}

/// Windows에는 권한을 묻는 창이 없다: 설정 › 개인정보 › 마이크에서 켜고 끈다. 그래서 --request도 지금 상태만 읽는다
fn run_mic_permission() -> ! {
    #[cfg(windows)]
    {
        let mic = match win::mic_permission() {
            "granted" => "granted",
            "denied" => "denied",
            _ => "undetermined",
        };
        emit(json!({ "mic": mic }));
        std::process::exit(0)
    }
    #[cfg(not(windows))]
    fatal("mic-permission은 Windows판만 합니다 (macOS는 Swift판)")
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("record") => run_record(&args[1..]),
        Some("check") => run_check(),
        Some("mic-permission") => run_mic_permission(),
        // 통화 감지·캘린더는 macOS 기능이다 (앱이 Windows에서 부르지 않는다)
        Some(cmd @ ("mic-apps" | "calendar")) => fatal(&format!("{cmd}는 Windows판에 아직 없습니다")),
        Some("--help" | "-h") | None => {
            eprintln!("{USAGE}");
            std::process::exit(0)
        }
        Some(other) => {
            eprintln!("알 수 없는 명령: {other}\n{USAGE}");
            std::process::exit(1)
        }
    }
}
