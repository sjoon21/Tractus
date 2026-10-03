import Foundation

/// 48 kHz mono 16-bit PCM WAV를 디스크에 바로 쓴다(메모리에 쌓지 않음).
/// 헤더의 크기 필드를 주기적으로 갱신하므로 프로세스가 강제 종료돼도 마지막 갱신 시점까지는 재생된다.
/// ponytail: 크기 필드가 UInt32라 4 GiB(약 12.4시간)가 상한. 상한에 닿으면 append가 throw하고 녹음은 error로 끝난다.
/// 더 길게 녹음하려면 RF64나 CAF로 바꾼다.
public final class WavWriter {
    public static let sampleRate = 48_000
    /// 헤더를 갱신하는 간격(표본 수). 0.25초.
    public static let headerInterval = sampleRate / 4
    /// 이보다 많이 뒤처지면 0으로 메워 트랙 시각을 맞춘다(표본 수). 0.5초. 평소 버퍼 지연(~0.1초)보다 넉넉히 크다.
    public static let maxLag = sampleRate / 2
    /// RIFF 크기(36 + 데이터 바이트)가 UInt32에 들어가는 최대 표본 수. 테스트에서만 줄인다.
    var maxFrames = (Int(UInt32.max) - 36) / 2

    public let url: URL
    public private(set) var frames = 0
    private var fd: Int32
    private var unflushed = 0

    public init(url: URL) throws {
        self.url = url
        fd = open(url.path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        guard fd >= 0 else { throw WavError.io("열기 실패 \(url.path): \(String(cString: strerror(errno)))") }
        try writeAll(Self.header(dataBytes: 0))
    }

    public func append(_ samples: [Int16]) throws {
        guard fd >= 0, !samples.isEmpty else { return }
        guard frames + samples.count <= maxFrames else { throw WavError.io("\(url.lastPathComponent)가 WAV 크기 상한(4 GiB)에 닿았습니다") }
        try samples.withUnsafeBytes { try writeAll($0) }  // Apple Silicon은 little-endian이라 그대로 쓴다
        frames += samples.count
        unflushed += samples.count
        if unflushed >= Self.headerInterval { try updateHeader() }
    }

    /// `samples`의 마지막 표본이 트랙 시작 기준 `endFrame` 위치라고 보고, 파일이 그보다 뒤처졌으면 앞을 0으로 메운다.
    /// 첫 버퍼(늦게 시작한 트랙)와 `realign`(소스 재시작 직후)은 항상, 그 밖에는 `maxLag`보다 크게 끊겼을 때만 메운다.
    /// 작은 지연은 스케줄링 지터라서 메우면 오히려 시각이 밀린다.
    public func append(_ samples: [Int16], endingAt endFrame: Int, realign: Bool = false) throws {
        var lag = endFrame - samples.count - frames
        if lag > 0, realign || frames == 0 || lag > Self.maxLag {
            while lag > 0 {  // 긴 끊김도 메모리를 크게 잡지 않도록 1초씩 쓴다
                let n = min(lag, Self.sampleRate)
                try append([Int16](repeating: 0, count: n))
                lag -= n
            }
        }
        try append(samples)
    }

    /// RIFF·data 크기 필드만 제자리에서 고친다(pwrite는 파일 오프셋을 옮기지 않는다).
    public func updateHeader() throws {
        guard fd >= 0 else { return }
        let dataBytes = UInt32(frames * 2)
        for (offset, value) in [(4, 36 + dataBytes), (40, dataBytes)] {
            var le = value.littleEndian
            guard pwrite(fd, &le, 4, off_t(offset)) == 4 else { throw WavError.io("헤더 갱신 실패: \(String(cString: strerror(errno)))") }
        }
        unflushed = 0
    }

    public func close() throws {
        guard fd >= 0 else { return }
        defer { Darwin.close(fd); fd = -1 }
        try updateHeader()
    }

    private func writeAll(_ buf: UnsafeRawBufferPointer) throws {
        var done = 0
        while done < buf.count {
            let n = write(fd, buf.baseAddress! + done, buf.count - done)
            if n < 0 {
                if errno == EINTR { continue }
                throw WavError.io("쓰기 실패 \(url.lastPathComponent): \(String(cString: strerror(errno)))")
            }
            done += n
        }
    }

    private func writeAll(_ data: Data) throws { try data.withUnsafeBytes { try writeAll($0) } }

    public static func header(dataBytes: UInt32) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + dataBytes); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1)
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(dataBytes)
        return d
    }
}

public enum WavError: Error, CustomStringConvertible {
    case io(String)
    public var description: String { if case let .io(m) = self { return m }; return "" }
}
