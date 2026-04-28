require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");
const FormData = require("form-data");
const OpenAI = require("openai");
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
  return { title: r.title, artist: r.artist, musicalKey: r.musical_key, tempo: r.tempo, capo: r.capo, sections: r.sections };
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

async function generateChartWithAI(title, artist, releaseDate, spotifyKey, spotifyTempo) {
  var systemPrompt = "You are a world-class musician and transcriptionist. Generate chord charts as a JSON object with EXACTLY these top-level fields: title (string), artist (string), musicalKey (string e.g. \"G major\"), tempo (number BPM), capo (number, 0 if none), sections (array). Each section has: label (string e.g. \"Verse 1\", \"Chorus\", \"Bridge\") and lines (array). Each line has: lyrics (string) and chords (array of {chord: string, position: number} where position is the 0-based character index in the lyrics string where the chord falls). Include ALL sections of the song — every verse, chorus, pre-chorus, bridge, and outro. Do not truncate. Use only exact chords from the original recording. No substitutions. Respond ONLY with a single valid JSON object.";
  var keyInfo = spotifyKey
    ? " The song is in " + spotifyKey + " (verified via Spotify)."
    : " Before generating chords, identify the exact musical key of this song from your training data and use it throughout — set the musicalKey field accordingly.";
  var tempoInfo = spotifyTempo ? " The tempo is " + spotifyTempo + " BPM (verified via Spotify)." : "";
  var userPrompt = "Generate a complete, accurate chord chart for \"" + title + "\" by " + artist + " (released " + (releaseDate || "unknown") + ")." + keyInfo + tempoInfo + " Include every section with real lyrics and accurate chords. Do not skip or summarize any section.";
  console.log("OpenAI: key source:", spotifyKey ? "Spotify" : "training data");

  var completion = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 4096,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ]
  });

  var raw = completion.choices[0].message.content || completion.choices[0].message.refusal || "";
  console.log("OpenAI: finish_reason:", completion.choices[0].finish_reason, "length:", raw.length);
  if (!raw) throw new Error("OpenAI returned empty response");
  var chart = JSON.parse(raw);
  if (chart.chart && typeof chart.chart === "object" && !Array.isArray(chart.chart)) chart = chart.chart;
  if (!Array.isArray(chart.sections)) chart.sections = [];
  return chart;
}

async function saveChartToDB(chart, title, artist) {
  var saveResult = await supabase.from("chord_charts").upsert({
    title:       chart.title  || title,
    artist:      chart.artist || artist,
    musical_key: chart.musicalKey,
    tempo:       chart.tempo,
    capo:        chart.capo,
    sections:    chart.sections,
    source:      "ai_generated",
    verified:    false,
    play_count:  1
  }, { onConflict: "title,artist" });
  console.log("Supabase save:", saveResult.error ? "ERROR: " + saveResult.error.message : "OK");
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

// POST /chords { title, artist } — generate + save (Spotify key → OpenAI → Supabase)
app.post("/chords", async function(req, res) {
  var title = req.body.title, artist = req.body.artist;
  if (!title || !artist) return res.status(400).json({ error: "title and artist required" });
  try {
    console.log("POST /chords: generating for", title, "by", artist);

    // Check cache first — might have been generated in a parallel request
    var existing = await fetchChartFromDB(title, artist);
    if (existing) {
      console.log("POST /chords: already in database, returning cached");
      return res.json({ found: true, fromDatabase: true, chart: existing });
    }

    var { spotifyKey, spotifyTempo } = await lookupSpotifyKey(title, artist);
    var chart = await generateChartWithAI(title, artist, null, spotifyKey, spotifyTempo);
    await saveChartToDB(chart, title, artist);
    res.json({ found: true, fromDatabase: false, chart });
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

    console.log("Step 2: Looking up Spotify audio features...");
    var spotifyKey = null, spotifyTempo = null;
    if (songInfo) {
      var spotifyResult = await lookupSpotifyKey(songInfo.title, songInfo.artist);
      spotifyKey = spotifyResult.spotifyKey;
      spotifyTempo = spotifyResult.spotifyTempo;
    }

    console.log("Step 3: Checking Supabase chord database...");
    if (songInfo) {
      try {
        var cached = await fetchChartFromDB(songInfo.title, songInfo.artist);
        if (cached) {
          console.log("Returning from database!");
          return res.json({ identified: true, fromDatabase: true, songInfo, chart: cached });
        }
      } catch(e) { console.log("DB lookup error:", e.message); }
    }

    console.log("Step 4: Generating chart with OpenAI gpt-4o...");
    var chart;
    if (songInfo) {
      chart = await generateChartWithAI(songInfo.title, songInfo.artist, songInfo.release_date, spotifyKey, spotifyTempo);
      await saveChartToDB(chart, songInfo.title, songInfo.artist);
    } else {
      chart = await generateChartWithAI("Unknown Song", "Unknown Artist", null, null, null);
    }

    res.json({ identified: !!songInfo, fromDatabase: false, songInfo, chart });

  } catch(error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, function() { console.log("Server started on port " + port); });
