// One-off test: run Demucs (htdemucs_6s) on Replicate, no "stem" param,
// to confirm we get all 6 stems (vocals, drums, bass, guitar, piano, other) back.
//
// Usage:
//   node test-demucs.js path/to/song.mp3
//
// Requires REPLICATE_API_TOKEN in .env

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const audioPath = process.argv[2];

if (!REPLICATE_API_TOKEN) {
  console.error("Missing REPLICATE_API_TOKEN in .env");
  process.exit(1);
}
if (!audioPath) {
  console.error("Usage: node test-demucs.js <path-to-audio-file>");
  process.exit(1);
}

const MIME_BY_EXT = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
};

async function main() {
  const fileBuffer = fs.readFileSync(audioPath);
  const ext = path.extname(audioPath).toLowerCase();
  const mimeType = MIME_BY_EXT[ext] || "audio/mpeg";
  const dataUri = `data:${mimeType};base64,${fileBuffer.toString("base64")}`;

  console.log(`Uploading ${audioPath} (${(fileBuffer.length / 1024).toFixed(0)} KB) and starting prediction...`);

  const createRes = await axios.post(
    "https://api.replicate.com/v1/predictions",
    {
      version: "25a173108cff36ef9f80f854c162d01df9e6528be175794b81158fa03836d953",
      input: {
        audio: dataUri,
        model_name: "htdemucs_6s",
        clip_mode: "rescale",
        // no "stem" key here on purpose -> Replicate returns ALL stems
      },
    },
    {
      headers: {
        Authorization: `Bearer ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
        Prefer: "wait",
      },
    }
  );

  let prediction = createRes.data;
  console.log("Status:", prediction.status);

  while (!["succeeded", "failed", "canceled"].includes(prediction.status)) {
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await axios.get(prediction.urls.get, {
      headers: { Authorization: `Bearer ${REPLICATE_API_TOKEN}` },
    });
    prediction = pollRes.data;
    console.log("Status:", prediction.status);
  }

  if (prediction.status !== "succeeded") {
    console.error("Prediction failed:", JSON.stringify(prediction.error));
    process.exit(1);
  }

  console.log("\nStems returned:");
  for (const [stem, url] of Object.entries(prediction.output)) {
    console.log(`  ${stem}: ${url}`);
  }
}

main().catch((e) => {
  console.error(e.response ? JSON.stringify(e.response.data) : e.message);
  process.exit(1);
});
