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
