import {execFileSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";

const project = process.env.FORECASTING_PROJECT_ID || "realx-forecasting-dev";
if (project === "reelx-backend" || project === "realx-dev" || project === "realx-dev-107") {
  throw new Error(`Refusing Phase 2 pipeline in production/dev project: ${project}`);
}
if (!/^realx-forecasting(?:-[a-z0-9-]+)?$/.test(project)) {
  throw new Error(`Phase 2 requires a realx-forecasting-* project: ${project}`);
}
if (!existsSync("forecasting/data/synthetic_transactions.csv")) execFileSync("node", ["forecasting/generate-synthetic.mjs"], {stdio: "inherit"});
if (!existsSync("forecasting/data/synthetic_events.csv")) execFileSync("node", ["forecasting/generate-synthetic-marketplace.mjs"], {stdio: "inherit"});
execFileSync("node", ["scripts/load-synthetic-forecasting-data.mjs"], {stdio: "inherit", env: {...process.env, FORECASTING_PROJECT_ID: project}});
for (const file of [
  "forecasting/bigquery/10_phase2_bronze.sql",
  "forecasting/bigquery/11_phase2_marts.sql",
  "forecasting/bigquery/12_phase2_models.sql",
  "forecasting/bigquery/13_phase2_backtest_and_rank.sql",
]) {
  execFileSync("bq", ["query", `--project_id=${project}`, "--location=US", "--use_legacy_sql=false"], {
    input: readFileSync(file), stdio: ["pipe", "inherit", "inherit"],
  });
}
