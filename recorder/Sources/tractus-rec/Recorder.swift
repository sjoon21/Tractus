import Foundation
import RecorderKit

enum Track: String {
    case mic, system
}

/// 녹음 한 번의 상태. 모든 상태 변경은 직렬 큐 `q`에서만 한다(오디오 콜백·stdin·시그널·타이머 모두 여기로 모인다).
final class Recorder {
    let q = DispatchQueue(label: "tractus.rec")
    let dir: URL
    let fake: Bool
    private var echoCancel: Bool  // 요청값. 마이크에서 켜지 못하면 false로 바뀐다

    private var t0 = ProcessInfo.processInfo.systemUptime
    private var info: RecordingInfo?
    private var writers: [Track: WavWriter] = [:]
    private var meters: [Track: LevelMeter] = [:]
    private var zero = ZeroDetector()
    private var flushSources: [() -> Void] = []  // fake 모드용
    private var sources: [Track: AudioSource] = [:]
    private var lastSampleAt: [Track: Double] = [:]
    private var realign: Set<Track> = []  // 재시작 뒤 첫 버퍼에서 끊긴 만큼 0으로 메울 트랙
    private var failing: Set<Track> = []  // 재시작 실패 경고를 한 번만 내기 위해
    private var timers: [DispatchSourceTimer] = []
    private var stopping = false
    private var pendingRestart: [Track: DispatchWorkItem] = [:]  // restartSoon이 미뤄 둔 재연결
    private var pausedSince: Double?  // 일시정지 시작 시 systemUptime. nil이면 녹음 중
    private var pausedTotal = 0.0  // 끝난 일시정지의 벽시계 합(초)
    private var pauseWallStart = Date()
    private var pauseAt = 0.0  // 진행 중인 일시정지의 오디오 시각

    init(dir: URL, fake: Bool, echoCancel: Bool) { self.dir = dir; self.fake = fake; self.echoCancel = echoCancel }

    /// 오디오 시계. 일시정지 시간을 뺀다(일시정지 중에는 멈춰 있다). 시각·길이·마커는 모두 이 값을 쓴다.
    private var elapsed: Double { (pausedSince ?? ProcessInfo.processInfo.systemUptime) - t0 - pausedTotal }

    /// 메인 스레드에서 한 번 부른다. 실패한 트랙은 경고 후 빼고, 남은 트랙이 없으면 종료 코드 1.
    func start(_ requested: [Track]) {
        q.sync {
            do {
                try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
                // 이전 녹음을 덮어써 잃지 않도록 기존 파일이 있으면 시작하지 않는다.
                for name in requested.map(\.file) + ["recording.json"] where FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path) {
                    throw WavError.io("이미 녹음 파일이 있습니다: \(dir.appendingPathComponent(name).path)")
                }
            } catch {
                fatal("\(error)")
            }

            let startedAt = Date()
            t0 = ProcessInfo.processInfo.systemUptime
            var active: [Track] = []
            var failed: [(Track, Error)] = []
            for track in requested {
                do {
                    writers[track] = try WavWriter(url: dir.appendingPathComponent(track.file))
                    meters[track] = LevelMeter()
                    try startSource(track)
                    active.append(track)
                } catch {
                    failed.append((track, error))
                }
            }
            for (track, error) in failed {
                // 화상회의 앱이 마이크를 잡는 중이면 시작에 실패할 수 있다. 다른 트랙이 돌면 마이크를 빼지 않고 watchdog이 2초마다 다시 연다.
                // 열리면 첫 버퍼 앞을 0으로 메워(WavWriter.append) 두 트랙 시각이 맞는다. 시스템 오디오 실패는 대개 권한·OS 문제라 다시 열지 않는다.
                if track == .mic, !active.isEmpty, sources[.mic] != nil {
                    active.insert(.mic, at: 0)  // 요청 순서(마이크가 먼저) 그대로
                    failing.insert(.mic)  // restart가 같은 경고를 또 내지 않게
                    warning("mic_failed", "마이크 녹음을 시작하지 못했습니다. 계속 다시 연결을 시도합니다: \(error)")
                    continue
                }
                sources.removeValue(forKey: track)?.stop()
                writers[track] = nil
                meters[track] = nil
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(track.file))
                warning("\(track.rawValue)_failed", "\(track == .mic ? "마이크" : "시스템 오디오") 녹음을 시작하지 못했습니다: \(error)")
            }
            guard !active.isEmpty else { fatal("녹음할 수 있는 트랙이 없습니다") }
            if !active.contains(.mic) { echoCancel = false }

            info = RecordingInfo(startedAt: isoLocal(startedAt), tracks: Dictionary(uniqueKeysWithValues: active.map { ($0.rawValue, $0.file) }), echoCancel: echoCancel)
            saveInfo()
            emit(["event": "started", "dir": dir.path, "tracks": active.map(\.rawValue), "sample_rate": WavWriter.sampleRate, "started_at": info!.startedAt, "echo_cancel": echoCancel])
            every(0.25) { [unowned self] in emitLevel() }
        }
    }

    private func startSource(_ track: Track) throws {
        if fake, track == .mic, let until = ProcessInfo.processInfo.environment["TRACTUS_REC_TEST_MIC_FAIL_UNTIL"].flatMap(Double.init) {
            try register(.mic, FlakyFakeMic(until: until, queue: q) { [unowned self] in elapsed })
            return
        }
        if fake {
            let source = FakeSource(frequency: track == .mic ? 440 : 660, gaps: track == .system)
            // 만든 시각과 쓰는 시각을 한 번 읽은 값으로 맞춘다: 둘 사이에 스레드가 밀리면 첫 버퍼 앞이 그만큼 0으로 메워져 트랙이 길어진다
            let tick = { [unowned self] in let now = elapsed; write(track, source.generate(upTo: now), at: now) }
            every(0.02, tick)
            flushSources.append(tick)
            return
        }
        let onChange = { [unowned self] in q.async { self.restartSoon(track) } }
        try register(track, track == .mic ? MicSource(echoCancel: echoCancel, onChange: onChange) : SystemTap(onChange: onChange))
    }

    /// 열기에 실패해도 `sources`에 남긴다: 다시 열지는 start가 정한다.
    private func register(_ track: Track, _ source: AudioSource) throws {
        sources[track] = source
        lastSampleAt[track] = elapsed
        try source.start(sink(track))
        syncEchoCancel(source)
    }

    /// 에코 제거를 켜지 못했으면 MicSource가 echo_cancel_failed 경고를 내고 끈다. 녹음 중에 꺼졌으면 recording.json도 false로 고친다.
    private func syncEchoCancel(_ source: AudioSource) {
        guard echoCancel, let mic = source as? MicSource, !mic.echoCancel else { return }
        echoCancel = false
        if info != nil {
            info!.echoCancel = false
            saveInfo()
        }
    }

    private func sink(_ track: Track) -> SampleSink {
        { [unowned self] samples in q.async { self.ingest(track, samples) } }
    }

    /// 장치·속도 알림은 한 번 바뀔 때 여러 개가 몰려 온다: 마지막 알림 0.3초 뒤에 한 번만 다시 연다(장치가 자리 잡은 뒤). q에서 부른다.
    private func restartSoon(_ track: Track) {
        pendingRestart[track]?.cancel()
        let work = DispatchWorkItem { [unowned self] in
            pendingRestart[track] = nil
            restart(track, "장치가 바뀌었습니다")
        }
        pendingRestart[track] = work
        q.asyncAfter(deadline: .now() + 0.3, execute: work)
    }

    /// 장치 전환이나 끊김 뒤에 소스를 다시 연다. 끊긴 구간은 다음 첫 버퍼에서 0으로 메워 두 트랙 시각을 맞춘다.
    private func restart(_ track: Track, _ reason: String) {
        guard !stopping, let source = sources[track] else { return }
        let name = track == .mic ? "마이크" : "시스템 오디오"
        source.stop()
        if pausedSince == nil { realign.insert(track) }  // 일시정지 중에는 메울 끊김이 없다
        lastSampleAt[track] = elapsed  // 실패해도 stallSeconds 뒤에 다시 시도한다
        do {
            defer { syncEchoCancel(source) }
            try source.start(sink(track))
            failing.remove(track)
            warning("\(track.rawValue)_restarted", "\(name) 입력을 다시 연결했습니다 (\(reason))")
        } catch {
            log("\(name) 재연결 실패: \(error)")
            if failing.insert(track).inserted {
                warning("\(track.rawValue)_failed", "\(name) 입력이 끊겼고 다시 연결하지 못했습니다. 계속 재시도합니다: \(error)")
            }
        }
    }

    /// 표본이 `stallSeconds` 넘게 안 오면 끊긴 것으로 보고 다시 연다(tap은 재생이 없어도 0을 계속 보내므로 무음과 구분된다).
    private static let stallSeconds = 2.0

    private func watchdog() {
        for track in sources.keys where elapsed - (lastSampleAt[track] ?? 0) > Self.stallSeconds {
            restart(track, "입력이 \(Int(Self.stallSeconds))초 넘게 끊겼습니다")
        }
    }

    private func ingest(_ track: Track, _ samples: [Int16]) {
        guard !stopping else { return }
        write(track, samples, at: elapsed)
    }

    /// `now`: 이 버퍼의 마지막 표본의 오디오 시각.
    private func write(_ track: Track, _ samples: [Int16], at now: Double) {
        // 일시정지 중에는 두 트랙 모두 표본을 버린다(캡처 엔진은 계속 돈다). 타임라인에는 무음도 남기지 않는다.
        guard pausedSince == nil, let writer = writers[track], !samples.isEmpty else { return }
        do {
            // 첫 버퍼가 늦게 오거나 중간에 끊긴 만큼 0으로 채워 두 트랙의 시각을 맞춘다.
            // ponytail: 끊김만 맞춘다. 장치 간 클록 드리프트는 보정하지 않는다(1시간에 수십 ms 수준).
            try writer.append(samples, endingAt: Int(now * Double(WavWriter.sampleRate)), realign: realign.remove(track) != nil)
        } catch {
            stop(error: "\(error)")
            return
        }
        lastSampleAt[track] = now
        meters[track]?.add(samples)
        if track == .system, zero.feed(samples) {
            warning("system_zero", "시스템 오디오가 5초 동안 정확히 0입니다. 시스템 설정 > 개인정보 보호 > 화면 및 시스템 오디오 녹음 권한을 확인하세요")
        }
    }

    private func emitLevel() {
        guard pausedSince == nil else { return }  // 일시정지 중에는 level 이벤트를 내지 않는다
        watchdog()
        emit(["event": "level", "t": round2(elapsed), "mic": meters[.mic]?.take() ?? NSNull(), "system": meters[.system]?.take() ?? NSNull()])
    }

    func handle(_ line: String) {
        guard let command = Command.parse(line) else {
            log("알 수 없는 명령: \(line)")
            return
        }
        switch command {
        case .stop: stop()
        case .pause: pause()
        case .resume: resume()
        case .bookmark: addMark(Mark(t: round2(elapsed), kind: "bookmark", text: nil))
        case let .memo(text): addMark(Mark(t: round2(elapsed), kind: "memo", text: text))
        case let .editMark(i, text): changeMarks { marks in
            guard marks.indices.contains(i), marks[i].kind == "memo" else { return false }  // 북마크는 글이 없다: 지우기만
            marks[i] = Mark(t: marks[i].t, kind: "memo", text: text)
            return true
        }
        case let .deleteMark(i): changeMarks { marks in
            guard marks.indices.contains(i) else { return false }
            marks.remove(at: i)
            return true
        }
        }
    }

    /// 이미 일시정지 중이면 무시한다(이벤트도 없다).
    private func pause() {
        guard !stopping, info != nil, pausedSince == nil else { return }
        flushSources.forEach { $0() }  // fake 모드: 일시정지 시각까지 쓴다
        for writer in writers.values {
            do { try writer.updateHeader() } catch { log("\(error)") }  // 일시정지 중 강제 종료돼도 여기까지는 재생된다
        }
        for track in meters.keys { _ = meters[track]?.take() }
        let at = elapsed
        pausedSince = ProcessInfo.processInfo.systemUptime
        pauseWallStart = Date()
        pauseAt = at
        emit(["event": "paused", "elapsed": round2(at)])
    }

    /// 일시정지 중이 아니면 무시한다(이벤트도 없다). 쓰지 않은 구간은 0으로 메우지 않고 오디오 시계를 이어 붙인다.
    private func resume() {
        guard !stopping, let since = pausedSince else { return }
        endPause(since: since)
        emit(["event": "resumed", "elapsed": round2(pauseAt)])  // 멈춘 시계 그대로: 지금 시계를 다시 읽으면 ms 단위로 어긋나 paused와 다른 값이 나온다
    }

    /// 진행 중인 일시정지를 닫고 recording.json에 기록한다(계속·종료 공용).
    private func endPause(since: Double) {
        pausedTotal += ProcessInfo.processInfo.systemUptime - since
        pausedSince = nil
        info?.pauses.append(Pause(at: round2(pauseAt), wallStart: isoLocal(pauseWallStart), wallEnd: isoLocal(Date())))
        saveInfo()
    }

    private func addMark(_ mark: Mark) {
        guard !stopping, info != nil else { return }
        info!.marks.append(mark)
        saveInfo()
        emit(["event": "mark"].merging(mark.json) { a, _ in a })
    }

    /// 남긴 메모를 고치거나 지운다. 바뀌면 recording.json에 쓰고 전체 목록을 `marks` 이벤트로 알린다 (앱이 번호를 다시 맞춘다).
    /// 없는 번호·북마크 고치기는 무시하되 지금 목록을 다시 보내 앱이 어긋난 화면을 바로잡게 한다.
    private func changeMarks(_ change: (inout [Mark]) -> Bool) {
        guard !stopping, info != nil else { return }
        if change(&info!.marks) { saveInfo() } else { log("메모를 바꾸지 않았습니다: 없는 번호이거나 북마크입니다") }
        emit(["event": "marks", "marks": info!.marks.map(\.json)])
    }

    /// stop 명령, SIGINT/SIGTERM, stdin EOF, 쓰기 실패가 모두 여기로 온다. 파일을 닫고 프로세스를 끝낸다.
    func stop(error: String? = nil) {
        guard !stopping else { return }
        stopping = true
        flushSources.forEach { $0() }  // fake 모드는 여기서 마지막 표본까지 쓴다
        if let since = pausedSince { endPause(since: since) }  // 일시정지 중 종료: 오디오 시계는 그대로(duration에 일시정지가 안 들어간다)
        sources.values.forEach { $0.stop() }
        timers.forEach { $0.cancel() }
        let end = elapsed
        for writer in writers.values {
            do {
                // 아직 오는 중이던 마지막 버퍼(기기가 느리면 0.1초 넘게 늦는다)는 버려지므로 끝을 0으로 메워 WAV 길이 = duration을 지킨다.
                // 한 번도 열리지 않은 트랙(빈 WAV)은 그대로 둔다.
                if writer.frames > 0 { try writer.append([], endingAt: Int(end * Double(WavWriter.sampleRate)), realign: true) }
                try writer.close()
            } catch { log("\(error)") }
        }
        info?.duration = round2(end)
        saveInfo()
        if let error { fatal(error) }
        emit(["event": "stopped", "dir": dir.path, "duration": info?.duration ?? 0])
        exit(0)
    }

    private func saveInfo() {
        do { try info?.write(to: dir.appendingPathComponent("recording.json")) } catch { log("recording.json 저장 실패: \(error)") }
    }

    private func every(_ interval: Double, _ handler: @escaping () -> Void) {
        let timer = DispatchSource.makeTimerSource(queue: q)
        timer.schedule(deadline: .now() + interval, repeating: interval)
        timer.setEventHandler(handler: handler)
        timer.resume()
        timers.append(timer)
    }
}

extension Track {
    var file: String { "\(rawValue).wav" }
}

// MARK: - 출력

/// stdout에는 JSON Lines 이벤트만 쓴다. FileHandle은 EPIPE에서 예외로 죽으므로 write(2)를 쓴다.
func emit(_ object: [String: Any]) {
    guard var data = try? jsonData(object) else {
        log("이벤트 직렬화 실패: \(object)")
        return
    }
    data.append(0x0A)
    data.withUnsafeBytes { _ = write(STDOUT_FILENO, $0.baseAddress, $0.count) }
}

func warning(_ code: String, _ message: String) {
    emit(["event": "warning", "code": code, "message": message])
}

func fatal(_ message: String) -> Never {
    emit(["event": "error", "message": message])
    exit(1)
}

func log(_ message: String) {
    fputs("tractus-rec: \(message)\n", stderr)
}
