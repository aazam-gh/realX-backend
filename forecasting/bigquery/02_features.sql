CREATE OR REPLACE TABLE `realx-forecasting-dev.forecasting.fact_daily_vendor_offer` AS
WITH bounds AS (
  SELECT MIN(DATE(created_at, 'Asia/Qatar')) AS first_date,
    MAX(DATE(created_at, 'Asia/Qatar')) AS last_date
  FROM `realx-forecasting-dev.forecasting.stg_transactions`
),
combos AS (
  SELECT DISTINCT vendor_id, offer_id
  FROM `realx-forecasting-dev.forecasting.stg_transactions`
),
dates AS (
  SELECT demand_date
  FROM bounds, UNNEST(GENERATE_DATE_ARRAY(first_date, last_date)) AS demand_date
),
observed AS (
  SELECT DATE(created_at, 'Asia/Qatar') AS demand_date, vendor_id, offer_id,
    COUNT(*) AS redemptions, SUM(final_amount) AS transaction_value,
    SUM(discount_amount) AS discount_amount, SUM(cashback_amount) AS cashback_amount
  FROM `realx-forecasting-dev.forecasting.stg_transactions`
  GROUP BY demand_date, vendor_id, offer_id
)
SELECT d.demand_date, c.vendor_id, c.offer_id,
  COALESCE(o.redemptions, 0) AS redemptions,
  COALESCE(o.transaction_value, 0) AS transaction_value,
  COALESCE(o.discount_amount, 0) AS discount_amount,
  COALESCE(o.cashback_amount, 0) AS cashback_amount
FROM dates d CROSS JOIN combos c
LEFT JOIN observed o USING (demand_date, vendor_id, offer_id);

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
