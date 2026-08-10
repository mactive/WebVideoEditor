use media_wasm::{PcmWaveformAccumulator, frame_to_microseconds, summarize_bytes};
use std::hint::black_box;
use std::time::Instant;

fn main() {
    const ITERATIONS: u32 = 100;
    let pcm: Vec<f32> = (0..48_000)
        .map(|index| ((index as f32) * 0.01).sin())
        .collect();
    let bytes = vec![0x5a; 1024 * 1024];

    let started = Instant::now();
    for _ in 0..ITERATIONS {
        black_box(frame_to_microseconds(black_box(107_892.0), 30_000, 1_001).unwrap());
    }
    let timeline_elapsed = started.elapsed();

    let started = Instant::now();
    for _ in 0..ITERATIONS {
        let mut accumulator = PcmWaveformAccumulator::new(pcm.len() as u32, 1_000).unwrap();
        accumulator.push(black_box(&pcm)).unwrap();
        black_box(accumulator.finish().unwrap());
    }
    let waveform_elapsed = started.elapsed();

    let started = Instant::now();
    for _ in 0..ITERATIONS {
        black_box(summarize_bytes(black_box(&bytes)));
    }
    let summary_elapsed = started.elapsed();

    println!(
        "[WASM BENCH] timeline iterations={ITERATIONS} duration_ms={:.3}",
        timeline_elapsed.as_secs_f64() * 1_000.0
    );
    println!(
        "[WASM BENCH] waveform samples={} buckets=1000 iterations={ITERATIONS} duration_ms={:.3}",
        pcm.len(),
        waveform_elapsed.as_secs_f64() * 1_000.0
    );
    println!(
        "[WASM BENCH] bytes={} iterations={ITERATIONS} duration_ms={:.3}",
        bytes.len(),
        summary_elapsed.as_secs_f64() * 1_000.0
    );
}
