const https = require('https');

const artist = "Michael Jackson";
const url = "https://itunes.apple.com/search?term=" + encodeURIComponent(artist) + "&entity=song&limit=13";

https.get(url, function(response) {
    let data = '';

    response.on('data', function(chunk) {
        data += chunk;
    });

    response.on('end', function() {
        let result = JSON.parse(data);
        console.log("Songs found:", result.resultCount);

        result.results.forEach(function(song) {
            console.log(song.trackName + " by " + song.artistName);
        });
    });
});
