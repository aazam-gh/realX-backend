CREATE SCHEMA IF NOT EXISTS `realx-forecasting-dev.forecasting` OPTIONS(location = 'US');

CREATE OR REPLACE TABLE `realx-forecasting-dev.forecasting.stg_transactions` AS
SELECT
  created_at, vendor_id, vendor_name, offer_id, type,
  total_amount, final_amount, discount_amount, cashback_amount
FROM `realx-forecasting-dev.forecasting.synthetic_transactions`
WHERE created_at IS NOT NULL AND vendor_id IS NOT NULL AND type = 'offer';

CREATE OR REPLACE TABLE `realx-forecasting-dev.forecasting.stg_vendors` AS
SELECT vendor_id, ANY_VALUE(vendor_name) AS vendor_name
FROM `realx-forecasting-dev.forecasting.stg_transactions`
GROUP BY vendor_id;

CREATE OR REPLACE TABLE `realx-forecasting-dev.forecasting.stg_offers` AS
SELECT vendor_id, offer_id, COUNT(*) AS observed_redemptions
FROM `realx-forecasting-dev.forecasting.stg_transactions`
GROUP BY vendor_id, offer_id;
