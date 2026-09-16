CREATE TABLE IF NOT EXISTS `realx-forecasting-dev.forecasting.forecasts` (
  forecast_date DATE NOT NULL,
  vendor_id STRING NOT NULL,
  offer_id STRING,
  predicted_redemptions FLOAT64,
  predicted_value FLOAT64,
  lower_redemptions FLOAT64,
  upper_redemptions FLOAT64,
  baseline_redemptions FLOAT64,
  confidence STRING,
  model_version STRING,
  generated_at TIMESTAMP
)
PARTITION BY forecast_date
CLUSTER BY vendor_id, offer_id;
