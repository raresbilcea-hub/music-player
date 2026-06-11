// One-off test: detect a chord timeline from an audio file using essentia.js,
// to judge whether real audio-based chord detection (vs. GPT hallucination) is
// good enough to build the new pipeline on.
//
// Usage:
//   node test-chords.js [path/to/audio-file]
//
// Defaults to demucs-test-output/guitar.mp3 (the isolated guitar stem from
// the "I'm Yours" test). Real chords for that song are roughly G - D - Em - C
// (capo 4) -- compare the printed timeline against that.

const fs = require("fs");
const os = require("os");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const wav = require("wav");
const { EssentiaWASM, Essentia } = require("essentia.js");

ffmpeg.setFfmpegPath(ffmpegPath);

const SAMPLE_RATE = 44100;
const FRAME_SIZE = 4096;
const HOP_SIZE = 2048;

const inputPath = process.argv[2] || path.join(__dirname, "demucs-test-output", "guitar.mp3");

if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

function convertToWav(srcPath) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `chord-test-${Date.now()}.wav`);
    ffmpeg(srcPath)
      .audioChannels(1)
      .audioFrequency(SAMPLE_RATE)
      .format("wav")
      .on("error", reject)
      .on("end", () => resolve(outPath))
      .save(outPath);
  });
}

function readWavAsFloat32(wavPath) {
  return new Promise((resolve, reject) => {
    const reader = new wav.Reader();
    const chunks = [];
    reader.on("format", (format) => {
      if (format.sampleRate !== SAMPLE_RATE || format.channels !== 1 || format.bitDepth !== 16) {
        reject(new Error(`Unexpected WAV format: ${JSON.stringify(format)}`));
      }
    });
    reader.on("data", (chunk) => chunks.push(chunk));
    reader.on("end", () => {
      const buffer = Buffer.concat(chunks);
      const samples = new Float32Array(buffer.length / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = buffer.readInt16LE(i * 2) / 32768;
      }
      resolve(samples);
    });
    reader.on("error", reject);
    fs.createReadStream(wavPath).pipe(reader);
  });
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(2).padStart(5, "0");
  return `${m}:${s}`;
}

async function main() {
  console.log(`Converting ${inputPath} to mono ${SAMPLE_RATE}Hz WAV...`);
  const wavPath = await convertToWav(inputPath);

  console.log("Decoding audio...");
  const signal = await readWavAsFloat32(wavPath);
  fs.unlinkSync(wavPath);
  console.log(`Loaded ${signal.length} samples (${(signal.length / SAMPLE_RATE).toFixed(1)}s)`);

  const essentia = new Essentia(EssentiaWASM);

  const frames = essentia.FrameGenerator(signal, FRAME_SIZE, HOP_SIZE);
  const numFrames = frames.size();
  console.log(`Analyzing ${numFrames} frames...`);

  const hpcpFrames = new EssentiaWASM.VectorVectorFloat();
  for (let i = 0; i < numFrames; i++) {
    const frame = frames.get(i);
    const windowed = essentia.Windowing(frame, true, FRAME_SIZE, "hann");
    const spectrum = essentia.Spectrum(windowed.frame);
    const peaks = essentia.SpectralPeaks(spectrum.spectrum, 0.00001, 5000, 100, 40, "magnitude", SAMPLE_RATE);
    const hpcp = essentia.HPCP(peaks.frequencies, peaks.magnitudes);
    hpcpFrames.push_back(hpcp.hpcp);
  }

  const result = essentia.ChordsDetection(hpcpFrames, HOP_SIZE, SAMPLE_RATE, 2);
  const numChords = result.chords.size();

  console.log("\nChord timeline:");
  let prevChord = null;
  for (let i = 0; i < numChords; i++) {
    const chord = result.chords.get(i);
    const strength = result.strength.get(i);
    if (chord !== prevChord) {
      const time = (i * HOP_SIZE) / SAMPLE_RATE;
      console.log(`  ${formatTime(time)}  ${chord}  (strength ${strength.toFixed(2)})`);
      prevChord = chord;
    }
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
