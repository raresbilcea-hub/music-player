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
app.get('/', function(req, res) { res.send('Music Player 2.0 server is running!'); });
app.get('/search', async function(req, res) {
  const query = req.query.q;
  if (!query) { res.json({ error: 'No query' }); return; }
  const url = 'https://itunes.apple.com/search?term=' + encodeURIComponent(query) + '&entity=song&limit=8';
  const response = await axios.get(url);
  const songs = response.data.results.map(function(song) {
    return { title: song.trackName, artist: song.artistName, album: song.collectionName, year: song.releaseDate ? song.releaseDate.substring(0,4) : 'Unknown', genre: song.primaryGenreName, artwork: song.artworkUrl100 };
  });
  res.json({ count: songs.length, songs: songs });
});
app.post('/identify', async function(req, res) {
  try {
    var audioBase64 = req.body.audioBase64;
    var mimeType = req.body.mimeType;
    if (!audioBase64) { return res.status(400).json({ error: 'No audio provided' }); }
    var audioBuffer = Buffer.from(audioBase64, 'base64');
    var songInfo = null;
    try {
      var form = new FormData();
      form.append('api_token', process.env.AUDD_API_KEY);
      form.append('return', 'spotify,apple_music');
      form.append('file', audioBuffer, { filename: 'recording.m4a', contentType: mimeType || 'audio/m4a' });
      var auddResponse = await axios.post('https://api.audd.io/', form, { headers: form.getHeaders() });
      if (auddResponse.data.result) { songInfo = auddResponse.data.result; console.log('Identified:', songInfo.title); }
    } catch(e) { console.error('AudD error:', e.message); }
    var userPrompt = songInfo ? 'Generate a full chord chart for ' + songInfo.title + ' by ' + songInfo.artist + '. Respond ONLY with valid JSON.' : 'Generate a placeholder chord chart. Use title Unknown Song. Respond ONLY with valid JSON.';
    var completion = await openai.chat.completions.create({ model: 'gpt-4o-mini', max_tokens: 2000, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: 'You are a musician. Generate chord charts in JSON with: title, artist, confidence, musicalKey, tempo, capo, sections array. Each section has label and lines array. Each line has lyrics string and chords array. Each chord has chord string and position number.' }, { role: 'user', content: userPrompt }] });
    var chart = JSON.parse(completion.choices[0].message.content);
    res.json({ identified: !!songInfo, songInfo: songInfo, chart: chart });
  } catch(error) { console.error('Error:', error.message); res.status(500).json({ error: error.message }); }
});
app.listen(port, function() { console.log('Server started on port ' + port); });
