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
    var spotifyKey = null;
    var spotifyTempo = null;
    if (songInfo) {
      try {
        // 2a: get access token
        console.log("Spotify 2a: requesting token...");
        var tokenResponse = await axios.post(
          "https://accounts.spotify.com/api/token",
          "grant_type=client_credentials",
          { headers: { "Content-Type": "application/x-www-form-urlencoded", "Authorization": "Basic " + Buffer.from(process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET).toString("base64") } }
        );
        var spotifyToken = tokenResponse.data.access_token;
        console.log("Spotify 2a: token OK, type:", tokenResponse.data.token_type);

        // 2b: search for track — use plain string query (field filters can trigger 403 on some app tiers)
        var searchQuery = songInfo.title + " " + songInfo.artist;
        console.log("Spotify 2b: searching for:", searchQuery);
        var searchResponse = await axios.get("https://api.spotify.com/v1/search", {
          headers: { "Authorization": "Bearer " + spotifyToken },
          params: { q: searchQuery, type: "track", limit: 1 }
        });
        console.log("Spotify 2b: search status:", searchResponse.status, "hits:", searchResponse.data.tracks.items.length);
        var tracks = searchResponse.data.tracks.items;

        if (tracks.length > 0) {
          var trackId = tracks[0].id;
          var trackName = tracks[0].name;
          console.log("Spotify 2b: matched track:", trackName, "id:", trackId);

          var KEY_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

          // 2c: audio-analysis — not deprecated, returns track.key + track.tempo
          console.log("Spotify 2c: fetching audio-analysis for id:", trackId);
          var analysisResponse = await axios.get("https://api.spotify.com/v1/audio-analysis/" + trackId, {
            headers: { "Authorization": "Bearer " + spotifyToken },
            validateStatus: null
          });
          console.log("Spotify 2c: audio-analysis status:", analysisResponse.status);

          if (analysisResponse.status === 200 && analysisResponse.data && analysisResponse.data.track) {
            var at = analysisResponse.data.track;
            console.log("Spotify 2c: raw key:", at.key, "mode:", at.mode, "tempo:", at.tempo);
            if (at.key !== undefined && at.key !== -1) {
              spotifyKey = KEY_NAMES[at.key] + (at.mode === 1 ? " major" : " minor");
              spotifyTempo = Math.round(at.tempo);
              console.log("Spotify 2c: resolved key:", spotifyKey, "tempo:", spotifyTempo);
            } else {
              console.log("Spotify 2c: key undetected in analysis (key=-1), falling through");
            }
          } else {
            console.log("Spotify 2c: audio-analysis failed (status " + analysisResponse.status + "), trying track metadata...");

            // 2d: track metadata — key/tempo not present in this object but log what we get
            var trackResponse = await axios.get("https://api.spotify.com/v1/tracks/" + trackId, {
              headers: { "Authorization": "Bearer " + spotifyToken },
              validateStatus: null
            });
            console.log("Spotify 2d: track metadata status:", trackResponse.status);
            if (trackResponse.status === 200 && trackResponse.data) {
              var tm = trackResponse.data;
              console.log("Spotify 2d: track confirmed:", tm.name, "by", tm.artists.map(function(a) { return a.name; }).join(", "), "— note: key/tempo not available in track metadata, will use OpenAI fallback");
            } else {
              console.log("Spotify 2d: track metadata also failed (status " + trackResponse.status + ")");
            }
            // spotifyKey remains null — OpenAI will infer from training data
          }
        } else {
          console.log("Spotify 2b: no tracks found for query");
        }
      } catch(e) {
        console.error("Spotify error:", e.message);
        if (e.response) console.error("Spotify response status:", e.response.status, "data:", JSON.stringify(e.response.data));
      }
    }

    console.log("Step 3: Checking Supabase chord database...");
    var existingChart = null;
    if (songInfo) {
      try {
        var { data: rows, error: dbError } = await supabase
          .from("chord_charts")
          .select("*")
          .ilike("title", songInfo.title)
          .ilike("artist", songInfo.artist)
          .limit(1);
        console.log("DB rows found:", rows ? rows.length : 0);
        if (rows && rows.length > 0) {
          var saved = rows[0];
          console.log("Returning from database!");
          await supabase.from("chord_charts").update({ play_count: (saved.play_count || 0) + 1 }).eq("id", saved.id);
          return res.json({ identified: true, fromDatabase: true, songInfo: songInfo, chart: { title: saved.title, artist: saved.artist, musicalKey: saved.musical_key, tempo: saved.tempo, capo: saved.capo, sections: saved.sections } });
        }
      } catch(e) { console.log("DB lookup:", e.message); }
    }

    console.log("Step 4: Generating chart with OpenAI gpt-4o...");
    var systemPrompt = "You are a world-class musician and transcriptionist. Generate chord charts as a JSON object with EXACTLY these top-level fields: title (string), artist (string), musicalKey (string e.g. \"G major\"), tempo (number BPM), capo (number, 0 if none), sections (array). Each section has: label (string e.g. \"Verse 1\", \"Chorus\", \"Bridge\") and lines (array). Each line has: lyrics (string) and chords (array of {chord: string, position: number} where position is the 0-based character index in the lyrics string where the chord falls). Include ALL sections of the song — every verse, chorus, pre-chorus, bridge, and outro. Do not truncate. Use only exact chords from the original recording. No substitutions. Respond ONLY with a single valid JSON object.";
    var userPrompt;
    if (songInfo) {
      var keyInfo = spotifyKey
        ? " The song is in " + spotifyKey + " (verified via Spotify)."
        : " Before generating chords, identify the exact musical key of this song from your training data and use it throughout — set the musicalKey field accordingly.";
      var tempoInfo = spotifyTempo ? " The tempo is " + spotifyTempo + " BPM (verified via Spotify)." : "";
      console.log("Step 4: key source:", spotifyKey ? "Spotify" : "OpenAI training data");
      userPrompt = "Generate a complete, accurate chord chart for \"" + songInfo.title + "\" by " + songInfo.artist + " (released " + (songInfo.release_date || "unknown") + ")." + keyInfo + tempoInfo + " Include every section with real lyrics and accurate chords. Do not skip or summarize any section.";
    } else {
      userPrompt = "Generate a chord chart for an unknown song in C major. Use title \"Unknown Song\" and artist \"Unknown Artist\". Create a simple structure with lyrics.";
    }

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
    console.log("Finish reason:", completion.choices[0].finish_reason);
    console.log("Raw length:", raw ? raw.length : 0);
    if (!raw) { return res.status(500).json({ error: "OpenAI returned empty response" }); }
    var chart = JSON.parse(raw);
    // Normalize: unwrap if OpenAI nested the chart under a "chart" key
    if (chart.chart && typeof chart.chart === "object" && !Array.isArray(chart.chart)) {
      chart = chart.chart;
    }
    if (!Array.isArray(chart.sections)) chart.sections = [];

    console.log("Saving to Supabase...");
    if (songInfo && chart) {
      var saveResult = await supabase.from("chord_charts").upsert({
        title: chart.title || songInfo.title,
        artist: chart.artist || songInfo.artist,
        musical_key: chart.musicalKey,
        tempo: chart.tempo,
        capo: chart.capo,
        sections: chart.sections,
        source: "ai_generated",
        verified: false,
        play_count: 1
      }, { onConflict: "title,artist" });
      console.log("Save result:", saveResult.error ? "ERROR: " + saveResult.error.message + " code:" + saveResult.error.code : "SUCCESS", "rows:", saveResult.data ? saveResult.data.length : 0);
    }

    res.json({ identified: !!songInfo, fromDatabase: false, songInfo: songInfo, chart: chart });

  } catch(error) {
    console.error("Error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, function() { console.log("Server started on port " + port); });
