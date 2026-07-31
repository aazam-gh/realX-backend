import {BigQuery, Job} from "@google-cloud/bigquery";
import {CallableRequest, HttpsError} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";
import {resolveMaximumBytesBilled} from "./bigquery-cost-controls.js";

/* eslint-disable require-jsdoc, max-len */

const PROJECT_ID = "reelx-backend";
const LOCATION = "US";
const VIEW = "`reelx-backend.firestore_export.transactions_admin_v1`";
const bigquery = new BigQuery({projectId: PROJECT_ID});

interface BigQueryValue<T> {
  value?: T;
}

interface DashboardStatsRow {
  transacting_students?: BigQueryValue<string> | string | number | null;
  transacting_vendors?: BigQueryValue<string> | string | number | null;
  offer_redemptions?: BigQueryValue<string> | string | number | null;
  transactions?: BigQueryValue<string> | string | number | null;
  transaction_value?: BigQueryValue<string> | string | number | null;
}

interface TransactionTrendRow {
  label?: string | null;
  transactions?: BigQueryValue<string> | string | number | null;
  value?: BigQueryValue<string> | string | number | null;
}

interface TopVendorRow {
  name?: string | null;
  sales?: BigQueryValue<string> | string | number | null;
}

interface TransactionBreakdownRow {
  type?: string | null;
  transactions?: BigQueryValue<string> | string | number | null;
  value?: BigQueryValue<string> | string | number | null;
}

interface LiveActivityRow {
  id?: string | null;
  student_name?: string | null;
  vendor_name?: string | null;
  amount?: BigQueryValue<string> | string | number | null;
  created_at?: string | null;
  status?: string | null;
}

interface AdminDashboardRow {
  stats?: DashboardStatsRow | null;
  transaction_trend?: TransactionTrendRow[] | null;
  transaction_breakdown?: TransactionBreakdownRow[] | null;
  top_vendors?: TopVendorRow[] | null;
  recent_activity?: LiveActivityRow[] | null;
  freshness?: string | null;
}

export interface AdminBigQueryDashboardResult {
  stats: {
    transactingStudents: number;
    transactingVendors: number;
    offerRedemptions: number;
    transactions: number;
    transactionValue: number;
  };
  transactionTrend: Array<{label: string; transactions: number; value: number}>;
  transactionBreakdown: Array<{type: string; transactions: number; value: number}>;
  topVendors: Array<{name: string; sales: number}>;
  recentActivity: Array<{
    id: string;
    studentName: string;
    vendorName: string;
    amount: number;
    createdAt: string;
    status: string;
  }>;
  freshness: string | null;
}

type DashboardRange = "30d" | "90d" | "6mo";

const DASHBOARD_RANGE_CONFIG: Record<DashboardRange, {
  daysBack: number;
  bucket: "day" | "week" | "month";
}> = {
  "30d": {daysBack: 29, bucket: "day"},
  "90d": {daysBack: 89, bucket: "week"},
  "6mo": {daysBack: 182, bucket: "month"},
};

function parseDashboardRange(value: unknown): DashboardRange {
  if (value === "30d" || value === "90d" || value === "6mo") return value;
  return "6mo";
}

const DASHBOARD_SQL = `
  WITH
    base AS (
      SELECT
        id,
        export_timestamp,
        created_at,
        user_id,
        vendor_id,
        vendor_name,
        type,
        COALESCE(final_amount, total_amount, 0) AS amount
      FROM ${VIEW}
      WHERE type != 'online_redemption'
    ),
    ranged AS (
      SELECT *
      FROM base
      WHERE DATE(created_at, 'Asia/Qatar') >= DATE_SUB(
        CURRENT_DATE('Asia/Qatar'), INTERVAL @days_back DAY
      )
    ),
    trend_buckets AS (
      SELECT DISTINCT
        CASE @bucket
          WHEN 'month' THEN DATE_TRUNC(day, MONTH)
          WHEN 'week' THEN DATE_TRUNC(day, WEEK(MONDAY))
          ELSE day
        END AS bucket_start
      FROM UNNEST(
        GENERATE_DATE_ARRAY(
          DATE_SUB(CURRENT_DATE('Asia/Qatar'), INTERVAL @days_back DAY),
          CURRENT_DATE('Asia/Qatar')
        )
      ) AS day
    )
  SELECT
    (
      SELECT AS STRUCT
        COUNT(DISTINCT user_id) AS transacting_students,
        COUNT(DISTINCT vendor_id) AS transacting_vendors,
        COUNTIF(type = 'offer') AS offer_redemptions,
        COUNT(*) AS transactions,
        ROUND(SUM(amount), 2) AS transaction_value
      FROM base
    ) AS stats,
    ARRAY(
      SELECT AS STRUCT
        FORMAT_DATE(
          IF(@bucket = 'month', '%b', IF(@bucket = 'week', '%d %b', '%d %b')),
          trend_buckets.bucket_start
        ) AS label,
        COUNT(ranged.id) AS transactions,
        ROUND(COALESCE(SUM(ranged.amount), 0), 2) AS value
      FROM trend_buckets
      LEFT JOIN ranged
        ON CASE @bucket
          WHEN 'month' THEN DATE_TRUNC(DATE(ranged.created_at, 'Asia/Qatar'), MONTH)
          WHEN 'week' THEN DATE_TRUNC(DATE(ranged.created_at, 'Asia/Qatar'), WEEK(MONDAY))
          ELSE DATE(ranged.created_at, 'Asia/Qatar')
        END = trend_buckets.bucket_start
      GROUP BY trend_buckets.bucket_start
      ORDER BY trend_buckets.bucket_start
    ) AS transaction_trend,
    ARRAY(
      SELECT AS STRUCT
        COALESCE(NULLIF(type, ''), 'unspecified') AS type,
        COUNT(*) AS transactions,
        ROUND(SUM(amount), 2) AS value
      FROM ranged
      GROUP BY type
      ORDER BY transactions DESC, type
    ) AS transaction_breakdown,
    ARRAY(
      SELECT AS STRUCT
        COALESCE(NULLIF(vendor_name, ''), 'Unknown Vendor') AS name,
        ROUND(SUM(amount), 2) AS sales
      FROM ranged
      GROUP BY name
      ORDER BY sales DESC, name
      LIMIT 5
    ) AS top_vendors,
    ARRAY(
      SELECT AS STRUCT
        id,
        CONCAT('Student ', SUBSTR(COALESCE(user_id, 'Unknown'), 1, 8)) AS student_name,
        COALESCE(NULLIF(vendor_name, ''), 'Unknown Vendor') AS vendor_name,
        ROUND(amount, 2) AS amount,
        FORMAT_TIMESTAMP(
          '%Y-%m-%dT%H:%M:%E3SZ',
          created_at,
          'UTC'
        ) AS created_at,
        'completed' AS status
      FROM base
      ORDER BY created_at DESC, id DESC
      LIMIT 15
    ) AS recent_activity,
    (
      SELECT FORMAT_TIMESTAMP(
        '%Y-%m-%dT%H:%M:%E3SZ',
        MAX(export_timestamp),
        'UTC'
      )
      FROM base
    ) AS freshness
`;

function scalar(value: unknown): unknown {
  if (value && typeof value === "object" && "value" in value) {
    return (value as BigQueryValue<unknown>).value;
  }
  return value;
}

function numberValue(value: unknown): number {
  const parsed = Number(scalar(value) ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function normalizeAdminBigQueryDashboardRow(
  row: AdminDashboardRow | undefined,
): AdminBigQueryDashboardResult {
  const stats = row?.stats || {};

  return {
    stats: {
      transactingStudents: numberValue(stats.transacting_students),
      transactingVendors: numberValue(stats.transacting_vendors),
      offerRedemptions: numberValue(stats.offer_redemptions),
      transactions: numberValue(stats.transactions),
      transactionValue: numberValue(stats.transaction_value),
    },
    transactionTrend: (row?.transaction_trend || []).map((item) => ({
      label: item.label || "",
      transactions: numberValue(item.transactions),
      value: numberValue(item.value),
    })),
    transactionBreakdown: (row?.transaction_breakdown || []).map((item) => ({
      type: item.type || "unspecified",
      transactions: numberValue(item.transactions),
      value: numberValue(item.value),
    })),
    topVendors: (row?.top_vendors || []).map((item) => ({
      name: item.name || "Unknown Vendor",
      sales: numberValue(item.sales),
    })),
    recentActivity: (row?.recent_activity || []).map((item) => ({
      id: item.id || "",
      studentName: item.student_name || "Unknown Student",
      vendorName: item.vendor_name || "Unknown Vendor",
      amount: numberValue(item.amount),
      createdAt: item.created_at || "",
      status: item.status || "completed",
    })),
    freshness: row?.freshness || null,
  };
}

function getQueryStats(job: Job) {
  const statistics = job.metadata?.statistics?.query;
  return {
    bytesProcessed: Number(statistics?.totalBytesProcessed || 0),
    bytesBilled: Number(statistics?.totalBytesBilled || 0),
    cacheHit: Boolean(statistics?.cacheHit),
  };
}

function getMaximumBytesBilled() {
  return resolveMaximumBytesBilled(
    process.env.ADMIN_DASHBOARD_BIGQUERY_MAX_BYTES_BILLED ||
    process.env.ADMIN_BIGQUERY_MAX_BYTES_BILLED,
  );
}

export async function getAdminBigQueryDashboardHandler(
  request: CallableRequest,
) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User not authenticated");
  }
  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required");
  }

  const startedAt = Date.now();
  const range = parseDashboardRange(request.data?.range);
  const byteBudget = getMaximumBytesBilled();

  try {
    const [job] = await bigquery.createQueryJob({
      query: DASHBOARD_SQL,
      location: LOCATION,
      params: {
        days_back: DASHBOARD_RANGE_CONFIG[range].daysBack,
        bucket: DASHBOARD_RANGE_CONFIG[range].bucket,
      },
      maximumBytesBilled: byteBudget.toString(),
      useLegacySql: false,
      labels: {
        app: "realx",
        surface: "admin_dashboard",
      },
    });
    const [rawRows] = await job.getQueryResults();
    await job.getMetadata();

    const dashboard = normalizeAdminBigQueryDashboardRow(
      (rawRows as AdminDashboardRow[])[0],
    );
    const queryStats = getQueryStats(job);
    const durationMs = Date.now() - startedAt;

    logger.info("Admin BigQuery dashboard query completed", {
      adminUid: request.auth.uid,
      durationMs,
      resultCount: dashboard.stats.transactions,
      maximumBytesBilled: byteBudget,
      freshness: dashboard.freshness,
      ...queryStats,
    });

    return {
      ...dashboard,
      query: {
        durationMs,
        ...queryStats,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rejectedByByteBudget =
      /maximum bytes billed|bytes billed limit|limit for bytes billed|bytesBilledLimitExceeded/i
        .test(message);

    logger.error("Admin BigQuery dashboard query failed", {
      adminUid: request.auth.uid,
      durationMs: Date.now() - startedAt,
      maximumBytesBilled: byteBudget,
      rejectedByByteBudget,
      error,
    });

    throw new HttpsError(
      rejectedByByteBudget ? "resource-exhausted" : "internal",
      rejectedByByteBudget ?
        "Dashboard query exceeded the configured BigQuery byte budget" :
        "Unable to load dashboard analytics",
    );
  }
}
