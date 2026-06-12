// ─── Audio analysis pipeline: real chord detection from a 30s preview clip ───
//
// analyzeAudioForChords(title, artist) -> { chords, progression, sourceClip } | null
//
// Pipeline (validated in test-demucs.js / test-chords.js):
//   1. iTunes Search API -> 30s preview clip (no auth needed)
//   2. Replicate htdemucs_6s (no "stem" param -> all 6 stems in one call)
//   3. essentia.js HPCP + ChordsDetection on the guitar stem (falls back to
//      "other" if the guitar stem is too quiet/ambiguous)
//   4. Smooth the raw per-frame chord timeline (collapse flicker) and
//      summarize into a chord vocabulary + representative progression.
//
// Returns null at any stage where we don't have enough signal to be useful
// (no preview, Demucs failure, too few/weak chords) so the caller can fall
// back to the existing AI-recall chart generation.

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const wav = require("wav");
const { EssentiaWASM, Essentia } = require("essentia.js");

ffmpeg.setFfmpegPath(ffmpegPath);

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const REPLICATE_DEMUCS_VERSION = "25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953";

const SAMPLE_RATE = 44100;
const FRAME_SIZE = 4096;
const HOP_SIZE = 2048;

const MIN_CHORD_DURATION = 0.6;   // seconds — segments shorter than this are flicker
const MIN_DISTINCT_CHORDS = 2;    // quality gate
const MIN_AVG_STRENGTH = 0.4;     // quality gate
const MIN_VOCAB_SHARE = 0.08;     // a chord must ring for >=8% of the clip to count
const MAX_VOCAB_SIZE = 6;
const MAX_PROGRESSION_LENGTH = 16;
const NO_CHORD_LABEL = "N";       // essentia's "no chord / silence" label

async function findItunesPreview(title, artist) {
  try {
    var url = "https://itunes.apple.com/search?term=" + encodeURIComponent(title + " " + artist) + "&entity=song&limit=1";
    var res = await axios.get(url);
    var results = res.data.results;
    if (!results || results.length === 0) return null;
    return results[0].previewUrl || null;
  } catch (e) {
    console.log("audioAnalysis: iTunes preview lookup failed:", e.message);
    return null;
  }
}

async function downloadBuffer(url) {
  var res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

async function runDemucs(audioBuffer) {
  if (!REPLICATE_API_TOKEN) {
    console.log("audioAnalysis: no REPLICATE_API_TOKEN configured, skipping Demucs");
    return null;
  }
  try {
    var dataUri = "data:audio/mp4;base64," + audioBuffer.toString("base64");
    var createRes = await axios.post(
      "https://api.replicate.com/v1/predictions",
      {
        version: REPLICATE_DEMUCS_VERSION,
        input: {
          audio: dataUri,
          model_name: "htdemucs_6s",
          clip_mode: "rescale",
          // no "stem" key on purpose -> Replicate returns ALL 6 stems
        },
      },
      {
        headers: {
          Authorization: "Bearer " + REPLICATE_API_TOKEN,
          "Content-Type": "application/json",
          Prefer: "wait",
        },
      }
    );

    var prediction = createRes.data;
    var maxPolls = 90; // ~3 minutes safety cap
    var polls = 0;
    while (!["succeeded", "failed", "canceled"].includes(prediction.status) && polls < maxPolls) {
      await new Promise(function (r) { setTimeout(r, 2000); });
      var pollRes = await axios.get(prediction.urls.get, {
        headers: { Authorization: "Bearer " + REPLICATE_API_TOKEN },
      });
      prediction = pollRes.data;
      polls++;
    }

    if (prediction.status !== "succeeded") {
      console.log("audioAnalysis: Demucs did not succeed (status=" + prediction.status + ")", prediction.error || "");
      return null;
    }
    return prediction.output; // { vocals, drums, bass, guitar, piano, other }
  } catch (e) {
    console.log("audioAnalysis: Demucs error:", e.response ? JSON.stringify(e.response.data) : e.message);
    return null;
  }
}

function convertToWav(buffer) {
  return new Promise(function (resolve, reject) {
    var inPath = path.join(os.tmpdir(), "audio-analysis-in-" + crypto.randomUUID());
    var outPath = path.join(os.tmpdir(), "audio-analysis-out-" + crypto.randomUUID() + ".wav");
    fs.writeFileSync(inPath, buffer);
    ffmpeg(inPath)
      .audioChannels(1)
      .audioFrequency(SAMPLE_RATE)
      .format("wav")
      .on("error", function (err) {
        try { fs.unlinkSync(inPath); } catch (e) {}
        reject(err);
      })
      .on("end", function () {
        try { fs.unlinkSync(inPath); } catch (e) {}
        resolve(outPath);
      })
      .save(outPath);
  });
}

function readWavAsFloat32(wavPath) {
  return new Promise(function (resolve, reject) {
    var reader = new wav.Reader();
    var chunks = [];
    reader.on("format", function (format) {
      if (format.sampleRate !== SAMPLE_RATE || format.channels !== 1 || format.bitDepth !== 16) {
        reject(new Error("Unexpected WAV format: " + JSON.stringify(format)));
      }
    });
    reader.on("data", function (chunk) { chunks.push(chunk); });
    reader.on("end", function () {
      var buffer = Buffer.concat(chunks);
      var samples = new Float32Array(buffer.length / 2);
      for (var i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(i * 2) / 32768;
      resolve(samples);
    });
    reader.on("error", reject);
    fs.createReadStream(wavPath).pipe(reader);
  });
}

// Detect the musical key from an audio buffer (run on the full mix, not a
// stem — key estimation works best with all instruments present). Replaces
// the Spotify audio-analysis lookup, which Spotify shut down (returns 403).
// Returns e.g. "Db major" or null.
async function detectKeyFromAudio(buffer) {
  var wavPath = await convertToWav(buffer);
  try {
    var signal = await readWavAsFloat32(wavPath);
    var essentia = new Essentia(EssentiaWASM);
    var result = essentia.KeyExtractor(essentia.arrayToVector(signal));
    if (!result || !result.key) return null;
    console.log("audioAnalysis: detected key " + result.key + " " + result.scale + " (strength " + result.strength.toFixed(2) + ")");
    if (result.strength < 0.5) return null; // too uncertain to enforce
    return result.key + " " + result.scale;
  } catch (e) {
    console.log("audioAnalysis: key detection failed:", e.message);
    return null;
  } finally {
    try { fs.unlinkSync(wavPath); } catch (e) {}
  }
}

// Returns { segments: [{ time, chord, strength }], clipDuration }
async function detectChordsFromAudio(buffer) {
  var wavPath = await convertToWav(buffer);
  try {
    var signal = await readWavAsFloat32(wavPath);
    var clipDuration = signal.length / SAMPLE_RATE;

    var essentia = new Essentia(EssentiaWASM);
    var frames = essentia.FrameGenerator(signal, FRAME_SIZE, HOP_SIZE);
    var numFrames = frames.size();

    var hpcpFrames = new EssentiaWASM.VectorVectorFloat();
    for (var i = 0; i < numFrames; i++) {
      var frame = frames.get(i);
      var windowed = essentia.Windowing(frame, true, FRAME_SIZE, "hann");
      var spectrum = essentia.Spectrum(windowed.frame);
      var peaks = essentia.SpectralPeaks(spectrum.spectrum, 0.00001, 5000, 100, 40, "magnitude", SAMPLE_RATE);
      var hpcp = essentia.HPCP(peaks.frequencies, peaks.magnitudes);
      hpcpFrames.push_back(hpcp.hpcp);
    }

    var result = essentia.ChordsDetection(hpcpFrames, HOP_SIZE, SAMPLE_RATE, 2);
    var numChords = result.chords.size();

    var segments = [];
    var prevChord = null;
    for (var j = 0; j < numChords; j++) {
      var chord = result.chords.get(j);
      var strength = result.strength.get(j);
      if (chord !== prevChord) {
        segments.push({ time: (j * HOP_SIZE) / SAMPLE_RATE, chord: chord, strength: strength });
        prevChord = chord;
      }
    }
    return { segments: segments, clipDuration: clipDuration };
  } finally {
    try { fs.unlinkSync(wavPath); } catch (e) {}
  }
}

// Collapse transient flicker: merge segments shorter than MIN_CHORD_DURATION
// into the previous segment, re-collapse newly-adjacent duplicates, and drop
// "no chord" silence segments. Returns [{ chord, time, duration, strength }].
function smoothChordTimeline(segments, clipDuration) {
  if (!segments || segments.length === 0) return [];

  var withDur = segments.map(function (seg, i) {
    var end = (i + 1 < segments.length) ? segments[i + 1].time : clipDuration;
    return { chord: seg.chord, strength: seg.strength, duration: Math.max(0, end - seg.time) };
  });

  var merged = [];
  for (var i = 0; i < withDur.length; i++) {
    var seg = withDur[i];
    if (seg.duration < MIN_CHORD_DURATION && merged.length > 0) {
      merged[merged.length - 1].duration += seg.duration;
    } else {
      merged.push(seg);
    }
  }

  var collapsed = [];
  for (var i = 0; i < merged.length; i++) {
    var seg = merged[i];
    if (seg.chord === NO_CHORD_LABEL) continue;
    var last = collapsed[collapsed.length - 1];
    if (last && last.chord === seg.chord) {
      last.duration += seg.duration;
      last.strength = Math.max(last.strength, seg.strength);
    } else {
      collapsed.push({ chord: seg.chord, strength: seg.strength, duration: seg.duration });
    }
  }

  var t = 0;
  for (var i = 0; i < collapsed.length; i++) {
    collapsed[i].time = t;
    t += collapsed[i].duration;
  }
  return collapsed;
}

// Returns { vocabulary, progression, distinctCount, avgStrength }
function summarizeTimeline(timeline) {
  var totalDuration = 0, weightedStrength = 0;
  var durationByChord = {};
  var progression = [];
  timeline.forEach(function (s) {
    totalDuration += s.duration;
    weightedStrength += s.strength * s.duration;
    durationByChord[s.chord] = (durationByChord[s.chord] || 0) + s.duration;
    if (progression.length === 0 || progression[progression.length - 1] !== s.chord) {
      progression.push(s.chord);
    }
  });
  // Only chords that ring for a meaningful share of the clip make the
  // vocabulary — brief detections at section boundaries are noise, and any
  // noise here gets baked into the chart because the LLM is told to use
  // exactly these chords.
  var vocabulary = Object.keys(durationByChord)
    .filter(function (c) { return totalDuration > 0 && durationByChord[c] / totalDuration >= MIN_VOCAB_SHARE; })
    .sort(function (a, b) { return durationByChord[b] - durationByChord[a]; })
    .slice(0, MAX_VOCAB_SIZE);
  var inVocab = {};
  vocabulary.forEach(function (c) { inVocab[c] = true; });
  var cleanProgression = [];
  progression.forEach(function (c) {
    if (!inVocab[c]) return;
    if (cleanProgression.length === 0 || cleanProgression[cleanProgression.length - 1] !== c) {
      cleanProgression.push(c);
    }
  });
  return {
    vocabulary: vocabulary,
    progression: cleanProgression.slice(0, MAX_PROGRESSION_LENGTH),
    distinctCount: vocabulary.length,
    avgStrength: totalDuration > 0 ? weightedStrength / totalDuration : 0,
  };
}

async function analyzeAudioForChords(title, artist) {
  var previewUrl = await findItunesPreview(title, artist);
  if (!previewUrl) {
    console.log("audioAnalysis: no iTunes preview found for", title, "by", artist);
    return null;
  }

  var previewBuffer;
  try {
    previewBuffer = await downloadBuffer(previewUrl);
  } catch (e) {
    console.log("audioAnalysis: failed to download preview:", e.message);
    return null;
  }

  console.log("audioAnalysis: running Demucs on 30s preview for", title, "by", artist, "...");
  var stemsPromise = runDemucs(previewBuffer);
  var keyPromise = detectKeyFromAudio(previewBuffer).catch(function () { return null; });
  var stems = await stemsPromise;
  var detectedKey = await keyPromise;
  if (!stems) return null;

  var stemOrder = ["guitar", "other"];
  for (var i = 0; i < stemOrder.length; i++) {
    var stemName = stemOrder[i];
    var stemUrl = stems[stemName];
    if (!stemUrl) continue;
    try {
      var stemBuffer = await downloadBuffer(stemUrl);
      var raw = await detectChordsFromAudio(stemBuffer);
      var timeline = smoothChordTimeline(raw.segments, raw.clipDuration);
      var summary = summarizeTimeline(timeline);
      if (summary.distinctCount >= MIN_DISTINCT_CHORDS && summary.avgStrength >= MIN_AVG_STRENGTH) {
        console.log("audioAnalysis: using " + stemName + " stem - " + summary.distinctCount + " chords, avg strength " + summary.avgStrength.toFixed(2));
        return {
          chords: summary.vocabulary,
          progression: summary.progression,
          key: detectedKey,
          sourceClip: "itunes_preview_30s",
        };
      }
      console.log("audioAnalysis: " + stemName + " stem too weak (" + summary.distinctCount + " chords, avg strength " + summary.avgStrength.toFixed(2) + ") - trying next");
    } catch (e) {
      console.log("audioAnalysis: chord detection failed on " + stemName + " stem:", e.message);
    }
  }

  return null;
}

module.exports = { analyzeAudioForChords, detectKeyFromAudio };
