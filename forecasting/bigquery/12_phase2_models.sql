CREATE OR REPLACE MODEL `realx-forecasting-dev.marketplace.vendor_gmv_linear`
OPTIONS(MODEL_TYPE = 'LINEAR_REG', INPUT_LABEL_COLS = ['target_gmv_next_30d'], DATA_SPLIT_METHOD = 'NO_SPLIT') AS
SELECT target_gmv_next_30d, impressions_30d, clicks_30d, saves_30d, purchases_30d,
  gmv_30d, gmv_7d, active_offers_7d, ctr_30d, conversion_30d, gmv_momentum
FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`
WHERE target_gmv_next_30d IS NOT NULL
  AND prediction_date < DATE_SUB((SELECT MAX(prediction_date) FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`), INTERVAL 30 DAY);

CREATE OR REPLACE MODEL `realx-forecasting-dev.marketplace.vendor_gmv_ridge`
OPTIONS(MODEL_TYPE = 'LINEAR_REG', L2_REG = 1.0, INPUT_LABEL_COLS = ['target_gmv_next_30d'], DATA_SPLIT_METHOD = 'NO_SPLIT') AS
SELECT target_gmv_next_30d, impressions_30d, clicks_30d, saves_30d, purchases_30d,
  gmv_30d, gmv_7d, active_offers_7d, ctr_30d, conversion_30d, gmv_momentum
FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`
WHERE target_gmv_next_30d IS NOT NULL
  AND prediction_date < DATE_SUB((SELECT MAX(prediction_date) FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`), INTERVAL 30 DAY);

CREATE OR REPLACE TABLE `realx-forecasting-dev.marketplace.model_metrics` AS
WITH holdout AS (
  SELECT * FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`
  WHERE target_gmv_next_30d IS NOT NULL
    AND prediction_date >= DATE_SUB((SELECT MAX(prediction_date) FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`), INTERVAL 30 DAY)
), baseline AS (
  SELECT 'seasonal_naive_gmv' AS model_version,
    SQRT(AVG(POW(gmv_30d - target_gmv_next_30d, 2))) AS rmse,
    AVG(ABS(gmv_30d - target_gmv_next_30d)) AS mae,
    CAST(NULL AS FLOAT64) AS r2
  FROM holdout
), linear AS (
  SELECT 'linear_regression' AS model_version, *
  FROM ML.EVALUATE(MODEL `realx-forecasting-dev.marketplace.vendor_gmv_linear`, (SELECT * FROM holdout))
), ridge AS (
  SELECT 'ridge_regression' AS model_version, *
  FROM ML.EVALUATE(MODEL `realx-forecasting-dev.marketplace.vendor_gmv_ridge`, (SELECT * FROM holdout))
)
SELECT model_version, rmse, mae, r2, CURRENT_TIMESTAMP() AS evaluated_at FROM baseline
UNION ALL SELECT model_version, SQRT(mean_squared_error), mean_absolute_error, r2_score, CURRENT_TIMESTAMP() FROM linear
UNION ALL SELECT model_version, SQRT(mean_squared_error), mean_absolute_error, r2_score, CURRENT_TIMESTAMP() FROM ridge;
