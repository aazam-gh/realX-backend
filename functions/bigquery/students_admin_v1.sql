-- Production admin student projection.
-- Deploy with:
-- bq query --use_legacy_sql=false < functions/bigquery/students_admin_v1.sql
CREATE OR REPLACE VIEW `reelx-backend.firestore_export.students_admin_v1` AS
SELECT
  document_id AS id,
  timestamp AS export_timestamp,
  COALESCE(JSON_VALUE(data, '$.firstName'), '') AS first_name,
  COALESCE(JSON_VALUE(data, '$.lastName'), '') AS last_name,
  TRIM(CONCAT(
    COALESCE(JSON_VALUE(data, '$.firstName'), ''),
    ' ',
    COALESCE(JSON_VALUE(data, '$.lastName'), '')
  )) AS full_name,
  JSON_VALUE(data, '$.email') AS email,
  JSON_VALUE(data, '$.studentId') AS student_id,
  JSON_VALUE(data, '$.gender') AS gender,
  JSON_VALUE(data, '$.dob') AS dob,
  COALESCE(JSON_VALUE(data, '$.role'), 'student') AS role,
  SAFE_CAST(JSON_VALUE(data, '$.createdAt._seconds') AS INT64) AS created_at_seconds,
  data AS raw_data
FROM `reelx-backend.firestore_export.students_raw_latest`;