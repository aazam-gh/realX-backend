-- Run from the forecasting GCP project. Production is read-only input.
CREATE SCHEMA IF NOT EXISTS `realx-forecasting-dev.forecasting` OPTIONS(location = 'US');

CREATE OR REPLACE TABLE `realx-forecasting-dev.forecasting.stg_transactions` AS
SELECT
  created_at,
  vendor_id,
  NULLIF(offer_id, '') AS offer_id,
  type,
  COALESCE(final_amount, total_amount, 0) AS transaction_value,
  COALESCE(discount_amount, 0) AS discount_amount,
  COALESCE(cashback_amount, 0) AS cashback_amount
FROM `reelx-backend.firestore_export.transactions_admin_v1`
WHERE created_at IS NOT NULL
  AND vendor_id IS NOT NULL
  AND type = 'offer';

CREATE OR REPLACE TABLE `realx-forecasting-dev.forecasting.stg_vendors` AS
SELECT vendor_id, ANY_VALUE(vendor_name) AS vendor_name
FROM `reelx-backend.firestore_export.transactions_admin_v1`
WHERE vendor_id IS NOT NULL
GROUP BY vendor_id;

CREATE OR REPLACE TABLE `realx-forecasting-dev.forecasting.stg_offers` AS
SELECT vendor_id, NULLIF(offer_id, '') AS offer_id, COUNT(*) AS observed_redemptions
FROM `realx-forecasting-dev.forecasting.stg_transactions`
GROUP BY vendor_id, offer_id;
