const axios = require('axios');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

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

    console.log("\n=================================");
    console.log("Results for: " + songName);
    console.log("=================================");
    
    data.results.forEach(function(song, index) {
      console.log("\n" + (index + 1) + ". " + song.trackName);
      console.log("   Artist: " + song.artistName);
      console.log("   Album:  " + song.collectionName);
      console.log("   Year:   " + (song.releaseDate ? song.releaseDate.substring(0, 4) : "Unknown"));
    });

    console.log("=================================\n");

  } catch (error) {
    console.log("Something went wrong: " + error.message);
  }
}

function askQuestion() {
  rl.question('Search for a song (or type "quit" to exit): ', async function(answer) {
    if (answer === "quit") {
      console.log("Goodbye!");
      rl.close();
    } else {
      await searchSong(answer);
      askQuestion();
    }
  });
}

console.log("Welcome to Music Player 2.0 Search!");
console.log("=====================================");
askQuestion();
