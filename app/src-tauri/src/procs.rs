//! 하위 프로세스 실행: 녹음(tractus-rec record), 작업(tractus transcribe/summarize --progress-json).
//! stdout의 JSON Lines 이벤트를 그대로 콜백에 넘기고, 끝나면 {"event":"exit","code":…,"stderr":…}를 하나 더 넘긴다.
//! 반환하는 Child로 취소(kill)할 수 있다 (질문 멈추기). `Stoppable`은 stop 명령으로 끝내는 상주 프로세스(실시간 자막)다.
//! Windows: 띄운 프로세스는 앱의 Job Object에 넣어 앱이 끝나면 자손까지 함께 끝나고(`spawn`), 멈추기는 자손까지 끝낸다(`kill_tree`, docs/desktop.md §3.10).

use crate::i18n::{t, tv};
use serde_json::{json, Map, Value};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const STDERR_TAIL: usize = 20;

/// 하위 프로세스는 모두 이것으로 만든다: Windows에서 콘솔 창이 뜨지 않게 CREATE_NO_WINDOW를 단다 (macOS는 `Command::new` 그대로)
pub fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

/// 실행 파일을 띄우지 못했을 때의 오류. 첫 줄은 화면 문장 (WORDS.md), 둘째 줄은 OS 오류 문구('자세히').
/// 녹음 헬퍼(tractus-rec)와 코어(tractus)를 이름으로 가른다
pub fn cannot_run(program: &str, e: impl std::fmt::Display) -> String {
    if is_recorder(program) {
        tv("녹음 프로그램을 실행할 수 없습니다. 설정에서 tractus-rec 실행 파일 경로를 확인하세요 ({program})\n{e}", &[("program", program.to_string()), ("e", e.to_string())])
    } else {
        tv("Tractus 엔진을 실행할 수 없습니다. 설정에서 tractus 실행 파일 경로를 확인하세요 ({program})\n{e}", &[("program", program.to_string()), ("e", e.to_string())])
    }
}

// ponytail: 파일 이름으로 가른다. 녹음 헬퍼 이름을 바꾸면 코어로 취급된다
fn is_recorder(program: &str) -> bool {
    Path::new(program).file_name().is_some_and(|n| n.to_string_lossy().starts_with("tractus-rec"))
}

/// 하위 프로세스를 띄운다. Windows에서는 앱의 Job Object(KILL_ON_JOB_CLOSE)에 넣는다: 앱이 끝나면(강제 종료도) 코어·ffmpeg가 남지 않는다.
/// 녹음 프로그램은 넣지 않는다: 앱이 끝나면 stdin EOF로 스스로 WAV를 마무리하고 끝난다(macOS와 같다, docs/desktop.md §1)
pub fn spawn(cmd: &mut Command) -> std::io::Result<Child> {
    let child = cmd.spawn()?;
    #[cfg(windows)]
    if !is_recorder(&cmd.get_program().to_string_lossy()) {
        win::adopt(&child);
    }
    Ok(child)
}

/// 멈추기. Windows는 자손까지 끝낸다(`taskkill /T`: 코어 실행기 → python → ffmpeg. `Child::kill`은 바로 아래 하나만 끝낸다). macOS는 지금처럼 그 프로세스만
pub fn kill_tree(child: &mut Child) {
    // Windows는 핸들이 열려 있는 동안 PID를 다시 쓰지 않는다: 아직 안 끝났으면 이 PID는 이 프로세스다
    #[cfg(windows)]
    if matches!(child.try_wait(), Ok(None)) {
        let _ = command("taskkill").args(["/F", "/T", "/PID", &child.id().to_string()]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
}

/// 하위 프로세스가 실패하면(녹음 프로그램은 늘: 장치·소리 크기 진단) 이름·종료 코드·stderr 꼬리를 앱 로그에 남긴다. 가리기는 applog가 한다
pub fn log_exit(program: &str, code: Option<i32>, stderr: &str) {
    if code == Some(0) && !is_recorder(program) {
        return;
    }
    let name = Path::new(program).file_name().map_or_else(|| program.to_string(), |n| n.to_string_lossy().into_owned());
    let lines: Vec<&str> = stderr.lines().collect();
    let tail = lines[lines.len().saturating_sub(STDERR_TAIL)..].join("\n");
    let code = code.map_or_else(|| "none".to_string(), |c| c.to_string());
    crate::applog::write(&format!("{name} exited (code {code}){}{tail}", if tail.is_empty() { "" } else { ":\n" }));
}

/// `tag`의 필드를 모든 이벤트에 덧붙인다 (예: {"job": "01K…", "kind": "transcribe"}).
pub fn spawn_streaming(
    mut cmd: Command,
    tag: Map<String, Value>,
    emit: impl Fn(Value) + Send + Sync + 'static,
) -> Result<(ChildStdin, Arc<Mutex<Child>>), String> {
    let program = cmd.get_program().to_string_lossy().into_owned();
    let mut child = spawn(cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())).map_err(|e| cannot_run(&program, e))?;
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
        let stderr = tail.lock().unwrap().iter().cloned().collect::<Vec<String>>().join("\n");
        log_exit(&program, code, &stderr);
        let Value::Object(exit) = json!({"event": "exit", "code": code, "stderr": stderr}) else { unreachable!() };
        emit(with_tag(exit));
    });
    Ok((stdin, child))
}

/// 녹음 헬퍼 stdin 명령. 한 줄에 명령 하나이므로 메모의 줄바꿈은 공백으로 바꾼다.
pub fn recorder_line(cmd: &str, text: Option<&str>, index: Option<u32>) -> Result<String, String> {
    let one_line = |t: &str| t.split_whitespace().collect::<Vec<_>>().join(" ");
    match (cmd, text, index) {
        ("bookmark" | "stop" | "pause" | "resume", _, _) => Ok(format!("{cmd}\n")),
        ("memo", Some(t), _) if !t.trim().is_empty() => Ok(format!("memo {}\n", one_line(t))),
        ("memo", _, _) => Err(t("메모가 비어 있습니다")),
        // 녹음 중에 남긴 메모 고치기·지우기 (번호는 남긴 순서, 0부터). 글을 비우면 지우기다
        ("mark_edit", Some(t), Some(i)) if !t.trim().is_empty() => Ok(format!("mark_edit {i} {}\n", one_line(t))),
        ("mark_edit", _, Some(i)) | ("mark_delete", _, Some(i)) => Ok(format!("mark_delete {i}\n")),
        _ => Err(tv("알 수 없는 녹음 명령: {cmd}", &[("cmd", cmd.to_string())])),
    }
}

/// stdin "stop"으로 끝내는 상주 프로세스 (실시간 자막 `tractus live`, Phase 7.2).
/// exit 이벤트를 넘긴 뒤 `exited`가 울린다: 기다리는 쪽은 exit가 화면에 간 다음에 다음 일(정식 전사)을 시작한다.
pub struct Stoppable {
    stdin: ChildStdin,
    child: Arc<Mutex<Child>>,
    exited: Receiver<()>,
}

pub fn spawn_stoppable(cmd: Command, tag: Map<String, Value>, emit: impl Fn(Value) + Send + Sync + 'static) -> Result<Stoppable, String> {
    let (tx, exited) = channel();
    let (stdin, child) = spawn_streaming(cmd, tag, move |ev| {
        let exit = ev["event"] == "exit";
        emit(ev);
        if exit {
            let _ = tx.send(());
        }
    })?;
    Ok(Stoppable { stdin, child, exited })
}

impl Stoppable {
    /// 정지 명령만 보낸다 (기다리지 않는다). 이미 끝났으면 무시한다
    pub fn send_stop(&mut self) {
        let _ = self.stdin.write_all(b"stop\n").and_then(|_| self.stdin.flush());
    }

    /// 정지 명령 + stdin 닫기(EOF) 후 `wait`까지 기다리고, 그래도 안 끝나면 kill한다. 스스로 끝났으면 true
    pub fn stop(mut self, wait: Duration) -> bool {
        self.send_stop();
        let Stoppable { stdin, child, exited } = self;
        drop(stdin);
        if exited.recv_timeout(wait).is_ok() {
            return true;
        }
        kill(&child);
        let _ = exited.recv_timeout(Duration::from_secs(1)); // kill 뒤의 exit 이벤트가 먼저 가게
        false
    }

    pub fn kill(&self) {
        kill(&self.child);
    }
}

/// stdout이 닫힌 뒤에는 대기 스레드가 잠그고 wait 중이다: 이미 끝나는 중이므로 건너뛴다
fn kill(child: &Mutex<Child>) {
    if let Ok(mut c) = child.try_lock() {
        kill_tree(&mut c);
    }
}

/// Windows Job Object (windows-sys, 이미 Cargo.lock에 있던 0.61)
#[cfg(windows)]
mod win {
    use std::os::windows::io::AsRawHandle;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE};

    /// 마지막 핸들이 닫히면 안의 프로세스(와 그 뒤에 생긴 자손)가 모두 끝나는 Job Object
    pub struct Job(HANDLE);
    // SAFETY: Job Object 핸들은 어느 스레드에서 써도 된다
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Option<Job> {
            // SAFETY: 널 보안 속성·이름 없는 Job을 만들고, 크기를 맞춘 구조체를 넘긴다
            unsafe {
                let job = Job(CreateJobObjectW(std::ptr::null(), std::ptr::null()));
                if job.0.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
                (SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &info as *const _ as *const _, size) != 0).then_some(job)
            }
        }

        pub fn assign(&self, child: &std::process::Child) -> bool {
            // SAFETY: child가 살아 있는 동안 그 핸들을 빌린다
            unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE) != 0 }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            // SAFETY: new에서 만든 핸들을 한 번만 닫는다
            unsafe { CloseHandle(self.0) };
        }
    }

    /// 앱 전체에 하나. 닫지 않는다: 앱 프로세스가 끝날 때 OS가 닫으며 안의 프로세스를 끝낸다.
    /// (앱 프로세스 자체를 Job에 넣지 않는 것은 브라우저처럼 앱이 연 다른 프로그램까지 함께 끝나기 때문이다)
    static APP_JOB: OnceLock<Option<Job>> = OnceLock::new();

    /// shortcut: 띄운 직후에 넣으므로 그 사이에 생긴 손자는 Job 밖이다(멈추기는 taskkill /T가 잡는다), 남는 것이 보이면 띄울 때 넣는 PROC_THREAD_ATTRIBUTE_JOB_LIST(raw_attribute가 안정화되면)로 바꾼다
    pub fn adopt(child: &std::process::Child) {
        match APP_JOB.get_or_init(Job::new) {
            Some(job) if job.assign(child) => {}
            _ => crate::applog::write("could not put a child process in the app job object"),
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[cfg(unix)] // sh 스크립트·유닉스 신호를 쓴다
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

    #[cfg(unix)] // sh 스크립트·유닉스 신호를 쓴다
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

    #[cfg(unix)] // sh 스크립트·유닉스 신호를 쓴다
    #[test]
    fn stoppable_stops_on_stop_line() {
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c", r#"echo '{"event":"stage","stage":"live"}'; read cmd; echo '{"event":"done"}'"#]);
        let (tx, rx) = channel();
        let p = spawn_stoppable(cmd, Map::new(), move |v| tx.send(v).unwrap()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap()["stage"], "live");
        assert!(p.stop(Duration::from_secs(5)));
        // exit 이벤트는 stop이 돌아오기 전에 이미 갔다
        let got: Vec<Value> = rx.try_iter().collect();
        assert_eq!(got.iter().map(|v| v["event"].as_str().unwrap()).collect::<Vec<_>>(), ["done", "exit"]);
        assert_eq!(got[1]["code"], 0);
    }

    #[cfg(unix)] // sh 스크립트·유닉스 신호를 쓴다
    #[test]
    fn stoppable_is_killed_after_timeout() {
        let mut cmd = Command::new("/bin/sh");
        // stop도 EOF도 무시하는 프로세스
        cmd.args(["-c", r#"trap '' TERM; echo '{"event":"stage","stage":"live"}'; exec sleep 30 < /dev/null"#]);
        let (tx, rx) = channel();
        let p = spawn_stoppable(cmd, Map::new(), move |v| tx.send(v).unwrap()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap()["stage"], "live");
        let t = std::time::Instant::now();
        assert!(!p.stop(Duration::from_millis(300)));
        assert!(t.elapsed() < Duration::from_secs(3));
        let exit = rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(exit["event"], "exit");
        assert_eq!(exit["code"], Value::Null);
    }

    /// 시험용 하위 프로세스의 몸통: `test_child`가 이 시험 실행 파일을 이 시험 하나만 돌게 다시 띄운다(sh 없이 macOS·Windows 모두에서 돈다).
    /// 그냥 시험을 돌릴 때는 무시되고, 환경변수가 없으면 아무것도 하지 않는다
    #[test]
    #[ignore = "test_child가 하위 프로세스로 띄운다"]
    fn child_main() {
        let Ok(mode) = std::env::var("TRACTUS_TEST_CHILD") else { return };
        println!(); // 시험 실행기가 찍는 머리 줄과 떨어지게
        let say = |v: Value| println!("{v}");
        match mode.as_str() {
            "json" => {
                let mut line = String::new();
                std::io::stdin().read_line(&mut line).unwrap();
                say(json!({"event": "stage", "stage": "decode"}));
                println!("human text");
                eprintln!("got {}", line.trim());
                say(json!({"event": "progress", "done": 1, "total": 2}));
                std::process::exit(1);
            }
            "stop" => {
                say(json!({"event": "stage", "stage": "live"}));
                let _ = std::io::stdin().read_line(&mut String::new()); // stop 줄이나 EOF
                say(json!({"event": "done"}));
            }
            // stdin을 듣지 않고 30초 잔다 (stop·EOF를 무시하는 프로세스)
            "sleep" => {
                say(json!({"event": "stage", "stage": "sleep"}));
                std::thread::sleep(Duration::from_secs(30));
            }
            // 손자를 띄우고 그 PID를 알린 뒤 잔다 (코어 실행기 → python → ffmpeg 꼴)
            "tree" => {
                #[allow(clippy::zombie_processes)] // 손자는 시험이 끝낸다(멈추기·Job 닫기)
                let grandchild = test_child("sleep").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
                say(json!({"event": "child", "pid": grandchild.id()}));
                std::thread::sleep(Duration::from_secs(30));
            }
            other => panic!("모르는 모드: {other}"),
        }
    }

    pub(crate) fn test_child(mode: &str) -> Command {
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args(["procs::tests::child_main", "--exact", "--ignored", "--nocapture", "--test-threads=1", "-q"]).env("TRACTUS_TEST_CHILD", mode);
        cmd
    }

    /// 신호(macOS)나 TerminateProcess(Windows, 코드 1)로 끝났다
    fn killed(code: &Value) -> bool {
        if cfg!(windows) { code == 1 } else { code.is_null() }
    }

    #[test]
    fn child_streams_json_lines_then_exit_on_every_platform() {
        let (tx, rx) = channel();
        let tag = json!({"job": "J1"}).as_object().unwrap().clone();
        let (mut stdin, _) = spawn_streaming(test_child("json"), tag, move |v| tx.send(v).unwrap()).unwrap();
        stdin.write_all(b"stop\n").unwrap();
        let got: Vec<Value> = (0..3).map(|_| rx.recv_timeout(Duration::from_secs(20)).unwrap()).collect();
        assert_eq!(got[0], json!({"event": "stage", "stage": "decode", "job": "J1"}));
        assert_eq!(got[1]["done"], 1);
        assert_eq!(got[2], json!({"event": "exit", "code": 1, "stderr": "got stop", "job": "J1"}));
    }

    #[test]
    fn stop_and_kill_end_a_child_on_every_platform() {
        let (tx, rx) = channel();
        let (_stdin, child) = spawn_streaming(test_child("sleep"), Map::new(), move |v| tx.send(v).unwrap()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(20)).unwrap()["stage"], "sleep");
        kill(&child);
        let exit = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(exit["event"] == "exit" && killed(&exit["code"]), "{exit}");
        kill_tree(&mut child.lock().unwrap()); // 이미 끝난 뒤의 멈추기는 무해하다

        // stop 줄로 스스로 끝난다
        let (tx, rx) = channel();
        let p = spawn_stoppable(test_child("stop"), Map::new(), move |v| tx.send(v).unwrap()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(20)).unwrap()["stage"], "live");
        assert!(p.stop(Duration::from_secs(10)));
        let got: Vec<Value> = rx.try_iter().collect();
        assert_eq!(got.iter().map(|v| v["event"].as_str().unwrap()).collect::<Vec<_>>(), ["done", "exit"]);
        assert_eq!(got[1]["code"], 0);

        // stop도 EOF도 듣지 않으면 기다린 뒤 끝낸다
        let (tx, rx) = channel();
        let p = spawn_stoppable(test_child("sleep"), Map::new(), move |v| tx.send(v).unwrap()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(20)).unwrap()["stage"], "sleep");
        let t = std::time::Instant::now();
        assert!(!p.stop(Duration::from_millis(300)));
        assert!(t.elapsed() < Duration::from_secs(5));
        let exit = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(exit["event"] == "exit" && killed(&exit["code"]), "{exit}");
    }

    /// PID의 프로세스가 `timeout` 안에 사라지는지
    #[cfg(windows)]
    fn gone(pid: u64, timeout: Duration) -> bool {
        let t = std::time::Instant::now();
        while t.elapsed() < timeout {
            let out = command("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]).output().unwrap();
            if !String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\"")) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        false
    }

    /// 멈추기는 손자까지 끝낸다 (Child::kill만으로는 손자가 남는다)
    #[cfg(windows)]
    #[test]
    fn stop_ends_grandchildren_on_windows() {
        let (tx, rx) = channel();
        let (_stdin, child) = spawn_streaming(test_child("tree"), Map::new(), move |v| tx.send(v).unwrap()).unwrap();
        let pid = rx.recv_timeout(Duration::from_secs(20)).unwrap()["pid"].as_u64().unwrap();
        kill(&child);
        assert_eq!(rx.recv_timeout(Duration::from_secs(10)).unwrap()["event"], "exit");
        assert!(gone(pid, Duration::from_secs(10)), "손자 {pid}가 남았다");
    }

    /// Job Object가 닫히면(앱이 끝나면) 넣은 프로세스와 그 뒤에 생긴 손자가 함께 끝난다
    #[cfg(windows)]
    #[test]
    fn closing_the_job_ends_children_and_grandchildren_on_windows() {
        let job = win::Job::new().expect("Job Object를 만든다");
        let mut child = test_child("tree").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
        assert!(job.assign(&child));
        let pid = BufReader::new(child.stdout.take().unwrap())
            .lines()
            .map_while(Result::ok)
            .find_map(|l| serde_json::from_str::<Value>(&l).ok().and_then(|v| v["pid"].as_u64()))
            .unwrap();
        drop(job);
        let t = std::time::Instant::now();
        while child.try_wait().unwrap().is_none() {
            assert!(t.elapsed() < Duration::from_secs(10), "자식이 남았다");
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(gone(pid, Duration::from_secs(10)), "손자 {pid}가 남았다");
    }

    #[test]
    fn missing_program_is_error() {
        assert!(spawn_streaming(Command::new("/nonexistent/tractus-rec"), Map::new(), |_| {}).is_err());
    }

    /// 실제 `tractus-rec --fake`에 앱이 보내는 줄(recorder_line)을 보내고, 받은 이벤트의 모양을 본다 (일시정지 중에는 level이 없다)
    #[test]
    #[ignore = "recorder/.build/release/tractus-rec가 필요하다 (cd recorder && swift build -c release)"]
    fn real_recorder_pause_resume_events() {
        use std::io::Write;
        let rec = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../recorder/.build/release/tractus-rec");
        let out = std::env::temp_dir().join(format!("tractus-rec-pause-{}", std::process::id()));
        let mut cmd = Command::new(rec);
        cmd.arg("record").arg("--out").arg(&out).args(["--fake", "--no-system"]);
        let (tx, rx) = channel();
        let (mut stdin, _) = spawn_streaming(cmd, Map::new(), move |v| tx.send(v).unwrap()).unwrap();
        let mut send = |cmd: &str| stdin.write_all(recorder_line(cmd, None, None).unwrap().as_bytes()).and_then(|_| stdin.flush()).unwrap();
        let mut seen: Vec<Value> = vec![];
        let mut wait = |event: &str| loop {
            let v = rx.recv_timeout(Duration::from_secs(10)).unwrap();
            seen.push(v.clone());
            if v["event"] == event {
                return v;
            }
        };
        wait("started");
        std::thread::sleep(Duration::from_millis(1200));
        send("pause");
        let paused = wait("paused");
        assert!(paused["elapsed"].as_f64().unwrap() > 0.5, "{paused}");
        send("bookmark");
        let mark = wait("mark");
        assert_eq!(mark["t"], paused["elapsed"]); // 일시정지 중 북마크는 멈춘 위치에 찍힌다
        std::thread::sleep(Duration::from_millis(800));
        send("resume");
        let resumed = wait("resumed");
        assert_eq!(resumed["elapsed"], paused["elapsed"]);
        send("stop");
        let stopped = wait("stopped");
        assert!(stopped["duration"].as_f64().unwrap() >= paused["elapsed"].as_f64().unwrap());
        assert_eq!(wait("exit")["code"], 0);
        // paused와 resumed 사이에는 level이 없다
        let names: Vec<&str> = seen.iter().map(|v| v["event"].as_str().unwrap()).collect();
        let (a, b) = (names.iter().position(|n| *n == "paused").unwrap(), names.iter().position(|n| *n == "resumed").unwrap());
        assert!(names[a..b].iter().all(|n| *n != "level"), "{names:?}");
        let info: Value = serde_json::from_str(&std::fs::read_to_string(out.join("recording.json")).unwrap()).unwrap();
        assert_eq!(info["pauses"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&out);
    }

    #[test]
    fn recorder_commands() {
        assert_eq!(recorder_line("bookmark", None, None).unwrap(), "bookmark\n");
        // 일시정지·계속은 녹음 헬퍼의 stdin 명령이다 (recorder/README.md). 본문은 받지 않는다
        assert_eq!(recorder_line("pause", None, None).unwrap(), "pause\n");
        assert_eq!(recorder_line("resume", Some("x"), None).unwrap(), "resume\n");
        assert!(recorder_line("Pause", None, None).is_err() && recorder_line("pause now", None, None).is_err());
        assert_eq!(recorder_line("memo", Some(" 예산\n다시  확인 "), None).unwrap(), "memo 예산 다시 확인\n");
        assert!(recorder_line("memo", Some("  "), None).is_err());
        assert!(recorder_line("rm -rf", None, None).is_err());
        // 녹음 중 메모 고치기·지우기: 번호가 있어야 하고, 빈 글로 고치면 지우기다
        assert_eq!(recorder_line("mark_edit", Some(" 고친\n 메모 "), Some(2)).unwrap(), "mark_edit 2 고친 메모\n");
        assert_eq!(recorder_line("mark_edit", Some("  "), Some(2)).unwrap(), "mark_delete 2\n");
        assert_eq!(recorder_line("mark_delete", None, Some(0)).unwrap(), "mark_delete 0\n");
        assert!(recorder_line("mark_edit", Some("글"), None).is_err() && recorder_line("mark_delete", None, None).is_err());
    }
}
