import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";

const project = process.env.FORECASTING_PROJECT_ID || "realx-forecasting-dev";
const input = process.env.SYNTHETIC_FORECAST_INPUT || "forecasting/data/synthetic_transactions.csv";
const eventInput = process.env.SYNTHETIC_EVENT_INPUT || "forecasting/data/synthetic_events.csv";
if (project === "reelx-backend" || project === "realx-dev" || project === "realx-dev-107") {
  throw new Error(`Refusing synthetic data load into production/dev project: ${project}`);
}
if (!/^realx-forecasting(?:-[a-z0-9-]+)?$/.test(project)) {
  throw new Error(`Synthetic forecasting data requires a realx-forecasting-* project: ${project}`);
}
if (!existsSync(input)) throw new Error(`Synthetic input does not exist: ${input}`);
execFileSync("bq", [
  "load", "--project_id", project, "--location=US", "--replace",
  "--source_format=CSV", "--skip_leading_rows=1",
  "--schema=created_at:TIMESTAMP,vendor_id:STRING,vendor_name:STRING,offer_id:STRING,type:STRING,total_amount:FLOAT,final_amount:FLOAT,discount_amount:FLOAT,cashback_amount:FLOAT",
  `${project}:forecasting.synthetic_transactions`, input,
], {stdio: "inherit"});
console.log(`Loaded synthetic forecasting transactions into ${project}:forecasting.synthetic_transactions`);
if (existsSync(eventInput)) {
  execFileSync("bq", [
    "load", "--project_id", project, "--location=US", "--replace",
    "--source_format=CSV", "--skip_leading_rows=1",
    "--schema=event_date:DATE,vendor_id:STRING,offer_id:STRING,event_type:STRING,event_count:INTEGER,platform:STRING",
    `${project}:forecasting.synthetic_events`, eventInput,
  ], {stdio: "inherit"});
  console.log(`Loaded synthetic marketplace events into ${project}:forecasting.synthetic_events`);
}
