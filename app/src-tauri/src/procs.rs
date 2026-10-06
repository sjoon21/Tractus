//! 하위 프로세스 실행: 녹음(tractus-rec record), 작업(tractus transcribe/summarize --progress-json).
//! stdout의 JSON Lines 이벤트를 그대로 콜백에 넘기고, 끝나면 {"event":"exit","code":…,"stderr":…}를 하나 더 넘긴다.
//! 반환하는 Child로 취소(kill)할 수 있다 (질문 멈추기).

use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

const STDERR_TAIL: usize = 20;

/// `tag`의 필드를 모든 이벤트에 덧붙인다 (예: {"job": "01K…", "kind": "transcribe"}).
pub fn spawn_streaming(
    mut cmd: Command,
    tag: Map<String, Value>,
    emit: impl Fn(Value) + Send + Sync + 'static,
) -> Result<(ChildStdin, Arc<Mutex<Child>>), String> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("실행할 수 없습니다 ({program}): {e}"))?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    // stderr는 사람용 로그다. 실패했을 때 보여 주려고 마지막 몇 줄만 남긴다
    let tail = Arc::new(Mutex::new(VecDeque::new()));
    let err_thread = {
        let tail = tail.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let mut t = tail.lock().unwrap();
                if t.len() == STDERR_TAIL {
                    t.pop_front();
                }
                t.push_back(line);
            }
        })
    };

    // stdout을 다 읽은 뒤에만 잠그고 기다린다. 읽는 동안에는 잠그지 않으므로 그사이 kill할 수 있다
    let child = Arc::new(Mutex::new(child));
    let waiter = child.clone();
    let with_tag = move |mut v: Map<String, Value>| {
        v.extend(tag.clone());
        Value::Object(v)
    };
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&line) {
                emit(with_tag(obj));
            }
        }
        let code = waiter.lock().unwrap().wait().ok().and_then(|s| s.code());
        let _ = err_thread.join();
        let stderr: Vec<String> = tail.lock().unwrap().iter().cloned().collect();
        let Value::Object(exit) = json!({"event": "exit", "code": code, "stderr": stderr.join("\n")}) else { unreachable!() };
        emit(with_tag(exit));
    });
    Ok((stdin, child))
}

/// 녹음 헬퍼 stdin 명령. 한 줄에 명령 하나이므로 메모의 줄바꿈은 공백으로 바꾼다.
pub fn recorder_line(cmd: &str, text: Option<&str>) -> Result<String, String> {
    match (cmd, text) {
        ("bookmark" | "stop", _) => Ok(format!("{cmd}\n")),
        ("memo", Some(t)) if !t.trim().is_empty() => Ok(format!("memo {}\n", t.split_whitespace().collect::<Vec<_>>().join(" "))),
        ("memo", _) => Err("메모가 비어 있습니다".into()),
        _ => Err(format!("알 수 없는 녹음 명령: {cmd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::mpsc::channel;
    use std::time::Duration;

    #[test]
    fn forwards_json_lines_with_tag_then_exit() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", r#"read cmd; echo '{"event":"stage","stage":"decode"}'; echo 'human text'; echo "got $cmd" >&2; echo '{"event":"progress","done":1,"total":2}'; exit 1"#]);
        let (tx, rx) = channel();
        let tag = json!({"job": "J1"}).as_object().unwrap().clone();
        let (mut stdin, _) = spawn_streaming(cmd, tag, move |v| tx.send(v).unwrap()).unwrap();
        stdin.write_all(b"stop\n").unwrap();
        let got: Vec<Value> = (0..3).map(|_| rx.recv_timeout(Duration::from_secs(5)).unwrap()).collect();
        assert_eq!(got[0], json!({"event": "stage", "stage": "decode", "job": "J1"}));
        assert_eq!(got[1]["done"], 1);
        assert_eq!(got[2], json!({"event": "exit", "code": 1, "stderr": "got stop", "job": "J1"}));
    }

    #[test]
    fn kill_ends_with_exit_event() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", r#"echo '{"event":"stage","stage":"retrieve"}'; exec sleep 30"#]);
        let (tx, rx) = channel();
        let (_stdin, child) = spawn_streaming(cmd, Map::new(), move |v| tx.send(v).unwrap()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap()["stage"], "retrieve");
        child.lock().unwrap().kill().unwrap();
        let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(exit["event"], "exit");
        assert_eq!(exit["code"], Value::Null); // 시그널로 끝남
        let _ = child.lock().unwrap().kill(); // 이미 끝난 뒤의 kill은 무해하다
    }

    #[test]
    fn missing_program_is_error() {
        assert!(spawn_streaming(Command::new("/nonexistent/tractus-rec"), Map::new(), |_| {}).is_err());
    }

    #[test]
    fn recorder_commands() {
        assert_eq!(recorder_line("bookmark", None).unwrap(), "bookmark\n");
        assert_eq!(recorder_line("memo", Some(" 예산\n다시  확인 ")).unwrap(), "memo 예산 다시 확인\n");
        assert!(recorder_line("memo", Some("  ")).is_err());
        assert!(recorder_line("rm -rf", None).is_err());
    }
}
