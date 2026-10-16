import AVFoundation
import Foundation
import RecorderKit

// tractus-rec — 녹음 헬퍼. 계약은 docs/desktop.md §1.

let usage = """
사용법:
  tractus-rec record --out <dir> [--no-mic] [--no-system] [--echo-cancel] [--fake]
  tractus-rec check
  tractus-rec calendar access|request|list|next [--ahead 분] [--exclude 캘린더ID]…
"""

signal(SIGPIPE, SIG_IGN)  // 부모가 먼저 죽어도 파일을 닫고 끝내도록

func micAllowed() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return true
    case .notDetermined:
        // 처음이면 권한을 묻는다(앱의 하위 프로세스라면 부모 앱 이름으로 뜬다).
        let done = DispatchSemaphore(value: 0)
        var granted = false
        AVCaptureDevice.requestAccess(for: .audio) { granted = $0; done.signal() }
        done.wait()
        return granted
    default: return false
    }
}

func runRecord(_ args: [String]) -> Never {
    let options: RecordOptions
    do { options = try RecordOptions.parse(args) } catch { fatal("\(error)\n\(usage)") }
    var tracks: [Track] = (options.mic ? [.mic] : []) + (options.system ? [.system] : [])
    if tracks.contains(.mic), !options.fake, !micAllowed() {
        warning("mic_denied", "마이크 권한이 없습니다")
        tracks.removeAll { $0 == .mic }
    }

    // --fake는 AVAudioEngine을 쓰지 않으므로 --echo-cancel을 무시한다(echo_cancel: false).
    let recorder = Recorder(dir: URL(fileURLWithPath: options.out).standardizedFileURL, fake: options.fake, echoCancel: options.echoCancel && !options.fake)
    recorder.start(tracks)

    // SIGINT·SIGTERM도 stop과 같이 마무리한다.
    let signalSources = [SIGINT, SIGTERM].map { sig -> DispatchSourceSignal in
        signal(sig, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: sig, queue: recorder.q)
        source.setEventHandler { recorder.stop() }
        source.resume()
        return source
    }
    // stdin이 닫히면(부모 앱이 죽음) 고아 녹음이 남지 않게 멈춘다.
    Thread.detachNewThread {
        while let line = readLine() { recorder.q.async { recorder.handle(line) } }
        recorder.q.async { recorder.stop() }
    }
    withExtendedLifetime(signalSources) { dispatchMain() }
}

func runCheck() -> Never {
    let mic: String
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: mic = "granted"
    case .notDetermined: mic = "undetermined"
    default: mic = "denied"
    }

    // 1초 동안 tap을 열어 0이 아닌 표본이 오는지 본다. 재생 중인 소리가 없으면 zero일 수 있다(참고용).
    var system = "error"
    let lock = NSLock()
    var nonzero = false
    let tap = SystemTap()
    do {
        try tap.start { samples in
            if samples.contains(where: { $0 != 0 }) { lock.withLock { nonzero = true } }
        }
        Thread.sleep(forTimeInterval: 1)
        tap.stop()
        system = lock.withLock { nonzero } ? "ok" : "zero"
    } catch {
        log("\(error)")
    }

    let v = ProcessInfo.processInfo.operatingSystemVersion
    let macos = "\(v.majorVersion).\(v.minorVersion)" + (v.patchVersion > 0 ? ".\(v.patchVersion)" : "")
    emit(["mic": mic, "system": system, "macos": macos])
    exit(0)
}

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "record": runRecord(Array(args.dropFirst()))
case "check": runCheck()
case "calendar": runCalendar(Array(args.dropFirst()))
default:
    fputs(usage + "\n", stderr)
    exit(args.isEmpty || args.first == "--help" || args.first == "-h" ? 0 : 1)
}
