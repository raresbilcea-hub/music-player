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

async function searchRealChords(title, artist) {
  try {
    const query = encodeURIComponent(artist + ' ' + title + ' chords');
    const searchUrl = 'https://www.googleapis.com/customsearch/v1?key=' + process.env.GOOGLE_API_KEY + '&cx=' + process.env.GOOGLE_CX + '&q=' + query + '&num=3';
    const response = await axios.get(searchUrl, { timeout: 5000 });
    const items = response.data.items || [];
    var chordData = '';
    for (var item of items) {
      if (item.snippet) chordData += item.snippet + ' ';
    }
    console.log('Chord search result:', chordData.substring(0, 200));
    return chordData || null;
  } catch(e) {
    console.log('Chord search failed:', e.message);
    return null;
  }
}

async function searchUltimateGuitar(title, artist) {
  try {
    const query = encodeURIComponent(artist + ' ' + title);
    const url = 'https://www.ultimate-guitar.com/search.php?search_type=title&value=' + query;
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 8000
    });
    const html = response.data;
    const dataMatch = html.match(/window\.__NUXT__\s*=\s*({.+?});\s*<\/script>/s) ||
                      html.match(/data-content="([^"]+)"/);
    if (dataMatch) {
      console.log('UG: Found data on page');
      const jsonStr = dataMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      try {
        const parsed = JSON.parse(jsonStr);
        const results = parsed?.data?.results || parsed?.results || [];
        const chordTab = results.find(r => r.type === 'Chords' || r.type === 'chords');
        if (chordTab) {
          console.log('UG: Found chord tab:', chordTab.song_name);
          return chordTab;
        }
      } catch(e) {
        console.log('UG: Parse error:', e.message);
      }
    }
    console.log('UG: No structured data found');
    return null;
  } catch(e) {
    console.log('UG search failed:', e.message);
    return null;
  }
}

app.post('/identify', async function(req, res) {
  try {
    var audioBase64 = req.body.audioBase64;
    var mimeType = req.body.mimeType;
    if (!audioBase64) { return res.status(400).json({ error: 'No audio provided' }); }
    var audioBuffer = Buffer.from(audioBase64, 'base64');

    console.log('Step 1: Identifying with AudD...');
    var songInfo = null;
    try {
      var form = new FormData();
      form.append('api_token', process.env.AUDD_API_KEY);
      form.append('return', 'spotify,apple_music');
      form.append('file', audioBuffer, { filename: 'recording.m4a', contentType: mimeType || 'audio/m4a' });
      var auddResponse = await axios.post('https://api.audd.io/', form, { headers: form.getHeaders() });
      if (auddResponse.data.result) {
        songInfo = auddResponse.data.result;
        console.log('Identified:', songInfo.title, 'by', songInfo.artist);
      }
    } catch(e) { console.error('AudD error:', e.message); }

    console.log('Step 2: Searching Ultimate Guitar...');
    var ugData = null;
    if (songInfo) {
      ugData = await searchUltimateGuitar(songInfo.title, songInfo.artist);
    }

    console.log('Step 3: Generating chart with OpenAI...');
    var systemPrompt = 'You are a world-class musician and chord transcriber. Generate accurate chord charts in JSON with: title, artist, confidence, musicalKey, tempo, capo, sections array. Each section has label and lines array. Each line has lyrics string and chords array. Each chord has chord string and position number (character index in lyrics where chord falls).';

    var userPrompt;
    if (songInfo && ugData) {
      userPrompt = 'Generate a precise chord chart for "' + songInfo.title + '" by ' + songInfo.artist + '. I found this chord data from Ultimate Guitar: ' + JSON.stringify(ugData) + '. Use the EXACT chords from this data. Organize by section with real lyrics. Respond ONLY with valid JSON.';
    } else if (songInfo) {
      var spotifyData = songInfo.spotify ? JSON.stringify(songInfo.spotify) : 'not available';
      var appleMusicData = songInfo.apple_music ? JSON.stringify(songInfo.apple_music) : 'not available';
      userPrompt = 'Generate a 100% accurate chord chart for "' + songInfo.title + '" by ' + songInfo.artist + '. Released: ' + (songInfo.release_date || 'unknown') + '. Spotify data: ' + spotifyData + '. This is a well-known song - use your training knowledge to provide the EXACT chords as played in the original studio recording. Do NOT guess or use substitutions. Do NOT use relative minor/major replacements. Include the real key, real capo position, real tempo, and all main sections (Verse, Pre-Chorus, Chorus, Bridge) with actual lyrics and chord changes placed at the correct syllable positions. Respond ONLY with valid JSON.';
    } else {
      userPrompt = 'Generate a chord chart for an unidentified song. Use C major as a starting point. Respond ONLY with valid JSON.';
    }

    var completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 3000,
      response_format: { type: 'json_object' },
      temperature: 0.1,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]
    });

    var chart = JSON.parse(completion.choices[0].message.content);
    console.log("Chart:", JSON.stringify(chart).substring(0, 200));
    res.json({ identified: !!songInfo, ugFound: !!ugData, songInfo: songInfo, chart: chart });

  } catch(error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, function() { console.log('Server started on port ' + port); });
