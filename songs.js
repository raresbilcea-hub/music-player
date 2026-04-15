let library = [
    { title: "My Way", artist: "Frank Sinatra", chords: ["F", "Gm", "Bb", "C", "Am", "Dm"], difficulty: "beginner" },
    { title: "Music is the answer", artist: "Myself", chords: ["D", "A", "E"], difficulty: "beginner" },
    {title: "Belief", artist: "John Mayer", chords: ["Am", "Dm", "G", "Bm"], difficulty: "intermediate" },
    {title: "Lupul", artist: "Rares Bilcea", chords: ["E", "A"], difficulty: "advanced" },
    {title: "Freedom", artist: "Rares Bilcea", chords: ["POC", "PIC", "BAM"], difficulty: "advanced" },

];
function printAll () {
    for (let i = 0; i < library.length; i++) {
        console.log(library[i].title + " by " + library[i].artist + " Chords: " + library[i].chords.join(" - ") +  " Level: " + library[i].difficulty )
    };

}
printAll()

function findByArtist(artistName) {
    for (let i = 0; i < library.length; i++) {
        if (library[i].artist === artistName) {
        console.log(library[i].title + " by " + library[i].artist);
        }
    }
}
findByArtist("John Mayer");

function findByDifficulty(difficultyLevel) {
    for (let i = 0; i < library.length; i++) {
        if (library[i].difficulty === difficultyLevel) {
            console.log(library[i].title + " by " + library[i].artist);
        }
    }
}
findByDifficulty("advanced");


function checkDifficulty(song) {
    if (song.difficulty === "beginner") {
        console.log(song.title + " is easy to play!");
    } else if (song.difficulty === "intermediate") {
        console.log(song.title + " needs some practice");
    } else if (song.difficulty === "advanced") {
        console.log(song.title + " is challenging");
    } else {
        console.log(song.title + " has an unknown difficulty.");
    }
}

for (let i = 0; i < library.length; i++) {
    checkDifficulty(library[i]);
}
