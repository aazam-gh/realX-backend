CREATE OR REPLACE TABLE `realx-forecasting-dev.marketplace.backtest_results` AS
WITH dates AS (
  SELECT DISTINCT prediction_date AS cutoff_date
  FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`
  WHERE prediction_date BETWEEN DATE_SUB((SELECT MAX(prediction_date) FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`), INTERVAL 150 DAY)
    AND DATE_SUB((SELECT MAX(prediction_date) FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`), INTERVAL 30 DAY)
), fold_errors AS (
  SELECT cutoff_date, gmv_30d AS prediction, target_gmv_next_30d AS actual
  FROM dates d JOIN `realx-forecasting-dev.marketplace.feature_vendor_performance` f
    ON f.prediction_date = d.cutoff_date WHERE target_gmv_next_30d IS NOT NULL
)
SELECT cutoff_date, SQRT(AVG(POW(prediction - actual, 2))) AS rmse,
  AVG(ABS(prediction - actual)) AS mae, COUNT(*) AS vendor_count
FROM fold_errors GROUP BY cutoff_date ORDER BY cutoff_date;

CREATE OR REPLACE TABLE `realx-forecasting-dev.marketplace.opportunity_rankings` AS
WITH latest AS (
  SELECT * EXCEPT(row_number) FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY vendor_id ORDER BY prediction_date DESC) AS row_number
    FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`
  ) WHERE row_number = 1
), selected AS (
  SELECT model_version FROM `realx-forecasting-dev.marketplace.model_metrics`
  WHERE rmse = (SELECT MIN(rmse) FROM `realx-forecasting-dev.marketplace.model_metrics`)
  LIMIT 1
), predictions AS (
  SELECT 'linear_regression' AS model_version, vendor_id, prediction_date, gmv_30d,
    predicted_target_gmv_next_30d AS predicted_gmv_next_30d, gmv_momentum
  FROM ML.PREDICT(MODEL `realx-forecasting-dev.marketplace.vendor_gmv_linear`, (SELECT * FROM latest))
  UNION ALL
  SELECT 'ridge_regression', vendor_id, prediction_date, gmv_30d,
    predicted_target_gmv_next_30d, gmv_momentum
  FROM ML.PREDICT(MODEL `realx-forecasting-dev.marketplace.vendor_gmv_ridge`, (SELECT * FROM latest))
  UNION ALL
  SELECT 'seasonal_naive_gmv', vendor_id, prediction_date, gmv_30d, gmv_30d, gmv_momentum FROM latest
)
SELECT ROW_NUMBER() OVER (ORDER BY predicted_gmv_next_30d DESC) AS rank,
  p.vendor_id, p.prediction_date, p.predicted_gmv_next_30d, p.gmv_30d,
  p.gmv_momentum, p.model_version, CURRENT_TIMESTAMP() AS generated_at
FROM predictions p CROSS JOIN selected s
WHERE p.model_version = s.model_version;
