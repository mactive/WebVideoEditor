use media_wasm::{
    PcmWaveformAccumulator, frame_to_microseconds, microseconds_to_frame, summarize_bytes,
};
use wasm_bindgen_test::*;

wasm_bindgen_test_configure!(run_in_browser);

#[wasm_bindgen_test]
fn converts_ntsc_frames_in_wasm() {
    let microseconds = frame_to_microseconds(30.0, 30_000, 1_001).unwrap();
    assert_eq!(microseconds, 1_001_000.0);
    assert_eq!(
        microseconds_to_frame(microseconds, 30_000, 1_001).unwrap(),
        30.0
    );
}

#[wasm_bindgen_test]
fn accumulates_typed_pcm_chunks_in_wasm() {
    let mut accumulator = PcmWaveformAccumulator::new(4, 2).unwrap();
    accumulator.push(&[-1.0, 1.0]).unwrap();
    accumulator.push(&[-0.5, 0.5]).unwrap();

    let output = accumulator.finish().unwrap();
    assert_eq!(&output[0..4], &[-1.0, -0.5, 1.0, 0.5]);
    assert!((output[4] - 1.0).abs() < f32::EPSILON);
    assert!((output[5] - 0.5).abs() < f32::EPSILON);
}

#[wasm_bindgen_test]
fn summarizes_uint8_input_in_wasm() {
    assert_eq!(
        summarize_bytes(&[1, 2, 3]).as_ref(),
        &[3, 1_456_420_779, 1, 3, 0]
    );
}

#[wasm_bindgen_test]
fn rejects_invalid_timeline_and_pcm_inputs_in_wasm() {
    assert!(frame_to_microseconds(1.0, 0, 1).is_err());
    assert!(microseconds_to_frame(f64::NAN, 30, 1).is_err());

    let mut accumulator = PcmWaveformAccumulator::new(2, 1).unwrap();
    assert!(accumulator.push(&[0.5, f32::NAN]).is_err());
    assert_eq!(accumulator.processed_samples(), 0);
    assert!(accumulator.finish().is_err());
}
