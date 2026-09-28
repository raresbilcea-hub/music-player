const { spawn } = require("child_process");
const path = require("path");
const { buildPythonEnv } = require("./audioDecomp");

const TOOL_DIR = path.join(__dirname, "tools", "rares-audio-decomp");
const child = spawn("bash", ["setup.sh", "--check"], {
  cwd: TOOL_DIR,
  env: buildPythonEnv(),
  stdio: "inherit",
});

child.on("exit", (code) => {
  process.exitCode = code || 0;
});
