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
