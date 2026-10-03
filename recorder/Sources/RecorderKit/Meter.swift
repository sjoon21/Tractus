import Foundation

/// 250ms 창의 RMS를 dBFS로 낸다. 정확히 0이거나 표본이 없으면 `floor`.
public struct LevelMeter {
    public static let floor = -100.0
    private var sumSquares = 0.0
    private var count = 0

    public init() {}

    public mutating func add(_ samples: [Int16]) {
        for s in samples { let v = Double(s); sumSquares += v * v }
        count += samples.count
    }

    /// 지금까지 모은 값으로 dBFS를 내고 창을 비운다.
    public mutating func take() -> Double {
        defer { sumSquares = 0; count = 0 }
        return Self.dbfs(sumSquares: sumSquares, count: count)
    }

    public static func dbfs(sumSquares: Double, count: Int) -> Double {
        guard count > 0, sumSquares > 0 else { return floor }
        let rms = (sumSquares / Double(count)).squareRoot() / 32768
        return max(floor, (20 * log10(rms) * 10).rounded() / 10)
    }
}

/// 표본이 **정확히 0**으로만 `threshold`개 연속 들어오면 한 번 알린다(권한 없는 tap의 증상).
/// 소리가 작은 것과는 구분한다. 0이 아닌 표본이 한 번이라도 들어오면 권한이 있다는 뜻이므로 그 뒤로는 감시하지 않는다
/// (재생이 멈춘 tap도 정확히 0을 보내므로, 회의 중 무음을 권한 문제로 오인하지 않기 위해서다).
public struct ZeroDetector {
    public let threshold: Int
    private var run = 0
    private var fired = false
    private var sawSignal = false

    public init(threshold: Int = 5 * WavWriter.sampleRate) { self.threshold = threshold }

    public mutating func feed(_ samples: [Int16]) -> Bool {
        guard !sawSignal else { return false }
        if samples.contains(where: { $0 != 0 }) {
            sawSignal = true
            return false
        }
        run += samples.count
        guard !fired, run >= threshold else { return false }
        fired = true
        return true
    }
}
