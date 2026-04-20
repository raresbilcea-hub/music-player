require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const FormData = require('form-data');
const fs = require('fs');

const app = express();
const port = 3000;

app.use(cors());
app.use(express.json());

app.get('/', function(req, res) {
  res.send('Music Player 2.0 server is running!');
});

app.get('/search', async function(req, res) {
  const query = req.query.q;

  if (!query) {
    res.json({ error: 'Please provide a search query' });
    return;
  }

  const url = "https://itunes.apple.com/search?term=" +
    encodeURIComponent(query) + "&entity=song&limit=8";

  const response = await axios.get(url);

  const songs = response.data.results.map(function(song) {
    return {
      title: song.trackName,
      artist: song.artistName,
      album: song.collectionName,
      year: song.releaseDate ? song.releaseDate.substring(0, 4) : 'Unknown',
      genre: song.primaryGenreName,
      duration: Math.floor(song.trackTimeMillis / 60000) + ':' +
        Math.floor((song.trackTimeMillis % 60000) / 1000).toString().padStart(2, '0'),
      artwork: song.artworkUrl100
    };
  });

  res.json({ count: songs.length, songs: songs });
});

app.post('/identify', async function(req, res) {
  try {
    const audioPath = req.body.audioPath;
    const form = new FormData();
    form.append('api_token', process.env.AUDD_API_KEY);
    form.append('file', fs.createReadStream(audioPath));
    form.append('return', 'spotify,apple_music');

    const response = await axios.post('https://api.audd.io/', form, {
      headers: form.getHeaders()
    });

    res.json(response.data);
  } catch (error) {
    res.json({ error: error.message });
  }
});

app.listen(port, function() {
  console.log('Server started on port ' + port);
});