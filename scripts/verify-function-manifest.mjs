import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";

const project = "reelx-backend";
const expected = JSON.parse(readFileSync("function-manifest.json", "utf8")).sort();
const output = execFileSync(
  "firebase",
  ["functions:list", "--project", project, "--json"],
  {encoding: "utf8"},
);
const live = JSON.parse(output).result
  .filter((fn) => !fn.id.startsWith("ext-"))
  .map((fn) => fn.id)
  .sort();

if (JSON.stringify(expected) !== JSON.stringify(live)) {
  console.error("Canonical manifest does not match live first-party functions.");
  console.error("Expected only:", expected.filter((name) => !live.includes(name)));
  console.error("Live only:", live.filter((name) => !expected.includes(name)));
  process.exit(1);
}

console.log(`Verified ${live.length} first-party production functions.`);
