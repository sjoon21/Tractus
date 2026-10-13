//! 상주 `tractus mcp` 클라이언트. 최소 JSON-RPC 2.0 over stdio (줄 단위 JSON).
//!
//! - 첫 호출 때 띄우고 initialize → notifications/initialized 순서로 연결한다.
//! - 하위 프로세스가 죽으면 대기 중인 호출은 실패하고, 다음 호출이 새로 띄운다(한 번 재시도).
//! - `call_tool`은 블로킹이다. Tauri 명령에서는 spawn_blocking으로 불러 UI 스레드를 막지 않는다.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const PROTOCOL_VERSION: &str = "2025-11-25";
/// 첫 검색은 색인 동기화·임베딩 모델 적재로 수십 초 걸릴 수 있다.
const CALL_TIMEOUT: Duration = Duration::from_secs(120);

type Pending = Arc<Mutex<HashMap<u64, Sender<Result<Value, String>>>>>;

#[derive(Clone, Debug, PartialEq)]
pub struct Spawn {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: Option<PathBuf>,
}

struct Conn {
    /// 이 연결을 띄운 명령. 설정이 바뀌면 다음 호출이 새로 띄운다
    spec: Spawn,
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
    alive: Arc<AtomicBool>,
}

impl Drop for Conn {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct McpClient {
    spawn: Mutex<Spawn>,
    conn: Mutex<Option<Conn>>,
    next_id: AtomicU64,
}

impl McpClient {
    pub fn new(spawn: Spawn) -> Self {
        Self { spawn: Mutex::new(spawn), conn: Mutex::new(None), next_id: AtomicU64::new(1) }
    }

    /// 설정이 바뀌면 다음 호출부터 새 명령으로 띄운다.
    /// conn 잠금은 잡지 않는다: 연결 중(initialize 대기)에는 conn 잠금이 오래 잡혀 있어 UI 스레드가 멈춘다.
    pub fn set_spawn(&self, spawn: Spawn) {
        *self.spawn.lock().unwrap() = spawn;
    }

    /// tools/call. 반환값은 JSON-RPC `result` 그대로다(content·structuredContent·isError는 프론트엔드가 해석).
    pub fn call_tool(&self, name: &str, arguments: Value) -> Result<Value, String> {
        let params = json!({"name": name, "arguments": arguments});
        match self.request("tools/call", params.clone()) {
            Err(e) if e == DISCONNECTED => self.request("tools/call", params),
            r => r,
        }
    }

    fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let rx = {
            let mut guard = self.conn.lock().unwrap();
            let spec = self.spawn.lock().unwrap().clone();
            if !guard.as_ref().is_some_and(|c| c.alive.load(Ordering::SeqCst) && c.spec == spec) {
                *guard = None; // 죽었거나 설정이 바뀐 프로세스 정리 (Drop에서 kill·wait)
                *guard = Some(connect(spec, self.next_id.fetch_add(1, Ordering::Relaxed))?);
            }
            let conn = guard.as_mut().unwrap();
            let (tx, rx) = channel();
            conn.pending.lock().unwrap().insert(id, tx);
            // read_loop는 alive=false를 먼저 쓰고 pending을 비운다. 그 사이에 넣은 항목은 여기서 걸러 무한 대기를 막는다
            if !conn.alive.load(Ordering::SeqCst) {
                conn.pending.lock().unwrap().remove(&id);
                *guard = None;
                return Err(DISCONNECTED.into());
            }
            if let Err(e) = send(&mut conn.stdin, &json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})) {
                *guard = None;
                return Err(if e.kind() == std::io::ErrorKind::BrokenPipe { DISCONNECTED.into() } else { e.to_string() });
            }
            rx
        };
        wait(rx)
    }
}

fn connect(spec: Spawn, id: u64) -> Result<Conn, String> {
    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args).envs(spec.env.iter().cloned()).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    if let Some(cwd) = &spec.cwd {
        cmd.current_dir(cwd);
    }
    let mut child = cmd.spawn().map_err(|e| format!("스마트 검색을 시작하지 못했습니다 ({})\n{e}", spec.program.display()))?;
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let pending: Pending = Arc::default();
    let alive = Arc::new(AtomicBool::new(true));
    {
        let (pending, alive) = (pending.clone(), alive.clone());
        std::thread::spawn(move || read_loop(BufReader::new(stdout), &pending, &alive));
    }

    let (tx, rx) = channel();
    pending.lock().unwrap().insert(id, tx);
    let init = json!({"jsonrpc": "2.0", "id": id, "method": "initialize", "params": {
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": {"name": "tractus-app", "version": env!("CARGO_PKG_VERSION")}
    }});
    let mut conn = Conn { spec, child, stdin, pending, alive };
    send(&mut conn.stdin, &init).map_err(|e| format!("스마트 검색을 시작하지 못했습니다\n{e}"))?;
    wait(rx).map_err(|e| format!("스마트 검색을 시작하지 못했습니다\n{e}"))?;
    send(&mut conn.stdin, &json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).map_err(|e| e.to_string())?;
    Ok(conn)
}

const DISCONNECTED: &str = "검색 엔진이 종료되었습니다. 다시 검색하면 새로 시작합니다";

fn send(w: &mut impl Write, msg: &Value) -> std::io::Result<()> {
    let mut line = serde_json::to_vec(msg)?;
    line.push(b'\n');
    w.write_all(&line)?;
    w.flush()
}

fn wait(rx: std::sync::mpsc::Receiver<Result<Value, String>>) -> Result<Value, String> {
    match rx.recv_timeout(CALL_TIMEOUT) {
        Ok(r) => r,
        Err(RecvTimeoutError::Timeout) => Err("검색 응답이 너무 늦습니다. 잠시 후 다시 시도하세요".into()),
        Err(RecvTimeoutError::Disconnected) => Err(DISCONNECTED.into()),
    }
}

/// 응답(id + result|error)만 대기 중인 호출에 넘긴다. 서버 알림·요청과 JSON이 아닌 줄은 버린다.
// ponytail: 서버→클라이언트 요청(ping 등)에 답하지 않는다. 지금 tractus mcp는 보내지 않음
fn read_loop(reader: impl BufRead, pending: &Pending, alive: &AtomicBool) {
    for line in reader.lines() {
        let Ok(line) = line else { break };
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let Some(id) = msg.get("id").and_then(Value::as_u64) else { continue };
        if msg.get("method").is_some() {
            continue;
        }
        let result = match msg.get("error") {
            Some(err) => Err(err.get("message").and_then(Value::as_str).unwrap_or("검색 중 오류가 났습니다").to_string()),
            None => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
        };
        if let Some(tx) = pending.lock().unwrap().remove(&id) {
            let _ = tx.send(result);
        }
    }
    alive.store(false, Ordering::SeqCst);
    pending.lock().unwrap().clear(); // Sender를 버려 대기 중인 호출을 깨운다
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 가짜 MCP 서버: 잡음 줄을 먼저 찍고, initialize 전 tools/call은 거부하고, "crash" 도구를 부르면 죽는다.
    const FAKE: &str = r#"
import json, sys
print("not json noise", flush=True)
ready = False
for line in sys.stdin:
    m = json.loads(line)
    if m.get("method") == "initialize":
        assert m["params"]["protocolVersion"] == "2025-11-25"
        print(json.dumps({"jsonrpc": "2.0", "method": "notifications/message", "params": {}}), flush=True)
        print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"protocolVersion": "2025-11-25", "capabilities": {}}}), flush=True)
    elif m.get("method") == "notifications/initialized":
        ready = True
    elif m.get("method") == "tools/call":
        name = m["params"]["name"]
        if not ready:
            print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32002, "message": "not initialized"}}), flush=True)
        elif name == "crash":
            sys.exit(3)
        elif name == "bad":
            print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "error": {"code": -32602, "message": "bad args"}}), flush=True)
        else:
            out = {"echo": m["params"]["arguments"], "pid": __import__("os").getpid()}
            print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": {"content": [{"type": "text", "text": json.dumps(out)}], "structuredContent": out, "isError": False}}), flush=True)
"#;

    fn client() -> McpClient {
        McpClient::new(Spawn { program: "/usr/bin/python3".into(), args: vec!["-c".into(), FAKE.into()], env: vec![], cwd: None })
    }

    #[test]
    fn handshake_then_tool_call() {
        let c = client();
        let r = c.call_tool("search_meetings", json!({"query": "예산", "limit": 3})).unwrap();
        assert_eq!(r["structuredContent"]["echo"]["query"], "예산");
        assert_eq!(r["isError"], false);
    }

    #[test]
    fn jsonrpc_error_is_err() {
        assert_eq!(client().call_tool("bad", json!({})).unwrap_err(), "bad args");
    }

    #[test]
    fn restarts_after_crash() {
        let c = client();
        let pid1 = c.call_tool("status", json!({})).unwrap()["structuredContent"]["pid"].clone();
        // crash는 재시도해도 또 죽으므로 끝내 실패한다
        assert_eq!(c.call_tool("crash", json!({})).unwrap_err(), DISCONNECTED);
        let pid2 = c.call_tool("status", json!({})).unwrap()["structuredContent"]["pid"].clone();
        assert_ne!(pid1, pid2);
    }

    #[test]
    fn concurrent_calls_get_their_own_responses() {
        let c = Arc::new(client());
        let handles: Vec<_> = (0..8)
            .map(|i| {
                let c = c.clone();
                std::thread::spawn(move || c.call_tool("status", json!({"i": i})).unwrap()["structuredContent"]["echo"]["i"].as_i64().unwrap())
            })
            .collect();
        let mut got: Vec<i64> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        got.sort();
        assert_eq!(got, (0..8).collect::<Vec<_>>());
    }

    /// 설정 저장(set_spawn)은 연결 중인 호출을 기다리지 않고, 다음 호출은 새 명령으로 띄운다.
    #[test]
    fn set_spawn_does_not_wait_for_connect_and_takes_effect() {
        let slow = Spawn { program: "/usr/bin/python3".into(), args: vec!["-c".into(), format!("import time; time.sleep(2)\n{FAKE}")], env: vec![], cwd: None };
        let c = Arc::new(McpClient::new(slow));
        let warm = {
            let c = c.clone();
            std::thread::spawn(move || c.call_tool("status", json!({})).unwrap()["structuredContent"]["pid"].clone())
        };
        std::thread::sleep(Duration::from_millis(300)); // warm이 initialize 응답을 기다리는 중
        let t0 = std::time::Instant::now();
        c.set_spawn(client().spawn.into_inner().unwrap());
        assert!(t0.elapsed() < Duration::from_millis(100), "set_spawn이 {:?} 막힘", t0.elapsed());
        let old_pid = warm.join().unwrap();
        let new_pid = c.call_tool("status", json!({})).unwrap()["structuredContent"]["pid"].clone();
        assert_ne!(old_pid, new_pid);
    }

    #[test]
    fn missing_binary_is_clear_error() {
        let c = McpClient::new(Spawn { program: "/nonexistent/tractus".into(), args: vec![], env: vec![], cwd: None });
        assert!(c.call_tool("status", json!({})).unwrap_err().contains("스마트 검색을 시작하지 못했습니다"));
    }
}
