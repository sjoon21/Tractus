//! 계약 시험 (docs/desktop.md §1): `record --fake`에 같은 명령을 넣고 이벤트·recording.json·WAV 모양을 본다.
//! macOS에서 Swift판(recorder/.build/release/tractus-rec)이 빌드돼 있으면 같은 시나리오를 돌려 두 판의 이벤트 키와
//! recording.json 키가 같은지도 본다 (`TRACTUS_SWIFT_REC`로 경로를 바꿀 수 있다). Windows·CI에서는 Rust판만 본다.
use std::collections::{BTreeMap, BTreeSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use serde_json::Value;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("tractus-rec-contract-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

/// 시나리오: 0.6초 녹음 → 메모 → 북마크 → 일시정지 → 메모(멈춘 시각) → 계속 → 0.4초 → 메모 고치기·지우기 → stop
fn scenario(bin: &Path, dir: &Path) -> (Vec<Value>, Value) {
    let mut child = Command::new(bin).args(["record", "--out", dir.to_str().unwrap(), "--fake"]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().expect("녹음 프로그램 실행");
    let mut stdin = child.stdin.take().unwrap();
    let mut send = |line: &str, wait_ms: u64| {
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
        std::thread::sleep(Duration::from_millis(wait_ms));
    };
    std::thread::sleep(Duration::from_millis(600));
    send("memo 예산 다시 확인", 50);
    send("bookmark", 50);
    send("pause", 300);
    send("memo 멈춘 동안", 50);
    send("resume", 400);
    send("mark_edit 0 예산 확인", 50);
    send("mark_delete 1", 50);
    send("stop", 0);
    drop(stdin);
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "종료 코드 0");
    let events: Vec<Value> = String::from_utf8(out.stdout).unwrap().lines().map(|l| serde_json::from_str(l).expect("stdout은 JSON Lines만")).collect();
    let info: Value = serde_json::from_slice(&std::fs::read(dir.join("recording.json")).unwrap()).unwrap();
    (events, info)
}

/// 이벤트 종류마다 키 모음 (level·mark처럼 여러 번 나오는 것은 합친다)
fn shape(events: &[Value]) -> BTreeMap<String, BTreeSet<String>> {
    let mut m: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for e in events {
        let kind = e["event"].as_str().unwrap().to_string();
        m.entry(kind).or_default().extend(e.as_object().unwrap().keys().cloned());
    }
    m
}

fn wav_frames(p: &Path) -> usize {
    let b = std::fs::read(p).unwrap();
    assert_eq!(&b[0..4], b"RIFF");
    let data = u32::from_le_bytes(b[40..44].try_into().unwrap()) as usize;
    assert_eq!(data, b.len() - 44, "헤더 크기 = 실제 데이터");
    data / 2
}

#[test]
fn fake_recording_follows_the_contract() {
    let dir = tmp("rust");
    let (events, info) = scenario(Path::new(env!("CARGO_BIN_EXE_tractus-rec")), &dir);
    let kinds: Vec<&str> = events.iter().map(|e| e["event"].as_str().unwrap()).collect();
    assert_eq!(kinds.first(), Some(&"started"));
    assert_eq!(kinds.last(), Some(&"stopped"));
    for k in ["level", "mark", "paused", "resumed", "marks"] {
        assert!(kinds.contains(&k), "{k} 이벤트가 있다: {kinds:?}");
    }
    let paused = events.iter().position(|e| e["event"] == "paused").unwrap();
    let resumed = events.iter().position(|e| e["event"] == "resumed").unwrap();
    assert!(events[paused..resumed].iter().all(|e| e["event"] != "level"), "일시정지 중에는 level이 없다");
    assert_eq!(events[paused]["elapsed"], events[resumed]["elapsed"], "멈춘 시각에서 이어진다");
    let pause_mark = events.iter().find(|e| e["event"] == "mark" && e["text"] == "멈춘 동안").unwrap();
    assert_eq!(pause_mark["t"], events[paused]["elapsed"], "일시정지 중 메모는 멈춘 시각");

    // recording.json: 메모 고치기·지우기 반영, 일시정지 하나, 길이 = WAV 길이
    assert_eq!(info["schema_version"], 1);
    let marks = info["marks"].as_array().unwrap();
    assert_eq!(marks.len(), 2);
    assert_eq!(marks[0]["text"], "예산 확인");
    assert_eq!(info["pauses"].as_array().unwrap().len(), 1);
    let duration = info["duration"].as_f64().unwrap();
    // 프로세스가 뜨는 시간만큼 짧아질 수 있다 (바쁜 CI): 넓게 본다. 핵심은 일시정지 0.35초가 빠지고 WAV 길이와 같다는 것
    assert!((0.5..1.6).contains(&duration), "길이는 일시정지를 뺀 약 1초: {duration}");
    for t in ["mic", "system"] {
        let secs = wav_frames(&dir.join(format!("{t}.wav"))) as f64 / 48_000.0;
        assert!((secs - duration).abs() < 0.1, "{t}.wav {secs}초 ≈ duration {duration}");
    }
    // 이미 있는 녹음은 덮어쓰지 않는다
    let again = Command::new(env!("CARGO_BIN_EXE_tractus-rec")).args(["record", "--out", dir.to_str().unwrap(), "--fake"]).stdin(Stdio::null()).output().unwrap();
    assert_eq!(again.status.code(), Some(1));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn same_shape_as_the_swift_recorder() {
    let swift = std::env::var("TRACTUS_SWIFT_REC").map(PathBuf::from).unwrap_or_else(|_| Path::new(env!("CARGO_MANIFEST_DIR")).join("../.build/release/tractus-rec"));
    if !cfg!(target_os = "macos") || !swift.is_file() {
        eprintln!("Swift판이 없어 비교를 건너뜁니다: {}", swift.display());
        return;
    }
    let (a, b) = (tmp("rs"), tmp("swift"));
    let (ev_rs, info_rs) = scenario(Path::new(env!("CARGO_BIN_EXE_tractus-rec")), &a);
    let (ev_sw, info_sw) = scenario(&swift, &b);
    assert_eq!(shape(&ev_rs), shape(&ev_sw), "이벤트 종류와 키가 같다");
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<BTreeSet<_>>();
    assert_eq!(keys(&info_rs), keys(&info_sw), "recording.json 키가 같다");
    assert_eq!(info_rs["marks"], info_sw["marks"].as_array().map(|m| {
        // 시각은 두 프로세스가 조금 다를 수 있다: 글·종류만 비교하도록 시각을 Rust 쪽 것으로 맞춘다
        Value::Array(m.iter().zip(info_rs["marks"].as_array().unwrap()).map(|(s, r)| { let mut s = s.clone(); s["t"] = r["t"].clone(); s }).collect())
    }).unwrap());
    let _ = (std::fs::remove_dir_all(&a), std::fs::remove_dir_all(&b));
}
