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
const crypto = require("crypto");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { analyzeAudioForChords, analyzeUploadedAudio } = require("./audioAnalysis");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
// Railway's current service networking target is configured for port 3000.
// Keep this explicit until the target port is migrated together with the
// deployment settings; otherwise Railway injects 8080 and the proxy returns
// 502 even though the process starts successfully.
const port = 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ALLOW_CATALOG_LYRICS_TRANSCRIPTION =
  String(process.env.ALLOW_CATALOG_LYRICS_TRANSCRIPTION || "").toLowerCase() === "true";
const MAX_AUDIO_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIBE_AUDIO_SECONDS = 10 * 60;
const FFMPEG_TIMEOUT_SECONDS = 90;
const ALLOWED_AUDIO_MIME_TYPES = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/flac": "flac",
};
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY
);

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

function identityWords(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitArtistIdentity(value) {
  return String(value || "")
    .replace(/\s+(?:feat\.?|featuring|ft\.?|with)\s+/gi, " / ")
    .split(/\s*(?:\/|,|;|&|\bx\b|\band\b)\s*/i)
    .map(identityWords)
    .filter(Boolean);
}

function artistNameMatches(a, b) {
  // Do not use substring matching here: it can treat tribute bands or
  // similarly named artists as the requested performer. Separators and
  // accents are normalized before this exact comparison.
  return a === b;
}

// Catalogs disagree on whether collaborators use '/', ',', '&' or 'x'. Match
// the normalized collaborator set, while keeping the comparison strict enough
// that a shared short word cannot select a different song.
function artistsLooselyMatch(a, b) {
  var actual = splitArtistIdentity(a);
  var requested = splitArtistIdentity(b);
  if (!actual.length || !requested.length) return false;
  // A solo artist must never match a collaboration merely because one name
  // overlaps. Every collaborator must have one counterpart on both sides.
  if (actual.length !== requested.length) return false;
  var matchedActual = {};
  var matches = 0;
  requested.forEach(function (requestedName) {
    for (var i = 0; i < actual.length; i++) {
      if (!matchedActual[i] && artistNameMatches(actual[i], requestedName)) {
        matchedActual[i] = true;
        matches++;
        break;
      }
    }
  });
  return matches === requested.length;
}

function containsLyricsRefusal(text) {
  var normalized = String(text || "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  if (!normalized) return false;
  return [
    /\b(?:i'm|i am) sorry\b.{0,180}\b(?:can't|cannot|unable to)\b.{0,120}\b(?:provide|share|reproduce|display|transcribe)\b/,
    /\b(?:i|we) (?:can't|cannot|am unable to|are unable to) (?:provide|share|reproduce|display|transcribe)\b.{0,160}\b(?:lyrics?|copyrighted content)\b/,
    /\b(?:lyrics?|full lyrics?|song lyrics?) (?:are|is) (?:unavailable|not available)\b/,
    /\b(?:copyright(?:ed)?|policy)\b.{0,120}\b(?:can't|cannot|unable|not able)\b.{0,120}\b(?:lyrics?|content)\b/,
  ].some(function (pattern) { return pattern.test(normalized); });
}

function chartContainsLyricsRefusal(chart) {
  var sections = chart && Array.isArray(chart.sections) ? chart.sections : [];
  var lyrics = [];
  sections.forEach(function (section) {
    var lines = section && Array.isArray(section.lines) ? section.lines : [];
    lines.forEach(function (line) { lyrics.push(String(line && line.lyrics || "")); });
  });
  return containsLyricsRefusal(lyrics.join("\n"));
}

function chartHasLyrics(chart) {
  var sections = chart && Array.isArray(chart.sections) ? chart.sections : [];
  return sections.some(function (section) {
    var lines = section && Array.isArray(section.lines) ? section.lines : [];
    return lines.some(function (line) {
      return String(line && line.lyrics || "").trim().length > 0;
    });
  });
}

function chartHasPartialMarker(chart, source) {
  if (!chart) return false;
  if (chart.partial === true) return true;
  var sourceName = String(source || chart.source || "");
  if (/_partial$/i.test(sourceName)) return true;
  var sections = Array.isArray(chart.sections) ? chart.sections : [];
  if (sections.some(function (section) {
    return section && (section.partial === true || String(section.warning || "").trim());
  })) return true;
  // Legacy chord-only rows predate explicit partial metadata. For this app a
  // chart with no lyric text is not a complete static lyrics/chords chart.
  return !chartHasLyrics(chart);
}

function rowIsUnverifiedPartial(row) {
  if (!row || row.verified === true) return false;
  return chartHasPartialMarker({
    sections: row.sections,
    source: row.source,
  }, row.source);
}

// Emit only bounded control-flow metadata. Do not add provider response
// bodies, URLs, transcript text, audio content, or credentials here.
function logPipelineDiagnostic(event, details) {
  var allowed = [
    "sourceClip", "sourceFallbackReason", "stage", "reason", "httpStatus",
    "segmentCount", "wordCount", "expectedDuration",
  ];
  var payload = { component: "lyrics_pipeline", event: String(event || "unknown") };
  details = details || {};
  allowed.forEach(function (key) {
    var value = details[key];
    if (value === undefined || value === null || value === "") return;
    payload[key] = typeof value === "number" ? value : String(value);
  });
  console.log("PIPELINE_DIAGNOSTIC " + JSON.stringify(payload));
}

function lyricsUnavailableError() {
  var error = new Error("The song was found, but its vocals could not be transcribed and no usable lyric source was available. Please try another recording or try again later.");
  error.code = "LYRICS_UNAVAILABLE";
  return error;
}

function databaseError(operation, providerError) {
  var error = new Error("The chord database is temporarily unavailable. Please try again later.");
  error.code = operation === "read" ? "DATABASE_READ_FAILED" : "DATABASE_WRITE_FAILED";
  error.httpStatus = 503;
  // Provider details stay server-side and never include credentials.
  console.error("Supabase " + operation + " failed:", providerError && providerError.message ? providerError.message : "unknown error");
  return error;
}

async function fetchChartFromDB(title, artist) {
  var titlePattern = "%" + normalizeForLookup(title).replace(/[%_]/g, "") + "%";
  var queryResult = await supabase
    .from("chord_charts")
    .select("*")
    .ilike("title", titlePattern)
    .limit(25);
  if (queryResult.error) throw databaseError("read", queryResult.error);
  var rows = queryResult.data;
  if (!rows || rows.length === 0) return null;

  var candidates = rows.filter(function (r) {
    return titlesMatch(r.title, title) && artistsLooselyMatch(r.artist, artist);
  });
  if (candidates.length === 0) return null;

  // Prefer musician-verified charts, then the most-played one.
  candidates.sort(function (a, b) {
    if (!!b.verified !== !!a.verified) return b.verified ? 1 : -1;
    return (b.play_count || 0) - (a.play_count || 0);
  });
  var r = null;
  var chart = null;
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    var candidateChart = { title: candidate.title, artist: candidate.artist, musicalKey: candidate.musical_key, tempo: candidate.tempo, capo: candidate.capo, sections: candidate.sections, verified: candidate.verified, source: candidate.source };
    var sectionMetadata = candidateChart.sections && candidateChart.sections[0];
    if (sectionMetadata && sectionMetadata.transcriptLanguage) {
      candidateChart.transcriptLanguage = sectionMetadata.transcriptLanguage;
    }
    if (sectionMetadata && sectionMetadata.warning) {
      candidateChart.partial = true;
      candidateChart.warning = sectionMetadata.warning;
    }
    if (sectionMetadata && sectionMetadata.sourceClip) {
      candidateChart.sourceClip = sectionMetadata.sourceClip;
    }
    if (sectionMetadata && sectionMetadata.partialReason) {
      candidateChart.partialReason = sectionMetadata.partialReason;
    }
    if (rowIsUnverifiedPartial(candidate)) {
      console.warn("Ignoring cached unverified partial chart for", candidate.title, "by", candidate.artist);
      continue;
    }
    if (chartContainsLyricsRefusal(candidateChart)) {
      console.warn("Ignoring cached chart containing a lyrics refusal for", candidate.title, "by", candidate.artist);
      continue;
    }
    r = candidate;
    chart = candidateChart;
    break;
  }
  if (!r || !chart) return null;
  var playCountResult = await supabase.from("chord_charts").update({ play_count: (r.play_count || 0) + 1 }).eq("id", r.id).select("id");
  if (playCountResult.error || !playCountResult.data || playCountResult.data.length === 0) {
    // Usage accounting is best-effort and must not hide an otherwise valid
    // chart when its RLS policy does not permit this nonessential update.
    console.warn(
      "Supabase play count update skipped:",
      playCountResult.error && playCountResult.error.message
        ? playCountResult.error.message
        : "update affected no rows"
    );
  }
  return chart;
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
    // Search results are not guaranteed to be ranked by identity. Accept only
    // a strict normalized title + collaborator match; never fall back to an
    // unrelated top hit merely because it contains a long transcript.
    for (var i = 0; i < hits.length; i++) {
      var h = hits[i];
      if (!h || !h.plainLyrics || h.plainLyrics.length < 80) continue;
      if (titlesMatch(h.trackName, title) && artistsLooselyMatch(h.artistName, artist)) {
        return { plain: h.plainLyrics.trim(), synced: h.syncedLyrics || null };
      }
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
  if (chart.partial === true) out.partial = true;
  if (chart.warning) out.warning = String(chart.warning);
  if (chart.transcriptLanguage) out.transcriptLanguage = String(chart.transcriptLanguage);
  if (chart.sourceClip) out.sourceClip = String(chart.sourceClip);
  if (chart.partialReason) out.partialReason = String(chart.partialReason);
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
      var cleanLine = { lyrics: lyrics, chords: cleanChords };
      var start = Number(ln.start);
      var end = Number(ln.end);
      if (Number.isFinite(start) && start >= 0) cleanLine.start = start;
      if (Number.isFinite(end) && end >= start) cleanLine.end = end;
      if (Array.isArray(ln.words)) {
        cleanLine.words = ln.words.map(function (word) {
          var value = String(word && word.word || "").trim();
          var wordStart = Number(word && word.start);
          var wordEnd = Number(word && word.end);
          var position = Number(word && word.position);
          if (!value || !Number.isFinite(wordStart) || !Number.isFinite(wordEnd)) return null;
          return {
            word: value,
            start: Math.max(0, wordStart),
            end: Math.max(wordStart, wordEnd),
            position: Number.isFinite(position) ? Math.max(0, Math.min(position, lyrics.length)) : 0,
          };
        }).filter(Boolean);
      }
      cleanLines.push(cleanLine);
    }
    if (cleanLines.length === 0) continue;
    var cleanSection = { label: String(s.label || "Verse"), lines: cleanLines };
    if (s.transcriptLanguage) cleanSection.transcriptLanguage = String(s.transcriptLanguage);
    if (s.transcriptSource) cleanSection.transcriptSource = String(s.transcriptSource);
    if (s.warning) cleanSection.warning = String(s.warning);
    out.sections.push(cleanSection);
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

  var choice = completion.choices[0] || {};
  var message = choice.message || {};
  if (message.refusal || choice.finish_reason === "content_filter" || choice.finish_reason === "refusal") {
    console.warn("OpenAI declined lyrics generation for", title, "by", artist);
    throw lyricsUnavailableError();
  }
  var raw = message.content || "";
  console.log("OpenAI: finish_reason:", choice.finish_reason, "length:", raw.length);
  if (!raw) throw new Error("OpenAI returned empty response");

  // Strip stray markdown fencing if the model wrapped its output
  raw = raw.replace(/^```[A-Za-z0-9_-]*\s*/m, "").replace(/```\s*$/m, "").trim();
  if (containsLyricsRefusal(raw)) {
    console.warn("OpenAI returned a lyrics refusal as content for", title, "by", artist);
    throw lyricsUnavailableError();
  }

  var sections = parseChordPro(raw);
  if (sections.length === 0) {
    console.error("ChordPro parse produced 0 sections (response length " + raw.length + ")");
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
  var cleanChart = validateAndRepairChart(chart);
  if (chartContainsLyricsRefusal(cleanChart)) throw lyricsUnavailableError();
  return cleanChart;
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

function audioExtensionForMime(mimeType, fallbackUrl) {
  var normalized = String(mimeType || "").toLowerCase().split(";")[0].trim();
  if (ALLOWED_AUDIO_MIME_TYPES[normalized]) return ALLOWED_AUDIO_MIME_TYPES[normalized];
  var urlPath = String(fallbackUrl || "").split("?")[0];
  var urlExt = path.extname(urlPath).slice(1).toLowerCase();
  if (["webm", "ogg", "mp4", "m4a", "wav", "mp3", "flac"].includes(urlExt)) return urlExt;
  return "audio";
}

function audioPayloadError(message, status) {
  var error = new Error(message);
  error.httpStatus = status;
  return error;
}

function decodeAudioPayload(audioBase64, mimeType, maxBytes) {
  var normalizedMime = String(mimeType || "").toLowerCase().split(";")[0].trim();
  if (!ALLOWED_AUDIO_MIME_TYPES[normalizedMime]) {
    throw audioPayloadError("Unsupported audio format. Use WebM, OGG, MP4/M4A, WAV, MP3, or FLAC.", 415);
  }
  if (typeof audioBase64 !== "string" || !audioBase64.trim()) {
    throw audioPayloadError("No audio provided", 400);
  }
  var normalizedBase64 = audioBase64.replace(/\s/g, "");
  if (normalizedBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedBase64)) {
    throw audioPayloadError("Invalid audio data", 400);
  }
  var padding = normalizedBase64.endsWith("==") ? 2 : (normalizedBase64.endsWith("=") ? 1 : 0);
  var estimatedBytes = Math.floor(normalizedBase64.length * 3 / 4) - padding;
  var limit = maxBytes || MAX_AUDIO_UPLOAD_BYTES;
  if (estimatedBytes > limit) {
    throw audioPayloadError("Audio is too large. The maximum upload size is 25 MB.", 413);
  }
  var buffer = Buffer.from(normalizedBase64, "base64");
  if (buffer.length < 256) throw audioPayloadError("Audio is empty or too short.", 400);
  if (buffer.length > limit) throw audioPayloadError("Audio is too large. The maximum upload size is 25 MB.", 413);
  return { buffer: buffer, mimeType: normalizedMime, extension: ALLOWED_AUDIO_MIME_TYPES[normalizedMime] };
}

// Whisper accepts common audio formats but Demucs often returns large WAV
// stems. Normalise every vocals stem to a compact mono MP3 first so full-song
// requests stay below the transcription upload limit and carry a correct
// filename/MIME hint.
function prepareWhisperAudio(audioBuffer, mimeType, sourceUrl) {
  return new Promise(function (resolve, reject) {
    var id = crypto.randomUUID();
    var inputPath = path.join(os.tmpdir(), "whisper-source-" + id + "." + audioExtensionForMime(mimeType, sourceUrl));
    var outputPath = path.join(os.tmpdir(), "whisper-ready-" + id + ".mp3");
    fs.writeFileSync(inputPath, audioBuffer);
    ffmpeg(inputPath, { timeout: FFMPEG_TIMEOUT_SECONDS })
      .noVideo()
      .audioChannels(1)
      .audioFrequency(16000)
      .audioBitrate("64k")
      .duration(MAX_TRANSCRIBE_AUDIO_SECONDS)
      .format("mp3")
      .on("error", function (error) {
        try { fs.unlinkSync(inputPath); } catch (_) {}
        try { fs.unlinkSync(outputPath); } catch (_) {}
        reject(error);
      })
      .on("end", function () {
        try { fs.unlinkSync(inputPath); } catch (_) {}
        resolve(outputPath);
      })
      .save(outputPath);
  });
}

function cleanTranscribedLine(text) {
  var cleaned = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/^[-–—]\s*/, "")
    .trim();
  if (!cleaned) return "";
  if (/^\[?(?:music|instrumental|applause|silence|inaudible|foreign language)\]?$/i.test(cleaned)) return "";
  if (/^(?:thanks for watching|thank you for watching|please subscribe|subtitles by|captioning by)(?:[.!…])?$/i.test(cleaned)) return "";
  return cleaned;
}

function appendTranscriptWord(currentText, rawWord) {
  var word = String(rawWord || "").trim();
  if (!word) return { text: currentText, position: currentText.length };
  var punctuationOnly = /^[,.;:!?…%)\]}]+$/.test(word);
  var apostropheSuffix = /^['’](?:s|re|ve|ll|d|m|t)$/i.test(word);
  var separator = currentText && !punctuationOnly && !apostropheSuffix ? " " : "";
  return { text: currentText + separator + word, position: currentText.length + separator.length };
}

function transcriptionToTimedLines(transcription) {
  var words = Array.isArray(transcription.words) ? transcription.words.filter(function (word) {
    return word && String(word.word || "").trim() && Number.isFinite(Number(word.start)) && Number.isFinite(Number(word.end));
  }) : [];
  var lines = [];

  if (words.length > 0) {
    var current = null;
    function flush() {
      if (!current) return;
      current.text = cleanTranscribedLine(current.text);
      if (current.text) lines.push(current);
      current = null;
    }
    words.forEach(function (word) {
      var start = Number(word.start);
      var end = Number(word.end);
      if (!current || start - current.end > 2.4) {
        flush();
        current = { text: "", start: start, end: end, words: [] };
      }
      var appended = appendTranscriptWord(current.text, word.word);
      current.text = appended.text;
      current.end = end;
      current.words.push({ word: String(word.word).trim(), start: start, end: end, position: appended.position });

      var wordCount = current.words.length;
      var duration = current.end - current.start;
      var sentenceEnd = /[.!?…]$/.test(String(word.word).trim());
      if ((sentenceEnd && wordCount >= 4) || wordCount >= 11 || duration >= 6) flush();
    });
    flush();
  }

  if (lines.length === 0) {
    (Array.isArray(transcription.segments) ? transcription.segments : []).forEach(function (segment) {
      var text = cleanTranscribedLine(segment && segment.text);
      var start = Number(segment && segment.start);
      var end = Number(segment && segment.end);
      if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return;
      lines.push({ text: text, start: Math.max(0, start), end: Math.max(start, end), words: [] });
    });
  }

  return lines.filter(function (line) { return cleanTranscribedLine(line.text); });
}

function assessTranscription(transcription, expectedDuration) {
  var lines = transcriptionToTimedLines(transcription || {});
  if (lines.length < 6) {
    return { accepted: false, reason: "fewer than six usable lyric lines", lines: lines, lexicalWordCount: 0 };
  }

  var lexicalWords = [];
  lines.forEach(function (line) {
    var matches = String(line.text || "").match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}'’\-]*/gu);
    if (matches) lexicalWords = lexicalWords.concat(matches);
  });
  if (lexicalWords.length < 30) {
    return { accepted: false, reason: "fewer than thirty lexical words", lines: lines, lexicalWordCount: lexicalWords.length };
  }

  var previousStart = -Infinity;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!Number.isFinite(line.start) || !Number.isFinite(line.end) || line.start < 0 || line.end <= line.start) {
      return { accepted: false, reason: "invalid lyric timestamps", lines: lines, lexicalWordCount: lexicalWords.length };
    }
    if (line.start + 0.05 < previousStart) {
      return { accepted: false, reason: "non-monotonic lyric timestamps", lines: lines, lexicalWordCount: lexicalWords.length };
    }
    previousStart = line.start;
  }

  var words = Array.isArray(transcription && transcription.words) ? transcription.words : [];
  var previousWordStart = -Infinity;
  for (var w = 0; w < words.length; w++) {
    var wordStart = Number(words[w] && words[w].start);
    var wordEnd = Number(words[w] && words[w].end);
    if (!Number.isFinite(wordStart) || !Number.isFinite(wordEnd) || wordEnd < wordStart || wordStart + 0.05 < previousWordStart) {
      return { accepted: false, reason: "non-monotonic word timestamps", lines: lines, lexicalWordCount: lexicalWords.length };
    }
    previousWordStart = wordStart;
  }

  var duration = Number(expectedDuration || (transcription && transcription.duration));
  var transcriptSpan = lines[lines.length - 1].end - lines[0].start;
  if (Number.isFinite(duration) && duration >= 20) {
    var minimumSpan = Math.min(90, duration * 0.35);
    if (transcriptSpan < minimumSpan) {
      return {
        accepted: false,
        reason: "lyrics cover too little of the recording",
        lines: lines,
        lexicalWordCount: lexicalWords.length,
      };
    }
  }

  return { accepted: true, reason: null, lines: lines, lexicalWordCount: lexicalWords.length };
}

function classifyWhisperFailure(error, stage) {
  var httpStatus = Number(error && error.response && error.response.status);
  var code = "unknown_failure";
  if (stage === "download_vocals") code = "vocals_download_failed";
  else if (stage === "prepare_audio") code = "audio_preparation_failed";
  else if (httpStatus === 401 || httpStatus === 403) code = "whisper_auth_failed";
  else if (httpStatus === 429) code = "whisper_rate_or_quota_limited";
  else if (httpStatus === 400 || httpStatus === 413 || httpStatus === 415) code = "whisper_rejected_audio";
  else if (error && ["ECONNABORTED", "ETIMEDOUT", "ESOCKETTIMEDOUT"].indexOf(error.code) !== -1) code = "whisper_timeout";
  else if (stage === "whisper_request") code = "whisper_request_failed";
  return {
    stage: stage,
    reason: code,
    httpStatus: Number.isFinite(httpStatus) ? httpStatus : null,
  };
}

async function transcribeVocalsStem(vocalsUrl) {
  if (!vocalsUrl) return { ok: false, failure: { stage: "input", reason: "vocals_stem_unavailable", httpStatus: null } };
  if (!process.env.OPENAI_API_KEY) return { ok: false, failure: { stage: "configuration", reason: "openai_not_configured", httpStatus: null } };
  var preparedPath = null;
  var stage = "download_vocals";
  try {
    console.log("Lyrics: downloading and preparing the Demucs vocals stem for Whisper");
    var response = await axios.get(vocalsUrl, {
      responseType: "arraybuffer",
      timeout: 90 * 1000,
      maxContentLength: 150 * 1024 * 1024,
      maxBodyLength: 150 * 1024 * 1024,
    });
    var contentType = response.headers && response.headers["content-type"];
    stage = "prepare_audio";
    preparedPath = await prepareWhisperAudio(Buffer.from(response.data), contentType, vocalsUrl);
    stage = "whisper_request";
    var transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(preparedPath),
      model: "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
    });
    var result = {
      text: cleanTranscribedLine(transcription.text),
      language: transcription.language || null,
      duration: Number.isFinite(Number(transcription.duration)) ? Number(transcription.duration) : null,
      segments: Array.isArray(transcription.segments) ? transcription.segments.map(function (segment) {
        return {
          text: cleanTranscribedLine(segment.text),
          start: Number(segment.start),
          end: Number(segment.end),
        };
      }).filter(function (segment) { return segment.text && Number.isFinite(segment.start) && Number.isFinite(segment.end); }) : [],
      words: Array.isArray(transcription.words) ? transcription.words.map(function (word) {
        return { word: String(word.word || "").trim(), start: Number(word.start), end: Number(word.end) };
      }).filter(function (word) { return word.word && Number.isFinite(word.start) && Number.isFinite(word.end); }) : [],
    };
    result.acceptance = assessTranscription(result);
    console.log(
      "Lyrics: Whisper detected " + (result.language || "unknown language") +
      " and returned " + result.segments.length + " segments / " + result.words.length +
      " words; transcript " + (result.acceptance.accepted ? "accepted" : "rejected: " + result.acceptance.reason)
    );
    if (!result.text && result.segments.length === 0) {
      var emptyFailure = { stage: "whisper_response", reason: "whisper_empty_transcript", httpStatus: null };
      logPipelineDiagnostic("whisper_failure", emptyFailure);
      return { ok: false, failure: emptyFailure };
    }
    return { ok: true, transcription: result };
  } catch (error) {
    var failure = classifyWhisperFailure(error, stage);
    logPipelineDiagnostic("whisper_failure", failure);
    return { ok: false, failure: failure };
  } finally {
    if (preparedPath) {
      try { fs.unlinkSync(preparedPath); } catch (_) {}
    }
  }
}

function normalizedLyricFingerprint(text) {
  return String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function groupTimedLinesIntoSections(lines, language, warning) {
  var fingerprints = {};
  lines.forEach(function (line) {
    var fingerprint = normalizedLyricFingerprint(line.text);
    if (fingerprint.split(/\s+/).filter(Boolean).length >= 3) {
      fingerprints[fingerprint] = (fingerprints[fingerprint] || 0) + 1;
    }
  });

  var blocks = [];
  var current = [];
  lines.forEach(function (line) {
    var previous = current[current.length - 1];
    var repeated = (fingerprints[normalizedLyricFingerprint(line.text)] || 0) > 1;
    var previousRepeated = previous && (fingerprints[normalizedLyricFingerprint(previous.text)] || 0) > 1;
    var shouldBreak = current.length > 0 && (
      (line.start - previous.end >= 3.5) ||
      current.length >= 8 ||
      (current.length >= 2 && repeated !== previousRepeated)
    );
    if (shouldBreak) {
      blocks.push(current);
      current = [];
    }
    current.push(line);
  });
  if (current.length) blocks.push(current);

  var verseNumber = 0;
  var chorusNumber = 0;
  return blocks.map(function (block, blockIndex) {
    var repeatedCount = block.filter(function (line) {
      return (fingerprints[normalizedLyricFingerprint(line.text)] || 0) > 1;
    }).length;
    var isChorus = block.length >= 2 && repeatedCount / block.length >= 0.5;
    var label;
    if (isChorus) {
      chorusNumber++;
      label = chorusNumber === 1 ? "Chorus" : "Chorus " + chorusNumber;
    } else {
      verseNumber++;
      label = "Verse " + verseNumber;
    }
    var section = {
      label: label,
      lines: block,
      transcriptLanguage: language || null,
      transcriptSource: "demucs_vocals_whisper",
    };
    if (blockIndex === 0 && warning) section.warning = warning;
    return section;
  });
}

function chordsForTimedLine(line, timeline) {
  if (!Array.isArray(timeline) || timeline.length === 0) return [];
  var events = [];
  var soundingAtStart = null;
  timeline.forEach(function (segment) {
    var segmentStart = Number(segment.time);
    var segmentEnd = segmentStart + Number(segment.duration || 0);
    if (segmentStart <= line.start && segmentEnd > line.start) soundingAtStart = segment.chord;
    if (segmentStart > line.start && segmentStart < line.end) {
      events.push({ time: segmentStart, chord: segment.chord });
    }
  });
  if (!soundingAtStart) {
    for (var i = timeline.length - 1; i >= 0; i--) {
      if (Number(timeline[i].time) <= line.start) {
        soundingAtStart = timeline[i].chord;
        break;
      }
    }
  }
  if (soundingAtStart) events.unshift({ time: line.start, chord: soundingAtStart });

  var chords = [];
  events.forEach(function (event) {
    var position = 0;
    if (Array.isArray(line.words) && line.words.length > 0) {
      var closest = line.words[0];
      for (var w = 0; w < line.words.length; w++) {
        if (line.words[w].start <= event.time) closest = line.words[w];
        else break;
      }
      position = closest.position || 0;
    } else if (line.end > line.start) {
      position = Math.round(((event.time - line.start) / (line.end - line.start)) * line.text.length);
    }
    position = Math.max(0, Math.min(position, line.text.length));
    var previous = chords[chords.length - 1];
    if (previous && previous.chord === event.chord) return;
    if (previous && previous.position === position) {
      previous.chord = event.chord;
      return;
    }
    chords.push({ chord: event.chord, position: position });
  });
  // Dense detector flicker is not useful in a static lyric chart.
  return chords.length > 4 ? chords.slice(0, 4) : chords;
}

function buildStaticChartFromTranscription(title, artist, detectedChords, transcription, musicalKey, tempo) {
  var acceptance = assessTranscription(transcription, detectedChords.clipDuration);
  if (!acceptance.accepted) return null;
  var timedLines = acceptance.lines;
  var hasChords = Array.isArray(detectedChords.timeline) && detectedChords.timeline.length > 0;
  var warning = hasChords
    ? null
    : "The vocals were transcribed, but the recording did not contain enough reliable harmonic signal to place chords.";
  var sections = groupTimedLinesIntoSections(timedLines, transcription.language, warning).map(function (section) {
    section.lines = section.lines.map(function (line) {
      return {
        lyrics: line.text,
        chords: chordsForTimedLine(line, detectedChords.timeline),
        start: line.start,
        end: line.end,
        words: line.words,
      };
    });
    return section;
  });
  return validateAndRepairChart({
    title: title,
    artist: artist,
    musicalKey: musicalKey || null,
    tempo: tempo || null,
    capo: 0,
    sections: sections,
    partial: !hasChords,
    warning: warning,
    transcriptLanguage: transcription.language || null,
  });
}

function buildChordOnlyChart(title, artist, detectedChords, musicalKey, tempo) {
  var progression = detectedChords.progression && detectedChords.progression.length
    ? detectedChords.progression
    : detectedChords.chords;
  if (!progression || progression.length === 0) return null;
  var warning = "Chords were detected, but the vocals could not be transcribed. The chord progression is still available below.";
  return validateAndRepairChart({
    title: title,
    artist: artist,
    musicalKey: musicalKey || null,
    tempo: tempo || null,
    capo: 0,
    partial: true,
    warning: warning,
    sections: [{
      label: "Detected chord progression",
      warning: warning,
      lines: progression.map(function (chord) {
        return { lyrics: "", chords: [{ chord: chord, position: 0 }] };
      }),
    }],
  });
}

function partialResult(chart, source, detectedChords, reason, warning) {
  chart.partial = true;
  chart.sourceClip = detectedChords.sourceClip || "unknown";
  chart.partialReason = String(reason || "incomplete_audio_analysis");
  var sourceReasonLabels = {
    yt_dlp_unavailable: "the full-song downloader is unavailable",
    youtube_search_failed: "the full-song search failed",
    youtube_no_matching_result: "no matching full-length recording was found",
    youtube_download_failed: "the full-song download failed",
    youtube_full_path_exception: "the full-song download could not be completed",
  };
  var transcriptionReasonLabels = {
    catalog_transcription_disabled: "catalog transcription is disabled on the backend",
    openai_not_configured: "Whisper is not configured on the backend",
    vocals_stem_unavailable: "Demucs did not provide a vocals stem",
    vocals_download_failed: "the separated vocals could not be downloaded",
    audio_preparation_failed: "the separated vocals could not be prepared for transcription",
    whisper_auth_failed: "Whisper rejected the backend credentials",
    whisper_rate_or_quota_limited: "Whisper reached a rate or usage limit",
    whisper_timeout: "Whisper timed out while transcribing the vocals",
    whisper_rejected_audio: "Whisper could not process the separated vocals",
    whisper_request_failed: "Whisper could not complete the transcription request",
    whisper_empty_transcript: "Whisper returned no lyric text",
  };
  var detail = transcriptionReasonLabels[reason] ||
    (String(reason || "").indexOf("whisper_incomplete_") === 0
      ? "Whisper returned too little usable lyric text"
      : null);
  if (detectedChords.sourceClip === "itunes_preview_30s") {
    var fallbackDetail = sourceReasonLabels[detectedChords.sourceFallbackReason] ||
      "a full-length recording was unavailable";
    detail = "Only the 30-second iTunes preview was available because " + fallbackDetail + ".";
  }
  chart.warning = [warning, detail].filter(Boolean).join(" ");
  if (chart.sections && chart.sections[0]) {
    // Keep the diagnostic with the rendered partial result. Partial charts
    // are not cached, but older clients read warning metadata from sections.
    chart.sections[0].warning = chart.warning || chart.sections[0].warning;
    chart.sections[0].sourceClip = chart.sourceClip;
    chart.sections[0].partialReason = chart.partialReason;
  }
  return {
    chart: chart,
    source: source,
    partialResult: {
      sourceClip: chart.sourceClip,
      reason: chart.partialReason,
      sourceFallbackReason: detectedChords.sourceFallbackReason || null,
    },
  };
}

function diagnosticReason(prefix, value) {
  var normalized = String(value || "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return prefix + (normalized ? "_" + normalized : "");
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

  console.log(
    "Audio analysis: detected chords",
    detectedChords.chords.length ? detectedChords.chords.join(", ") : "(none above the confidence threshold)",
    "for", title, "by", artist
  );
  // Spotify's key endpoint is gone (403), so the key heard in the actual
  // recording is our best "confirmed key" for the prompt's key enforcement.
  var confirmedKey = spotifyKey || detectedChords.key || null;

  // Prefer complete catalog lyrics when their identity is verified. Whisper
  // then serves as a timing anchor, not as a replacement for most of a song.
  var alignedLines = null;
  if (realLyrics && realLyrics.synced && detectedChords.vocalsUrl && detectedChords.timeline.length) {
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
      }
    }
  }

  if (realLyrics && realLyrics.plain && detectedChords.chords.length) {
    var chart = await generateChartWithAI(title, artist, releaseDate, confirmedKey, spotifyTempo, realLyrics.plain, detectedChords, alignedLines);
    return { chart: chart, source: "audio_analysis" };
  }

  // Only use lyrics transcribed from the recording when no verified catalog
  // lyrics exist and the transcript passes a full-song completeness gate.
  var transcriptionOutcome;
  if (!detectedChords.vocalsUrl) {
    transcriptionOutcome = { ok: false, failure: { stage: "input", reason: "vocals_stem_unavailable", httpStatus: null } };
  } else if (!ALLOW_CATALOG_LYRICS_TRANSCRIPTION) {
    transcriptionOutcome = { ok: false, failure: { stage: "configuration", reason: "catalog_transcription_disabled", httpStatus: null } };
  } else {
    transcriptionOutcome = await transcribeVocalsStem(detectedChords.vocalsUrl);
  }
  if (detectedChords.vocalsUrl && !ALLOW_CATALOG_LYRICS_TRANSCRIPTION) {
    console.log("Lyrics: catalog transcription is disabled by ALLOW_CATALOG_LYRICS_TRANSCRIPTION");
  }
  var transcription = transcriptionOutcome.ok ? transcriptionOutcome.transcription : null;
  var partialReason = transcriptionOutcome.ok
    ? null
    : transcriptionOutcome.failure.reason;
  if (!transcriptionOutcome.ok) {
    logPipelineDiagnostic("transcription_unavailable", {
      sourceClip: detectedChords.sourceClip,
      sourceFallbackReason: detectedChords.sourceFallbackReason,
      stage: transcriptionOutcome.failure.stage,
      reason: transcriptionOutcome.failure.reason,
      httpStatus: transcriptionOutcome.failure.httpStatus,
    });
  }
  if (transcription) {
    transcription.acceptance = assessTranscription(transcription, detectedChords.clipDuration);
    var transcribedChart = buildStaticChartFromTranscription(
      title,
      artist,
      detectedChords,
      transcription,
      confirmedKey,
      spotifyTempo
    );
    if (transcribedChart) {
      if (detectedChords.sourceClip !== "youtube_full") {
        var coverageWarning = detectedChords.sourceClip === "itunes_preview_30s"
          ? "Lyrics and chords cover only the available 30-second preview, not the full song."
          : "Lyrics and chords cover only the analyzed audio clip, not a verified full-song recording.";
        console.log("Audio analysis: returning clip-covered vocals as an explicit partial result");
        return partialResult(
          transcribedChart,
          "audio_transcription_partial",
          detectedChords,
          "preview_only_not_full_song",
          coverageWarning
        );
      }
      if (transcribedChart.partial) {
        return partialResult(
          transcribedChart,
          "audio_transcription_partial",
          detectedChords,
          "reliable_chords_unavailable",
          transcribedChart.warning
        );
      }
      console.log(
        "Audio analysis: accepted a complete vocals transcript (" +
        transcribedChart.sections.reduce(function (count, section) { return count + section.lines.length; }, 0) +
        " timed lyric lines)"
      );
      return { chart: transcribedChart, source: "audio_transcription" };
    }
    partialReason = diagnosticReason("whisper_incomplete", transcription.acceptance && transcription.acceptance.reason);
    logPipelineDiagnostic("whisper_incomplete", {
      sourceClip: detectedChords.sourceClip,
      sourceFallbackReason: detectedChords.sourceFallbackReason,
      reason: transcription.acceptance && transcription.acceptance.reason,
      segmentCount: transcription.segments.length,
      wordCount: transcription.words.length,
      expectedDuration: detectedChords.clipDuration,
    });
    console.log("Audio analysis: vocals transcript rejected as incomplete");
  }

  // Do not turn a lyrics failure into a generic 500 after an expensive audio
  // analysis. If harmony succeeded, return the measured progression and an
  // explicit warning. The UI can render this partial chart and the user keeps
  // the useful work that did succeed.
  var chordOnlyChart = buildChordOnlyChart(title, artist, detectedChords, confirmedKey, spotifyTempo);
  if (chordOnlyChart) {
    return partialResult(
      chordOnlyChart,
      "audio_analysis_partial",
      detectedChords,
      partialReason || "vocals_transcription_unavailable",
      chordOnlyChart.warning
    );
  }
  return null;
}

async function saveChartToDB(chart, title, artist, source) {
  if (chartContainsLyricsRefusal(chart)) throw lyricsUnavailableError();
  if (chartHasPartialMarker(chart, source)) {
    logPipelineDiagnostic("partial_chart_not_cached", {
      sourceClip: chart.sourceClip,
      reason: chart.partialReason || "partial_chart",
    });
    return { saved: false, reason: "partial_chart_not_cached" };
  }

  // Read the exact candidates so a complete result can replace a legacy
  // partial row. The update below is conditional on both id and
  // verified=false (and the observed partial source), which prevents a
  // musician-verified or concurrently corrected chart from being overwritten.
  var existingResult = await supabase
    .from("chord_charts")
    .select("id,title,artist,verified,source,sections")
    .ilike("title", "%" + normalizeForLookup(title).replace(/[%_]/g, "") + "%")
    .limit(25);
  if (existingResult.error) throw databaseError("read", existingResult.error);
  var matchingRows = (existingResult.data || []).filter(function (row) {
    return titlesMatch(row.title, title) && artistsLooselyMatch(row.artist, artist);
  });
  var protectedChart = matchingRows.some(function (row) { return row.verified === true; });
  if (protectedChart) {
    var protectedError = new Error("A musician-verified chart already exists and was not overwritten.");
    protectedError.code = "VERIFIED_CHART_PROTECTED";
    protectedError.httpStatus = 409;
    throw protectedError;
  }

  var rowPayload = {
    title:       chart.title  || title,
    artist:      chart.artist || artist,
    musical_key: chart.musicalKey,
    tempo:       chart.tempo,
    capo:        chart.capo,
    sections:    chart.sections,
    source:      source || "ai_generated",
    verified:    false,
    play_count:  1
  };

  var partialRow = matchingRows.find(rowIsUnverifiedPartial);
  if (partialRow) {
    var updateQuery = supabase
      .from("chord_charts")
      .update(rowPayload)
      .eq("id", partialRow.id)
      .eq("verified", false);
    updateQuery = partialRow.source == null
      ? updateQuery.is("source", null)
      : updateQuery.eq("source", partialRow.source);
    var updateResult = await updateQuery.select("id");
    if (updateResult.error) throw databaseError("write", updateResult.error);
    if (!updateResult.data || updateResult.data.length === 0) {
      var racedResult = await supabase
        .from("chord_charts")
        .select("id,verified,source")
        .eq("id", partialRow.id)
        .limit(1);
      if (racedResult.error) throw databaseError("read", racedResult.error);
      var racedRow = racedResult.data && racedResult.data[0];
      var raceError = new Error(
        racedRow && racedRow.verified === true
          ? "A musician-verified chart was saved concurrently and was not overwritten."
          : "The cached chart changed concurrently and was not overwritten."
      );
      raceError.code = racedRow && racedRow.verified === true
        ? "VERIFIED_CHART_PROTECTED"
        : "CHART_ALREADY_EXISTS";
      raceError.httpStatus = 409;
      throw raceError;
    }
    console.log("Supabase save: replaced legacy unverified partial chart (source=" + (source || "ai_generated") + ")");
    return { saved: true, replacedPartial: true };
  }

  var saveResult = await supabase.from("chord_charts").insert(rowPayload).select("id");
  if (saveResult.error && saveResult.error.code === "23505") {
    var conflictError = new Error("Another chart for this song was saved first and was not overwritten.");
    conflictError.code = "CHART_ALREADY_EXISTS";
    conflictError.httpStatus = 409;
    throw conflictError;
  }
  if (saveResult.error || !saveResult.data || saveResult.data.length === 0) {
    throw databaseError("write", saveResult.error || new Error("chart insert returned no row"));
  }
  console.log("Supabase save: OK (source=" + (source || "ai_generated") + ")");
  return { saved: true };
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

function identityText(s) {
  return stripAccents(normalizeForLookup(s))
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titlesMatch(actual, requested) {
  var a = identityText(actual);
  var b = identityText(requested);
  return !!a && !!b && a === b;
}

function pageIdentityMatches($, title, artist) {
  var identity = [
    $("title").first().text(),
    $("meta[property='og:title']").attr("content") || "",
    $("meta[name='twitter:title']").attr("content") || "",
    $("h1").first().text(),
    $("h2").first().text(),
    $("[itemprop='name']").slice(0, 4).text(),
  ].join(" ");
  var normalized = identityText(identity);
  var normalizedTitle = identityText(title);
  var normalizedArtist = identityText(artist);
  return !!normalizedTitle && !!normalizedArtist
    && normalized.indexOf(normalizedTitle) !== -1
    && normalized.indexOf(normalizedArtist) !== -1;
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
      var resultTitle = r.song_name || r.song || r.title;
      var resultArtist = r.artist_name || r.artist;
      if (!titlesMatch(resultTitle, title) || !artistsLooselyMatch(resultArtist, artist)) {
        continue;
      }
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
  var pageData = data && data.store && data.store.page && data.store.page.data;
  var tab = pageData && pageData.tab;
  var meta = (tabView && tabView.meta) || {};
  var actualTitle = (tab && (tab.song_name || tab.song && tab.song.name))
    || meta.song_name || meta.title;
  var actualArtist = (tab && (tab.artist_name || tab.artist && tab.artist.name))
    || meta.artist_name || meta.artist;
  var metadataMatches = actualTitle && actualArtist
    && titlesMatch(actualTitle, title)
    && artistsLooselyMatch(actualArtist, artist);
  if (!metadataMatches && !pageIdentityMatches($, title, artist)) {
    console.log("UG: tab identity mismatch; rejecting result");
    return null;
  }
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
      try {
        var candidateUrl = new URL(href, "https://www.cifraclub.com.br");
        if (candidateUrl.hostname !== "www.cifraclub.com.br" && candidateUrl.hostname !== "cifraclub.com.br") return;
        var segments = candidateUrl.pathname.split("/").filter(Boolean);
        if (segments.length !== 2) return;
        if (segments[0] !== artistSlug || segments[1] !== titleSlug) return;
        songLink = candidateUrl.origin + "/" + segments.join("/") + "/";
      } catch(_) {}
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
  if (!pageIdentityMatches($, title, artist)) {
    console.log("Cifra Club: page identity mismatch; rejecting result");
    return null;
  }

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

async function fetchChartFromRealSources(title, artist) {
  // SKIP_SCRAPERS=1 forces the audio-analysis path — used when testing the
  // pipeline against songs the chord sites already cover.
  var chart;
  if (process.env.SKIP_SCRAPERS === "1") {
    console.log("Sources: SKIP_SCRAPERS set — going straight to audio analysis");
    return null;
  }

  console.log("Sources: trying Ultimate-Guitar for", title, "by", artist);
  chart = await fetchChartFromUG(title, artist);
  if (chart) return { chart: chart, source: "ultimate_guitar" };

  console.log("Sources: trying Cifra Club for", title, "by", artist);
  chart = await fetchChartFromCifra(title, artist);
  if (chart) return { chart: chart, source: "cifraclub" };

  console.log("Sources: trying e-chords for", title, "by", artist);
  chart = await fetchChartFromEchords(title, artist);
  if (chart) return { chart: chart, source: "echords" };

  return null;
}

async function fetchChartFromSources(title, artist, releaseDate) {
  var chart;
  var realResult = await fetchChartFromRealSources(title, artist);
  if (realResult) return realResult;

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
  if (!lyricsResult && !ALLOW_CATALOG_LYRICS_TRANSCRIPTION) {
    console.log("Sources: catalog lyric generation disabled; no external lyrics available");
    throw lyricsUnavailableError();
  }
  console.log("Sources: falling back to plain AI generation");
  chart = await generateChartWithAI(title, artist, releaseDate || null, spotifyResult.spotifyKey, spotifyResult.spotifyTempo, lyricsResult ? lyricsResult.plain : null);
  return { chart: chart, source: "ai_generated" };
}

async function canonicalSongCandidates(songInfo) {
  var candidates = [];
  function add(title, artist) {
    title = String(title || "").trim();
    artist = String(artist || "").trim();
    if (!title || !artist) return;
    var key = title.toLowerCase() + "\u0000" + artist.toLowerCase();
    if (!candidates.some(function (candidate) { return candidate.key === key; })) {
      candidates.push({ key: key, title: title, artist: artist });
    }
  }

  var apple = songInfo.apple_music || {};
  add(apple.name, apple.artistName);
  var spotify = songInfo.spotify || {};
  add(spotify.name, spotify.artists && spotify.artists[0] && spotify.artists[0].name);

  try {
    var query = songInfo.title + " " + songInfo.artist;
    var response = await axios.get(
      "https://itunes.apple.com/search?term=" + encodeURIComponent(query) + "&entity=song&limit=8",
      { timeout: 8000 }
    );
    var results = response.data && Array.isArray(response.data.results) ? response.data.results : [];
    var requestedTitle = normalizeForLookup(songInfo.title).toLowerCase();
    for (var i = 0; i < results.length; i++) {
      var item = results[i];
      var itemTitle = normalizeForLookup(item.trackName).toLowerCase();
      var titleMatches = itemTitle === requestedTitle
        || itemTitle.indexOf(requestedTitle) !== -1
        || requestedTitle.indexOf(itemTitle) !== -1;
      if (titleMatches && artistsLooselyMatch(item.artistName, songInfo.artist)) {
        add(item.trackName, item.artistName);
      }
    }
  } catch(error) {
    console.log("iTunes canonical metadata lookup failed:", error.message);
  }

  return candidates;
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
      catalogLyricsTranscription: ALLOW_CATALOG_LYRICS_TRANSCRIPTION,
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
    res.status(e.httpStatus || 500).json({ error: e.httpStatus ? "The chord database is temporarily unavailable." : e.message, code: e.code });
  }
});

// POST /chords { title, artist, force? } — generate + save
//   force: true → bypass a non-verified cached chart. A verified chart that
//   was observed by either protection check is never deliberately replaced.
app.post("/chords", rateLimit("chords", 50), async function(req, res) {
  var title = req.body.title, artist = req.body.artist;
  var force = req.body.force === true;
  if (!title || !artist) return res.status(400).json({ error: "title and artist required" });
  try {
    console.log("POST /chords:", force ? "FORCE-regenerating" : "generating", "for", title, "by", artist);

    // Verified charts always win, even when force=true.
    var existing = await fetchChartFromDB(title, artist);
    if (existing && (existing.verified || !force)) {
        console.log("POST /chords: already in database, returning cached");
        return res.json({ found: true, fromDatabase: true, chart: existing });
    }

    // Try real chord sources (Cifra Club → e-chords) first, LLM as fallback.
    var result = await fetchChartFromSources(title, artist, null);
    result.chart.source = result.source;
    var persistence = await saveChartToDB(result.chart, title, artist, result.source);
    var responseBody = {
      found: true,
      fromDatabase: false,
      chart: result.chart,
      source: result.source,
      cached: persistence.saved === true,
    };
    if (result.partialResult) responseBody.partialResult = result.partialResult;
    res.json(responseBody);
  } catch(e) {
    if (e.code === "CHART_ALREADY_EXISTS" || e.code === "VERIFIED_CHART_PROTECTED") {
      try {
        var concurrentChart = await fetchChartFromDB(title, artist);
        if (concurrentChart) {
          console.log("POST /chords: returning chart saved by a concurrent request");
          return res.json({ found: true, fromDatabase: true, chart: concurrentChart });
        }
      } catch (lookupError) {
        console.warn("POST /chords conflict lookup failed:", lookupError.message);
      }
    }
    console.error("POST /chords error:", e.message);
    res.status(e.httpStatus || (e.code === "LYRICS_UNAVAILABLE" ? 422 : 500)).json({ error: e.message, code: e.code });
  }
});

var identifyChartRequests = new Map();

app.post("/identify", rateLimit("identify", 50), async function(req, res) {
  try {
    var audioBase64 = req.body.audioBase64;
    var mimeType = req.body.mimeType;
    if (typeof audioBase64 !== "string" || !audioBase64.trim()) {
      return res.status(400).json({ error: "No audio provided" });
    }

    var normalizedMime = typeof mimeType === "string"
      ? mimeType.toLowerCase().split(";")[0].trim()
      : "";
    var audioExtensions = {
      "audio/webm": "webm",
      "audio/ogg": "ogg",
      "audio/mp4": "mp4",
      "audio/m4a": "m4a",
      "audio/x-m4a": "m4a",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/mpeg": "mp3",
      "audio/mp3": "mp3",
    };
    var audioExtension = audioExtensions[normalizedMime];
    if (!audioExtension) {
      return res.status(415).json({
        error: "Unsupported audio format. Use WebM, OGG, MP4/M4A, WAV, or MP3.",
      });
    }

    var normalizedBase64 = audioBase64.replace(/\s/g, "");
    if (
      normalizedBase64.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(normalizedBase64)
    ) {
      return res.status(400).json({ error: "Invalid audio data" });
    }

    var maxIdentifyBytes = 5 * 1024 * 1024;
    var base64Padding = normalizedBase64.endsWith("==")
      ? 2
      : (normalizedBase64.endsWith("=") ? 1 : 0);
    var estimatedBytes = Math.floor(normalizedBase64.length * 3 / 4) - base64Padding;
    if (estimatedBytes > maxIdentifyBytes) {
      return res.status(413).json({ error: "Recording is too large. Please record a shorter clip." });
    }

    var audioBuffer = Buffer.from(normalizedBase64, "base64");
    if (!audioBuffer.length) {
      return res.status(400).json({ error: "No audio provided" });
    }
    if (audioBuffer.length > maxIdentifyBytes) {
      return res.status(413).json({ error: "Recording is too large. Please record a shorter clip." });
    }
    if (!process.env.AUDD_API_KEY) {
      console.error("AudD is not configured");
      return res.status(503).json({
        error: "Song identification is temporarily unavailable.",
      });
    }

    console.log("Step 1: Identifying with AudD...");
    var auddResponse;
    try {
      var form = new FormData();
      form.append("api_token", process.env.AUDD_API_KEY);
      form.append("return", "spotify,apple_music");
      form.append("file", audioBuffer, {
        filename: "recording." + audioExtension,
        contentType: normalizedMime,
      });
      auddResponse = await axios.post("https://api.audd.io/", form, {
        headers: form.getHeaders(),
        timeout: 20 * 1000,
      });
    } catch(e) {
      console.error("AudD provider error:", e.message);
      var auddTimedOut = e.code === "ECONNABORTED" || e.code === "ETIMEDOUT";
      return res.status(auddTimedOut ? 504 : 502).json({
        error: auddTimedOut
          ? "Song identification service timed out. Please try again."
          : "Song identification service failed. Please try again.",
      });
    }

    if (!auddResponse.data || auddResponse.data.status === "error") {
      console.error("AudD provider error:", auddResponse.data && auddResponse.data.error);
      return res.status(502).json({
        error: "Song identification service failed. Please try again.",
      });
    }

    var songInfo = auddResponse.data.result;
    if (!songInfo) {
      console.log("Not identified by AudD");
      return res.json({ identified: false, songInfo: null });
    }
    console.log("Identified:", songInfo.title, "by", songInfo.artist);

    // Adaptive browser recognition asks only for metadata. Do not start the
    // expensive chart/Demucs job on every short microphone window.
    if (req.body.identifyOnly === true) {
      return res.json({
        identified: true,
        fromDatabase: false,
        songInfo: songInfo,
        chart: null,
        chartDeferred: true,
      });
    }

    var chartRequestKey = normalizeForLookup(songInfo.title).toLowerCase()
      + "\u0000"
      + normalizeForLookup(songInfo.artist).toLowerCase();
    var chartRequest = identifyChartRequests.get(chartRequestKey);

    if (!chartRequest) {
      chartRequest = (async function() {
        try {
          console.log("Step 2: Checking Supabase chord database...");
          var cached = await fetchChartFromDB(songInfo.title, songInfo.artist);
          if (cached) {
            console.log("Returning from database!");
            return { fromDatabase: true, chart: cached };
          }

          console.log("Step 3: Looking up chord chart from real sources or AI...");
          var result = await fetchChartFromSources(songInfo.title, songInfo.artist, songInfo.release_date);
          var chart  = result.chart;
          var source = result.source;
          chart.source = source;
          var persistence = await saveChartToDB(chart, songInfo.title, songInfo.artist, source);
          return {
            fromDatabase: false,
            chart: chart,
            source: source,
            cached: persistence.saved === true,
            partialResult: result.partialResult || null,
          };
        } finally {
          if (identifyChartRequests.get(chartRequestKey) === chartRequest) {
            identifyChartRequests.delete(chartRequestKey);
          }
        }
      })();
      identifyChartRequests.set(chartRequestKey, chartRequest);
    } else {
      console.log("Reusing in-flight chart request for", songInfo.title, "by", songInfo.artist);
    }

    var chartResult;
    try {
      chartResult = await chartRequest;
    } catch(error) {
      if (error.code === "LYRICS_UNAVAILABLE") {
        console.log("AudD metadata produced no safe chart; trying canonical metadata");
        var canonicalCandidates = await canonicalSongCandidates(songInfo);
        var originalKey = String(songInfo.title).trim().toLowerCase()
          + "\u0000"
          + String(songInfo.artist).trim().toLowerCase();
        for (var i = 0; i < canonicalCandidates.length; i++) {
          var canonical = canonicalCandidates[i];
          if (canonical.key === originalKey) continue;
          try {
            console.log("Retrying chart with canonical metadata:", canonical.title, "by", canonical.artist);
            var canonicalCached = await fetchChartFromDB(canonical.title, canonical.artist);
            if (canonicalCached) {
              chartResult = {
                fromDatabase: true,
                chart: canonicalCached,
                source: canonicalCached.source,
              };
            } else {
              var canonicalResult = await fetchChartFromRealSources(
                canonical.title,
                canonical.artist
              );
              if (!canonicalResult) continue;
              canonicalResult.chart.source = canonicalResult.source;
              await saveChartToDB(
                canonicalResult.chart,
                canonical.title,
                canonical.artist,
                canonicalResult.source
              );
              chartResult = {
                fromDatabase: false,
                chart: canonicalResult.chart,
                source: canonicalResult.source,
              };
            }
            songInfo = Object.assign({}, songInfo, {
              title: canonical.title,
              artist: canonical.artist,
            });
            break;
          } catch(canonicalError) {
            if (canonicalError.code === "DATABASE_READ_FAILED" || canonicalError.code === "DATABASE_WRITE_FAILED") {
              throw canonicalError;
            }
            console.log("Canonical chart retry failed:", canonicalError.message);
          }
        }
        if (!chartResult) {
          console.log("Song identified, but no safe lyrics chart is available");
          return res.json({
            identified: true,
            fromDatabase: false,
            songInfo: songInfo,
            chart: null,
            lyricsAvailable: false,
            lyricsUnavailable: true,
          });
        }
      } else if (error.code === "CHART_ALREADY_EXISTS" || error.code === "VERIFIED_CHART_PROTECTED") {
        // A concurrent generator or manual correction won the insert race.
        // Read and return that canonical row instead of surfacing a false
        // failure or allowing the generated chart to replace it.
        chartResult = {
          fromDatabase: true,
          chart: await fetchChartFromDB(songInfo.title, songInfo.artist),
        };
        if (!chartResult.chart) throw error;
      } else {
        throw error;
      }
    }
    var lyricsAvailable = chartHasLyrics(chartResult.chart);
    res.json({
      identified: true,
      fromDatabase: chartResult.fromDatabase,
      songInfo: songInfo,
      chart: chartResult.chart,
      source: chartResult.source,
      cached: chartResult.cached,
      partialResult: chartResult.partialResult || undefined,
      lyricsAvailable: lyricsAvailable,
      lyricsUnavailable: !lyricsAvailable,
    });

  } catch(error) {
    console.error("Error:", error.message);
    res.status(error.httpStatus || (error.code === "LYRICS_UNAVAILABLE" ? 422 : 500)).json({ error: error.message, code: error.code });
  }
});

// POST /deconstruct { audioBase64, mimeType?, separate? }
//
// First production-safe slice of Paul's deconstruction handoff:
// capture-quality gate -> key -> optional Demucs stems -> harmonic chord
// timelines for guitar/piano/other. Stages we have not safely ported yet are
// returned under `stagesSkipped` instead of being faked.
app.post("/deconstruct", rateLimit("deconstruct", 20), async function(req, res) {
  var audioBase64 = req.body.audioBase64;
  var mimeType = req.body.mimeType || "audio/m4a";
  if (!audioBase64) return res.status(400).json({ error: "No audio provided" });

  var tempPath = null;
  try {
    var decoded = decodeAudioPayload(audioBase64, mimeType);
    var audioBuffer = decoded.buffer;
    console.log("Deconstruct: analysing uploaded audio (" + (audioBuffer.length / 1024).toFixed(0) + " KB)");
    var analysis = await analyzeUploadedAudio(audioBuffer, {
      separate: req.body.separate !== false,
      transcribe: false,
    });

    if (req.body.transcribe === true) {
      if (!process.env.OPENAI_API_KEY) {
        analysis.stagesSkipped.lyrics = "OPENAI_API_KEY is not configured";
      } else {
        try {
          var transcriptBuffer = audioBuffer;
          var transcriptMime = decoded.mimeType;
          var transcriptSource = "original";
          if (analysis.stems && analysis.stems.vocals) {
            var vocals = await axios.get(analysis.stems.vocals, { responseType: "arraybuffer" });
            transcriptBuffer = Buffer.from(vocals.data);
            transcriptMime = "audio/wav";
            transcriptSource = "vocals_stem";
          }
          tempPath = await prepareWhisperAudio(transcriptBuffer, transcriptMime, analysis.stems && analysis.stems.vocals);
          var tr = await openai.audio.transcriptions.create({
            file: fs.createReadStream(tempPath),
            model: "whisper-1",
            response_format: "verbose_json",
            timestamp_granularities: ["segment", "word"],
          });
          analysis.lyrics = {
            transcript: tr.text || "",
            language: tr.language || null,
            source: transcriptSource,
            segments: tr.segments || [],
            words: tr.words || [],
          };
          analysis.stagesRun.push("lyrics");
          delete analysis.stagesSkipped.lyrics;
        } catch(e) {
          analysis.stagesSkipped.lyrics = e.message;
        }
      }
    } else {
      analysis.stagesSkipped.lyrics = "not requested";
    }

    res.json({
      ok: true,
      input: {
        bytes: audioBuffer.length,
        mimeType: decoded.mimeType,
      },
      analysis: analysis,
    });
  } catch(e) {
    console.error("Deconstruct error:", e.message);
    res.status(e.httpStatus || 500).json({ error: e.message });
  } finally {
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch(_) {}
    }
  }
});

async function requireAuthenticatedUser(req, res, next) {
  var authorization = req.headers.authorization;
  var match = typeof authorization === "string"
    ? authorization.match(/^Bearer\s+([^\s]+)$/i)
    : null;
  if (!match) {
    return res.status(401).json({ error: "Sign in to edit chord charts.", code: "AUTH_REQUIRED" });
  }
  try {
    // getUser(token) validates the access token with Supabase Auth; the
    // service-role key remains backend-only and is never sent to the client.
    var authResult = await supabase.auth.getUser(match[1]);
    if (authResult.error || !authResult.data || !authResult.data.user) {
      return res.status(401).json({ error: "Your session is invalid or expired. Please sign in again.", code: "AUTH_INVALID" });
    }
    req.authUser = authResult.data.user;
    next();
  } catch (error) {
    console.error("Supabase auth validation failed:", error && error.message ? error.message : "unknown error");
    return res.status(503).json({ error: "Authentication is temporarily unavailable.", code: "AUTH_UNAVAILABLE" });
  }
}

function requireChartEditor(req, res, next) {
  var metadata = req.authUser && req.authUser.app_metadata ? req.authUser.app_metadata : {};
  var roles = Array.isArray(metadata.roles) ? metadata.roles : [];
  var role = typeof metadata.role === "string" ? metadata.role : "";
  var allowed = [role].concat(roles).some(function (candidate) {
    return typeof candidate === "string" && ["chart_editor", "admin"].includes(candidate.toLowerCase());
  });
  if (!allowed) {
    return res.status(403).json({ error: "Chord chart editing is limited to authorized editors.", code: "CHART_EDITOR_REQUIRED" });
  }
  next();
}

// Only a server-granted app_metadata role may publish a correction as verified.
app.put("/chords", requireAuthenticatedUser, requireChartEditor, rateLimit("chord-corrections", 30), async function(req, res) {
  res.setHeader("Content-Type", "application/json");
  var title = req.body.title, artist = req.body.artist;
  var sections = req.body.sections, musicalKey = req.body.musicalKey;
  var tempo = req.body.tempo, capo = req.body.capo;
  if (typeof title !== "string" || typeof artist !== "string" || !title.trim() || !artist.trim()) {
    return res.status(400).json({ error: "title and artist required" });
  }
  if (title.length > 200 || artist.length > 200) {
    return res.status(400).json({ error: "title or artist is too long" });
  }
  if (!Array.isArray(sections) || sections.length === 0 || sections.length > 100) {
    return res.status(400).json({ error: "sections must contain between 1 and 100 entries" });
  }
  var serializedSections = JSON.stringify(sections);
  if (serializedSections.length > 1024 * 1024) {
    return res.status(413).json({ error: "The corrected chart is too large." });
  }
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
    }, { onConflict: "title,artist" }).select("id");
    if (saveResult.error || !saveResult.data || saveResult.data.length === 0) {
      throw databaseError("write", saveResult.error || new Error("correction upsert returned no row"));
    }
    console.log("PUT /chords: saved OK");
    return res.json({ success: true });
  } catch(e) {
    console.error("PUT /chords error:", e.message);
    return res.status(e.httpStatus || 500).json({ error: e.httpStatus ? "The chord database is temporarily unavailable." : e.message, code: e.code });
  }
});

// POST /transcribe { audioBase64, mimeType? } — Whisper transcription, any language
app.post("/transcribe", rateLimit("transcribe", 50), async function(req, res) {
  var audioBase64 = req.body.audioBase64;
  var mimeType    = req.body.mimeType || "audio/m4a";
  if (!audioBase64) return res.status(400).json({ error: "No audio provided" });

  var tempPath = null;

  try {
    var decoded = decodeAudioPayload(audioBase64, mimeType);
    var audioBuffer = decoded.buffer;
    tempPath = await prepareWhisperAudio(audioBuffer, decoded.mimeType);
    console.log("Whisper: transcribing " + (audioBuffer.length / 1024).toFixed(0) + " KB");

    var response = await openai.audio.transcriptions.create({
      file:            fs.createReadStream(tempPath),
      model:           "whisper-1",
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
    });

    console.log("Whisper: language=" + response.language + " chars=" + (response.text || "").length);
    res.json({
      transcript: response.text,
      language: response.language,
      duration: response.duration || null,
      segments: response.segments || [],
      words: response.words || [],
    });
  } catch(e) {
    console.error("Transcribe error:", e.message);
    res.status(e.httpStatus || 500).json({ error: e.message });
  } finally {
    if (tempPath) {
      try { fs.unlinkSync(tempPath); } catch(_) {}
    }
  }
});

if (require.main === module) {
  app.listen(port, function() { console.log("Server started on port " + port); });
}

// exposed for test scripts only — `node server.js` is the real entry point
module.exports = {
  _internals: {
    generateChartWithAI,
    fetchChartFromAudioAnalysis,
    fetchChartFromSources,
    fetchRealLyrics,
    saveChartToDB,
    artistsLooselyMatch,
    titlesMatch,
    assessTranscription,
    transcriptionToTimedLines,
    buildStaticChartFromTranscription,
    buildChordOnlyChart,
    validateAndRepairChart,
    audioExtensionForMime,
    chartHasPartialMarker,
    rowIsUnverifiedPartial,
    classifyWhisperFailure,
    diagnosticReason,
  },
};
