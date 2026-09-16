-- Run only after 00_readiness.sql reports sufficient history. This model is
-- experimental until rolling validation beats the seasonal-naive baseline.
CREATE OR REPLACE MODEL `realx-forecasting-dev.forecasting.offer_demand_xgb`
OPTIONS(
  MODEL_TYPE = 'BOOSTED_TREE_REGRESSOR',
  INPUT_LABEL_COLS = ['redemptions'],
  DATA_SPLIT_METHOD = 'NO_SPLIT',
  MAX_ITERATIONS = 50,
  LEARN_RATE = 0.05,
  MAX_TREE_DEPTH = 5,
  L2_REG = 1.0
) AS
SELECT
  redemptions, vendor_id, offer_id, day_of_week, week_of_year,
  COALESCE(lag_1, 0) AS lag_1, COALESCE(lag_7, 0) AS lag_7,
  COALESCE(lag_14, 0) AS lag_14, COALESCE(lag_28, 0) AS lag_28,
  COALESCE(rolling_28, 0) AS rolling_28
FROM `realx-forecasting-dev.forecasting.forecast_features`
WHERE demand_date < DATE_SUB(CURRENT_DATE('Asia/Qatar'), INTERVAL 28 DAY);
