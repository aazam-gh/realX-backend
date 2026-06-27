-- Production admin vendor projection.
-- Deploy with:
-- bq query --use_legacy_sql=false < functions/bigquery/vendors_admin_v1.sql
CREATE OR REPLACE VIEW `reelx-backend.firestore_export.vendors_admin_v1` AS
SELECT
  document_id AS id,
  timestamp AS export_timestamp,
  COALESCE(JSON_VALUE(data, '$.name'), 'Unnamed Vendor') AS name,
  COALESCE(JSON_VALUE(data, '$.contact'), JSON_VALUE(data, '$.email'), '') AS contact,
  JSON_VALUE(data, '$.email') AS email,
  JSON_VALUE(data, '$.profilePicture') AS profile_picture,
  COALESCE(JSON_VALUE(data, '$.vendorType'), 'in_store') AS vendor_type,
  COALESCE(SAFE_CAST(JSON_VALUE(data, '$.xcard') AS BOOL), FALSE) AS xcard,
  JSON_VALUE(data, '$.mainCategory') AS main_category,
  JSON_VALUE(data, '$.subcategory') AS subcategory,
  COALESCE(SAFE_CAST(JSON_VALUE(data, '$.isTrending') AS BOOL), FALSE) AS is_trending,
  SAFE_CAST(JSON_VALUE(data, '$.latitude') AS FLOAT64) AS latitude,
  SAFE_CAST(JSON_VALUE(data, '$.longitude') AS FLOAT64) AS longitude,
  SAFE_CAST(JSON_VALUE(data, '$.lat') AS FLOAT64) AS lat,
  SAFE_CAST(JSON_VALUE(data, '$.lng') AS FLOAT64) AS lng,
  data AS raw_data
FROM `reelx-backend.firestore_export.vendors_raw_latest`;