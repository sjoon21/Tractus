import Foundation

// RecorderKit(../Sources/RecorderKit/Recording.swift)에서 복사한 작은 공용 함수. 두 패키지를 나눈 뒤 서로 의존하지 않는다.

public struct UsageError: Error, CustomStringConvertible {
    public let description: String
}

/// JSONSerialization은 0.24를 0.23999999999999999로 쓴다. Double을 최단 10진 표기(NSDecimalNumber)로 바꿔 직렬화한다.
public func jsonData(_ object: [String: Any], pretty: Bool = false) throws -> Data {
    func clean(_ v: Any) -> Any {
        switch v {
        case let d as Double: return NSDecimalNumber(string: String(d))
        case let a as [Any]: return a.map(clean)
        case let o as [String: Any]: return o.mapValues(clean)
        default: return v
        }
    }
    let options: JSONSerialization.WritingOptions = pretty ? [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes] : [.withoutEscapingSlashes]
    return try JSONSerialization.data(withJSONObject: clean(object), options: options)
}

/// 소수 둘째 자리 반올림(이벤트·JSON의 시각 표기).
public func round2(_ x: Double) -> Double { (x * 100).rounded() / 100 }
