//! WASAPI: 마이크, 시스템 소리(이 앱만 뺀 process loopback, 안 되면 출력 전체), 기본 장치 바뀜 알림.
//! 공유 모드만 쓰고 통신 역할·독점 모드는 쓰지 않는다: 통화 앱의 마이크를 건드리지 않는다.
//! Yogurt(FrigadeHQ/yogurt, MIT, Copyright (c) 2026 Frigade) app/native/yogurt-audio-win/src/win/mod.rs에서 옮겨
//! Tractus 계약(48 kHz mono 16-bit, `Msg`)에 맞췄다 (NOTICE 12번). Opus·Ogg·PCM 스트림·마이크 고르기는 가져오지 않았다.
#![allow(non_snake_case)]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use windows::core::{implement, w, Interface, Ref, Result as WinResult, HRESULT, IUnknown, PCWSTR};
use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED, E_FAIL, HANDLE, PROPERTYKEY, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, IAgileObject, IAgileObject_Impl, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{CreateEventW, GetCurrentProcessId, SetEvent, WaitForSingleObject};

use crate::gap::GapFiller;
use crate::meter::to_i16;
use crate::protocol::log;
use crate::recorder::{Msg, OpenError, Opener, Source, Track};

/// 이 프로그램이 뜬 뒤의 ms. WASAPI 버퍼의 QPC 시각과 같은 시계다
#[derive(Clone, Copy)]
pub struct Clock {
    start: Instant,
    start_hns: u64,
}

impl Clock {
    pub fn new() -> Clock {
        Clock { start: Instant::now(), start_hns: qpc_hns() }
    }
    fn now_ms(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }
    fn qpc_ms(&self, hns: u64) -> f64 {
        (hns as f64 - self.start_hns as f64) / 10_000.0
    }
}

fn qpc_hns() -> u64 {
    use windows::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    let (mut c, mut f) = (0i64, 0i64);
    unsafe {
        let _ = QueryPerformanceCounter(&mut c);
        let _ = QueryPerformanceFrequency(&mut f);
    }
    if f <= 0 {
        return 0;
    }
    ((c as i128 * 10_000_000) / f as i128) as u64
}

pub fn com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn enumerator() -> WinResult<IMMDeviceEnumerator> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
}

fn start_error(e: windows::core::Error) -> OpenError {
    if e.code() == E_ACCESSDENIED {
        OpenError::Denied
    } else {
        OpenError::Failed(format!("{e}"))
    }
}

/// 48 kHz float. 장치가 다른 형식이면 Windows가 바꿔 준다 (AUTOCONVERTPCM)
fn format(channels: u16) -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
        nChannels: channels,
        nSamplesPerSec: 48_000,
        nAvgBytesPerSec: 48_000 * 4 * channels as u32,
        nBlockAlign: 4 * channels,
        wBitsPerSample: 32,
        cbSize: 0,
    }
}

/// 공유 모드, 200ms 버퍼. mono부터, 안 되면 stereo. 채널 수를 돌려준다
fn initialize(client: &IAudioClient, loopback: bool) -> WinResult<u16> {
    let mut flags = AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    if loopback {
        flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
    }
    let mut last = None;
    for ch in [1u16, 2] {
        let f = format(ch);
        match unsafe { client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2_000_000, 0, &f, None) } {
            Ok(()) => return Ok(ch),
            Err(e) => {
                if e.code() == E_ACCESSDENIED {
                    return Err(e);
                }
                last = Some(e)
            }
        }
    }
    Err(last.unwrap_or_else(|| E_FAIL.into()))
}

/// 도는 캡처 스레드. 멈추면 끝날 때까지 기다린다
pub struct Stream {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Source for Stream {
    fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        Source::stop(self);
    }
}

const POLL: Duration = Duration::from_millis(10);

/// 패킷 하나: 48 kHz mono 표본과 QPC 시각 (장치가 시각을 안 주면 0)
fn read_packet(cap: &IAudioCaptureClient, channels: u16) -> WinResult<Option<(Vec<f32>, u64)>> {
    unsafe {
        if cap.GetNextPacketSize()? == 0 {
            return Ok(None);
        }
        let mut data: *mut u8 = std::ptr::null_mut();
        let (mut frames, mut flags, mut qpc) = (0u32, 0u32, 0u64);
        cap.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc as *mut u64))?;
        let n = frames as usize;
        let ch = channels as usize;
        let samples: Vec<f32> = if flags & 2 != 0 || data.is_null() {
            vec![0.0; n] // AUDCLNT_BUFFERFLAGS_SILENT
        } else {
            let all = std::slice::from_raw_parts(data as *const f32, n * ch);
            if ch == 1 {
                all.to_vec()
            } else {
                all.chunks_exact(ch).map(|c| c.iter().sum::<f32>() / ch as f32).collect()
            }
        };
        cap.ReleaseBuffer(frames)?;
        let qpc = if flags & 4 != 0 { 0 } else { qpc }; // AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR
        Ok(Some((samples, qpc)))
    }
}

/// 스트림을 자기 스레드에서 시작한다. 시작했는지는 돌려주기 전에 안다
fn spawn(
    setup: impl FnOnce() -> Result<(IAudioClient, u16), OpenError> + Send + 'static,
    each: impl FnMut(Option<(Vec<f32>, u64)>) + Send + 'static,
    lost: impl FnOnce() + Send + 'static,
) -> Result<Stream, OpenError> {
    let stop = Arc::new(AtomicBool::new(false));
    let (ready_tx, ready_rx) = channel::<Result<(), OpenError>>();
    let s = stop.clone();
    let thread = std::thread::spawn(move || {
        com();
        let mut each = each;
        let (client, ch) = match setup() {
            Ok(x) => x,
            Err(e) => {
                let _ = ready_tx.send(Err(e));
                return;
            }
        };
        let cap: IAudioCaptureClient = match unsafe { client.GetService() } {
            Ok(c) => c,
            Err(e) => {
                let _ = ready_tx.send(Err(start_error(e)));
                return;
            }
        };
        if let Err(e) = unsafe { client.Start() } {
            let _ = ready_tx.send(Err(start_error(e)));
            return;
        }
        let _ = ready_tx.send(Ok(()));
        'run: while !s.load(Ordering::SeqCst) {
            std::thread::sleep(POLL);
            let mut got = false;
            loop {
                match read_packet(&cap, ch) {
                    Ok(Some(p)) => {
                        got = true;
                        each(Some(p))
                    }
                    Ok(None) => break,
                    Err(e) => {
                        if !s.load(Ordering::SeqCst) {
                            log(&format!("오디오 스트림이 멈췄습니다: {e}"));
                            lost();
                        }
                        break 'run;
                    }
                }
            }
            if !got {
                each(None);
            }
        }
        unsafe {
            let _ = client.Stop();
        }
    });
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(Stream { stop, thread: Some(thread) }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            let _ = thread.join();
            Err(OpenError::Failed("오디오 스레드가 끝났습니다".into()))
        }
    }
}

/// Windows 기본 입력 장치
pub fn start_mic(tx: Sender<Msg>) -> Result<Stream, OpenError> {
    let lost_tx = tx.clone();
    spawn(
        || {
            let dev = unsafe { enumerator().map_err(start_error)?.GetDefaultAudioEndpoint(eCapture, eConsole) }.map_err(|_| OpenError::Failed("마이크가 없습니다".into()))?;
            let client: IAudioClient = unsafe { dev.Activate(CLSCTX_ALL, None) }.map_err(start_error)?;
            let ch = initialize(&client, false).map_err(start_error)?;
            Ok((client, ch))
        },
        move |p| {
            if let Some((s, _)) = p {
                let _ = tx.send(Msg::Samples(Track::Mic, to_i16(&s)));
            }
        },
        move || {
            let _ = lost_tx.send(Msg::Restart(Track::Mic, "장치가 끊겼습니다"));
        },
    )
}

/// 시스템 소리. process loopback(Windows 10 2004 이상)은 이 프로그램을 띄운 앱(Tractus)과 그 하위 프로세스만 빼고
/// 모든 앱을 녹음한다. 안 되면 출력 전체(Tractus 소리 포함). `TRACTUS_REC_LOOPBACK=endpoint`면 일부러 출력 전체 (CI 시험용)
pub fn start_system(tx: Sender<Msg>, clock: Clock) -> Result<Stream, OpenError> {
    let lost_tx = tx.clone();
    let mut gap = GapFiller::new(clock.now_ms());
    spawn(
        move || {
            let parent = parent_pid();
            if parent != 0 && std::env::var("TRACTUS_REC_LOOPBACK").as_deref() != Ok("endpoint") {
                match process_loopback(parent) {
                    Ok(client) => match initialize(&client, true) {
                        Ok(ch) => {
                            log("시스템 오디오: Tractus를 뺀 모든 앱");
                            return Ok((client, ch));
                        }
                        Err(e) => log(&format!("process loopback을 시작하지 못했습니다({e}): 출력 전체를 녹음합니다")),
                    },
                    Err(e) => log(&format!("process loopback을 쓸 수 없습니다({e}): 출력 전체를 녹음합니다")),
                }
            }
            let dev = unsafe { enumerator().map_err(start_error)?.GetDefaultAudioEndpoint(eRender, eConsole) }.map_err(|_| OpenError::Failed("출력 장치가 없습니다".into()))?;
            let client: IAudioClient = unsafe { dev.Activate(CLSCTX_ALL, None) }.map_err(start_error)?;
            let ch = initialize(&client, true).map_err(start_error)?;
            log("시스템 오디오: 출력 전체 (Tractus 소리 포함)");
            Ok((client, ch))
        },
        move |p| match p {
            Some((s, qpc)) => {
                let frames = s.len();
                let heard = if qpc != 0 { clock.qpc_ms(qpc) } else { clock.now_ms() - frames as f64 / 48.0 };
                let skip = gap.packet(heard, frames);
                if skip < frames {
                    let _ = tx.send(Msg::Samples(Track::System, to_i16(&s[skip..])));
                }
            }
            None => {
                if let Some((_, frames)) = gap.idle(clock.now_ms()) {
                    let _ = tx.send(Msg::Samples(Track::System, vec![0; frames]));
                }
            }
        },
        move || {
            let _ = lost_tx.send(Msg::Restart(Track::System, "장치가 끊겼습니다"));
        },
    )
}

/// 이 프로그램을 띄운 프로세스 (Tractus 앱)
pub fn parent_pid() -> u32 {
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return 0 };
        let me = GetCurrentProcessId();
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        let mut found = 0;
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                if e.th32ProcessID == me {
                    found = e.th32ParentProcessID;
                    break;
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        found
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Activated(HANDLE);

impl IActivateAudioInterfaceCompletionHandler_Impl for Activated_Impl {
    fn ActivateCompleted(&self, _op: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> WinResult<()> {
        unsafe { SetEvent(self.0) }
    }
}

impl IAgileObject_Impl for Activated_Impl {}

/// BLOB을 담은 PROPVARIANT (x64 배치)
#[repr(C)]
struct BlobVariant {
    vt: u16,
    r1: u16,
    r2: u16,
    r3: u16,
    size: u32,
    data: *const std::ffi::c_void,
}

fn process_loopback(pid: u32) -> WinResult<IAudioClient> {
    unsafe {
        let params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS { TargetProcessId: pid, ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE },
            },
        };
        let blob = BlobVariant { vt: 65, r1: 0, r2: 0, r3: 0, size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32, data: &params as *const _ as *const _ };
        let done = CreateEventW(None, true, false, PCWSTR::null())?;
        let handler: IActivateAudioInterfaceCompletionHandler = Activated(done).into();
        let op = match ActivateAudioInterfaceAsync(w!("VAD\\Process_Loopback"), &IAudioClient::IID, Some(&blob as *const BlobVariant as *const PROPVARIANT), &handler) {
            Ok(op) => op,
            Err(e) => {
                let _ = CloseHandle(done);
                return Err(e);
            }
        };
        let waited = WaitForSingleObject(done, 5_000);
        let _ = CloseHandle(done);
        if waited != WAIT_OBJECT_0 {
            return Err(E_FAIL.into());
        }
        let mut hr = HRESULT(0);
        let mut unk: Option<IUnknown> = None;
        op.GetActivateResult(&mut hr, &mut unk)?;
        hr.ok()?;
        unk.ok_or_else(|| windows::core::Error::from(E_FAIL))?.cast()
    }
}

#[implement(IMMNotificationClient)]
struct Watcher(Sender<Msg>);

impl IMMNotificationClient_Impl for Watcher_Impl {
    fn OnDeviceStateChanged(&self, _id: &PCWSTR, _state: DEVICE_STATE) -> WinResult<()> {
        Ok(())
    }
    fn OnDeviceAdded(&self, _id: &PCWSTR) -> WinResult<()> {
        Ok(())
    }
    fn OnDeviceRemoved(&self, _id: &PCWSTR) -> WinResult<()> {
        Ok(())
    }
    /// 기본 장치가 바뀌면 그 트랙을 다시 연다 (헤드셋을 꽂았다·뺐다)
    fn OnDefaultDeviceChanged(&self, flow: EDataFlow, role: ERole, _id: &PCWSTR) -> WinResult<()> {
        if role == eConsole {
            let track = if flow == eRender { Track::System } else { Track::Mic };
            let _ = self.0.send(Msg::Restart(track, "기본 장치가 바뀌었습니다"));
        }
        Ok(())
    }
    fn OnPropertyValueChanged(&self, _id: &PCWSTR, _key: &PROPERTYKEY) -> WinResult<()> {
        Ok(())
    }
}

/// 장치 알림. 들고 있는 동안 받는다
pub struct Watch {
    e: IMMDeviceEnumerator,
    client: IMMNotificationClient,
}

pub fn watch(tx: Sender<Msg>) -> Option<Watch> {
    let e = enumerator().ok()?;
    let client: IMMNotificationClient = Watcher(tx).into();
    unsafe { e.RegisterEndpointNotificationCallback(&client).ok()? };
    Some(Watch { e, client })
}

impl Drop for Watch {
    fn drop(&mut self) {
        unsafe {
            let _ = self.e.UnregisterEndpointNotificationCallback(&self.client);
        }
    }
}

/// recorder.rs가 쓰는 장치 열기
pub fn opener() -> Opener {
    let clock = Clock::new();
    Box::new(move |track, tx| -> Result<Box<dyn Source>, OpenError> {
        Ok(match track {
            Track::Mic => Box::new(start_mic(tx)?),
            Track::System => Box::new(start_system(tx, clock)?),
        })
    })
}

/// 마이크를 열 수 있는가: "granted" | "denied" | "none"(장치 없음). Windows는 묻는 창이 없다(개인정보 설정에서 켜고 끈다)
pub fn mic_permission() -> &'static str {
    com();
    let (tx, _rx) = channel();
    match start_mic(tx) {
        Ok(mut s) => {
            s.stop();
            "granted"
        }
        Err(OpenError::Denied) => "denied",
        Err(OpenError::Failed(_)) => "none",
    }
}

/// `check`의 시스템 오디오: 1초 동안 0이 아닌 표본이 오면 ok, 0만이면 zero(재생 중인 소리가 없을 수 있다), 못 열면 error
pub fn system_check() -> &'static str {
    com();
    let (tx, rx) = channel();
    let Ok(mut s) = start_system(tx, Clock::new()) else { return "error" };
    std::thread::sleep(Duration::from_secs(1));
    s.stop();
    if rx.try_iter().any(|m| matches!(m, Msg::Samples(_, v) if v.iter().any(|&x| x != 0))) {
        "ok"
    } else {
        "zero"
    }
}
