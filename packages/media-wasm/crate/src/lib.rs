use wasm_bindgen::prelude::*;

const MICROS_PER_SECOND: f64 = 1_000_000.0;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
const FNV_OFFSET_BASIS: u32 = 0x811c_9dc5;
const FNV_PRIME: u32 = 0x0100_0193;

fn finite_non_negative(value: f64, name: &str) -> Result<(), String> {
    if !value.is_finite() || value < 0.0 {
        return Err(format!("{name} must be finite and non-negative"));
    }
    Ok(())
}

fn safe_integer(value: f64, name: &str) -> Result<(), String> {
    finite_non_negative(value, name)?;
    if value.fract() != 0.0 || value > MAX_SAFE_INTEGER {
        return Err(format!("{name} must be a non-negative safe integer"));
    }
    Ok(())
}

fn valid_frame_rate(numerator: u32, denominator: u32) -> Result<(), String> {
    if numerator == 0 || denominator == 0 {
        return Err("frame-rate numerator and denominator must be non-zero".into());
    }
    Ok(())
}

fn seconds_to_microseconds_core(seconds: f64) -> Result<f64, String> {
    finite_non_negative(seconds, "seconds")?;
    let result = (seconds * MICROS_PER_SECOND).round();
    if !result.is_finite() || result > MAX_SAFE_INTEGER {
        return Err("microsecond result exceeds the JavaScript safe integer range".into());
    }
    Ok(result)
}

fn microseconds_to_seconds_core(microseconds: f64) -> Result<f64, String> {
    safe_integer(microseconds, "microseconds")?;
    Ok(microseconds / MICROS_PER_SECOND)
}

fn frame_to_microseconds_core(
    frame: f64,
    fps_numerator: u32,
    fps_denominator: u32,
) -> Result<f64, String> {
    safe_integer(frame, "frame")?;
    valid_frame_rate(fps_numerator, fps_denominator)?;
    let result =
        (frame * f64::from(fps_denominator) * MICROS_PER_SECOND / f64::from(fps_numerator)).round();
    if !result.is_finite() || result > MAX_SAFE_INTEGER {
        return Err("microsecond result exceeds the JavaScript safe integer range".into());
    }
    Ok(result)
}

fn microseconds_to_frame_core(
    microseconds: f64,
    fps_numerator: u32,
    fps_denominator: u32,
) -> Result<f64, String> {
    safe_integer(microseconds, "microseconds")?;
    valid_frame_rate(fps_numerator, fps_denominator)?;
    let result = (microseconds * f64::from(fps_numerator)
        / (f64::from(fps_denominator) * MICROS_PER_SECOND))
        .round();
    if result > MAX_SAFE_INTEGER {
        return Err("frame result exceeds the JavaScript safe integer range".into());
    }
    Ok(result)
}

#[wasm_bindgen]
pub fn seconds_to_microseconds(seconds: f64) -> Result<f64, JsError> {
    seconds_to_microseconds_core(seconds).map_err(|error| JsError::new(&error))
}

#[wasm_bindgen]
pub fn microseconds_to_seconds(microseconds: f64) -> Result<f64, JsError> {
    microseconds_to_seconds_core(microseconds).map_err(|error| JsError::new(&error))
}

#[wasm_bindgen]
pub fn frame_to_microseconds(
    frame: f64,
    fps_numerator: u32,
    fps_denominator: u32,
) -> Result<f64, JsError> {
    frame_to_microseconds_core(frame, fps_numerator, fps_denominator)
        .map_err(|error| JsError::new(&error))
}

#[wasm_bindgen]
pub fn microseconds_to_frame(
    microseconds: f64,
    fps_numerator: u32,
    fps_denominator: u32,
) -> Result<f64, JsError> {
    microseconds_to_frame_core(microseconds, fps_numerator, fps_denominator)
        .map_err(|error| JsError::new(&error))
}

#[wasm_bindgen]
pub struct PcmWaveformAccumulator {
    total_samples: u32,
    bucket_count: u32,
    processed_samples: u32,
    minima: Vec<f32>,
    maxima: Vec<f32>,
    sum_squares: Vec<f64>,
    counts: Vec<u32>,
}

#[wasm_bindgen]
impl PcmWaveformAccumulator {
    #[wasm_bindgen(constructor)]
    pub fn new(total_samples: u32, bucket_count: u32) -> Result<PcmWaveformAccumulator, JsError> {
        if bucket_count == 0 {
            return Err(JsError::new("bucket_count must be greater than zero"));
        }

        let length = bucket_count as usize;
        Ok(PcmWaveformAccumulator {
            total_samples,
            bucket_count,
            processed_samples: 0,
            minima: vec![f32::INFINITY; length],
            maxima: vec![f32::NEG_INFINITY; length],
            sum_squares: vec![0.0; length],
            counts: vec![0; length],
        })
    }

    pub fn push(&mut self, samples: &[f32]) -> Result<(), JsError> {
        self.push_core(samples)
            .map_err(|error| JsError::new(&error))
    }

    pub fn finish(&self) -> Result<Box<[f32]>, JsError> {
        self.finish_core()
            .map(Vec::into_boxed_slice)
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen(getter)]
    pub fn processed_samples(&self) -> u32 {
        self.processed_samples
    }

    #[wasm_bindgen(getter)]
    pub fn expected_samples(&self) -> u32 {
        self.total_samples
    }

    #[wasm_bindgen(getter)]
    pub fn buckets(&self) -> u32 {
        self.bucket_count
    }
}

impl PcmWaveformAccumulator {
    fn push_core(&mut self, samples: &[f32]) -> Result<(), String> {
        let new_total = u64::from(self.processed_samples) + samples.len() as u64;
        if new_total > u64::from(self.total_samples) {
            return Err("PCM input exceeds total_samples".into());
        }
        if samples.iter().any(|sample| !sample.is_finite()) {
            return Err("PCM input must contain only finite samples".into());
        }

        for (offset, sample) in samples.iter().copied().enumerate() {
            let sample_index = u64::from(self.processed_samples) + offset as u64;
            let bucket = if self.total_samples == 0 {
                0
            } else {
                (sample_index * u64::from(self.bucket_count) / u64::from(self.total_samples))
                    .min(u64::from(self.bucket_count - 1)) as usize
            };
            self.minima[bucket] = self.minima[bucket].min(sample);
            self.maxima[bucket] = self.maxima[bucket].max(sample);
            self.sum_squares[bucket] += f64::from(sample) * f64::from(sample);
            self.counts[bucket] += 1;
        }

        self.processed_samples = new_total as u32;
        Ok(())
    }

    fn finish_core(&self) -> Result<Vec<f32>, String> {
        if self.processed_samples != self.total_samples {
            return Err(format!(
                "PCM input incomplete: expected {} samples, received {}",
                self.total_samples, self.processed_samples
            ));
        }

        let bucket_count = self.bucket_count as usize;
        let mut output = vec![0.0; bucket_count * 3];
        for bucket in 0..bucket_count {
            let count = self.counts[bucket];
            if count == 0 {
                continue;
            }
            output[bucket] = self.minima[bucket];
            output[bucket_count + bucket] = self.maxima[bucket];
            output[bucket_count * 2 + bucket] =
                (self.sum_squares[bucket] / f64::from(count)).sqrt() as f32;
        }
        Ok(output)
    }
}

#[wasm_bindgen]
pub fn summarize_bytes(bytes: &[u8]) -> Box<[u32]> {
    let mut hash = FNV_OFFSET_BASIS;
    let mut minimum = u8::MAX;
    let mut maximum = u8::MIN;
    let mut xor = 0_u8;

    for byte in bytes.iter().copied() {
        hash ^= u32::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
        minimum = minimum.min(byte);
        maximum = maximum.max(byte);
        xor ^= byte;
    }

    if bytes.is_empty() {
        minimum = 0;
    }

    vec![
        bytes.len() as u32,
        hash,
        u32::from(minimum),
        u32::from(maximum),
        u32::from(xor),
    ]
    .into_boxed_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPSILON: f32 = 1e-6;

    #[test]
    fn converts_seconds_and_microseconds() {
        assert_eq!(
            seconds_to_microseconds_core(1.234_567).unwrap(),
            1_234_567.0
        );
        assert_eq!(
            microseconds_to_seconds_core(1_234_567.0).unwrap(),
            1.234_567
        );
        assert!(seconds_to_microseconds_core(-1.0).is_err());
        assert!(seconds_to_microseconds_core(f64::INFINITY).is_err());
        assert!(microseconds_to_seconds_core(1.5).is_err());
    }

    #[test]
    fn converts_fractional_frame_rates_and_boundaries() {
        assert_eq!(
            frame_to_microseconds_core(30.0, 30, 1).unwrap(),
            1_000_000.0
        );
        assert_eq!(
            frame_to_microseconds_core(30.0, 30_000, 1_001).unwrap(),
            1_001_000.0
        );
        assert_eq!(
            microseconds_to_frame_core(1_001_000.0, 30_000, 1_001).unwrap(),
            30.0
        );
        assert!(frame_to_microseconds_core(1.0, 0, 1).is_err());
        assert!(microseconds_to_frame_core(1.0, 30, 0).is_err());
    }

    #[test]
    fn accumulates_pcm_across_chunks() {
        let mut accumulator = PcmWaveformAccumulator::new(8, 2).unwrap();
        accumulator.push_core(&[-1.0, -0.5, 0.5]).unwrap();
        accumulator
            .push_core(&[1.0, -0.25, 0.25, -0.75, 0.75])
            .unwrap();

        let output = accumulator.finish_core().unwrap();
        assert_eq!(&output[0..2], &[-1.0, -0.75]);
        assert_eq!(&output[2..4], &[1.0, 0.75]);
        assert!((output[4] - (0.625_f32).sqrt()).abs() < EPSILON);
        assert!((output[5] - (0.3125_f32).sqrt()).abs() < EPSILON);
    }

    #[test]
    fn rejects_incomplete_invalid_and_excess_pcm_without_partial_mutation() {
        let mut accumulator = PcmWaveformAccumulator::new(2, 1).unwrap();
        assert!(accumulator.push_core(&[0.5, f32::NAN]).is_err());
        assert_eq!(accumulator.processed_samples, 0);
        accumulator.push_core(&[0.5]).unwrap();
        assert!(accumulator.finish_core().is_err());
        assert!(accumulator.push_core(&[0.5, 0.5]).is_err());
        assert_eq!(accumulator.processed_samples, 1);
    }

    #[test]
    fn emits_zeroes_for_empty_buckets() {
        let accumulator = PcmWaveformAccumulator::new(0, 3).unwrap();
        assert_eq!(accumulator.finish_core().unwrap(), vec![0.0; 9]);
    }

    #[test]
    fn summarizes_bytes_with_stable_layout() {
        assert_eq!(
            summarize_bytes(&[1, 2, 3]).as_ref(),
            &[3, 1_456_420_779, 1, 3, 0]
        );
        assert_eq!(
            summarize_bytes(&[]).as_ref(),
            &[0, FNV_OFFSET_BASIS, 0, 0, 0]
        );
    }
}
