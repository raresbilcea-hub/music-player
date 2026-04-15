let library = [
    {title: "Hotel California", artist: "Eagles", chords: ["Em", "Bm", "G"], difficulty: "advanced"},
    {title: "Thong Song", artist: "Sisqo", chords: ["Am", "D", "G"], difficulty: "intermediate"},
    {title: "Arheologie", artist: "Amarie", chords: ["Em", "Am", "D"], difficulty: "beginner"},
    {title: "Freedom", artist: "Bilcea Rares", chords: ["E", "A", "C#m", "F#"], difficulty: "advanced"},
    {title: "Sick Boi", artist: "REN", chords: ["C", "F", "G"], difficulty: "intermediate"},
];
function printAll () {
    for (let i = 0; i < library.length; i++) {
        console.log(library[i].title + " by " + library[i].artist + " chords: " + library[i].chords.join(" - ") + " Level: " + library[i].difficulty )
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
findByArtist("Eagles");

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
        console.log(song.title + " is easy to play! ");
    } else if (song.difficulty === "intermediate") {
        console.log(song.title + " needs some practice ");
    } else if (song.difficulty === "advanced") {
        console.log(song.title + " is challenging ");
    } else {
        console.log(song.title + " has an unknown difficulty");
    }
}

for (let i = 0; i < library.length; i++) {
    checkDifficulty(library[i]);
}

let beginnerSongs = library.filter(function(song) {
    return song.difficulty === "beginner";
});

console.log("beginner songs:");
console.log(beginnerSongs);

let songTitles = library.map(function(song) {
    return song.title;
});

console.log("All song titles");
console.log(songTitles);

let advancedTitles = library
.filter(function(song) {return song.difficulty === "advanced";
})
.map(function(song){ return song.title; });

console.log("Advanced songs:", advancedTitles);
