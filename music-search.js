const axios = require('axios');

async function searchSong(songName) {
  try {
    const url = "https://itunes.apple.com/search?term=" + 
      encodeURIComponent(songName) + "&entity=song&limit=5";
    
    const response = await axios.get(url);
    const data = response.data;

    if (data.resultCount === 0) {
      console.log("No songs found for: " + songName);
      return;
    }

    console.log("=================================");
    console.log("Results for: " + songName);
    console.log("=================================");
    
    data.results.forEach(function(song, index) {
      console.log("\n" + (index + 1) + ". " + song.trackName);
      console.log("   Artist: " + song.artistName);
      console.log("   Album:  " + song.collectionName);
      console.log("   Year:   " + (song.releaseDate ? song.releaseDate.substring(0, 4) : "Unknown"));
    });

    console.log("=================================");

  } catch (error) {
    console.log("Something went wrong: " + error.message);
  }
}

if (!process.argv[2]) {
  console.log("Please provide a song name!");
  console.log("Example: node music-search.js \"Hotel California\"");
} else {
  searchSong(process.argv[2]);
}
