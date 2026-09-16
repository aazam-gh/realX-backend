SELECT
  (SELECT COUNT(*) FROM `realx-forecasting-dev.forecasting.stg_transactions`) AS transaction_rows,
  (SELECT COUNT(DISTINCT vendor_id) FROM `realx-forecasting-dev.forecasting.fact_daily_vendor_offer`) AS vendors,
  (SELECT COUNT(DISTINCT offer_id) FROM `realx-forecasting-dev.forecasting.fact_daily_vendor_offer`) AS offers,
  (SELECT MIN(demand_date) FROM `realx-forecasting-dev.forecasting.fact_daily_vendor_offer`) AS first_date,
  (SELECT MAX(demand_date) FROM `realx-forecasting-dev.forecasting.fact_daily_vendor_offer`) AS last_date,
  (SELECT DATE_DIFF(MAX(demand_date), MIN(demand_date), DAY) + 1 FROM `realx-forecasting-dev.forecasting.fact_daily_vendor_offer`) AS calendar_days,
  (SELECT COUNT(*) FROM `realx-forecasting-dev.forecasting.forecast_features`) AS feature_rows,
  (SELECT COUNT(DISTINCT vendor_id) FROM `realx-forecasting-dev.forecasting.forecast_features`) AS model_ready_vendors;
