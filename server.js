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

    console.log("Step 2: Checking Supabase chord database...");
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

    console.log("Step 3: Generating chart with OpenAI gpt-4o...");
    var systemPrompt = "You are a world-class musician and transcriptionist. Generate chord charts as a JSON object with EXACTLY these top-level fields: title (string), artist (string), musicalKey (string e.g. \"G major\"), tempo (number BPM), capo (number, 0 if none), sections (array). Each section has: label (string e.g. \"Verse 1\", \"Chorus\", \"Bridge\") and lines (array). Each line has: lyrics (string) and chords (array of {chord: string, position: number} where position is the 0-based character index in the lyrics string where the chord falls). Include ALL sections of the song — every verse, chorus, pre-chorus, bridge, and outro. Do not truncate. Use only exact chords from the original recording. No substitutions. Respond ONLY with a single valid JSON object.";
    var userPrompt;
    if (songInfo) {
      userPrompt = "Generate a complete, accurate chord chart for \"" + songInfo.title + "\" by " + songInfo.artist + " (released " + (songInfo.release_date || "unknown") + "). Include every section with real lyrics and accurate chords. Do not skip or summarize any section.";
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
