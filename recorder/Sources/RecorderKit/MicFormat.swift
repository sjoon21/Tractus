/// 마이크 입력 노드에 tap을 걸어도 되는지 본다. 걸어도 되면 nil, 아니면 이유.
/// 장치를 막 바꾼 뒤에는 채널 0이나 낡은 표본 속도가 남아 있을 수 있고, 그때 installTap은 NSException을 던진다(2026-10-30 이슈 #57).
/// 음성 처리(에코 제거)를 켜면 tap 포맷과 하드웨어 포맷이 다를 수 있어 표본 속도 일치는 음성 처리가 꺼져 있을 때만 본다.
public func micFormatProblem(tapRate: Double, tapChannels: Int, hardwareRate: Double, hardwareChannels: Int, voiceProcessing: Bool) -> String? {
    if tapRate <= 0 || tapChannels <= 0 {
        return "입력 장치 포맷이 아직 준비되지 않았습니다 (\(Int(tapRate))Hz, \(tapChannels)채널)"
    }
    if hardwareRate <= 0 || hardwareChannels <= 0 {
        return "입력 장치가 아직 준비되지 않았습니다 (\(Int(hardwareRate))Hz, \(hardwareChannels)채널)"
    }
    if !voiceProcessing && tapRate != hardwareRate {
        return "입력 장치 포맷이 바뀌는 중입니다 (\(Int(tapRate))Hz ≠ \(Int(hardwareRate))Hz)"
    }
    return nil
}

/// 마이크 입력 유닛의 클라이언트 쪽 표본 속도를 하드웨어 속도로 맞춰야 하면 그 속도, 아니면 nil.
/// 입력 유닛은 표본 속도를 바꾸지 않는데 클라이언트 쪽은 이전 장치의 속도(48 kHz)를 기억해, 44.1·96 kHz 장치나
/// 화상회의 앱이 막 바꾼 장치는 그대로는 열리지 않는다. 음성 처리(에코 제거) 중에는 다른 게 정상이라 건드리지 않는다.
public func micClientRateToSet(clientRate: Double, hardwareRate: Double, voiceProcessing: Bool) -> Double? {
    !voiceProcessing && hardwareRate > 0 && clientRate != hardwareRate ? hardwareRate : nil
}
