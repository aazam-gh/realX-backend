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
}

interface MonthlyRevenueRow {
  month?: string | null;
  amount?: BigQueryValue<string> | string | number | null;
}

interface TopVendorRow {
  name?: string | null;
  sales?: BigQueryValue<string> | string | number | null;
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
  monthly_revenue?: MonthlyRevenueRow[] | null;
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
  };
  monthlyRevenue: Array<{month: string; amount: number}>;
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
    months AS (
      SELECT month_start
      FROM UNNEST(
        GENERATE_DATE_ARRAY(
          DATE_SUB(
            DATE_TRUNC(CURRENT_DATE('Asia/Qatar'), MONTH),
            INTERVAL 5 MONTH
          ),
          DATE_TRUNC(CURRENT_DATE('Asia/Qatar'), MONTH),
          INTERVAL 1 MONTH
        )
      ) AS month_start
    )
  SELECT
    (
      SELECT AS STRUCT
        COUNT(DISTINCT user_id) AS transacting_students,
        COUNT(DISTINCT vendor_id) AS transacting_vendors,
        COUNTIF(type = 'offer') AS offer_redemptions,
        COUNT(*) AS transactions
      FROM base
    ) AS stats,
    ARRAY(
      SELECT AS STRUCT
        FORMAT_DATE('%b', months.month_start) AS month,
        ROUND(COALESCE(SUM(base.amount), 0), 2) AS amount
      FROM months
      LEFT JOIN base
        ON DATE_TRUNC(DATE(base.created_at, 'Asia/Qatar'), MONTH) =
          months.month_start
      GROUP BY months.month_start
      ORDER BY months.month_start
    ) AS monthly_revenue,
    ARRAY(
      SELECT AS STRUCT
        COALESCE(NULLIF(vendor_name, ''), 'Unknown Vendor') AS name,
        ROUND(SUM(amount), 2) AS sales
      FROM base
      WHERE created_at >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
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
    },
    monthlyRevenue: (row?.monthly_revenue || []).map((item) => ({
      month: item.month || "",
      amount: numberValue(item.amount),
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
  const byteBudget = getMaximumBytesBilled();

  try {
    const [job] = await bigquery.createQueryJob({
      query: DASHBOARD_SQL,
      location: LOCATION,
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
