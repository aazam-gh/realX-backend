import {execFileSync} from "node:child_process";
import {createInterface} from "node:readline/promises";
import {stdin, stdout} from "node:process";

const project = "reelx-backend";
const scope = process.argv[2];
const allowedScopes = new Set([
  "functions",
  "firestore:rules",
  "firestore:indexes",
  "storage",
]);

if (!allowedScopes.has(scope)) {
  console.error(`Usage: npm run deploy:prod -- <${[...allowedScopes].join("|")}>`);
  process.exit(1);
}

const branch = execFileSync("git", ["branch", "--show-current"], {encoding: "utf8"}).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], {encoding: "utf8"}).trim();
if (branch !== "main") throw new Error("Production deploys require the main branch.");
if (dirty) throw new Error("Production deploys require a clean working tree.");

execFileSync("npm", ["run", "check"], {stdio: "inherit"});
execFileSync(
  "firebase",
  ["deploy", "--dry-run", "--only", scope, "--project", project],
  {stdio: "inherit"},
);

const prompt = createInterface({input: stdin, output: stdout});
const answer = await prompt.question(`Type "DEPLOY ${project} ${scope}" to continue: `);
prompt.close();
if (answer !== `DEPLOY ${project} ${scope}`) throw new Error("Deployment cancelled.");

execFileSync(
  "firebase",
  ["deploy", "--only", scope, "--project", project],
  {stdio: "inherit"},
);
