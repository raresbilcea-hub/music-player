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
const { execFile } = require("child_process");
const axios = require("axios");
const FormData = require("form-data");
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

const MAX_SONG_SECONDS = 600;     // skip YouTube hits longer than 10 min (live sets, mixes)
const MIN_CHORD_DURATION = 0.6;   // seconds — segments shorter than this are flicker
const MIN_DISTINCT_CHORDS = 2;    // quality gate
const MIN_AVG_STRENGTH = 0.4;     // quality gate
const MIN_VOCAB_SHARE = 0.04;        // minimum share of the clip for any chord
const MIN_NON_DIATONIC_SHARE = 0.15; // chords outside the detected key need much more
const MAX_VOCAB_SIZE = 6;
const MAX_PROGRESSION_LENGTH = 16;
const NO_CHORD_LABEL = "N";       // essentia's "no chord / silence" label

function normalizeForMatch(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s*[\(\[].*?[\)\]]/g, "")  // drop "(Band Version)", "[Remastered]"
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function artistLooselyMatches(a, b) {
  var na = normalizeForMatch(a).replace(/\s*(feat|featuring|with|and|x)\s+.*$/, "").trim();
  var nb = normalizeForMatch(b).replace(/\s*(feat|featuring|with|and|x)\s+.*$/, "").trim();
  if (!na || !nb) return false;
  return na === nb || na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1;
}

async function findItunesPreview(title, artist) {
  try {
    var url = "https://itunes.apple.com/search?term=" + encodeURIComponent(title + " " + artist) + "&entity=song&limit=10";
    var res = await axios.get(url);
    var results = res.data.results || [];

    // iTunes ranks by popularity/promotion, not relevance — the first hit
    // can be a totally different song (observed: searching "Redemption Song
    // Bob Marley" returned a new Jessie Reyez collab first). Only accept a
    // result whose title AND artist actually match what we asked for.
    var wantTitle = normalizeForMatch(title);
    var match = results.find(function (r) {
      return normalizeForMatch(r.trackName) === wantTitle && artistLooselyMatches(r.artistName, artist) && r.previewUrl;
    });
    // Fall back to a prefix title match ("Redemption Song" vs a version-tagged
    // release) before giving up.
    if (!match) {
      match = results.find(function (r) {
        var t = normalizeForMatch(r.trackName);
        return (t.indexOf(wantTitle) === 0 || wantTitle.indexOf(t) === 0) && artistLooselyMatches(r.artistName, artist) && r.previewUrl;
      });
    }
    if (!match) {
      console.log("audioAnalysis: no iTunes result matched '" + title + "' by '" + artist + "'");
      return null;
    }
    console.log("audioAnalysis: using iTunes preview '" + match.trackName + "' by '" + match.artistName + "' (" + (match.collectionName || "single") + ")");
    return match.previewUrl;
  } catch (e) {
    console.log("audioAnalysis: iTunes preview lookup failed:", e.message);
    return null;
  }
}

async function downloadBuffer(url) {
  var res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

// ─── Full-song audio via YouTube (yt-dlp) ─────────────────────────────────────
// Founder's decision (see CLAUDE.md roadmap): analyze the full recording, not
// just the 30s preview. yt-dlp ships as a declared npm dependency
// (youtube-dl-exec) — no runtime downloads. YouTube bot-blocks many
// datacenter IPs, so every failure here returns null and the caller falls
// back to the iTunes preview path.

// Resolve yt-dlp: a system install (brew locally, nixpacks on Railway —
// see nixpacks.toml) is preferred; the npm-bundled zipapp works wherever
// Python >= 3.10 exists.
var YT_DLP_CANDIDATES = [
  process.env.YT_DLP_PATH,
  "/opt/homebrew/bin/yt-dlp",
  "/usr/local/bin/yt-dlp",
  "/usr/bin/yt-dlp",
  path.join(__dirname, "node_modules", "youtube-dl-exec", "bin", "yt-dlp"),
].filter(Boolean);

function resolveYtDlp() {
  for (var i = 0; i < YT_DLP_CANDIDATES.length; i++) {
    if (fs.existsSync(YT_DLP_CANDIDATES[i])) return YT_DLP_CANDIDATES[i];
  }
  return null;
}

function runYtDlp(args, timeoutMs) {
  return new Promise(function (resolve) {
    execFile(resolveYtDlp(), args, { timeout: timeoutMs || 180000, maxBuffer: 10 * 1024 * 1024 }, function (err, stdout, stderr) {
      resolve({ err: err, stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

// Download the full song from YouTube. Returns { buffer, videoTitle } or null.
async function downloadFullSong(title, artist) {
  if (!resolveYtDlp()) {
    console.log("audioAnalysis: yt-dlp not installed — full-song path unavailable");
    return null;
  }

  var query = "ytsearch3:" + title + " " + artist + " official audio";
  // Probe the search results first (cheap, metadata only) and pick the first
  // hit whose video title actually contains the song title — same defense as
  // the iTunes matcher: search ranking is not relevance.
  var probe = await runYtDlp([
    query,
    "--print", "%(id)s\t%(duration)s\t%(title)s",
    "--no-playlist", "--no-warnings", "--skip-download",
  ], 60000);
  if (probe.err) {
    console.log("audioAnalysis: YouTube search failed:", (probe.stderr || probe.err.message).split("\n")[0]);
    return null;
  }

  var wantTitle = normalizeForMatch(title);
  var chosen = null;
  probe.stdout.split("\n").forEach(function (line) {
    if (chosen) return;
    var parts = line.split("\t");
    if (parts.length < 3) return;
    var duration = parseFloat(parts[1]);
    var videoTitle = parts.slice(2).join("\t");
    if (!duration || duration > MAX_SONG_SECONDS || duration < 60) return;
    if (normalizeForMatch(videoTitle).indexOf(wantTitle) === -1) return;
    chosen = { id: parts[0], duration: duration, title: videoTitle };
  });
  if (!chosen) {
    console.log("audioAnalysis: no YouTube result matched '" + title + "' — falling back to preview");
    return null;
  }
  console.log("audioAnalysis: downloading full song from YouTube: \"" + chosen.title + "\" (" + Math.round(chosen.duration) + "s)");

  var outPath = path.join(os.tmpdir(), "fullsong-" + crypto.randomUUID() + ".mp3");
  var dl = await runYtDlp([
    "https://www.youtube.com/watch?v=" + chosen.id,
    "-f", "bestaudio",
    "-x", "--audio-format", "mp3", "--audio-quality", "128K",
    "--max-filesize", "25M",
    "--no-playlist", "--no-warnings",
    "--ffmpeg-location", ffmpegPath,
    "-o", outPath,
  ], 240000);
  if (dl.err || !fs.existsSync(outPath)) {
    console.log("audioAnalysis: YouTube download failed:", (dl.stderr || (dl.err && dl.err.message) || "no output file").split("\n")[0]);
    try { fs.unlinkSync(outPath); } catch (_) {}
    return null;
  }
  var buffer = fs.readFileSync(outPath);
  try { fs.unlinkSync(outPath); } catch (_) {}
  console.log("audioAnalysis: full song downloaded (" + (buffer.length / 1024 / 1024).toFixed(1) + " MB)");
  return { buffer: buffer, videoTitle: chosen.title };
}

// Replicate's data-URI inputs are only safe for small files; full songs go
// through the Files API and are passed by URL instead.
async function uploadToReplicate(buffer) {
  var form = new FormData();
  form.append("content", buffer, { filename: "audio.mp3", contentType: "audio/mpeg" });
  var res = await axios.post("https://api.replicate.com/v1/files", form, {
    headers: Object.assign({ Authorization: "Bearer " + REPLICATE_API_TOKEN }, form.getHeaders()),
    maxBodyLength: 50 * 1024 * 1024,
  });
  return res.data && res.data.urls && res.data.urls.get ? res.data.urls.get : null;
}

async function runDemucs(audioBuffer) {
  if (!REPLICATE_API_TOKEN) {
    console.log("audioAnalysis: no REPLICATE_API_TOKEN configured, skipping Demucs");
    return null;
  }
  try {
    // Small clips ride along as data URIs; full songs are uploaded to
    // Replicate's Files API first and passed by URL.
    var audioInput;
    if (audioBuffer.length > 1024 * 1024) {
      audioInput = await uploadToReplicate(audioBuffer);
      if (!audioInput) {
        console.log("audioAnalysis: Replicate file upload failed");
        return null;
      }
    } else {
      audioInput = "data:audio/mp4;base64," + audioBuffer.toString("base64");
    }
    var createRes = await axios.post(
      "https://api.replicate.com/v1/predictions",
      {
        version: REPLICATE_DEMUCS_VERSION,
        input: {
          audio: audioInput,
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
    var maxPolls = 300; // ~10 minutes safety cap (full songs take a while)
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

// ─── Diatonic filtering ──────────────────────────────────────────────────────
// Essentia's chord labels are major ("G") or minor ("Em") triads. Given a
// detected key, the six diatonic triads are trusted at a low duration share;
// anything outside the key needs a much larger share to survive (it's far
// more often a detection artifact than a real borrowed chord in a 30s clip).

var NOTE_TO_SEMITONE = { "C": 0, "C#": 1, "Db": 1, "D": 2, "D#": 3, "Eb": 3, "E": 4, "F": 5, "F#": 6, "Gb": 6, "G": 7, "G#": 8, "Ab": 8, "A": 9, "A#": 10, "Bb": 10, "B": 11, "Cb": 11 };

function isDiatonic(chordLabel, key) {
  var km = String(key || "").match(/^([A-G][#b]?)\s+(major|minor)$/i);
  var cm = String(chordLabel || "").match(/^([A-G][#b]?)(m?)$/);
  if (!km || !cm) return true; // can't tell -> don't filter on it
  var keyRoot = NOTE_TO_SEMITONE[km[1]];
  var chordRoot = NOTE_TO_SEMITONE[cm[1]];
  if (keyRoot === undefined || chordRoot === undefined) return true;
  var chordIsMinor = cm[2] === "m";
  // [interval from key root, triad is minor]
  var triads = /major/i.test(km[2])
    ? [[0, false], [2, true], [4, true], [5, false], [7, false], [9, true]]
    : [[0, true], [3, false], [5, true], [7, true], [8, false], [10, false]];
  return triads.some(function (t) {
    return (keyRoot + t[0]) % 12 === chordRoot && t[1] === chordIsMinor;
  });
}

// Returns { vocabulary, progression, distinctCount, avgStrength }
function summarizeTimeline(timeline, detectedKey) {
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
  // exactly these chords. Chords in the detected key are trusted at a low
  // share; out-of-key chords need a large share to count.
  var vocabulary = Object.keys(durationByChord)
    .filter(function (c) {
      if (totalDuration <= 0) return false;
      var share = durationByChord[c] / totalDuration;
      var threshold = isDiatonic(c, detectedKey) ? MIN_VOCAB_SHARE : MIN_NON_DIATONIC_SHARE;
      return share >= threshold;
    })
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
  // Best source first: the full song from YouTube. Falls back to the 30s
  // iTunes preview when YouTube is blocked or has no matching video.
  var sourceClip = null;
  var audioBuffer = null;

  var fullSong = await downloadFullSong(title, artist).catch(function (e) {
    console.log("audioAnalysis: full-song path error:", e.message);
    return null;
  });
  if (fullSong) {
    audioBuffer = fullSong.buffer;
    sourceClip = "youtube_full";
  } else {
    var previewUrl = await findItunesPreview(title, artist);
    if (!previewUrl) {
      console.log("audioAnalysis: no iTunes preview found for", title, "by", artist);
      return null;
    }
    try {
      audioBuffer = await downloadBuffer(previewUrl);
    } catch (e) {
      console.log("audioAnalysis: failed to download preview:", e.message);
      return null;
    }
    sourceClip = "itunes_preview_30s";
  }

  console.log("audioAnalysis: running Demucs on " + sourceClip + " for", title, "by", artist, "...");
  var stemsPromise = runDemucs(audioBuffer);
  var keyPromise = detectKeyFromAudio(audioBuffer).catch(function () { return null; });
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
      var summary = summarizeTimeline(timeline, detectedKey);
      if (summary.distinctCount >= MIN_DISTINCT_CHORDS && summary.avgStrength >= MIN_AVG_STRENGTH) {
        console.log("audioAnalysis: using " + stemName + " stem - " + summary.distinctCount + " chords, avg strength " + summary.avgStrength.toFixed(2));
        return {
          chords: summary.vocabulary,
          progression: summary.progression,
          key: detectedKey,
          // clip-relative [{ chord, time, duration }], noise chords removed
          // so alignment can't place a chord the vocabulary rejected
          timeline: timeline.filter(function (s) { return summary.vocabulary.indexOf(s.chord) !== -1; }),
          clipDuration: raw.clipDuration,
          vocalsUrl: stems.vocals || null, // for Whisper-based lyric alignment
          sourceClip: sourceClip,
        };
      }
      console.log("audioAnalysis: " + stemName + " stem too weak (" + summary.distinctCount + " chords, avg strength " + summary.avgStrength.toFixed(2) + ") - trying next");
    } catch (e) {
      console.log("audioAnalysis: chord detection failed on " + stemName + " stem:", e.message);
    }
  }

  return null;
}

module.exports = {
  analyzeAudioForChords,
  detectKeyFromAudio,
  // exposed for test scripts only
  _internals: { detectChordsFromAudio, smoothChordTimeline, summarizeTimeline, isDiatonic, findItunesPreview, downloadFullSong },
};
