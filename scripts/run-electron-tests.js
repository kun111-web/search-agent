// PowerShell can detach GUI executables before they finish. Keep their pipes alive
// until completion so logging cannot raise Electron's EPIPE error dialog.
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const electron = require("electron");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const root = path.resolve(__dirname, "..");
const tests = [
  "bugfix-test.js",
  "dedup-fix-test.js",
  "orb-render-test.js",
  "picks-render-test.js",
  "retry-pace-test.js",
  "scrape-flow-test.js",
];
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  try {
    const output = execFileSync(electron, [path.join(root, test)], {
      cwd: root, env, windowsHide: true, encoding: "utf8", timeout: 60000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(output);
  } catch (error) {
    if (error.stdout) process.stdout.write(error.stdout);
    if (error.stderr) process.stderr.write(error.stderr);
    console.error(`${test} failed (exit=${error.status ?? "timeout"})`);
    process.exit(1);
  }
}
