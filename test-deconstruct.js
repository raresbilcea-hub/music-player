const fs = require("fs");
const path = require("path");
const { analyzeUploadedAudio } = require("./audioAnalysis");

async function main() {
  const audioPath = process.argv[2];
  if (!audioPath) {
    console.error("Usage: node test-deconstruct.js <audio-file> [--separate]");
    process.exit(1);
  }

  const separate = process.argv.includes("--separate");
  const buffer = fs.readFileSync(path.resolve(audioPath));
  const result = await analyzeUploadedAudio(buffer, { separate });
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
