# Firestore to BigQuery Analytics Integration

## Overview

This document describes the implementation, validation, and analytics testing performed for the Firestore to BigQuery integration in the RealX platform.

The objective was to verify that transaction data stored in Firestore can be automatically synchronized to BigQuery and used for analytics and reporting purposes.

---

# Architecture

Firestore Transactions Collection

↓

Firebase Firestore to BigQuery Extension

↓

BigQuery Export Dataset

↓

SQL Analytics Queries

↓

Business Intelligence and Reporting

---

# Configuration

## Environment

Project ID:

reelx-backend

## Firestore Collection

transactions

## BigQuery Dataset

firestore_export

## Export Table

transactions_raw_latest

## Extension

Stream Firestore to BigQuery

---

# Implementation Process

The following steps were completed:

1. Installed and configured the Firestore to BigQuery extension.
2. Configured synchronization for the transactions collection.
3. Verified creation of BigQuery export tables.
4. Added test transaction records to Firestore.
5. Confirmed successful synchronization to BigQuery.
6. Executed analytics queries against exported data.
7. Validated query results and transaction metrics.

---

# Data Synchronization Verification

Synchronization was verified by creating test transaction records inside the Firestore transactions collection and confirming that corresponding records appeared in the BigQuery export tables.

The export process successfully captured document changes and made them available for analytical processing.

---

# Analytics Queries Executed

## Query 1 – Total Transactions

Purpose:

Determine the total number of exported transaction records.

Result:

* Total Transactions: 6

Observation:

All test transaction records were successfully exported and detected in BigQuery.

---

## Query 2 – Total Sales

Purpose:

Calculate the total transaction volume.

Result:

* Total Sales: 20,647 QAR

Observation:

BigQuery successfully aggregated transaction values from Firestore-exported records.

---

## Query 3 – Total Cashback

Purpose:

Calculate the total cashback distributed across transactions.

Result:

* Total Cashback: 184 QAR

Observation:

Cashback data was correctly synchronized and available for aggregation.

---

## Query 4 – Transactions by Vendor

Purpose:

Analyze transaction distribution across vendors.

Results:

* Starbucks: 1
* McDonalds: 1
* Carrefour: 1
* Talabat: 1
* KFC: 1
* ewheiooo: 1

Observation:

Vendor-level analytics can be generated directly from exported Firestore data.

---

## Query 5 – Status Breakdown

Purpose:

Analyze transaction status distribution.

Results:

* completed: 5
* pending: 1

Observation:

The query identified multiple transaction states.

A minor data consistency issue was observed where one completed value appears separately, likely due to formatting differences in the source Firestore document. This demonstrates the usefulness of analytics for identifying data-quality issues.

---

# Validation Summary

The integration was successfully validated.

Verified capabilities:

* Automatic Firestore to BigQuery synchronization
* Near real-time transaction export
* SQL-based analytics
* Aggregation reporting
* Vendor performance analysis
* Transaction status monitoring
* Data quality verification

---

# Future Enhancements

Potential future improvements include:

* BigQuery dashboards
* Scheduled reporting
* Vendor performance KPIs
* Customer behavior analytics
* Revenue forecasting
* BigQuery ML integration
* Automated anomaly detection

---

# Conclusion

The Firestore to BigQuery integration was successfully configured and validated.

Transaction data can now be exported, queried, aggregated, and analyzed within BigQuery, providing a scalable foundation for reporting, analytics, and future business intelligence features for the RealX platform.

---

# Parallel Admin Transactions Evaluation

## Production architecture

The existing `/admin/transactions` route remains Firestore-backed and is the control panel during evaluation.

The parallel `/admin/bigquery-transactions` route calls the admin-only
`listAdminBigQueryTransactions` callable Function. The Function queries the typed
`reelx-backend.firestore_export.transactions_admin_v1` view, which projects fields
from `transactions_raw_latest`. The extension's latest view excludes deleted
documents.

Rows in the BigQuery panel continue to open the existing Firestore-backed
`/admin/transactions/$id` detail route.

## Deploy the typed view

From the repository root:

```sh
bq query --use_legacy_sql=false < functions/bigquery/transactions_admin_v1.sql
```

## Initial import and consistency

The Firestore to BigQuery extension is incremental. Installing it starts
listening for subsequent document changes, but does not automatically export
documents that already exist in the collection. Run the official import tool
over the entire collection immediately after installing or reconfiguring the
extension:

```sh
npx --yes @firebaseextensions/fs-bq-import-collection \
  --non-interactive \
  --project reelx-backend \
  --big-query-project reelx-backend \
  --query-collection-group false \
  --source-collection-path transactions \
  --dataset firestore_export \
  --table-name-prefix transactions \
  --batch-size 300 \
  --dataset-location us \
  --multi-threaded false \
  --use-new-snapshot-query-syntax true \
  --firestore-instance-id '(default)'
```

The import is safe to run over the full live collection. Imported snapshots use
the `IMPORT` operation with an epoch timestamp, so later streamed `CREATE`,
`UPDATE`, and `DELETE` events remain authoritative.

The import tool can remove clustering metadata while updating the changelog
schema. Restore the extension's configured clustering afterward:

```sh
bq update \
  --project_id=reelx-backend \
  --clustering_fields=document_id,timestamp,operation \
  reelx-backend:firestore_export.transactions_raw_changelog
```

Verify the live Firestore and BigQuery counts manually after import. Re-run the
full import after extension updates or reconfiguration to cover any writes that
occurred while event streaming was interrupted.

## Security boundary and IAM

The browser never receives BigQuery credentials or direct BigQuery access.
The callable requires an authenticated Firebase user with the `admin: true`
custom claim.

The callable runs as the dedicated
`admin-bigquery-transactions@reelx-backend.iam.gserviceaccount.com` service
account. Grant it only:

* `roles/bigquery.jobUser` on project `reelx-backend`
* `roles/bigquery.dataViewer` on dataset `reelx-backend:firestore_export`

Do not grant BigQuery roles to admin browser users.

## Cost controls and logging

The callable uses fixed SQL, allowlisted sort columns, parameterized values,
deterministic cursor pagination, and `LIMIT + 1`. It defaults to a 256 MiB
`maximumBytesBilled` limit per query. Override it with the
`ADMIN_BIGQUERY_MAX_BYTES_BILLED` Function environment variable when needed.

Each query logs requesting admin UID, filters, sorting, cursor presence,
duration, result count, bytes processed, bytes billed, cache status, and
whether a failure was caused by the byte budget.

## Evaluation workflow

1. Open the Firestore and BigQuery transaction panels side by side.
2. Compare representative records and each vendor/sort combination manually.
3. Confirm cursor pages contain no duplicate or skipped rows.
4. Monitor displayed export freshness, query duration, and billed bytes.
5. Use Cloud Logging to review failures and byte-budget rejections.

The BigQuery panel intentionally does not query Firestore for automatic
comparison, because doing so would add evaluation reads to the production
collection.
