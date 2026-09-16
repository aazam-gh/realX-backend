import {execFileSync} from "node:child_process";
import {existsSync, symlinkSync, unlinkSync} from "node:fs";
const project = process.env.FORECASTING_PROJECT_ID || "realx-forecasting-dev";
execFileSync("node", ["scripts/guard-forecasting-deploy.mjs", project], {stdio: "inherit"});
const dependencyLink = "forecasting-functions/node_modules";
let createdLink = false;
if (!existsSync(dependencyLink) && existsSync("functions/node_modules")) {
  symlinkSync("../functions/node_modules", dependencyLink, "junction");
  createdLink = true;
}
try {
  execFileSync("firebase", ["deploy", "--config", "firebase.forecasting.json", "--project", project], {stdio: "inherit"});
} finally {
  if (createdLink) unlinkSync(dependencyLink);
}
