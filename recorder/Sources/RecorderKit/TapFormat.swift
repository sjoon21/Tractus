/// 시스템 오디오 버퍼에 붙일 표본 속도. tap 포맷보다 장치(aggregate)가 실제로 도는 속도를 믿는다.
/// 블루투스 헤드셋이 통화 중 핸즈프리로 바뀌면 장치는 16 kHz로 도는데 tap은 여전히 48 kHz라고 해,
/// 48 kHz로 붙이면 상대 목소리가 약 3배 빠르게 녹음된다(Yogurt 이슈 #23).
public func systemTapRate(tapRate: Double, deviceRate: Double?) -> Double {
    if let deviceRate, deviceRate > 0 { return deviceRate }
    return tapRate
}

/// aggregate IOProc 버퍼 목록에서 tap 버퍼의 위치. 출력 장치에 입력 스트림(헤드셋 마이크)이 있으면 그것이 앞에 오고 tap은 맨 뒤에 온다.
/// `channels`는 버퍼마다 채널 수. 맞는 버퍼가 없으면 nil.
public func tapBufferIndex(channels: [Int], tapChannels: Int) -> Int? {
    channels.lastIndex(of: tapChannels)
}
