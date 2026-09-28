const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOOL_DIR = path.join(__dirname, "tools", "rares-audio-decomp");
const DECOMPOSE_SCRIPT = path.join(TOOL_DIR, "decompose.py");

function buildPythonEnv() {
  const env = { ...process.env };
  try {
    const ffmpegPath = require("ffmpeg-static");
    if (ffmpegPath) {
      env.PATH = `${path.dirname(ffmpegPath)}${path.delimiter}${env.PATH || ""}`;
    }
  } catch {}
  return env;
}

function parseCliArgs(argv) {
  const options = {};
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--start" || arg === "--dur" || arg === "--bpb" || arg === "--stay") {
      options[arg.slice(2)] = argv[i + 1];
      i += 1;
    } else {
      positional.push(arg);
    }
  }

  return { audioPath: positional[0], options };
}

function ensureReady(audioPath) {
  if (!fs.existsSync(DECOMPOSE_SCRIPT)) {
    throw new Error(`Audio decomposition tool is missing: ${DECOMPOSE_SCRIPT}`);
  }
  if (!audioPath) {
    throw new Error("Usage: npm run audio:decomp -- <audio-file> [--start N] [--dur N]");
  }
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }
}

function analyzeLocalAudio(audioPath, options = {}) {
  ensureReady(audioPath);

  const python = process.env.PYTHON || "python3";
  const jsonPath = path.join(
    os.tmpdir(),
    `musicplayer-audio-decomp-${process.pid}-${Date.now()}.json`
  );

  const args = [DECOMPOSE_SCRIPT, audioPath];
  if (options.start !== undefined) args.push("--start", String(options.start));
  if (options.dur !== undefined) args.push("--dur", String(options.dur));
  if (options.bpb !== undefined) args.push("--bpb", String(options.bpb));
  if (options.stay !== undefined) args.push("--stay", String(options.stay));
  args.push("--json", jsonPath);

  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { cwd: TOOL_DIR, env: buildPythonEnv() });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            [
              `Audio decomposition failed with exit code ${code}.`,
              "Run `python3 -m pip install -r tools/rares-audio-decomp/requirements.txt` first.",
              stderr.trim(),
              stdout.trim(),
            ]
              .filter(Boolean)
              .join("\n\n")
          )
        );
        return;
      }

      try {
        const result = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        fs.unlinkSync(jsonPath);
        resolve({ result, stdout, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function main() {
  const { audioPath, options } = parseCliArgs(process.argv.slice(2));
  try {
    const { result } = await analyzeLocalAudio(audioPath, options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  analyzeLocalAudio,
  buildPythonEnv,
};
