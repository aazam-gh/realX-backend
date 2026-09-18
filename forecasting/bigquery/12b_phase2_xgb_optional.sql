-- Optional: BigQuery ML boosted-tree training can be slower and more
-- expensive than the default Phase 2 pipeline.
CREATE OR REPLACE MODEL `realx-forecasting-dev.marketplace.vendor_gmv_xgb`
OPTIONS(MODEL_TYPE = 'BOOSTED_TREE_REGRESSOR', INPUT_LABEL_COLS = ['target_gmv_next_30d'], DATA_SPLIT_METHOD = 'NO_SPLIT', MAX_ITERATIONS = 10, LEARN_RATE = 0.05, MAX_TREE_DEPTH = 4, L2_REG = 1.0) AS
SELECT target_gmv_next_30d, impressions_30d, clicks_30d, saves_30d, purchases_30d,
  gmv_30d, gmv_7d, active_offers_7d, ctr_30d, conversion_30d, gmv_momentum
FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`
WHERE target_gmv_next_30d IS NOT NULL
  AND prediction_date < DATE_SUB((SELECT MAX(prediction_date) FROM `realx-forecasting-dev.marketplace.feature_vendor_performance`), INTERVAL 30 DAY);
