const axios = require('axios');

async function searchSong(songName) {
  const url = "https://itunes.apple.com/search?term=" + 
    encodeURIComponent(songName) + "&entity=song&limit=5";
  
  const response = await axios.get(url);
  const data = response.data;

  console.log("=================================");
  console.log("Results for: " + songName);
  console.log("=================================");
  
  data.results.forEach(function(song, index) {
    console.log("\n" + (index + 1) + ". " + song.trackName);
    console.log("   Artist: " + song.artistName);
    console.log("   Album:  " + song.collectionName);
    console.log("   Year:   " + song.releaseDate.substring(0, 4));
  });

  console.log("=================================");
}

searchSong(process.argv[2]);
