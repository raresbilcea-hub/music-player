const axios = require('axios');

async function searchArtist(artistName) {
  const url = "https://itunes.apple.com/search?term=" + 
    encodeURIComponent(artistName) + "&entity=song&limit=5";
  
  const response = await axios.get(url);
  const data = response.data;
  
  console.log("Songs found:", data.resultCount);
  
  data.results.forEach(function(song) {
    console.log(song.trackName + " by " + song.artistName + 
      " — " + song.releaseDate.substring(0, 4));
  });
}

searchArtist(process.argv[2]);

