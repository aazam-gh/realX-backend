DELETE FROM `realx-forecasting-dev.forecasting.forecasts` WHERE TRUE;

INSERT INTO `realx-forecasting-dev.forecasting.forecasts`
WITH recent AS (
  SELECT vendor_id, offer_id,
    AVG(redemptions) AS baseline_redemptions,
    AVG(SAFE_DIVIDE(transaction_value, NULLIF(redemptions, 0))) AS average_value_per_redemption
  FROM `realx-forecasting-dev.forecasting.fact_daily_vendor_offer`
  WHERE demand_date >= DATE_SUB(CURRENT_DATE('Asia/Qatar'), INTERVAL 56 DAY)
  GROUP BY vendor_id, offer_id
),
future AS (
  SELECT forecast_date FROM UNNEST(GENERATE_DATE_ARRAY(
    CURRENT_DATE('Asia/Qatar'), DATE_ADD(CURRENT_DATE('Asia/Qatar'), INTERVAL 27 DAY)
  )) AS forecast_date
)
SELECT
  f.forecast_date, r.vendor_id, r.offer_id,
  r.baseline_redemptions AS predicted_redemptions,
  r.baseline_redemptions * COALESCE(r.average_value_per_redemption, 0) AS predicted_value,
  GREATEST(0, r.baseline_redemptions * 0.5) AS lower_redemptions,
  r.baseline_redemptions * 1.5 AS upper_redemptions,
  r.baseline_redemptions,
  CASE WHEN r.baseline_redemptions >= 5 THEN 'high'
    WHEN r.baseline_redemptions >= 1 THEN 'medium' ELSE 'low' END AS confidence,
  'seasonal_naive_v1' AS model_version,
  CURRENT_TIMESTAMP() AS generated_at
FROM future f CROSS JOIN recent r;
