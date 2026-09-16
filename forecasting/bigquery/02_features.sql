CREATE OR REPLACE TABLE `realx-forecasting-dev.forecasting.fact_daily_vendor_offer` AS
SELECT
  DATE(created_at, 'Asia/Qatar') AS demand_date,
  vendor_id,
  offer_id,
  COUNT(*) AS redemptions,
  SUM(transaction_value) AS transaction_value,
  SUM(discount_amount) AS discount_amount,
  SUM(cashback_amount) AS cashback_amount
FROM `realx-forecasting-dev.forecasting.stg_transactions`
GROUP BY demand_date, vendor_id, offer_id;

CREATE OR REPLACE TABLE `realx-forecasting-dev.forecasting.forecast_features` AS
WITH daily AS (
  SELECT * FROM `realx-forecasting-dev.forecasting.fact_daily_vendor_offer`
),
features AS (
  SELECT
    demand_date, vendor_id, offer_id, redemptions, transaction_value,
    EXTRACT(DAYOFWEEK FROM demand_date) AS day_of_week,
    EXTRACT(WEEK FROM demand_date) AS week_of_year,
    LAG(redemptions, 1) OVER w AS lag_1,
    LAG(redemptions, 7) OVER w AS lag_7,
    LAG(redemptions, 14) OVER w AS lag_14,
    LAG(redemptions, 28) OVER w AS lag_28,
    AVG(redemptions) OVER (
      PARTITION BY vendor_id, offer_id ORDER BY demand_date
      ROWS BETWEEN 28 PRECEDING AND 1 PRECEDING
    ) AS rolling_28,
    COUNT(*) OVER (PARTITION BY vendor_id, offer_id) AS history_days
  FROM daily
  WINDOW w AS (PARTITION BY vendor_id, offer_id ORDER BY demand_date)
)
SELECT * FROM features WHERE history_days >= 28;
