const https = require('https');

const artist = process.argv[2];
const url = "https://itunes.apple.com/search?term=" + encodeURIComponent(artist) + "&entity=song&limit=7";

https.get(url, function(response) {
    let data = '';

    response.on('data', function(chunk) {
        data += chunk;
    });

    response.on('end', function() {
        let result = JSON.parse(data);
        console.log("Songs found:", result.resultCount);

        result.results.forEach(function(song) {
            console.log(song.trackName + " by " + song.artistName + " - Album: " + song.collectionName + " Year: " + song.releaseDate.substring(0, 4));
        });
    });
});
