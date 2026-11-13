//! 48 kHz mono 16-bit PCM WAV를 디스크에 바로 쓴다 (Swift `RecorderKit/Wav.swift`와 같다).
//! 헤더의 크기 칸을 0.25초마다 고쳐 강제 종료돼도 거기까지는 재생된다. 크기 칸이 u32라 4 GiB(약 12.4시간)가 상한이다.
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const SAMPLE_RATE: usize = 48_000;
const HEADER_INTERVAL: usize = SAMPLE_RATE / 4;
/// 이보다 많이 뒤처지면 0으로 메워 트랙 시각을 맞춘다 (0.5초)
pub const MAX_LAG: usize = SAMPLE_RATE / 2;

pub struct WavWriter {
    pub path: PathBuf,
    file: Option<File>,
    pub frames: usize,
    unflushed: usize,
    max_frames: usize,
}

pub fn header(data_bytes: u32) -> [u8; 44] {
    let mut h = [0u8; 44];
    let rate = SAMPLE_RATE as u32;
    h[0..4].copy_from_slice(b"RIFF");
    h[4..8].copy_from_slice(&(36 + data_bytes).to_le_bytes());
    h[8..16].copy_from_slice(b"WAVEfmt ");
    h[16..20].copy_from_slice(&16u32.to_le_bytes());
    h[20..22].copy_from_slice(&1u16.to_le_bytes()); // PCM
    h[22..24].copy_from_slice(&1u16.to_le_bytes()); // mono
    h[24..28].copy_from_slice(&rate.to_le_bytes());
    h[28..32].copy_from_slice(&(rate * 2).to_le_bytes());
    h[32..34].copy_from_slice(&2u16.to_le_bytes());
    h[34..36].copy_from_slice(&16u16.to_le_bytes());
    h[36..40].copy_from_slice(b"data");
    h[40..44].copy_from_slice(&data_bytes.to_le_bytes());
    h
}

impl WavWriter {
    pub fn create(path: &Path) -> std::io::Result<WavWriter> {
        let mut file = File::create(path)?;
        file.write_all(&header(0))?;
        Ok(WavWriter { path: path.to_path_buf(), file: Some(file), frames: 0, unflushed: 0, max_frames: (u32::MAX as usize - 36) / 2 })
    }

    pub fn append(&mut self, samples: &[i16]) -> Result<(), String> {
        let Some(f) = self.file.as_mut() else { return Ok(()) };
        if samples.is_empty() {
            return Ok(());
        }
        if self.frames + samples.len() > self.max_frames {
            return Err(format!("{}가 WAV 크기 상한(4 GiB)에 닿았습니다", self.path.display()));
        }
        let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
        f.write_all(&bytes).map_err(|e| format!("쓰기 실패 {}: {e}", self.path.display()))?;
        self.frames += samples.len();
        self.unflushed += samples.len();
        if self.unflushed >= HEADER_INTERVAL {
            self.update_header()?;
        }
        Ok(())
    }

    /// `samples`의 마지막 표본이 트랙 시작 기준 `end_frame`이라고 보고, 파일이 뒤처졌으면 앞을 0으로 메운다.
    /// 첫 버퍼·재시작 직후(`realign`)는 언제나, 그 밖에는 `MAX_LAG`보다 크게 끊겼을 때만 (작은 지연은 스케줄링 흔들림이다)
    pub fn append_at(&mut self, samples: &[i16], end_frame: usize, realign: bool) -> Result<(), String> {
        let lag = end_frame as i64 - samples.len() as i64 - self.frames as i64;
        if lag > 0 && (realign || self.frames == 0 || lag as usize > MAX_LAG) {
            let mut left = lag as usize;
            while left > 0 {
                let n = left.min(SAMPLE_RATE);
                self.append(&vec![0; n])?;
                left -= n;
            }
        }
        self.append(samples)
    }

    pub fn update_header(&mut self) -> Result<(), String> {
        let Some(f) = self.file.as_mut() else { return Ok(()) };
        let data = (self.frames * 2) as u32;
        let res = (|| {
            f.seek(SeekFrom::Start(4))?;
            f.write_all(&(36 + data).to_le_bytes())?;
            f.seek(SeekFrom::Start(40))?;
            f.write_all(&data.to_le_bytes())?;
            f.seek(SeekFrom::End(0))?;
            f.flush()
        })();
        self.unflushed = 0;
        res.map_err(|e| format!("헤더 갱신 실패: {e}"))
    }

    pub fn close(&mut self) -> Result<(), String> {
        let r = self.update_header();
        self.file = None;
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("tractus-rec-test-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d.join("t.wav")
    }

    #[test]
    fn header_and_sizes_are_right_after_close() {
        let p = tmp("hdr");
        let mut w = WavWriter::create(&p).unwrap();
        w.append(&[1, -1, 2]).unwrap();
        w.close().unwrap();
        let b = std::fs::read(&p).unwrap();
        assert_eq!(b.len(), 44 + 6);
        assert_eq!(&b[0..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(b[4..8].try_into().unwrap()), 36 + 6);
        assert_eq!(u32::from_le_bytes(b[40..44].try_into().unwrap()), 6);
        assert_eq!(u32::from_le_bytes(b[24..28].try_into().unwrap()), 48_000);
    }

    #[test]
    fn late_first_buffer_and_long_gaps_are_filled_small_jitter_is_not() {
        let mut w = WavWriter::create(&tmp("lag")).unwrap();
        w.append_at(&[5; 10], 110, false).unwrap(); // 첫 버퍼가 100표본 늦게 왔다
        assert_eq!(w.frames, 110);
        w.append_at(&[5; 10], 130, false).unwrap(); // 10표본 흔들림: 메우지 않는다
        assert_eq!(w.frames, 120);
        w.append_at(&[5; 10], 120 + MAX_LAG + 20, false).unwrap(); // 0.5초 넘게 끊김
        assert_eq!(w.frames, 120 + MAX_LAG + 20);
        let end = w.frames + 30;
        w.append_at(&[5; 10], end, true).unwrap(); // 재시작 직후는 작은 끊김(20표본)도 메운다
        assert_eq!(w.frames, end);
    }

    #[test]
    fn the_size_limit_is_an_error() {
        let mut w = WavWriter::create(&tmp("max")).unwrap();
        w.max_frames = 5;
        assert!(w.append(&[0; 6]).is_err());
    }
}
