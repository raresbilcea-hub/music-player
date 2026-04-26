require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const FormData = require('form-data');
const OpenAI = require('openai');

const app = express();
const port = 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.get('/', function(req, res) {
  res.send('Music Player 2.0 server is running!');
});

app.get('/search', async function(req, res) {
  const query = req.query.q;
  if (!query) {
    res.json({ error: 'Please provide a search query' });
    return;
  }
  const url = "https://itunes.apple.com/search?term=" + encodeURIComponent(query) + "&entity=song&limit=8";
  const response = await axios.get(url);
  const songs = response.data.results.map(function(song) {
    return {
      title: song.trackName,
      artist: song.artistName,
      album: song.collectionName,
      year: song.releaseDate ? song.releaseDate.substring(0, 4) : 'Unknown',
      genre: song.primaryGenreName,
      duration: Math.floor(song.trackTimeMillis / 60000) + ':' + Math.floor((song.trackTimeMillis % 60000) / 1000).toString().padStart(2, '0'),
      artwork: song.artworkUrl100
    };
  });
  res.json({ count: songs.length, songs: songs });
});

app.post('/identify', async function(req, res) {
  try {
    const audioBase64 = req.body.audioBase64;
    const mimeType = req.body.mimeType;

    if (!audioBase64) {
      return res.status(400).json({ error: 'No audio provided' });
    }

    const audioBuffer = Buffer.from(audioBase64, 'base64');

    console.log('Step 1: Identifying song with AudD...');
    let songInfo = null;
    try {
      const form = new FormData();
      form.append('api_token', process.env.AUDD_API_KEY);
      form.append('return', 'spotify,apple_music');
      form.append('file', audioBuffer, {
        filename: 'recording.m4a',
        contentType: mimeType || 'audio/m4a'
      });
      const auddResponse = await axios.post('https://api.audd.io/', form, {
        headers: form.getHeaders()
      });
      if (auddResponse.data.result) {
        songInfo = auddResponse.data.result;
        console.log('Song identified:', songInfo.title, 'by', songInfo.artist);
      } else {
        console.log('Song not identified by AudD');
      }
    } catch (auddError) {
      console.error('AudD error:', auddError.message);
    }

    console.log('Step 2: Generating chord chart with OpenAI...');

    var systemPrompt = 'You are a world-class musician. Generate chord charts in JSON with these fields: title, artist, confidence, musicalKey, tempo, capo, sections. Each section has label and lines. Each line has lyrics and chords array. Each chord has chord name and position number.';

    var userPrompt;
    if (songInfo) {
      userPrompt = 'Generate a full chord chart for "' + songInfo.title + '" by ' + songInfo.artist + '. Include all sections with real lyrics and chords. Respond ONLY with valid JSON.';
    } else {
      userPrompt = 'Generate a placeholder chord chart for an unidentified song. Use title "Unknown Song" and artist "Unknown Artist". Respond ONLY with valid JSON.';
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    const chart = JSON.parse(completion.choices[0].message.content);

    res.json({
      identified: !!songInfo,
      songInfo: songInfo,
      chart: chart
    });

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, function() {
  console.log('Server started on port ' + port);
});
