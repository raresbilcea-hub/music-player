const express = require('express');
const axios = require('axios');
const app = express();
const port = 3000;

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

app.listen(port, function() {
  console.log('Server started on port ' + port);
});