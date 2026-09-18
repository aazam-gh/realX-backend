CREATE SCHEMA IF NOT EXISTS `realx-forecasting-dev.marketplace` OPTIONS(location = 'US');

CREATE OR REPLACE TABLE `realx-forecasting-dev.marketplace.bronze_events` AS
SELECT event_date, vendor_id, offer_id, event_type, event_count, platform
FROM `realx-forecasting-dev.forecasting.synthetic_events`;

CREATE OR REPLACE TABLE `realx-forecasting-dev.marketplace.bronze_transactions` AS
SELECT DATE(created_at, 'Asia/Qatar') AS transaction_date,
  vendor_id, offer_id, final_amount AS gmv, discount_amount, cashback_amount
FROM `realx-forecasting-dev.forecasting.synthetic_transactions`
WHERE type = 'offer';
