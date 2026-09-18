CREATE OR REPLACE TABLE `realx-forecasting-dev.marketplace.mart_vendor_daily` AS
WITH bounds AS (
  SELECT MIN(transaction_date) AS first_date, MAX(transaction_date) AS last_date
  FROM `realx-forecasting-dev.marketplace.bronze_transactions`
), vendors AS (
  SELECT DISTINCT vendor_id FROM `realx-forecasting-dev.marketplace.bronze_transactions`
), dates AS (
  SELECT date FROM bounds, UNNEST(GENERATE_DATE_ARRAY(first_date, last_date)) AS date
), vendor_dates AS (
  SELECT date, vendor_id FROM dates CROSS JOIN vendors
), event_daily AS (
  SELECT event_date AS date, vendor_id,
    SUM(IF(event_type = 'impression', event_count, 0)) AS impressions,
    SUM(IF(event_type = 'click', event_count, 0)) AS clicks,
    SUM(IF(event_type = 'save', event_count, 0)) AS saves,
    SUM(IF(event_type = 'purchase', event_count, 0)) AS event_purchases,
    COUNT(DISTINCT offer_id) AS active_offers
  FROM `realx-forecasting-dev.marketplace.bronze_events`
  GROUP BY date, vendor_id
), transaction_daily AS (
  SELECT transaction_date AS date, vendor_id, COUNT(*) AS purchases,
    SUM(gmv) AS gmv, SUM(discount_amount) AS discount_amount,
    SUM(cashback_amount) AS cashback_amount
  FROM `realx-forecasting-dev.marketplace.bronze_transactions`
  GROUP BY date, vendor_id
)
SELECT vd.date, vd.vendor_id,
  COALESCE(e.impressions, 0) AS impressions, COALESCE(e.clicks, 0) AS clicks,
  COALESCE(e.saves, 0) AS saves, COALESCE(t.purchases, e.event_purchases, 0) AS purchases,
  COALESCE(t.gmv, 0) AS gmv, COALESCE(t.discount_amount, 0) AS discount_amount,
  COALESCE(t.cashback_amount, 0) AS cashback_amount, COALESCE(e.active_offers, 0) AS active_offers
FROM vendor_dates vd
LEFT JOIN event_daily e USING (date, vendor_id)
LEFT JOIN transaction_daily t USING (date, vendor_id);

CREATE OR REPLACE TABLE `realx-forecasting-dev.marketplace.feature_vendor_performance` AS
WITH features AS (
  SELECT date AS prediction_date, vendor_id,
    SUM(impressions) OVER w30 AS impressions_30d,
    SUM(clicks) OVER w30 AS clicks_30d,
    SUM(saves) OVER w30 AS saves_30d,
    SUM(purchases) OVER w30 AS purchases_30d,
    SUM(gmv) OVER w30 AS gmv_30d,
    SUM(gmv) OVER w7 AS gmv_7d,
    SUM(active_offers) OVER w7 AS active_offers_7d,
    SAFE_DIVIDE(SUM(clicks) OVER w30, NULLIF(SUM(impressions) OVER w30, 0)) AS ctr_30d,
    SAFE_DIVIDE(SUM(purchases) OVER w30, NULLIF(SUM(clicks) OVER w30, 0)) AS conversion_30d,
    SAFE_DIVIDE(SUM(gmv) OVER w7, NULLIF(SUM(gmv) OVER w30 / 4, 0)) AS gmv_momentum,
    SUM(gmv) OVER (
      PARTITION BY vendor_id ORDER BY date
      ROWS BETWEEN 1 FOLLOWING AND 30 FOLLOWING
    ) AS target_gmv_next_30d
  FROM `realx-forecasting-dev.marketplace.mart_vendor_daily`
  WINDOW
    w7 AS (PARTITION BY vendor_id ORDER BY date ROWS BETWEEN 6 PRECEDING AND CURRENT ROW),
    w30 AS (PARTITION BY vendor_id ORDER BY date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW)
)
SELECT * FROM features WHERE prediction_date >= DATE_ADD(
  (SELECT MIN(date) FROM `realx-forecasting-dev.marketplace.mart_vendor_daily`), INTERVAL 30 DAY
);
