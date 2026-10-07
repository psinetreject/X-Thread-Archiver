// Runs every test file in turn: `npm test`.

const { spawnSync } = require("child_process");

const files = ["unit.test.js", "firefox.test.js", "chrome.test.js"];
const failed = [];
for (const f of files) {
  console.log(`\n▶ ${f}`);
  const r = spawnSync(process.execPath, [f], { cwd: __dirname, stdio: "inherit" });
  if (r.status !== 0) failed.push(f);
}
console.log(failed.length ? `\n✗ Failed: ${failed.join(", ")}` : `\n✓ All ${files.length} test files passed`);
process.exit(failed.length ? 1 : 0);
