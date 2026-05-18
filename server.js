require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const FormData = require("form-data");
const OpenAI = require("openai");
const cheerio = require("cheerio");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const port = 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function fetchChartFromDB(title, artist) {
  var { data: rows } = await supabase
    .from("chord_charts")
    .select("*")
    .ilike("title", title)
    .ilike("artist", artist)
    .limit(1);
  if (!rows || rows.length === 0) return null;
  var r = rows[0];
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

async function lrclibGet(title, artist) {
  try {
    var params = "artist_name=" + encodeURIComponent(artist) + "&track_name=" + encodeURIComponent(title);
    var res = await axios.get("https://lrclib.net/api/get?" + params, { timeout: 6000 });
    if (res.data && res.data.plainLyrics && res.data.plainLyrics.trim().length > 80) {
      return res.data.plainLyrics.trim();
    }
  } catch(e) { /* 404 is normal */ }
  return null;
}

async function lrclibSearch(title, artist) {
  try {
    var q = "q=" + encodeURIComponent(title + " " + artist);
    var res = await axios.get("https://lrclib.net/api/search?" + q, { timeout: 6000 });
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
      if (titleOk && artistOk) return h.plainLyrics.trim();
    }
    // No good match, fall back to top hit if it has substantial lyrics
    if (hits[0] && hits[0].plainLyrics && hits[0].plainLyrics.trim().length > 200) {
      return hits[0].plainLyrics.trim();
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
      return res.data.lyrics.trim();
    }
  } catch(e) { /* 404 is normal */ }
  return null;
}

async function fetchRealLyrics(rawTitle, rawArtist) {
  var title  = normalizeForLookup(rawTitle);
  var artist = normalizeForLookup(rawArtist);

  console.log("Lyrics: lrclib /get normalized -> '" + title + "' / '" + artist + "'");
  var l = await lrclibGet(title, artist);
  if (l) { console.log("Lyrics: lrclib /get hit (" + l.length + " chars)"); return l; }

  if (rawTitle !== title || rawArtist !== artist) {
    console.log("Lyrics: lrclib /get raw -> '" + rawTitle + "' / '" + rawArtist + "'");
    l = await lrclibGet(rawTitle, rawArtist);
    if (l) { console.log("Lyrics: lrclib /get raw hit (" + l.length + " chars)"); return l; }
  }

  console.log("Lyrics: lrclib /search...");
  l = await lrclibSearch(title, artist);
  if (l) { console.log("Lyrics: lrclib /search hit (" + l.length + " chars)"); return l; }

  console.log("Lyrics: lyrics.ovh...");
  l = await fetchLyricsFromOVH(title, artist);
  if (l) { console.log("Lyrics: lyrics.ovh hit (" + l.length + " chars)"); return l; }

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
        if (end === -1) { lyrics += rawLine.substring(i); break; }
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

async function generateChartWithAI(title, artist, releaseDate, spotifyKey, spotifyTempo, realLyrics) {
  var keyInfo = spotifyKey
    ? "Confirmed musical key: " + spotifyKey + " (Spotify audio analysis)."
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

// ── Orchestrator: try real chord sources → fall back to LLM ─────────────────
// Returns { chart, source } where source is one of:
//   "cifraclub", "echords", "ai_generated"

async function fetchChartFromSources(title, artist, releaseDate) {
  console.log("Sources: trying Ultimate-Guitar for", title, "by", artist);
  var chart = await fetchChartFromUG(title, artist);
  if (chart) return { chart: chart, source: "ultimate_guitar" };

  console.log("Sources: trying Cifra Club for", title, "by", artist);
  chart = await fetchChartFromCifra(title, artist);
  if (chart) return { chart: chart, source: "cifraclub" };

  console.log("Sources: trying e-chords for", title, "by", artist);
  chart = await fetchChartFromEchords(title, artist);
  if (chart) return { chart: chart, source: "echords" };

  // Last resort — LLM with our existing lyrics + Spotify pipeline
  console.log("Sources: no real source had the song, falling back to AI");
  var [lyricsResult, spotifyResult] = await Promise.all([
    fetchRealLyrics(title, artist),
    lookupSpotifyKey(title, artist),
  ]);
  chart = await generateChartWithAI(title, artist, releaseDate || null, spotifyResult.spotifyKey, spotifyResult.spotifyTempo, lyricsResult);
  return { chart: chart, source: "ai_generated" };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get("/", function(req, res) { res.send("Music Player 2.0 server is running!"); });

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
app.post("/chords", async function(req, res) {
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

app.post("/identify", async function(req, res) {
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

app.listen(port, function() { console.log("Server started on port " + port); });
