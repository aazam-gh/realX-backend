import {BigQuery} from "@google-cloud/bigquery";
import {HttpsError, onCall} from "firebase-functions/v2/https";
import {setGlobalOptions} from "firebase-functions/v2";

setGlobalOptions({region: "me-central1", maxInstances: 5});

const PROJECT_ID = process.env.GCLOUD_PROJECT || "realx-forecasting-dev";
const DATASET = process.env.FORECASTING_DATASET || "forecasting";
const TABLE = `${PROJECT_ID}.${DATASET}.forecasts`;
const bigquery = new BigQuery({projectId: PROJECT_ID});

export type ForecastRow = {
  forecast_date: string;
  vendor_id: string;
  offer_id: string | null;
  predicted_redemptions: number;
  predicted_value: number;
  lower_redemptions: number | null;
  upper_redemptions: number | null;
  baseline_redemptions: number;
  confidence: "high" | "medium" | "low";
  model_version: string;
  generated_at: string;
};

export type ForecastDashboard = {
  generatedAt: string | null;
  horizonDays: number;
  modelVersion: string | null;
  forecasts: Array<{
    forecastDate: string;
    vendorId: string;
    offerId: string | null;
    predictedRedemptions: number;
    predictedValue: number;
    lowerRedemptions: number | null;
    upperRedemptions: number | null;
    baselineRedemptions: number;
    confidence: ForecastRow["confidence"];
  }>;
  status: "ready" | "empty" | "stale";
};

function isAdmin(request: {auth?: {token?: Record<string, unknown>} | null}) {
  return request.auth?.token?.admin === true;
}

function numberValue(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export const getForecastDashboard = onCall(async (request): Promise<ForecastDashboard> => {
  if (!isAdmin(request)) throw new HttpsError("permission-denied", "Admin access required");

  const requestedHorizon = Number(request.data?.horizonDays || 28);
  const horizonDays = [7, 14, 28].includes(requestedHorizon) ? requestedHorizon : 28;
  const query = `
    SELECT forecast_date, vendor_id, offer_id, predicted_redemptions,
      predicted_value, lower_redemptions, upper_redemptions,
      baseline_redemptions, confidence, model_version, generated_at
    FROM \`${TABLE}\`
    WHERE forecast_date BETWEEN CURRENT_DATE('Asia/Qatar')
      AND DATE_ADD(CURRENT_DATE('Asia/Qatar'), INTERVAL @horizon DAY)
    ORDER BY predicted_redemptions DESC, vendor_id, offer_id
    LIMIT 500
  `;

  try {
    const [job] = await bigquery.createQueryJob({
      query,
      params: {horizon: horizonDays},
      maximumBytesBilled: String(process.env.FORECASTING_MAX_BYTES_BILLED || 100000000),
      location: "US",
      useLegacySql: false,
    });
    const [rows] = await job.getQueryResults() as [ForecastRow[]];
    const forecasts = rows.map((row) => ({
      forecastDate: row.forecast_date,
      vendorId: row.vendor_id,
      offerId: row.offer_id || null,
      predictedRedemptions: numberValue(row.predicted_redemptions),
      predictedValue: numberValue(row.predicted_value),
      lowerRedemptions: row.lower_redemptions == null ? null : numberValue(row.lower_redemptions),
      upperRedemptions: row.upper_redemptions == null ? null : numberValue(row.upper_redemptions),
      baselineRedemptions: numberValue(row.baseline_redemptions),
      confidence: row.confidence || "low",
    }));
    const generatedAt = rows[0]?.generated_at || null;
    const stale = generatedAt ? Date.now() - Date.parse(generatedAt) > 48 * 60 * 60 * 1000 : false;
    return {
      generatedAt,
      horizonDays,
      modelVersion: rows[0]?.model_version || null,
      forecasts,
      status: forecasts.length === 0 ? "empty" : stale ? "stale" : "ready",
    };
  } catch (error) {
    console.error("Forecast query failed", error);
    throw new HttpsError("unavailable", "Forecasts are temporarily unavailable");
  }
});
