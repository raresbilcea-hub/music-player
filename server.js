require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const FormData = require("form-data");
const OpenAI = require("openai");
const cheerio = require("cheerio");
const { createClient } = require("@supabase/supabase-js");
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { analyzeAudioForChords } = require("./audioAnalysis");

const app = express();
const port = 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Tell Express to honour Railway's X-Forwarded-For so req.ip is the real client IP
app.set("trust proxy", true);

// ─── Rate limiting ────────────────────────────────────────────────────────────
// Simple in-memory daily counter per IP per route. Protects the OpenAI / AudD
// / Whisper budgets from being drained by a single client. Resets at server
// restart (Railway naturally restarts on deploy) or after 24h of inactivity.
//
// This is intentionally a tiny, dependency-free implementation. If/when we
// horizontally scale, swap this for a Redis-backed limiter.

var rateLimitState = Object.create(null);  // { "ip|route": { count, resetAt } }
var DAY_MS = 24 * 60 * 60 * 1000;

function rateLimit(route, max) {
  return function (req, res, next) {
    var ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    // x-forwarded-for can be a comma-separated chain — take the first
    if (typeof ip === "string" && ip.indexOf(",") !== -1) ip = ip.split(",")[0].trim();
    var key = ip + "|" + route;
    var now = Date.now();
    var entry = rateLimitState[key];
    if (!entry || entry.resetAt < now) {
      entry = { count: 0, resetAt: now + DAY_MS };
      rateLimitState[key] = entry;
    }
    entry.count += 1;
    if (entry.count > max) {
      var hoursLeft = Math.ceil((entry.resetAt - now) / (60 * 60 * 1000));
      console.log("RateLimit: " + ip + " hit " + route + " " + entry.count + "x (limit " + max + ")");
      return res.status(429).json({
        error: "Daily limit reached for this endpoint. Try again in ~" + hoursLeft + " hour(s).",
        retryAfterHours: hoursLeft,
      });
    }
    next();
  };
}

// Periodic cleanup: prune entries whose window has fully expired so the map
// doesn't grow forever for one-shot visitors.
setInterval(function () {
  var now = Date.now();
  for (var key in rateLimitState) {
    if (rateLimitState[key].resetAt < now) delete rateLimitState[key];
  }
}, 60 * 60 * 1000);  // every hour

// ─── Shared helpers ───────────────────────────────────────────────────────────

// Loose artist comparison so "Hannes" matches "Hannes & waterbaby" or
// "Bob Marley" matches "Bob Marley & The Wailers". Sources disagree on
// featured-artist suffixes, and an exact-match miss regenerates the chart
// from scratch — potentially shadowing a musician-verified one.
function artistsLooselyMatch(a, b) {
  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/\s*(&|and|feat\.?|featuring|with|x|,)\s+.*$/i, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }
  var na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1;
}

async function fetchChartFromDB(title, artist) {
  var { data: rows } = await supabase
    .from("chord_charts")
    .select("*")
    .ilike("title", title)
    .limit(10);
  if (!rows || rows.length === 0) return null;

  var candidates = rows.filter(function (r) { return artistsLooselyMatch(r.artist, artist); });
  if (candidates.length === 0) return null;

  // Prefer musician-verified charts, then the most-played one.
  candidates.sort(function (a, b) {
    if (!!b.verified !== !!a.verified) return b.verified ? 1 : -1;
    return (b.play_count || 0) - (a.play_count || 0);
  });
  var r = candidates[0];
  await supabase.from("chord_charts").update({ play_count: (r.play_count || 0) + 1 }).eq("id", r.id);
  return { title: r.title, artist: r.artist, musicalKey: r.musical_key, tempo: r.tempo, capo: r.capo, sections: r.sections, verified: r.verified, source: r.source };
}

async function lookupSpotifyKey(title, artist) {
  var spotifyKey = null, spotifyTempo = null;
  try {
    console.log("Spotify: requesting token...");
    var tokenResponse = await axios.post(
      "https://accounts.spotify.com/api/token",
      "grant_type=client_credentials",
      { headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET).toString("base64") } }
    );
    var spotifyToken = tokenResponse.data.access_token;

    var searchResponse = await axios.get("https://api.spotify.com/v1/search", {
      headers: { "Authorization": "Bearer " + spotifyToken },
      params: { q: title + " " + artist, type: "track", limit: 1 }
    });
    var tracks = searchResponse.data.tracks.items;
    console.log("Spotify: search hits:", tracks.length);

    if (tracks.length > 0) {
      var trackId = tracks[0].id;
      console.log("Spotify: matched track:", tracks[0].name, "id:", trackId);
      var analysisResponse = await axios.get("https://api.spotify.com/v1/audio-analysis/" + trackId, {
        headers: { "Authorization": "Bearer " + spotifyToken },
        validateStatus: null
      });
      console.log("Spotify: audio-analysis status:", analysisResponse.status);
      if (analysisResponse.status === 200 && analysisResponse.data && analysisResponse.data.track) {
        var at = analysisResponse.data.track;
        if (at.key !== undefined && at.key !== -1) {
          var KEY_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
          spotifyKey = KEY_NAMES[at.key] + (at.mode === 1 ? " major" : " minor");
          spotifyTempo = Math.round(at.tempo);
          console.log("Spotify: key:", spotifyKey, "tempo:", spotifyTempo);
        } else {
          console.log("Spotify: key undetected (key=-1)");
        }
      } else {
        console.log("Spotify: audio-analysis unavailable (status " + analysisResponse.status + ")");
      }
    }
  } catch(e) {
    console.error("Spotify error:", e.message);
  }
  return { spotifyKey, spotifyTempo };
}

// ─── Title / artist normalization ────────────────────────────────────────────
// Strips parenthetical decorations and common suffixes that prevent lrclib's
// exact match from finding the canonical recording.
//   "Bohemian Rhapsody (Remastered 2011)"     -> "Bohemian Rhapsody"
//   "One Love / People Get Ready - Live"      -> "One Love / People Get Ready"
//   "Bob Marley & The Wailers"                -> "Bob Marley"
//   "Drake feat. Future"                      -> "Drake"

function normalizeForLookup(s) {
  return String(s || "")
    .replace(/\s*\([^)]*\)\s*/g, " ")                                              // "(Remastered 2015)"
    .replace(/\s*\[[^\]]*\]\s*/g, " ")                                             // "[Live]"
    .replace(/\s*-\s*(Remastered|Remaster|Live|Acoustic|Demo|Mono|Stereo|Single Version|Album Version|Radio Edit|Edit|Bonus Track)[^-]*$/i, "")
    .replace(/\s*(feat\.?|featuring|ft\.?)\s+.+$/i, "")
    .replace(/\s+&\s+The\s+\w+.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Lyrics fetching (lrclib /get → lrclib /search → lyrics.ovh) ────────────

// All lyric fetchers return { plain, synced } — synced is the raw LRC text
// ("[00:17.55] Old pirates...") when the source has it, else null. The
// synced timestamps drive the chord-to-lyric alignment in the audio
// pipeline; plain text remains the "VERIFIED LYRICS" block for the LLM.

async function lrclibGet(title, artist) {
  // lrclib is the only source of time-stamped lyrics (which drive chord
  // alignment), so it gets a generous timeout and one retry — a transient
  // slow response here would silently degrade the whole chart.
  var params = "artist_name=" + encodeURIComponent(artist) + "&track_name=" + encodeURIComponent(title);
  for (var attempt = 1; attempt <= 2; attempt++) {
    try {
      var res = await axios.get("https://lrclib.net/api/get?" + params, { timeout: 12000 });
      if (res.data && res.data.plainLyrics && res.data.plainLyrics.trim().length > 80) {
        return { plain: res.data.plainLyrics.trim(), synced: res.data.syncedLyrics || null };
      }
      return null; // real 200 without usable lyrics — no point retrying
    } catch(e) {
      if (e.response && e.response.status === 404) return null; // not found is normal
      console.log("lrclib /get attempt " + attempt + " failed: " + e.message);
    }
  }
  return null;
}

async function lrclibSearch(title, artist) {
  try {
    var q = "q=" + encodeURIComponent(title + " " + artist);
    var res = await axios.get("https://lrclib.net/api/search?" + q, { timeout: 12000 });
    var hits = Array.isArray(res.data) ? res.data : [];
    var nT = normalizeForLookup(title).toLowerCase();
    var nA = normalizeForLookup(artist).toLowerCase().split(" ")[0]; // first artist word
    // Prefer hits whose title + artist roughly match the request
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h || !h.plainLyrics || h.plainLyrics.length < 80) continue;
      var hT = String(h.trackName  || "").toLowerCase();
      var hA = String(h.artistName || "").toLowerCase();
      var titleOk  = hT.indexOf(nT) !== -1 || nT.indexOf(hT) !== -1;
      var artistOk = nA && (hA.indexOf(nA) !== -1 || nA.indexOf(hA.split(" ")[0]) !== -1);
      if (titleOk && artistOk) return { plain: h.plainLyrics.trim(), synced: h.syncedLyrics || null };
    }
    // No good match, fall back to top hit if it has substantial lyrics
    if (hits[0] && hits[0].plainLyrics && hits[0].plainLyrics.trim().length > 200) {
      return { plain: hits[0].plainLyrics.trim(), synced: hits[0].syncedLyrics || null };
    }
  } catch(e) { console.log("lrclib /search error:", e.message); }
  return null;
}

async function fetchLyricsFromOVH(title, artist) {
  try {
    var url = "https://api.lyrics.ovh/v1/" + encodeURIComponent(artist) + "/" + encodeURIComponent(title);
    var res = await axios.get(url, { timeout: 6000 });
    // 200-char floor — lyrics.ovh sometimes returns truncated junk
    if (res.data && res.data.lyrics && res.data.lyrics.trim().length > 200) {
      return { plain: res.data.lyrics.trim(), synced: null };
    }
  } catch(e) { /* 404 is normal */ }
  return null;
}

async function fetchRealLyrics(rawTitle, rawArtist) {
  var title  = normalizeForLookup(rawTitle);
  var artist = normalizeForLookup(rawArtist);

  console.log("Lyrics: lrclib /get normalized -> '" + title + "' / '" + artist + "'");
  var l = await lrclibGet(title, artist);
  if (l) { console.log("Lyrics: lrclib /get hit (" + l.plain.length + " chars, synced: " + !!l.synced + ")"); return l; }

  if (rawTitle !== title || rawArtist !== artist) {
    console.log("Lyrics: lrclib /get raw -> '" + rawTitle + "' / '" + rawArtist + "'");
    l = await lrclibGet(rawTitle, rawArtist);
    if (l) { console.log("Lyrics: lrclib /get raw hit (" + l.plain.length + " chars, synced: " + !!l.synced + ")"); return l; }
  }

  console.log("Lyrics: lrclib /search...");
  l = await lrclibSearch(title, artist);
  if (l) { console.log("Lyrics: lrclib /search hit (" + l.plain.length + " chars, synced: " + !!l.synced + ")"); return l; }

  console.log("Lyrics: lyrics.ovh...");
  l = await fetchLyricsFromOVH(title, artist);
  if (l) { console.log("Lyrics: lyrics.ovh hit (" + l.plain.length + " chars)"); return l; }

  console.log("Lyrics: not found — AI will recall from training data");
  return null;
}

// ─── ChordPro parsing + chart validation ────────────────────────────────────
// We ask the LLM to emit ChordPro inline format (e.g. "[G]Hello dar[Am]ling")
// instead of computing character positions itself. The server then parses
// the brackets and computes accurate positions — this is the main reliability
// fix: it removes character counting from the LLM's job.

var SECTION_RE = /^(intro|verse|pre[ -]?chorus|chorus|post[ -]?chorus|bridge|hook|interlude|instrumental|solo|outro|breakdown|refrain|tag|coda|ending|drop|build|riff)/i;

function parseChordPro(text) {
  var rawLines = String(text || "").split(/\r?\n/);
  var sections = [];
  var current  = null;

  function ensureSection() {
    if (!current) current = { label: "Verse", lines: [] };
  }

  function parseInline(rawLine) {
    var lyrics = "";
    var chords = [];
    var i = 0;
    while (i < rawLine.length) {
      if (rawLine[i] === "[") {
        var end = rawLine.indexOf("]", i);
        if (end === -1) {
          // Unterminated bracket. If the rest looks like a chord fragment
          // the model forgot to close ("[A", "[Em7"), drop it rather than
          // leak it into the lyrics; otherwise keep the text as-is.
          var rest = rawLine.substring(i);
          if (!/^\[[A-G][#b]?[A-Za-z0-9\/]*\s*$/.test(rest)) lyrics += rest;
          break;
        }
        var chord = rawLine.substring(i + 1, end).trim();
        if (chord) chords.push({ chord: chord, position: lyrics.length });
        i = end + 1;
      } else {
        lyrics += rawLine[i];
        i++;
      }
    }
    ensureSection();
    current.lines.push({ lyrics: lyrics.replace(/\s+$/, ""), chords: chords });
  }

  for (var li = 0; li < rawLines.length; li++) {
    var line    = rawLines[li];
    var trimmed = line.trim();

    if (trimmed === "") {
      // blank line = soft section boundary; commit current if it has content
      if (current && current.lines.length > 0) { sections.push(current); current = null; }
      continue;
    }

    // Section header forms: "[Verse 1]", "(Chorus)", "Verse 1:"
    var m =
      trimmed.match(/^\[([^\]]+)\]$/) ||
      trimmed.match(/^\(([^)]+)\)$/) ||
      trimmed.match(/^([A-Z][A-Za-z0-9 \-]{1,30}):$/);
    if (m && SECTION_RE.test(m[1].trim())) {
      if (current && current.lines.length > 0) sections.push(current);
      current = { label: m[1].trim(), lines: [] };
      continue;
    }

    parseInline(line);
  }
  if (current && current.lines.length > 0) sections.push(current);
  return sections;
}

function validateAndRepairChart(chart) {
  var out = {
    title:      String(chart.title  || ""),
    artist:     String(chart.artist || ""),
    musicalKey: chart.musicalKey || null,
    tempo:      chart.tempo      || null,
    capo:       (chart.capo === 0 || chart.capo) ? chart.capo : 0,
    sections:   [],
  };
  var rawSections = Array.isArray(chart.sections) ? chart.sections : [];
  for (var i = 0; i < rawSections.length; i++) {
    var s = rawSections[i] || {};
    var lines = Array.isArray(s.lines) ? s.lines : [];
    var cleanLines = [];
    for (var j = 0; j < lines.length; j++) {
      var ln = lines[j] || {};
      var lyrics = String(ln.lyrics || "").replace(/\s+$/, "");
      var chords = Array.isArray(ln.chords) ? ln.chords : [];
      var cleanChords = [];
      for (var k = 0; k < chords.length; k++) {
        var c = chords[k] || {};
        var name = String(c.chord || "").trim();
        if (!name) continue;
        var pos = Number(c.position);
        if (!Number.isFinite(pos) || pos < 0) pos = 0;
        var maxPos = Math.max(0, lyrics.length);
        if (pos > maxPos) pos = maxPos;
        cleanChords.push({ chord: name, position: pos });
      }
      cleanChords.sort(function(a, b) { return a.position - b.position; });
      if (lyrics.length === 0 && cleanChords.length === 0) continue;
      cleanLines.push({ lyrics: lyrics, chords: cleanChords });
    }
    if (cleanLines.length === 0) continue;
    out.sections.push({ label: String(s.label || "Verse"), lines: cleanLines });
  }
  return out;
}

// ─── Chart generation ─────────────────────────────────────────────────────────

async function generateChartWithAI(title, artist, releaseDate, spotifyKey, spotifyTempo, realLyrics, detectedChords, alignedLines) {
  var keyInfo = spotifyKey
    ? "Confirmed musical key: " + spotifyKey + " (measured from the recording)."
    : "Identify the exact musical key from your training data.";
  var tempoInfo = spotifyTempo ? " Tempo: " + spotifyTempo + " BPM (Spotify)." : "";

  // Pre-compute the enharmonic preference — if Spotify says a flat key, lock
  // chord names to flats; if sharp, lock to sharps. Avoids the "Db song with
  // C#m chords" bug class.
  var FLAT_KEYS  = ["F", "Bb", "Eb", "Ab", "Db", "Gb", "Cb"];
  var SHARP_KEYS = ["G", "D", "A", "E", "B", "F#", "C#"];
  var enharmonicHint = "";
  if (spotifyKey) {
    var rootMatch = spotifyKey.match(/^([A-G][#b]?)/);
    var root = rootMatch ? rootMatch[1] : null;
    var isMinor = /minor/i.test(spotifyKey);
    // For minor keys, the enharmonic convention follows the relative major.
    if (root) {
      var prefersFlats = FLAT_KEYS.indexOf(root) !== -1 || (isMinor && /^(D|G|C|F|Bb|Eb)$/.test(root));
      enharmonicHint = prefersFlats
        ? "Use FLAT chord names throughout (Db, Eb, Ab, Bb, Gb, F, Cm, Fm, Bbm). Never write C# / D# / G# / A# in this song — use the flat equivalent (Db, Eb, Ab, Bb)."
        : "Use SHARP chord names throughout (C#, D#, F#, G#, A#, F#m, C#m). Never write Db / Eb / Gb / Ab in this song — use the sharp equivalent.";
    }
  }

  // Common output format spec for both modes — ChordPro inline.
  // The model only inserts [Chord] tags; the server computes character
  // positions afterwards. This eliminates the "off-by-one syllable" failure
  // mode caused by asking an LLM to count characters.
  var FORMAT_SPEC = [
    "OUTPUT FORMAT — plain text, ChordPro inline. No JSON, no markdown fences, no commentary.",
    "  - Each section starts with a header on its own line in square brackets:",
    "      [Intro], [Verse 1], [Pre-Chorus], [Chorus], [Bridge], [Outro], etc.",
    "  - Then the lyrics for that section, one line per line.",
    "  - Place chord names in square brackets INLINE, immediately before the syllable they sound on.",
    "  - No space between ']' and the next character.",
    "  - Example:",
    "      [Verse 1]",
    "      [G]Hello dar[Am]ling, the [C]days drift [G]by",
    "      [Em]Time keeps [C]turning, [G]you and [D]I",
    "  - Standard chord names only: G, D, Em, A7, Cmaj7, F#m, Bb, D/F#. No tablature, no rhythm notation.",
  ].join("\n");

  // If audio analysis (Demucs + Essentia) detected real chords from the
  // original recording, constrain the model to that harmonic content instead
  // of letting it recall/hallucinate chords freely.
  var detectedChordsLines = [];
  if (detectedChords && detectedChords.chords && detectedChords.chords.length > 0) {
    var vocabSize = detectedChords.chords.length;
    detectedChordsLines = [
      "ACTUAL CHORDS DETECTED FROM THE ORIGINAL RECORDING (audio analysis of an isolated stem",
      "from a ~30-second preview clip):",
      "  Chord vocabulary: " + detectedChords.chords.join(", "),
      "  Representative progression sample: " + detectedChords.progression.join(" - "),
      "",
      "The measurement covers only a ~30-second window of the song. That window may land on a",
      "harmonically static section (e.g. a one-chord vamp) while other sections of the song",
      "move through more chords. Apply it accordingly:",
      "  - For the section(s) of the song the progression sample matches, use these measured",
      "    chords exactly (plus simple extensions/variants of them — 7ths, sus, add9, slash",
      "    chords on the same root). Where your recollection conflicts with the measurement",
      "    for that passage, the measurement wins.",
      "  - For the song's OTHER sections, recall their actual chords from your training data.",
      "    Every chord you use beyond the measured vocabulary MUST be diatonic to the confirmed",
      "    key. Do NOT flatten the whole song to the measured vocabulary if you know other",
      "    sections change chords.",
    ];
    if (vocabSize <= 2) {
      detectedChordsLines.push(
        "  - The measured window contains only " + vocabSize + " distinct chord" + (vocabSize === 1 ? "" : "s") + " — it almost certainly",
        "    covers a static section. Expect the rest of the song to move through more chords",
        "    (still diatonic to the confirmed key)."
      );
    }
    detectedChordsLines.push("");
  }

  // Lines whose chord placements were MEASURED by aligning the chord
  // timeline with time-stamped lyrics — the model must reproduce these
  // verbatim and pattern-match the rest of the song to them. alignedLines
  // is { lines, highCoverage } — with full-song audio nearly every line is
  // measured and the model's job collapses to section labelling.
  if (alignedLines && alignedLines.lines && alignedLines.lines.length > 0) {
    var closing = alignedLines.highCoverage
      ? [
          "",
          "Nearly the ENTIRE song above is measured. Your job is ONLY to group these lines",
          "into sections with [Section] headers (and repeat sections where the song repeats",
          "them). For the few unmeasured lines, follow the pattern of their neighbours.",
          "Do not re-harmonize anything.",
          "",
        ]
      : [
          "",
          "These measured lines reveal the song's true chord pattern. Sections parallel to them",
          "(other verses, other choruses, repeats of the same melody) MUST follow the same chord",
          "pattern at the same lyrical positions. Do not simplify or substitute.",
          "",
        ];
    detectedChordsLines = detectedChordsLines.concat([
      "MEASURED FROM THE RECORDING — the following lines were aligned to the actual audio.",
      "When any of these lines appears in the lyrics, output it character-for-character as",
      "written here (same chords, same bracket positions) — never your own version of it:",
      "",
    ], alignedLines.lines.slice(0, 60), closing);
  }

  var systemPrompt, userPrompt;

  if (realLyrics) {
    // ── Mode A: real lyrics in hand — model only places chords ────────────────
    console.log("OpenAI: ChordPro placement mode (verified lyrics, " + realLyrics.length + " chars)");
    systemPrompt = [
      "You are a world-class guitarist and music transcriptionist.",
      "",
      "TASK",
      "You will be given the verified lyrics of a song. Re-emit the song in ChordPro inline format with accurate chords from the original recording placed inline before the syllable they sound on.",
      "",
      FORMAT_SPEC,
      "",
      ...detectedChordsLines,
      "RULES",
      "  1. COPY THE LYRICS WORD-FOR-WORD. Do not change, omit, fix, or invent a single word.",
      "  2. Use the ACTUAL chords from the original recording — recall them from your training data, do not substitute generic ones.",
      "  3. Every line of lyrics must carry at least one chord.",
      "  4. Group lines into the song's real sections: Intro, Verse, Pre-Chorus, Chorus, Bridge, Outro, etc. Use [Section] headers.",
      "  5. If the verified lyrics already contain [Section] markers, preserve them.",
      "  6. The first line of your response MUST be a section header in square brackets.",
      "  7. KEY ENFORCEMENT — if a confirmed key is given, every chord MUST be diatonic to that key, or a clearly recognised borrowed-chord exception used in the original recording. Do NOT pick a chord whose root is foreign to the key.",
      "  8. " + (enharmonicHint || "Pick one enharmonic convention (sharps OR flats) per song and stay consistent. Never mix C# and Db in the same chart."),
      "  9. SIMPLICITY — if you are not certain the song uses many chord changes, prefer the simplest progression that fits the key. Many recordings use only 2-4 chords throughout; do not invent extra changes to seem comprehensive.",
      " 10. If you do not actually know this specific song, output the simplest 2-3 chord progression in the confirmed key and apply it consistently — do not fabricate exotic chord changes.",
    ].join("\n");

    userPrompt = [
      'Song: "' + title + '" by ' + artist + (releaseDate ? " (" + releaseDate + ")" : "") + ".",
      keyInfo + tempoInfo,
      "",
      "VERIFIED LYRICS — copy these exactly, do not alter a single word:",
      "---",
      realLyrics,
      "---",
      "",
      "Emit the full song in ChordPro inline format with the actual chords from the original recording.",
    ].join("\n");

  } else {
    // ── Mode B: no verified lyrics — full recall ──────────────────────────────
    console.log("OpenAI: ChordPro recall mode (no verified lyrics)");
    systemPrompt = [
      "You are a world-class guitarist, lyricist, and music transcriptionist with encyclopedic knowledge of recorded music.",
      "",
      "TASK",
      "Recall the song from your training data and emit it in ChordPro inline format.",
      "",
      FORMAT_SPEC,
      "",
      ...detectedChordsLines,
      "RULES",
      "  1. Lyrics must be EXACT — word-for-word as sung on the original recording. No paraphrasing or invention.",
      "  2. Chords must be ACCURATE — the actual chords from the original recording, not generic substitutes.",
      "  3. Cover every section in order: Intro, Verse 1, Verse 2, Pre-Chorus, Chorus, Bridge, Outro, etc.",
      "  4. Every line of lyrics must carry at least one chord.",
      "  5. Do not invent placeholder text like 'la la la' or '[unintelligible]'.",
      "  6. The first line of your response MUST be a section header in square brackets.",
      "  7. KEY ENFORCEMENT — if a confirmed key is given, every chord MUST be diatonic to that key, or a clearly recognised borrowed-chord exception used in the original recording. Do NOT pick a chord whose root is foreign to the key.",
      "  8. " + (enharmonicHint || "Pick one enharmonic convention (sharps OR flats) per song and stay consistent. Never mix C# and Db in the same chart."),
      "  9. SIMPLICITY — many indie/folk/pop recordings use only 2-4 chords throughout. If you are not 100% certain of complex chord changes, output the simplest progression that fits the key and apply it consistently.",
      " 10. If you do not actually know this specific song from your training data, do NOT fabricate exotic chord changes. Pick the most common 2-3 chord progression in the confirmed key and use it consistently.",
      "",
      "BEFORE writing, briefly think through:",
      "  - What is the song's structure? (list sections in order)",
      "  - What are the opening words of each section?",
      "  - What chord progression underlies each section?",
    ].join("\n");

    userPrompt = [
      'Recall and transcribe "' + title + '" by ' + artist + (releaseDate ? " (released " + releaseDate + ")" : "") + ".",
      keyInfo + tempoInfo,
      "Output the complete song in ChordPro inline format.",
    ].join("\n");
  }

  var completion = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4096,
    temperature: 0.1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  var raw = completion.choices[0].message.content || completion.choices[0].message.refusal || "";
  console.log("OpenAI: finish_reason:", completion.choices[0].finish_reason, "length:", raw.length);
  if (!raw) throw new Error("OpenAI returned empty response");

  // Strip stray markdown fencing if the model wrapped its output
  raw = raw.replace(/^```[A-Za-z0-9_-]*\s*/m, "").replace(/```\s*$/m, "").trim();

  var sections = parseChordPro(raw);
  if (sections.length === 0) {
    console.error("ChordPro parse produced 0 sections — raw output:\n" + raw.substring(0, 500));
    throw new Error("Could not parse ChordPro output from model");
  }

  var chart = {
    title:      title,
    artist:     artist,
    musicalKey: spotifyKey || null,
    tempo:      spotifyTempo || null,
    capo:       0,
    sections:   sections,
  };
  return validateAndRepairChart(chart);
}

// ─── Chord-to-lyric alignment ─────────────────────────────────────────────────
// The chord timeline knows WHEN each chord sounds (clip-relative seconds);
// synced lyrics know WHEN each line is sung (song-absolute seconds). The
// missing link is the clip's offset within the song — recovered by Whisper-
// transcribing the clip's vocals stem and matching the words against the
// synced lyrics. With the offset known, chord placements for the covered
// lines are computed arithmetically instead of guessed by the LLM.

function parseLrc(synced) {
  var lines = [];
  String(synced || "").split(/\r?\n/).forEach(function (raw) {
    var m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (!m) return;
    var t = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
    lines.push({ t: t, text: m[3].trim() });
  });
  return lines;
}

function alignTokens(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);
}

function tokenDice(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  var setB = {};
  b.forEach(function (w) { setB[w] = (setB[w] || 0) + 1; });
  var hits = 0;
  a.forEach(function (w) { if (setB[w] > 0) { hits++; setB[w]--; } });
  return (2 * hits) / (a.length + b.length);
}

// Whisper-transcribe the vocals stem and locate the clip in the song.
// Returns offset in seconds (song time = clip time + offset) or null.
async function locateClipInSong(vocalsUrl, lrcLines) {
  var tempPath = path.join(os.tmpdir(), "align_vocals_" + Date.now() + ".mp3");
  try {
    var res = await axios.get(vocalsUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(tempPath, Buffer.from(res.data));

    var tr = await openai.audio.transcriptions.create({
      file:            fs.createReadStream(tempPath),
      model:           "whisper-1",
      response_format: "verbose_json",
    });
    var segments = tr.segments || [];
    console.log("Align: Whisper heard " + segments.length + " segments in the vocals stem");

    // Every (segment, lyric-line) pair with decent word overlap implies a
    // candidate offset. Songs repeat lines, so candidates can point at the
    // wrong copy of a line — instead of demanding raw agreement, score each
    // candidate offset by how many segments find a matching lyric line at
    // the position that offset predicts, and keep the best-supported one.
    var usable = segments.filter(function (seg) { return alignTokens(seg.text).length >= 3; });
    var candidates = [];   // offsets implied by any decent (segment, line) match
    var anchors = [];      // high-confidence matches against UNIQUE lyric lines
    var lineTextCounts = {};
    lrcLines.forEach(function (line) {
      var key = alignTokens(line.text).join(" ");
      if (key) lineTextCounts[key] = (lineTextCounts[key] || 0) + 1;
    });
    usable.forEach(function (seg) {
      var segTokens = alignTokens(seg.text);
      lrcLines.forEach(function (line) {
        var lineTokens = alignTokens(line.text);
        var score = tokenDice(segTokens, lineTokens);
        if (score >= 0.5) candidates.push(line.t - seg.start);
        // An anchor: near-verbatim match on a line whose text appears exactly
        // once in the song — it cannot be confused with a repeated chorus
        // line, so a single one is enough to fix the offset.
        if (score >= 0.7 && lineTokens.length >= 6 && lineTextCounts[lineTokens.join(" ")] === 1) {
          anchors.push({ offset: line.t - seg.start, score: score });
        }
      });
    });
    if (candidates.length === 0) {
      console.log("Align: no confident lyric matches — skipping alignment");
      return null;
    }

    var best = null;
    candidates.forEach(function (cand) {
      var implied = [], totalScore = 0;
      usable.forEach(function (seg) {
        var segTokens = alignTokens(seg.text);
        var predicted = seg.start + cand;
        lrcLines.forEach(function (line) {
          if (Math.abs(line.t - predicted) > 2.5) return;
          var score = tokenDice(segTokens, alignTokens(line.text));
          if (score >= 0.4) { implied.push(line.t - seg.start); totalScore += score; }
        });
      });
      if (!best || implied.length > best.implied.length ||
          (implied.length === best.implied.length && totalScore > best.totalScore)) {
        best = { offset: cand, implied: implied, totalScore: totalScore };
      }
    });

    if (!best || best.implied.length < 2) {
      // Fall back to a single near-verbatim match on a unique lyric line.
      if (anchors.length > 0) {
        anchors.sort(function (a, b) { return b.score - a.score; });
        console.log("Align: clip sits at " + anchors[0].offset.toFixed(1) + "s into the song (single unique-line anchor, score " + anchors[0].score.toFixed(2) + ")");
        return anchors[0].offset;
      }
      console.log("Align: no offset supported by 2+ segments (candidates: " + candidates.map(function (c) { return c.toFixed(1); }).join(", ") + ") — skipping");
      return null;
    }
    var offset = best.implied.reduce(function (s, o) { return s + o; }, 0) / best.implied.length;
    console.log("Align: clip sits at " + offset.toFixed(1) + "s into the song (" + best.implied.length + "/" + usable.length + " segments support it)");
    return offset;
  } catch (e) {
    console.log("Align: failed (" + e.message + ") — skipping alignment");
    return null;
  } finally {
    try { fs.unlinkSync(tempPath); } catch (_) {}
  }
}

// Place chords on the lyric lines covered by the clip. Returns an array of
// ChordPro strings ("[G]Old pirates, yes, they [Em]rob I") or null.
function buildAlignedChordPro(timeline, clipDuration, offset, lrcLines) {
  var clipStart = offset, clipEnd = offset + clipDuration;
  var out = [];

  for (var i = 0; i < lrcLines.length; i++) {
    var line = lrcLines[i];
    if (!line.text) continue;
    var lineStart = line.t;
    var lineEnd = (i + 1 < lrcLines.length) ? lrcLines[i + 1].t : lineStart + 8;
    // Only lines fully inside the clip window — partial coverage means
    // chords could be missing from the edges of the line.
    if (lineStart < clipStart + 0.5 || lineEnd > clipEnd) continue;

    var events = []; // { position, chord }
    var soundingAtStart = null;
    timeline.forEach(function (seg) {
      var absTime = seg.time + offset;
      if (absTime <= lineStart && absTime + seg.duration > lineStart) soundingAtStart = seg.chord;
      if (absTime > lineStart && absTime < lineEnd) {
        var frac = (absTime - lineStart) / (lineEnd - lineStart);
        events.push({ position: Math.round(frac * line.text.length), chord: seg.chord });
      }
    });
    if (soundingAtStart) events.unshift({ position: 0, chord: soundingAtStart });
    if (events.length === 0) continue;

    // If chords change faster than ~1.2s within this line, the detector is
    // mushing through a transition (or hearing passing tones) — trust only
    // the chord sounding at the line start rather than teach the LLM noise.
    var lineDur = lineEnd - lineStart;
    if (events.length > 1 && lineDur / events.length < 1.2) {
      events = events.slice(0, 1);
    }

    // Chords belong at word starts; snap each position back to the start of
    // the word it lands in, then drop duplicates that collide.
    var text = line.text;
    var seen = {};
    var snapped = [];
    events.forEach(function (ev) {
      var pos = Math.min(Math.max(ev.position, 0), text.length);
      if (pos > 0 && pos < text.length) {
        pos = text.lastIndexOf(" ", pos - 1) + 1;
      }
      if (seen[pos]) return;
      var prev = snapped[snapped.length - 1];
      if (prev && prev.chord === ev.chord) return;
      seen[pos] = true;
      snapped.push({ position: pos, chord: ev.chord });
    });

    var result = "", cursor = 0;
    snapped.forEach(function (ev) {
      result += text.slice(cursor, ev.position) + "[" + ev.chord + "]";
      cursor = ev.position;
    });
    result += text.slice(cursor);
    out.push(result);
  }
  return out.length >= 3 ? out : null;
}

// Real audio-based chord detection: Demucs (Replicate) isolates a guitar
// stem from a 30s iTunes preview, essentia.js detects chords from it, and
// the AI is constrained to those real chords when placing them against
// lyrics/structure. When synced lyrics exist, chord placements for the
// lines the clip covers are measured (Whisper-anchored) rather than
// guessed. Returns null if any stage doesn't yield enough signal, so the
// caller can fall back to plain AI recall.
async function fetchChartFromAudioAnalysis(title, artist, releaseDate, realLyrics, spotifyKey, spotifyTempo) {
  var detectedChords = await analyzeAudioForChords(title, artist);
  if (!detectedChords) return null;

  console.log("Audio analysis: detected chords", detectedChords.chords.join(", "), "for", title, "by", artist);
  // Spotify's key endpoint is gone (403), so the key heard in the actual
  // recording is our best "confirmed key" for the prompt's key enforcement.
  var confirmedKey = spotifyKey || detectedChords.key || null;

  var alignedLines = null;
  if (realLyrics && realLyrics.synced && detectedChords.vocalsUrl && detectedChords.timeline) {
    var lrcLines = parseLrc(realLyrics.synced);
    if (lrcLines.length >= 4) {
      var offset = await locateClipInSong(detectedChords.vocalsUrl, lrcLines);
      if (offset !== null) {
        var measured = buildAlignedChordPro(detectedChords.timeline, detectedChords.clipDuration, offset, lrcLines);
        if (measured) {
          var lrcWithText = lrcLines.filter(function (l) { return l.text; }).length;
          alignedLines = {
            lines: measured,
            highCoverage: lrcWithText > 0 && measured.length / lrcWithText >= 0.6,
          };
        }
        console.log("Align: " + (measured ? measured.length + " lines measured (coverage " + (alignedLines.highCoverage ? "HIGH" : "partial") + ")" : "not enough covered lines"));
        if (measured) measured.forEach(function (l) { console.log("Align measured | " + l); });
      }
    }
  }

  var chart = await generateChartWithAI(title, artist, releaseDate, confirmedKey, spotifyTempo, realLyrics ? realLyrics.plain : null, detectedChords, alignedLines);
  return { chart: chart, source: "audio_analysis" };
}

async function saveChartToDB(chart, title, artist, source) {
  var saveResult = await supabase.from("chord_charts").upsert({
    title:       chart.title  || title,
    artist:      chart.artist || artist,
    musical_key: chart.musicalKey,
    tempo:       chart.tempo,
    capo:        chart.capo,
    sections:    chart.sections,
    source:      source || "ai_generated",
    verified:    false,
    play_count:  1
  }, { onConflict: "title,artist" });
  console.log("Supabase save:", saveResult.error ? "ERROR: " + saveResult.error.message : "OK (source=" + (source || "ai_generated") + ")");
}

// ─── Chord-source scrapers (Cifra Club + e-chords) ───────────────────────────
// Tried BEFORE the LLM. If a real chord site has the song, the LLM is never
// invoked and the user gets actual chords from a human-curated source.
// We slugify title/artist into the canonical URL each site uses; if the
// direct URL 404s we fall back to the site's search page.

function stripAccents(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function slugify(s) {
  return stripAccents(String(s || ""))
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['"`´’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// A real-browser User-Agent — sites block axios/node-fetch defaults.
var SCRAPER_HEADERS = {
  "User-Agent":       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept":           "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language":  "en-US,en;q=0.9",
};

// ── Cifra Club ──────────────────────────────────────────────────────────────
// Songs live at https://www.cifraclub.com.br/<artist-slug>/<song-slug>/
// Chord chart is in <pre class="cifra_chord"> with <b> tags wrapping chords.

// ── Ultimate-Guitar ─────────────────────────────────────────────────────────
// UG embeds all page data as JSON inside <div class="js-store" data-content="...">
// Search:   https://www.ultimate-guitar.com/search.php?title=<q>&type=300  (300 = Chords)
// Tab page: https://tabs.ultimate-guitar.com/tab/<artist-slug>/<song-slug>-<id>
// Wiki-tab format: [ch]G[/ch]Hello [ch]Am[/ch]world  →  we just rewrite [ch]X[/ch] as [X].
//
// Caveats:
//   - UG is behind Cloudflare. With a real-browser UA we usually pass through.
//     If we hit a JS challenge page, the parse will find no js-store and return null,
//     and the orchestrator falls through to Cifra Club / e-chords / AI. Safe failure.

async function fetchChartFromUG(rawTitle, rawArtist) {
  var artist = normalizeForLookup(rawArtist);
  var title  = normalizeForLookup(rawTitle);
  if (!artist || !title) return null;

  // Step 1 — search UG for chord tabs only (type=300)
  var searchUrl = "https://www.ultimate-guitar.com/search.php?title=" +
                  encodeURIComponent(title + " " + artist) +
                  "&search_type=title&type=300";
  console.log("UG: searching " + searchUrl);
  var searchHtml = await fetchHtml(searchUrl);
  if (!searchHtml) return null;

  var $ = cheerio.load(searchHtml);
  var storeRaw = $(".js-store").attr("data-content");
  if (!storeRaw) { console.log("UG: no js-store on search page (Cloudflare?)"); return null; }

  var bestTabUrl = null;
  var bestRating = -1;
  try {
    var storeData = JSON.parse(storeRaw);
    var results = (storeData && storeData.store && storeData.store.page && storeData.store.page.data && storeData.store.page.data.results) || [];

    // Filter to chord-type tabs and pick the highest rating × votes score.
    // Many obscure songs have only 1 result; popular songs have dozens.
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (!r) continue;
      var typeName = r.type || r.type_name;
      if (typeName !== "Chords" && typeName !== "chords") continue;
      var score = (r.rating || 0) * Math.log(1 + (r.votes || 0));
      if (score > bestRating && r.tab_url) {
        bestRating = score;
        bestTabUrl = r.tab_url;
      }
    }
  } catch(e) { console.log("UG search parse error:", e.message); return null; }

  if (!bestTabUrl) { console.log("UG: no chord-type results in search"); return null; }
  console.log("UG: best tab " + bestTabUrl + " (score " + bestRating.toFixed(2) + ")");

  // Step 2 — fetch the tab page and pull the wiki_tab content
  var tabHtml = await fetchHtml(bestTabUrl);
  if (!tabHtml) return null;
  return parseUGTabPage(tabHtml, rawTitle, rawArtist);
}

function parseUGTabPage(html, title, artist) {
  var $ = cheerio.load(html);
  var storeRaw = $(".js-store").attr("data-content");
  if (!storeRaw) { console.log("UG: no js-store on tab page"); return null; }

  var data;
  try { data = JSON.parse(storeRaw); } catch(e) { console.log("UG tab JSON parse error:", e.message); return null; }

  var tabView = data && data.store && data.store.page && data.store.page.data && data.store.page.data.tab_view;
  var rawContent = tabView && tabView.wiki_tab && tabView.wiki_tab.content;
  if (!rawContent) { console.log("UG: no wiki_tab content on tab page"); return null; }

  // UG's content uses:
  //   [ch]G[/ch]  → chord markers (we convert to ChordPro [G])
  //   [tab]...[/tab]  → wraps "tab-formatted" blocks (we strip markers but keep content)
  //   plain section headers like "Verse 1", "Chorus" on their own lines
  var chordProText = String(rawContent)
    .replace(/\[ch\]([^\[\]]+)\[\/ch\]/g, "[$1]")
    .replace(/\[\/?tab\]/g, "");

  // Strip standalone metadata lines that UG sometimes puts at the top
  // ("Capo: 2nd fret", "Tempo: 90 BPM", "Key: Db major", "Tuning: EADGBE", ...).
  // Without this, those lines become a phantom first "Verse" section.
  chordProText = chordProText.replace(
    /^(?:Capo|Tempo|Key|Tonality|Tuning|BPM|Difficulty|Author|Submitted by|Strumming)\s*[:\-].*$/gim,
    ""
  );

  // Normalize plain-text headers to [Section] form so parseChordPro picks them up
  var SECTION_WORDS = "intro|verse|pre[- ]?chorus|chorus|post[- ]?chorus|bridge|hook|interlude|instrumental|solo|outro|breakdown|refrain|tag|coda|ending";
  var headerRe = new RegExp("^(" + SECTION_WORDS + ")(\\s*\\d*)?\\s*:?$", "gim");
  chordProText = chordProText.replace(headerRe, function(_, w, n) {
    return "[" + (w + (n || "")).trim() + "]";
  });

  var sections = parseChordPro(chordProText);
  if (sections.length === 0) { console.log("UG: parseChordPro produced 0 sections"); return null; }

  // UG provides metadata directly — use what they tell us
  var meta = (tabView && tabView.meta) || {};
  var musicalKey = meta.tonality_name || data.store.page.data.tab && data.store.page.data.tab.tonality_name || null;
  var capo       = meta.capo || (data.store.page.data.tab && data.store.page.data.tab.capo) || 0;
  var tempo      = (data.store.page.data.tab && data.store.page.data.tab.tempo) || null;

  return validateAndRepairChart({
    title:      title,
    artist:     artist,
    musicalKey: musicalKey,
    tempo:      tempo,
    capo:       parseInt(capo, 10) || 0,
    sections:   sections,
  });
}

async function fetchChartFromCifra(rawTitle, rawArtist) {
  var artist = normalizeForLookup(rawArtist);
  var title  = normalizeForLookup(rawTitle);
  var artistSlug = slugify(artist);
  var titleSlug  = slugify(title);
  if (!artistSlug || !titleSlug) return null;

  // 1) Direct canonical URL — fast path
  var directUrl = "https://www.cifraclub.com.br/" + artistSlug + "/" + titleSlug + "/";
  console.log("Cifra Club: trying " + directUrl);
  var html = await fetchHtml(directUrl);
  if (html) {
    var chart = parseCifraClubHtml(html, rawTitle, rawArtist);
    if (chart && chart.sections.length > 0) {
      console.log("Cifra Club: parsed " + chart.sections.length + " sections from direct URL");
      return chart;
    }
  }

  // 2) Search fallback — Cifra Club search returns a results page we scan for the first song link
  try {
    var q = encodeURIComponent(title + " " + artist);
    var searchUrl = "https://www.cifraclub.com.br/?q=" + q;
    console.log("Cifra Club: searching " + searchUrl);
    var sres = await axios.get(searchUrl, { headers: SCRAPER_HEADERS, timeout: 8000, validateStatus: function(s){return s<500;} });
    if (sres.status !== 200) { console.log("Cifra Club: search " + sres.status); return null; }
    var $ = cheerio.load(sres.data);
    // Cifra Club search results: links to /artist-slug/song-slug/
    var songLink = null;
    $("a").each(function() {
      if (songLink) return;
      var href = $(this).attr("href") || "";
      // Filter for song-page URLs (have artist + song segments, no extra suffixes)
      if (/^\/[a-z0-9-]+\/[a-z0-9-]+\/?$/.test(href)) {
        songLink = href.startsWith("http") ? href : "https://www.cifraclub.com.br" + href;
      }
    });
    if (!songLink) { console.log("Cifra Club: no song link in search results"); return null; }
    console.log("Cifra Club: search found " + songLink);
    var html2 = await fetchHtml(songLink);
    if (!html2) return null;
    var chart2 = parseCifraClubHtml(html2, rawTitle, rawArtist);
    if (chart2 && chart2.sections.length > 0) {
      console.log("Cifra Club: parsed " + chart2.sections.length + " sections from search");
      return chart2;
    }
  } catch(e) { console.log("Cifra Club search error:", e.message); }
  return null;
}

function parseCifraClubHtml(html, title, artist) {
  var $ = cheerio.load(html);

  // Find the chord-chart pre. Cifra Club uses class "cifra_chord", but the
  // exact class varies; fall back to any pre containing multiple <b> tags
  // (each <b> is a chord name).
  var pre = $("pre.cifra_chord, pre[class*='cifra']").first();
  if (!pre.length) {
    $("pre").each(function() {
      if (pre.length) return;
      if ($(this).find("b").length >= 3) pre = $(this);
    });
  }
  if (!pre.length) return null;

  // Walk the pre's children: text nodes → lyrics, <b>/<strong> → chord tags.
  // Reconstruct as ChordPro text ("[G]Hello dar[Am]ling") so we can reuse
  // our existing parseChordPro().
  var chordProText = "";
  pre.contents().each(function() {
    if (this.type === "text") {
      chordProText += this.data;
    } else if (this.type === "tag" && (this.name === "b" || this.name === "strong")) {
      var c = $(this).text().trim();
      if (c) chordProText += "[" + c + "]";
    } else if (this.type === "tag" && this.name === "br") {
      chordProText += "\n";
    } else if (this.type === "tag") {
      chordProText += $(this).text();
    }
  });

  // Cifra Club section headers are plain-text lines like "Intro", "Verse 1",
  // "Refrão" (Portuguese), "Estrofe". Normalize to [Section] form for the parser.
  var SECTION_WORDS = "intro|verse|verso|estrofe|chorus|refrão|refrao|pre[- ]?chorus|pre[- ]?refrão|bridge|ponte|outro|hook|solo|interlude|interlúdio";
  var headerRe = new RegExp("^(" + SECTION_WORDS + ")(\\s*\\d*)?\\s*:?$", "gim");
  chordProText = chordProText.replace(headerRe, function(_, word, num) {
    var label = (word + (num || "")).trim();
    // Translate PT-BR labels to standard English ones
    label = label.replace(/refr[ãa]o/i, "Chorus").replace(/estrofe|verso/i, "Verse").replace(/ponte/i, "Bridge").replace(/interlúdio/i, "Interlude");
    return "[" + label + "]";
  });

  var sections = parseChordPro(chordProText);
  if (sections.length === 0) return null;

  // Musical key — Cifra Club shows "Tom: <key>"
  var musicalKey = null;
  var bodyText = $("body").text();
  var keyMatch = bodyText.match(/Tom:\s*([A-G][#b]?m?)/);
  if (keyMatch) {
    var k = keyMatch[1];
    musicalKey = /m$/.test(k) ? k.replace(/m$/, " minor") : k + " major";
  }

  // Capo — "Capotraste na Xª casa"
  var capo = 0;
  var capoMatch = bodyText.match(/Capotraste\s+na\s+(\d+)/i);
  if (capoMatch) capo = parseInt(capoMatch[1], 10) || 0;

  return validateAndRepairChart({
    title:      title,
    artist:     artist,
    musicalKey: musicalKey,
    tempo:      null,
    capo:       capo,
    sections:   sections,
  });
}

// ── e-chords ─────────────────────────────────────────────────────────────────
// Songs live at https://www.e-chords.com/chords/<artist-slug>/<song-slug>
// Chord chart in <pre id="core"> with <u> tags wrapping chords.

async function fetchChartFromEchords(rawTitle, rawArtist) {
  var artist = normalizeForLookup(rawArtist);
  var title  = normalizeForLookup(rawTitle);
  var artistSlug = slugify(artist);
  var titleSlug  = slugify(title);
  if (!artistSlug || !titleSlug) return null;

  var url = "https://www.e-chords.com/chords/" + artistSlug + "/" + titleSlug;
  console.log("e-chords: trying " + url);
  var html = await fetchHtml(url);
  if (!html) return null;
  var chart = parseEchordsHtml(html, rawTitle, rawArtist);
  if (chart && chart.sections.length > 0) {
    console.log("e-chords: parsed " + chart.sections.length + " sections");
    return chart;
  }
  return null;
}

function parseEchordsHtml(html, title, artist) {
  var $ = cheerio.load(html);
  var pre = $("pre#core, pre.core").first();
  if (!pre.length) {
    $("pre").each(function() {
      if (pre.length) return;
      if ($(this).find("u").length >= 3) pre = $(this);
    });
  }
  if (!pre.length) return null;

  var chordProText = "";
  pre.contents().each(function() {
    if (this.type === "text") {
      chordProText += this.data;
    } else if (this.type === "tag" && (this.name === "u" || this.name === "b")) {
      var c = $(this).text().trim();
      if (c) chordProText += "[" + c + "]";
    } else if (this.type === "tag" && this.name === "br") {
      chordProText += "\n";
    } else if (this.type === "tag") {
      chordProText += $(this).text();
    }
  });

  // e-chords uses bracketed section headers already: [Intro], [Verse], etc.
  // Sometimes plain text. Normalize bare lines.
  var headerRe = /^(intro|verse|chorus|pre[- ]?chorus|bridge|outro|hook|solo|interlude)(\s*\d*)?\s*:?$/gim;
  chordProText = chordProText.replace(headerRe, function(_, w, n) { return "[" + (w + (n || "")).trim() + "]"; });

  var sections = parseChordPro(chordProText);
  if (sections.length === 0) return null;

  var musicalKey = null;
  var bodyText = $("body").text();
  var keyMatch = bodyText.match(/Tone:\s*([A-G][#b]?(?:\s+(?:major|minor))?)/i);
  if (keyMatch) musicalKey = keyMatch[1];

  return validateAndRepairChart({
    title:      title,
    artist:     artist,
    musicalKey: musicalKey,
    tempo:      null,
    capo:       0,
    sections:   sections,
  });
}

// Common HTML fetcher with browser-like headers, short timeout, no error on
// non-2xx (we want to inspect the status and fall through gracefully).
async function fetchHtml(url) {
  try {
    var res = await axios.get(url, {
      headers:         SCRAPER_HEADERS,
      timeout:         8000,
      validateStatus:  function(s) { return s < 500; },
      maxRedirects:    5,
    });
    if (res.status !== 200) {
      console.log("fetchHtml: " + res.status + " " + url);
      return null;
    }
    return res.data;
  } catch(e) {
    console.log("fetchHtml error: " + e.message);
    return null;
  }
}

// ── Orchestrator: try real chord sources → audio analysis → fall back to LLM ─
// Returns { chart, source } where source is one of:
//   "ultimate_guitar", "cifraclub", "echords", "audio_analysis", "ai_generated"

async function fetchChartFromSources(title, artist, releaseDate) {
  // SKIP_SCRAPERS=1 forces the audio-analysis path — used when testing the
  // pipeline against songs the chord sites already cover.
  var chart;
  if (process.env.SKIP_SCRAPERS === "1") {
    console.log("Sources: SKIP_SCRAPERS set — going straight to audio analysis");
  } else {
    console.log("Sources: trying Ultimate-Guitar for", title, "by", artist);
    chart = await fetchChartFromUG(title, artist);
    if (chart) return { chart: chart, source: "ultimate_guitar" };

    console.log("Sources: trying Cifra Club for", title, "by", artist);
    chart = await fetchChartFromCifra(title, artist);
    if (chart) return { chart: chart, source: "cifraclub" };

    console.log("Sources: trying e-chords for", title, "by", artist);
    chart = await fetchChartFromEchords(title, artist);
    if (chart) return { chart: chart, source: "echords" };
  }

  // No human-curated source had it — gather lyrics + key/tempo once, shared
  // by both the audio-analysis attempt and the final AI fallback.
  console.log("Sources: no real source had the song, fetching lyrics + key for analysis/AI");
  var [lyricsResult, spotifyResult] = await Promise.all([
    fetchRealLyrics(title, artist),
    lookupSpotifyKey(title, artist),
  ]);

  console.log("Sources: trying audio analysis (Demucs + Essentia) for", title, "by", artist);
  try {
    var analysisResult = await fetchChartFromAudioAnalysis(title, artist, releaseDate || null, lyricsResult, spotifyResult.spotifyKey, spotifyResult.spotifyTempo);
    if (analysisResult) return analysisResult;
  } catch(e) {
    console.log("Sources: audio analysis failed, falling back to AI:", e.message);
  }

  // Last resort — LLM with our existing lyrics + Spotify pipeline
  console.log("Sources: falling back to plain AI generation");
  chart = await generateChartWithAI(title, artist, releaseDate || null, spotifyResult.spotifyKey, spotifyResult.spotifyTempo, lyricsResult ? lyricsResult.plain : null);
  return { chart: chart, source: "ai_generated" };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/", function(req, res) {
  // Health check + config presence (booleans only, never the values).
  // Lets us see from outside whether the deployed environment has each
  // service key — the audio pipeline silently falls back to AI recall
  // when REPLICATE_API_TOKEN is missing, which is invisible otherwise.
  res.json({
    status: "Music Player 2.0 server is running!",
    config: {
      replicate: !!process.env.REPLICATE_API_TOKEN,
      openai:    !!process.env.OPENAI_API_KEY,
      supabase:  !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY),
      audd:      !!process.env.AUDD_API_KEY,
      spotify:   !!(process.env.SPOTIFY_CLIENT_ID && process.env.SPOTIFY_CLIENT_SECRET),
    },
  });
});

app.get("/search", async function(req, res) {
  const query = req.query.q;
  if (!query) { res.json({ error: "No query" }); return; }
  const url = "https://itunes.apple.com/search?term=" + encodeURIComponent(query) + "&entity=song&limit=8";
  const response = await axios.get(url);
  const songs = response.data.results.map(function(song) {
    return { title: song.trackName, artist: song.artistName, album: song.collectionName, year: song.releaseDate ? song.releaseDate.substring(0,4) : "Unknown", genre: song.primaryGenreName, artwork: song.artworkUrl100 };
  });
  res.json({ count: songs.length, songs: songs });
});

// GET /chords?title=...&artist=... — fast Supabase-only lookup
app.get("/chords", async function(req, res) {
  var title = req.query.title, artist = req.query.artist;
  if (!title || !artist) return res.status(400).json({ error: "title and artist required" });
  try {
    console.log("GET /chords:", title, "by", artist);
    var chart = await fetchChartFromDB(title, artist);
    if (chart) {
      console.log("GET /chords: found in database");
      return res.json({ found: true, fromDatabase: true, chart });
    }
    console.log("GET /chords: not found");
    res.json({ found: false });
  } catch(e) {
    console.error("GET /chords error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /chords { title, artist, force? } — generate + save
//   force: true → bypass cache + overwrite any existing row.
//   Used by the "Regenerate" button in the app for songs with wrong chords.
app.post("/chords", rateLimit("chords", 50), async function(req, res) {
  var title = req.body.title, artist = req.body.artist;
  var force = req.body.force === true;
  if (!title || !artist) return res.status(400).json({ error: "title and artist required" });
  try {
    console.log("POST /chords:", force ? "FORCE-regenerating" : "generating", "for", title, "by", artist);

    // Check cache first (unless forcing a fresh generation)
    if (!force) {
      var existing = await fetchChartFromDB(title, artist);
      if (existing) {
        console.log("POST /chords: already in database, returning cached");
        return res.json({ found: true, fromDatabase: true, chart: existing });
      }
    }

    // Try real chord sources (Cifra Club → e-chords) first, LLM as fallback.
    var result = await fetchChartFromSources(title, artist, null);
    result.chart.source = result.source;
    await saveChartToDB(result.chart, title, artist, result.source);
    res.json({ found: true, fromDatabase: false, chart: result.chart, source: result.source });
  } catch(e) {
    console.error("POST /chords error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post("/identify", rateLimit("identify", 50), async function(req, res) {
  try {
    var audioBase64 = req.body.audioBase64;
    var mimeType = req.body.mimeType;
    if (!audioBase64) { return res.status(400).json({ error: "No audio provided" }); }
    var audioBuffer = Buffer.from(audioBase64, "base64");

    console.log("Step 1: Identifying with AudD...");
    var songInfo = null;
    try {
      var form = new FormData();
      form.append("api_token", process.env.AUDD_API_KEY);
      form.append("return", "spotify,apple_music");
      form.append("file", audioBuffer, { filename: "recording.m4a", contentType: mimeType || "audio/m4a" });
      var auddResponse = await axios.post("https://api.audd.io/", form, { headers: form.getHeaders() });
      if (auddResponse.data.result) {
        songInfo = auddResponse.data.result;
        console.log("Identified:", songInfo.title, "by", songInfo.artist);
      } else {
        console.log("Not identified by AudD");
      }
    } catch(e) { console.error("AudD error:", e.message); }

    console.log("Step 2: Checking Supabase chord database...");
    if (songInfo) {
      try {
        var cached = await fetchChartFromDB(songInfo.title, songInfo.artist);
        if (cached) {
          console.log("Returning from database!");
          return res.json({ identified: true, fromDatabase: true, songInfo, chart: cached });
        }
      } catch(e) { console.log("DB lookup error:", e.message); }
    }

    console.log("Step 3: Looking up chord chart from real sources or AI...");
    var chart, source;
    if (songInfo) {
      var result = await fetchChartFromSources(songInfo.title, songInfo.artist, songInfo.release_date);
      chart  = result.chart;
      source = result.source;
      chart.source = source;
      await saveChartToDB(chart, songInfo.title, songInfo.artist, source);
    } else {
      // No song info at all — last-ditch LLM call with placeholder labels.
      chart  = await generateChartWithAI("Unknown Song", "Unknown Artist", null, null, null, null);
      source = "ai_generated";
    }

    res.json({ identified: !!songInfo, fromDatabase: false, songInfo, chart, source });

  } catch(error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// PUT /chords { title, artist, sections, musicalKey, tempo, capo } — user correction, marks verified
app.put("/chords", async function(req, res) {
  res.setHeader("Content-Type", "application/json");
  var title = req.body.title, artist = req.body.artist;
  var sections = req.body.sections, musicalKey = req.body.musicalKey;
  var tempo = req.body.tempo, capo = req.body.capo;
  if (!title || !artist) return res.status(400).json({ error: "title and artist required" });
  if (!Array.isArray(sections)) return res.status(400).json({ error: "sections must be an array" });
  try {
    console.log("PUT /chords: saving corrected chart for", title, "by", artist);
    var saveResult = await supabase.from("chord_charts").upsert({
      title:       title,
      artist:      artist,
      musical_key: musicalKey  || null,
      tempo:       tempo       || null,
      capo:        capo        != null ? capo : null,
      sections:    sections,
      source:      "user_corrected",
      verified:    true,
    }, { onConflict: "title,artist" });
    if (saveResult.error) throw new Error(saveResult.error.message);
    console.log("PUT /chords: saved OK");
    return res.json({ success: true });
  } catch(e) {
    console.error("PUT /chords error:", e.message);
    return res.status(500).json({ error: e.message });
  }
});

// POST /transcribe { audioBase64, mimeType? } — Whisper transcription, any language
app.post("/transcribe", rateLimit("transcribe", 50), async function(req, res) {
  var audioBase64 = req.body.audioBase64;
  var mimeType    = req.body.mimeType || "audio/m4a";
  if (!audioBase64) return res.status(400).json({ error: "No audio provided" });

  var ext      = (mimeType.includes("mp4") || mimeType.includes("m4a")) ? "m4a" : "wav";
  var tempPath = path.join(os.tmpdir(), "transcribe_" + Date.now() + "." + ext);

  try {
    var audioBuffer = Buffer.from(audioBase64, "base64");
    fs.writeFileSync(tempPath, audioBuffer);
    console.log("Whisper: transcribing " + (audioBuffer.length / 1024).toFixed(0) + " KB");

    var response = await openai.audio.transcriptions.create({
      file:            fs.createReadStream(tempPath),
      model:           "whisper-1",
      response_format: "verbose_json",
    });

    console.log("Whisper: language=" + response.language + " chars=" + (response.text || "").length);
    res.json({ transcript: response.text, language: response.language });
  } catch(e) {
    console.error("Transcribe error:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    try { fs.unlinkSync(tempPath); } catch(_) {}
  }
});

if (require.main === module) {
  app.listen(port, function() { console.log("Server started on port " + port); });
}

// exposed for test scripts only — `node server.js` is the real entry point
module.exports = {
  _internals: { generateChartWithAI, fetchChartFromAudioAnalysis, fetchChartFromSources, fetchRealLyrics, saveChartToDB },
};
