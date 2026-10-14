import Foundation
@testable import RecorderKit
import XCTest

/// WAV 헤더를 읽어 테스트에서 확인한다.
struct WavHeader {
    let riffBytes: UInt32, channels: UInt16, sampleRate: UInt32, bits: UInt16, dataBytes: UInt32, fileBytes: Int

    init(_ url: URL) throws {
        let d = try Data(contentsOf: url)
        func u32(_ o: Int) -> UInt32 { d[o..<o + 4].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) } }
        func u16(_ o: Int) -> UInt16 { d[o..<o + 2].withUnsafeBytes { $0.loadUnaligned(as: UInt16.self) } }
        XCTAssertEqual(String(decoding: d[0..<4], as: UTF8.self), "RIFF")
        XCTAssertEqual(String(decoding: d[8..<16], as: UTF8.self), "WAVEfmt ")
        XCTAssertEqual(String(decoding: d[36..<40], as: UTF8.self), "data")
        XCTAssertEqual(u16(20), 1, "PCM")
        riffBytes = u32(4); channels = u16(22); sampleRate = u32(24); bits = u16(34); dataBytes = u32(40); fileBytes = d.count
    }
}

func tempDir() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tractus-rec-test-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

final class WavWriterTests: XCTestCase {
    func testHeaderAfterWritesAndClose() throws {
        let url = try tempDir().appendingPathComponent("a.wav")
        let w = try WavWriter(url: url)
        for _ in 0..<7 { try w.append([Int16](repeating: 100, count: 1000)) }
        try w.close()
        let h = try WavHeader(url)
        XCTAssertEqual(h.channels, 1)
        XCTAssertEqual(h.sampleRate, 48_000)
        XCTAssertEqual(h.bits, 16)
        XCTAssertEqual(h.dataBytes, 14_000)
        XCTAssertEqual(h.riffBytes, 36 + 14_000)
        XCTAssertEqual(h.fileBytes, 44 + 14_000)
    }

    /// close 없이 끝난(강제 종료) 파일도 마지막 헤더 갱신 시점까지는 올바른 WAV다.
    func testHeaderAfterSimulatedCrash() throws {
        let url = try tempDir().appendingPathComponent("b.wav")
        let w = try WavWriter(url: url)
        try w.append([Int16](repeating: 1, count: 10_000))  // 갱신 전 (< 0.25초)
        XCTAssertEqual(try WavHeader(url).dataBytes, 0)
        try w.append([Int16](repeating: 1, count: 5_000))   // 누적 15,000 ≥ 12,000 → 갱신
        try w.append([Int16](repeating: 1, count: 1_000))   // 갱신 안 됨
        let h = try WavHeader(url)  // close 하지 않음
        XCTAssertEqual(h.dataBytes, 30_000)
        XCTAssertEqual(h.riffBytes, 36 + 30_000)
        XCTAssertEqual(h.fileBytes, 44 + 32_000)
        XCTAssertLessThanOrEqual(Int(h.dataBytes), h.fileBytes - 44)
        XCTAssertLessThan(h.fileBytes - 44 - Int(h.dataBytes), WavWriter.headerInterval * 2, "헤더는 최대 0.25초만 뒤처진다")
    }

    func testAlignmentPadsOnlyLargeGaps() throws {
        let w = try WavWriter(url: try tempDir().appendingPathComponent("c.wav"))
        try w.append([Int16](repeating: 1, count: 100), endingAt: 1_100)
        XCTAssertEqual(w.frames, 1_100, "첫 버퍼는 늦은 만큼 앞을 메운다")
        try w.append([Int16](repeating: 1, count: 100), endingAt: 1_200 + WavWriter.maxLag)
        XCTAssertEqual(w.frames, 1_200, "maxLag 이하의 지연은 메우지 않는다")
        let end = 1_300 + WavWriter.maxLag + 2 * WavWriter.sampleRate
        try w.append([Int16](repeating: 1, count: 100), endingAt: end)
        XCTAssertEqual(w.frames, end, "끊긴 구간은 0으로 메워 시각을 맞춘다")
        try w.append([Int16](repeating: 1, count: 100), endingAt: 0)
        XCTAssertEqual(w.frames, end + 100, "앞서 있으면 그대로 붙인다")
        try w.append([Int16](repeating: 1, count: 100), endingAt: end + 300, realign: true)
        XCTAssertEqual(w.frames, end + 300, "재시작 직후에는 작은 끊김도 메운다")
    }

    func testSizeLimitThrowsInsteadOfOverflow() throws {
        let url = try tempDir().appendingPathComponent("d.wav")
        let w = try WavWriter(url: url)
        w.maxFrames = 1_000
        try w.append([Int16](repeating: 1, count: 1_000))
        XCTAssertThrowsError(try w.append([1]))
        try w.close()
        XCTAssertEqual(try WavHeader(url).dataBytes, 2_000, "상한 전까지는 온전한 WAV")
    }
}

final class LevelTests: XCTestCase {
    func testDbfs() {
        var m = LevelMeter()
        m.add([Int16](repeating: 32767, count: 480))
        XCTAssertEqual(m.take(), 0, accuracy: 0.05)
        // 진폭 0.5 사인파: 20·log10(0.5/√2) ≈ -9.0 dBFS
        m.add((0..<4800).map { Int16(16384 * sin(2 * .pi * 440 * Double($0) / 48_000)) })
        XCTAssertEqual(m.take(), -9.0, accuracy: 0.1)
        XCTAssertEqual(m.take(), LevelMeter.floor, "표본이 없으면 floor")
        m.add([0, 0, 0])
        XCTAssertEqual(m.take(), LevelMeter.floor, "정확히 0이면 floor")
        m.add([1, -1])
        XCTAssertGreaterThan(m.take(), LevelMeter.floor, "아주 작은 소리는 0과 구분")
    }

    func testZeroDetector() {
        var z = ZeroDetector(threshold: 10)
        XCTAssertFalse(z.feed([Int16](repeating: 0, count: 6)))
        XCTAssertTrue(z.feed([Int16](repeating: 0, count: 4)))
        XCTAssertFalse(z.feed([Int16](repeating: 0, count: 100)), "한 번만 알린다")
        var quiet = ZeroDetector(threshold: 10)
        XCTAssertFalse(quiet.feed([0, 0, 0, 1]))
        for _ in 0..<20 { XCTAssertFalse(quiet.feed([Int16](repeating: 0, count: 100)), "신호를 한 번 본 뒤의 무음은 권한 문제가 아니다") }
    }
}

final class CommandTests: XCTestCase {
    func testParse() {
        XCTAssertEqual(Command.parse("bookmark"), .bookmark)
        XCTAssertEqual(Command.parse("  stop \n"), .stop)
        XCTAssertEqual(Command.parse("memo 예산 다시 확인"), .memo("예산 다시 확인"))
        XCTAssertEqual(Command.parse("memo   a b  "), .memo("a b"))
        XCTAssertNil(Command.parse("memo "))
        XCTAssertNil(Command.parse("memo"))
        XCTAssertNil(Command.parse("memoX"))
        XCTAssertNil(Command.parse(""))
        XCTAssertEqual(Command.parse("pause"), .pause)
        XCTAssertEqual(Command.parse(" resume\n"), .resume)
        XCTAssertNil(Command.parse("pause now"))
        XCTAssertNil(Command.parse("Pause"))
    }
}

final class RecordOptionsTests: XCTestCase {
    func testParse() throws {
        XCTAssertEqual(try RecordOptions.parse(["--out", "/tmp/a"]), RecordOptions(out: "/tmp/a"))
        let o = try RecordOptions.parse(["--echo-cancel", "--out", "/tmp/b", "--no-system", "--fake"])
        XCTAssertEqual(o.out, "/tmp/b")
        XCTAssertTrue(o.echoCancel)
        XCTAssertTrue(o.fake)
        XCTAssertTrue(o.mic)
        XCTAssertFalse(o.system)
        XCTAssertFalse(try RecordOptions.parse(["--out", "x"]).echoCancel, "대면 회의 기본값은 에코 제거 끔")
        XCTAssertThrowsError(try RecordOptions.parse(["--echo-cancel"]), "--out은 필수")
        XCTAssertThrowsError(try RecordOptions.parse(["--out"]))
        XCTAssertThrowsError(try RecordOptions.parse(["--out", "x", "--aec"]))
    }
}

final class RecordingInfoTests: XCTestCase {
    func testSchema() throws {
        let dir = try tempDir()
        let url = dir.appendingPathComponent("recording.json")
        var info = RecordingInfo(startedAt: "2026-10-02T14:00:00+09:00", tracks: ["mic": "mic.wav", "system": "system.wav"])
        try info.write(to: url)
        var j = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        XCTAssertEqual(Set(j.keys), ["schema_version", "started_at", "duration", "tracks", "marks", "pauses", "echo_cancel"])
        XCTAssertEqual(j["echo_cancel"] as? Bool, false)
        XCTAssertEqual(j["schema_version"] as? Int, 1)
        XCTAssertTrue(j["duration"] is NSNull, "녹음 중에는 null")
        XCTAssertEqual(j["tracks"] as? [String: String], ["mic": "mic.wav", "system": "system.wav"])
        XCTAssertEqual((j["marks"] as? [Any])?.count, 0)
        XCTAssertEqual((j["pauses"] as? [Any])?.count, 0)

        info.marks = [Mark(t: 95, kind: "bookmark", text: nil), Mark(t: 130.5, kind: "memo", text: "예산 다시 확인")]
        info.duration = 3605.2
        info.echoCancel = true
        info.pauses = [Pause(at: 12.5, wallStart: "2026-10-14T10:00:12+09:00", wallEnd: "2026-10-14T10:05:00+09:00")]
        try info.write(to: url)
        j = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        XCTAssertEqual(j["echo_cancel"] as? Bool, true)
        XCTAssertEqual(j["schema_version"] as? Int, 1)
        XCTAssertEqual(j["duration"] as? Double, 3605.2)
        let marks = j["marks"] as! [[String: Any]]
        XCTAssertEqual(marks[0]["kind"] as? String, "bookmark")
        XCTAssertTrue(marks[0]["text"] is NSNull)
        XCTAssertEqual(marks[1]["t"] as? Double, 130.5)
        XCTAssertEqual(marks[1]["text"] as? String, "예산 다시 확인")
        let pauses = j["pauses"] as! [[String: Any]]
        XCTAssertEqual(pauses[0]["at"] as? Double, 12.5)
        XCTAssertEqual(pauses[0]["wall_start"] as? String, "2026-10-14T10:00:12+09:00")
        XCTAssertEqual(pauses[0]["wall_end"] as? String, "2026-10-14T10:05:00+09:00")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), ["recording.json"], "임시 파일이 남지 않는다")
    }

    func testIsoLocal() {
        let s = isoLocal(Date(timeIntervalSince1970: 0))
        XCTAssertNotNil(s.range(of: #"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d([+-]\d\d:\d\d|Z)$"#, options: .regularExpression), s)
    }
}

final class JsonTests: XCTestCase {
    func testShortestDecimal() throws {
        let s = String(decoding: try jsonData(["t": 0.24, "n": [1.38, -100.0], "i": 48_000, "x": NSNull()]), as: UTF8.self)
        XCTAssertTrue(s.contains(#""t":0.24"#), s)
        XCTAssertTrue(s.contains("[1.38,-100]"), s)
        XCTAssertTrue(s.contains(#""i":48000"#), s)
        XCTAssertTrue(s.contains(#""x":null"#), s)
    }
}
