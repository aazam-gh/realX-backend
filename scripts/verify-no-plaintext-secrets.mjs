import {execFileSync} from "node:child_process";
import {readdirSync, readFileSync} from "node:fs";

const project = "reelx-backend";
const forbiddenKeys = new Set(["RESEND_API_KEY", "WAKTI_API_KEY"]);
const localViolations = readdirSync("functions")
  .filter((name) => name.startsWith(".env"))
  .flatMap((name) => {
    const contents = readFileSync(`functions/${name}`, "utf8");
    return [...forbiddenKeys]
      .filter((key) => new RegExp(`^${key}=`, "m").test(contents))
      .map((key) => `${name}:${key}`);
  });

if (localViolations.length > 0) {
  console.error("Plaintext secrets found in local environment files:", localViolations);
  process.exit(1);
}

const output = execFileSync(
  "firebase",
  ["functions:list", "--project", project, "--json"],
  {encoding: "utf8"},
);
const functions = JSON.parse(output).result;
const violations = functions.flatMap((fn) =>
  Object.keys(fn.environmentVariables || {})
    .filter((key) => forbiddenKeys.has(key))
    .map((key) => `${fn.id}:${key}`),
);

if (violations.length > 0) {
  console.error("Plaintext secret environment variables found:", violations);
  process.exit(1);
}

console.log("Verified that production exposes no plaintext secret environment variables.");
