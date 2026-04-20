const express = require('express');
const app = express();
const port = 3000;
const axios = require('axios');

app.get('/search', async function(req, res) {
    const query = req.query.q;

    if (!query) {
        res.json({ error: 'Please provide a search query' });
        return;
    }
    
    const url = "https://itunes.apple.com/search?term=" + encodeURIComponent(query) + "&entity=song&limit=8";

    const response = await axios.get(url);
    res.json(response.data);
});

app.get('/', function (req, res) {
    res.send('Music Player 2.0 server is running!');
});

app.listen(port, function() {
    console.log('Server started at port ' + port);
});
