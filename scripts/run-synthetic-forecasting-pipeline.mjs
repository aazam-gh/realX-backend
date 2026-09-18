import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";

const project = process.env.FORECASTING_PROJECT_ID || "realx-forecasting-dev";
if (project === "reelx-backend" || project === "realx-dev" || project === "realx-dev-107") {
  throw new Error(`Refusing synthetic forecasting pipeline in production/dev project: ${project}`);
}
if (!existsSync("forecasting/data/synthetic_transactions.csv")) {
  execFileSync("node", ["forecasting/generate-synthetic.mjs"], {stdio: "inherit"});
}
execFileSync("node", ["scripts/load-synthetic-forecasting-data.mjs"], {stdio: "inherit", env: {...process.env, FORECASTING_PROJECT_ID: project}});
for (const file of [
  "forecasting/bigquery/01_synthetic_staging.sql",
  "forecasting/bigquery/02_features.sql",
  "forecasting/bigquery/03_forecast_table.sql",
  "forecasting/bigquery/05_publish_seasonal_naive.sql",
]) {
  execFileSync("bq", ["query", `--project_id=${project}`, "--location=US", "--use_legacy_sql=false", `<${file}`], {stdio: "inherit", shell: true});
}
