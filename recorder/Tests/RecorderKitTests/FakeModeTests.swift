import Foundation
import XCTest

/// 빌드된 tractus-rec를 --fake로 실행하는 E2E 테스트(권한 불필요).
final class FakeModeTests: XCTestCase {
    var binary: URL { Bundle(for: Self.self).bundleURL.deletingLastPathComponent().appendingPathComponent("tractus-rec") }

    struct Run { let events: [[String: Any]]; let status: Int32; let dir: URL }

    func run(_ extra: [String], _ drive: (Process, FileHandle) throws -> Void) throws -> Run {
        let dir = try tempDir().appendingPathComponent("rec")
        let p = Process()
        p.executableURL = binary
        p.arguments = ["record", "--out", dir.path, "--fake"] + extra
        let stdin = Pipe(), stdout = Pipe()
        p.standardInput = stdin
        p.standardOutput = stdout
        let exited = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in exited.signal() }
        try p.run()
        try drive(p, stdin.fileHandleForWriting)
        if exited.wait(timeout: .now() + 10) == .timedOut {
            p.interrupt(); kill(p.processIdentifier, SIGKILL)
            XCTFail("10초 안에 끝나지 않음")
        }
        let out = stdout.fileHandleForReading.readDataToEndOfFile()
        let events = String(decoding: out, as: UTF8.self).split(separator: "\n").map {
            (try? JSONSerialization.jsonObject(with: Data($0.utf8))) as? [String: Any] ?? ["invalid": String($0)]
        }
        return Run(events: events, status: p.terminationStatus, dir: dir)
    }

    func testFakeRecordingWithCommands() throws {
        let r = try run([]) { _, stdin in
            Thread.sleep(forTimeInterval: 0.8)
            stdin.write(Data("bookmark\nmemo 테스트\nunknown\n".utf8))
            Thread.sleep(forTimeInterval: 1.4)
            stdin.write(Data("stop\n".utf8))
        }
        XCTAssertEqual(r.status, 0)
        XCTAssertFalse(r.events.contains { $0["invalid"] != nil }, "stdout은 JSON Lines만")

        let started = try XCTUnwrap(r.events.first)
        XCTAssertEqual(started["event"] as? String, "started")
        XCTAssertEqual(started["tracks"] as? [String], ["mic", "system"])
        XCTAssertEqual(started["sample_rate"] as? Int, 48_000)
        XCTAssertEqual(started["dir"] as? String, r.dir.path)
        XCTAssertEqual(started["echo_cancel"] as? Bool, false)

        let levels = r.events.filter { $0["event"] as? String == "level" }
        XCTAssertGreaterThanOrEqual(levels.count, 6, "250ms마다")
        let ts = levels.compactMap { $0["t"] as? Double }
        XCTAssertEqual(ts, ts.sorted())
        // 440 Hz, 진폭 0.3 → 약 -13.5 dBFS
        for l in levels { XCTAssertEqual(l["mic"] as? Double ?? 0, -13.5, accuracy: 0.5) }
        XCTAssertTrue(levels.contains { $0["system"] as? Double == -100 }, "시스템 트랙의 무음 구간(1.0~1.5초)")
        XCTAssertTrue(levels.contains { ($0["system"] as? Double ?? -100) > -20 })
        XCTAssertFalse(r.events.contains { $0["code"] as? String == "system_zero" }, "0.5초 무음은 system_zero가 아니다")

        let marks = r.events.filter { $0["event"] as? String == "mark" }
        XCTAssertEqual(marks.map { $0["kind"] as? String }, ["bookmark", "memo"])
        XCTAssertTrue(marks[0]["text"] is NSNull)
        XCTAssertEqual(marks[1]["text"] as? String, "테스트")

        let stopped = try XCTUnwrap(r.events.last)
        XCTAssertEqual(stopped["event"] as? String, "stopped")
        let duration = try XCTUnwrap(stopped["duration"] as? Double)
        // 프로세스 기동 시간이 들쭉날쭉하므로 북마크와 stop 사이 간격(1.4초)으로 확인한다.
        XCTAssertEqual(duration - (marks[0]["t"] as? Double ?? 0), 1.4, accuracy: 0.2)

        for name in ["mic.wav", "system.wav"] {
            let h = try WavHeader(r.dir.appendingPathComponent(name))
            XCTAssertEqual(h.sampleRate, 48_000)
            XCTAssertEqual(h.channels, 1)
            XCTAssertEqual(h.bits, 16)
            XCTAssertEqual(Int(h.dataBytes), h.fileBytes - 44, "\(name) 종료 시 헤더 확정")
            XCTAssertEqual(Double(h.dataBytes) / 96_000, duration, accuracy: 0.05, name)
        }

        let info = try JSONSerialization.jsonObject(with: Data(contentsOf: r.dir.appendingPathComponent("recording.json"))) as! [String: Any]
        XCTAssertEqual(info["schema_version"] as? Int, 1)
        XCTAssertEqual(info["started_at"] as? String, started["started_at"] as? String)
        XCTAssertEqual(info["duration"] as? Double, duration)
        XCTAssertEqual(info["tracks"] as? [String: String], ["mic": "mic.wav", "system": "system.wav"])
        XCTAssertEqual(info["echo_cancel"] as? Bool, false)
        let saved = info["marks"] as! [[String: Any]]
        XCTAssertEqual(saved.count, 2)
        XCTAssertEqual(saved[1]["text"] as? String, "테스트")
    }

    func testSigtermStopsGracefully() throws {
        let r = try run(["--no-mic"]) { p, _ in
            Thread.sleep(forTimeInterval: 0.7)
            p.terminate()
        }
        XCTAssertEqual(r.status, 0)
        XCTAssertEqual(r.events.first?["tracks"] as? [String], ["system"])
        XCTAssertTrue(r.events.contains { $0["event"] as? String == "level" && $0["mic"] is NSNull }, "없는 트랙은 null")
        XCTAssertEqual(r.events.last?["event"] as? String, "stopped")
        XCTAssertFalse(FileManager.default.fileExists(atPath: r.dir.appendingPathComponent("mic.wav").path))
        let h = try WavHeader(r.dir.appendingPathComponent("system.wav"))
        XCTAssertEqual(Int(h.dataBytes), h.fileBytes - 44)
        let info = try JSONSerialization.jsonObject(with: Data(contentsOf: r.dir.appendingPathComponent("recording.json"))) as! [String: Any]
        XCTAssertEqual(info["tracks"] as? [String: String], ["system": "system.wav"])
        XCTAssertNotNil(info["duration"] as? Double)
    }

    /// --fake는 AVAudioEngine을 쓰지 않으므로 --echo-cancel을 받아도 경고 없이 echo_cancel false로 녹음한다.
    func testFakeIgnoresEchoCancel() throws {
        let r = try run(["--echo-cancel"]) { _, stdin in
            Thread.sleep(forTimeInterval: 0.6)
            stdin.write(Data("stop\n".utf8))
        }
        XCTAssertEqual(r.status, 0)
        let started = try XCTUnwrap(r.events.first)
        XCTAssertEqual(started["event"] as? String, "started")
        XCTAssertEqual(started["echo_cancel"] as? Bool, false)
        XCTAssertFalse(r.events.contains { $0["event"] as? String == "warning" })
        XCTAssertEqual(r.events.last?["event"] as? String, "stopped")
        let info = try JSONSerialization.jsonObject(with: Data(contentsOf: r.dir.appendingPathComponent("recording.json"))) as! [String: Any]
        XCTAssertEqual(info["echo_cancel"] as? Bool, false)
    }

    /// 부모 앱이 죽어 stdin이 닫히면 stop과 같이 마무리한다.
    func testStdinEOFStopsGracefully() throws {
        let r = try run([]) { _, stdin in
            Thread.sleep(forTimeInterval: 0.6)
            try stdin.close()
        }
        XCTAssertEqual(r.status, 0)
        XCTAssertEqual(r.events.last?["event"] as? String, "stopped")
        let h = try WavHeader(r.dir.appendingPathComponent("mic.wav"))
        XCTAssertEqual(Int(h.dataBytes), h.fileBytes - 44)
    }

    // MARK: - 일시정지

    func events(_ r: Run, _ name: String) -> [[String: Any]] { r.events.filter { $0["event"] as? String == name } }

    func info(_ r: Run) throws -> [String: Any] {
        try JSONSerialization.jsonObject(with: Data(contentsOf: r.dir.appendingPathComponent("recording.json"))) as! [String: Any]
    }

    func seconds(_ name: String, in r: Run) throws -> Double {
        let h = try WavHeader(r.dir.appendingPathComponent(name))
        XCTAssertEqual(Int(h.dataBytes), h.fileBytes - 44, "\(name) 종료 시 헤더 확정")
        return Double(h.dataBytes) / 96_000
    }

    /// 마이크(440 Hz 사인파)에 0이 길게 이어지는 구간이 없어야 한다(일시정지를 0으로 메우지 않음).
    func longestZeroRun(_ url: URL) throws -> Int {
        let d = try Data(contentsOf: url).dropFirst(44)
        var longest = 0, run = 0
        d.withUnsafeBytes { raw in
            for s in raw.bindMemory(to: Int16.self) {
                run = s == 0 ? run + 1 : 0
                longest = max(longest, run)
            }
        }
        return longest
    }

    func testPauseExcludesPausedTimeFromTimeline() throws {
        let r = try run([]) { _, stdin in
            Thread.sleep(forTimeInterval: 0.7)
            stdin.write(Data("pause\n".utf8))
            Thread.sleep(forTimeInterval: 0.3)
            stdin.write(Data("bookmark\nmemo 정지 중 메모\n".utf8))  // 일시정지 중에도 받고, 멈춘 오디오 시각을 찍는다
            Thread.sleep(forTimeInterval: 1.2)
            stdin.write(Data("resume\n".utf8))
            Thread.sleep(forTimeInterval: 0.7)
            stdin.write(Data("stop\n".utf8))
        }
        XCTAssertEqual(r.status, 0)
        XCTAssertFalse(r.events.contains { $0["invalid"] != nil })

        let paused = try XCTUnwrap(events(r, "paused").first)
        let resumed = try XCTUnwrap(events(r, "resumed").first)
        XCTAssertEqual(events(r, "paused").count, 1)
        XCTAssertEqual(events(r, "resumed").count, 1)
        let p = try XCTUnwrap(paused["elapsed"] as? Double)
        XCTAssertEqual(resumed["elapsed"] as? Double ?? -1, p, accuracy: 0.03, "계속 시각 = 멈춘 오디오 시각")

        // paused ~ resumed 사이에는 level 이벤트가 없고, 그 뒤 t는 멈춘 시각에서 이어진다.
        let pi = try XCTUnwrap(r.events.firstIndex { $0["event"] as? String == "paused" })
        let ri = try XCTUnwrap(r.events.firstIndex { $0["event"] as? String == "resumed" })
        XCTAssertFalse(r.events[pi..<ri].contains { $0["event"] as? String == "level" }, "일시정지 중 level 없음")
        let after = r.events[ri...].filter { $0["event"] as? String == "level" }.compactMap { $0["t"] as? Double }
        XCTAssertFalse(after.isEmpty)
        XCTAssertGreaterThanOrEqual(after.first!, p - 0.01)
        XCTAssertLessThan(after.first!, p + 0.5, "벽시계(1.2초 점프)가 아니라 오디오 시계")

        // 일시정지 중 북마크·메모는 멈춘 오디오 시각에 찍힌다.
        let marks = events(r, "mark")
        XCTAssertEqual(marks.map { $0["kind"] as? String }, ["bookmark", "memo"])
        for m in marks { XCTAssertEqual(m["t"] as? Double ?? -1, p, accuracy: 0.011) }

        let stopped = try XCTUnwrap(r.events.last)
        let duration = try XCTUnwrap(stopped["duration"] as? Double)
        XCTAssertEqual(duration, p + 0.7, accuracy: 0.25, "duration은 일시정지(1.5초)를 뺀 오디오 시계")
        XCTAssertLessThan(duration, p + 1.2, "일시정지 시간이 들어가지 않는다")

        // 두 트랙 모두 같은 길이(= duration)이고 일시정지를 0으로 메우지 않았다.
        let mic = try seconds("mic.wav", in: r), system = try seconds("system.wav", in: r)
        XCTAssertEqual(mic, duration, accuracy: 0.05)
        XCTAssertEqual(system, duration, accuracy: 0.05)
        XCTAssertEqual(mic, system, accuracy: 0.03, "트랙 정렬")
        XCTAssertLessThan(try longestZeroRun(r.dir.appendingPathComponent("mic.wav")), 100)

        let json = try info(r)
        XCTAssertEqual(json["duration"] as? Double, duration)
        let pauses = try XCTUnwrap(json["pauses"] as? [[String: Any]])
        XCTAssertEqual(pauses.count, 1)
        XCTAssertEqual(pauses[0]["at"] as? Double ?? -1, p, accuracy: 0.011)
        let f = ISO8601DateFormatter()
        let start = try XCTUnwrap(f.date(from: pauses[0]["wall_start"] as? String ?? ""))
        let end = try XCTUnwrap(f.date(from: pauses[0]["wall_end"] as? String ?? ""))
        XCTAssertEqual(end.timeIntervalSince(start), 1.5, accuracy: 0.9, "ISO는 초 단위라 오차를 넉넉히")
        let saved = json["marks"] as! [[String: Any]]
        XCTAssertEqual(saved.count, 2)
    }

    func testRedundantPauseAndResumeAreIgnored() throws {
        let r = try run(["--no-system"]) { _, stdin in
            Thread.sleep(forTimeInterval: 0.4)
            stdin.write(Data("resume\n".utf8))  // 일시정지 중이 아님
            Thread.sleep(forTimeInterval: 0.2)
            stdin.write(Data("pause\n".utf8))
            Thread.sleep(forTimeInterval: 0.2)
            stdin.write(Data("pause\n".utf8))  // 이미 일시정지
            Thread.sleep(forTimeInterval: 0.3)
            stdin.write(Data("resume\nresume\n".utf8))
            Thread.sleep(forTimeInterval: 0.3)
            stdin.write(Data("stop\n".utf8))
        }
        XCTAssertEqual(r.status, 0)
        XCTAssertEqual(events(r, "paused").count, 1)
        XCTAssertEqual(events(r, "resumed").count, 1)
        XCTAssertFalse(r.events.contains { $0["event"] as? String == "warning" || $0["event"] as? String == "error" })
        XCTAssertEqual(((try info(r))["pauses"] as? [[String: Any]])?.count, 1)
    }

    func testStopWhilePausedFlushesAndClosesPause() throws {
        let r = try run(["--no-system"]) { _, stdin in
            Thread.sleep(forTimeInterval: 0.7)
            stdin.write(Data("pause\n".utf8))
            Thread.sleep(forTimeInterval: 0.6)
            stdin.write(Data("stop\n".utf8))
        }
        XCTAssertEqual(r.status, 0)
        let p = try XCTUnwrap(events(r, "paused").first?["elapsed"] as? Double)
        XCTAssertTrue(events(r, "resumed").isEmpty)
        let stopped = try XCTUnwrap(r.events.last)
        XCTAssertEqual(stopped["event"] as? String, "stopped")
        XCTAssertEqual(stopped["duration"] as? Double ?? -1, p, accuracy: 0.03, "duration에 일시정지가 들어가지 않는다")
        XCTAssertEqual(try seconds("mic.wav", in: r), p, accuracy: 0.05)
        let json = try info(r)
        XCTAssertEqual(json["duration"] as? Double, stopped["duration"] as? Double)
        XCTAssertEqual((json["pauses"] as? [[String: Any]])?.count, 1, "열린 일시정지는 종료 때 닫는다")
    }

    func testSigtermWhilePausedFlushes() throws {
        let r = try run(["--no-system"]) { p, stdin in
            Thread.sleep(forTimeInterval: 0.7)
            stdin.write(Data("pause\n".utf8))
            Thread.sleep(forTimeInterval: 0.5)
            p.terminate()
        }
        XCTAssertEqual(r.status, 0)
        XCTAssertEqual(r.events.last?["event"] as? String, "stopped")
        let duration = try XCTUnwrap(r.events.last?["duration"] as? Double)
        XCTAssertEqual(try seconds("mic.wav", in: r), duration, accuracy: 0.05)
        XCTAssertEqual(((try info(r))["pauses"] as? [[String: Any]])?.count, 1)
    }

    /// 첫 표본이 오기 전(녹음 시작 직후)에 일시정지해도 타임라인이 맞는다.
    func testPauseRightAfterStart() throws {
        let r = try run(["--no-system"]) { _, stdin in
            stdin.write(Data("pause\n".utf8))
            Thread.sleep(forTimeInterval: 0.8)
            stdin.write(Data("resume\n".utf8))
            Thread.sleep(forTimeInterval: 0.7)
            stdin.write(Data("stop\n".utf8))
        }
        XCTAssertEqual(r.status, 0)
        let p = try XCTUnwrap(events(r, "paused").first?["elapsed"] as? Double)
        XCTAssertLessThan(p, 0.3)
        let duration = try XCTUnwrap(r.events.last?["duration"] as? Double)
        XCTAssertEqual(duration, p + 0.7, accuracy: 0.25)
        XCTAssertEqual(try seconds("mic.wav", in: r), duration, accuracy: 0.05)
        XCTAssertLessThan(try longestZeroRun(r.dir.appendingPathComponent("mic.wav")), 100)
    }

    func testRecordingJsonHasEmptyPausesWhenNeverPaused() throws {
        let r = try run(["--no-system"]) { _, stdin in
            Thread.sleep(forTimeInterval: 0.4)
            stdin.write(Data("stop\n".utf8))
        }
        XCTAssertEqual(((try info(r))["pauses"] as? [Any])?.count, 0)
    }

    func testRefusesToOverwrite() throws {
        let dir = try tempDir()
        try Data().write(to: dir.appendingPathComponent("recording.json"))
        let p = Process()
        p.executableURL = binary
        p.arguments = ["record", "--out", dir.path, "--fake"]
        let out = Pipe()
        p.standardOutput = out
        try p.run()
        p.waitUntilExit()
        XCTAssertEqual(p.terminationStatus, 1)
        let line = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        XCTAssertTrue(line.contains(#""event":"error""#), line)
    }
}
