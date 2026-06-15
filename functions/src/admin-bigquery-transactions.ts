import {BigQuery, Job} from "@google-cloud/bigquery";
import {HttpsError, CallableRequest} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

/* eslint-disable require-jsdoc, max-len */

const PROJECT_ID = "reelx-backend";
const LOCATION = "US";
const VIEW = "`reelx-backend.firestore_export.transactions_admin_v1`";
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAXIMUM_BYTES_BILLED = 256 * 1024 * 1024;

const bigquery = new BigQuery({projectId: PROJECT_ID});

const SORTS = {
  date_asc: {
    column: "sort_created_at",
    cursor: "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', sort_created_at)",
    direction: "ASC",
    type: "STRING",
  },
  date_desc: {
    column: "sort_created_at",
    cursor: "FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', sort_created_at)",
    direction: "DESC",
    type: "STRING",
  },
  amount_asc: {
    column: "sort_total_amount",
    cursor: "sort_total_amount",
    direction: "ASC",
    type: "FLOAT64",
  },
  amount_desc: {
    column: "sort_total_amount",
    cursor: "sort_total_amount",
    direction: "DESC",
    type: "FLOAT64",
  },
  vendor_asc: {
    column: "sort_vendor_name",
    cursor: "sort_vendor_name",
    direction: "ASC",
    type: "STRING",
  },
  vendor_desc: {
    column: "sort_vendor_name",
    cursor: "sort_vendor_name",
    direction: "DESC",
    type: "STRING",
  },
} as const;

type SortOption = keyof typeof SORTS;

interface Cursor {
  value: string | number;
  id: string;
}

interface Input {
  pageSize?: unknown;
  vendorName?: unknown;
  sort?: unknown;
  cursor?: unknown;
}

interface BigQueryValue<T> {
  value?: T;
}

interface AdminTransactionRow {
  id: string;
  export_timestamp: BigQueryValue<string> | string | null;
  created_at: BigQueryValue<string> | string | null;
  transaction_id: string | null;
  vendor_name: string;
  total_amount: number | null;
  type: string;
  cashback_amount: number | null;
  creator_cashback_amount: number | null;
  creator_code: string | null;
  creator_code_owner_id: string | null;
  creator_uid: string | null;
  discount_amount: number | null;
  discount_code: string | null;
  discount_type: string | null;
  discount_value: number | null;
  final_amount: number | null;
  purchase_url: string | null;
  offer_id: string | null;
  pin: string | null;
  user_id: string | null;
  vendor_id: string | null;
  redemption_card_amount: number | null;
  remaining_amount: number | null;
  cursor_value: BigQueryValue<string> | string | number;
  freshness_timestamp: BigQueryValue<string> | string | null;
}

function parseInput(data: Input) {
  const pageSize = data.pageSize === undefined ?
    DEFAULT_PAGE_SIZE :
    data.pageSize;
  if (
    typeof pageSize !== "number" ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw new HttpsError("invalid-argument", "pageSize must be an integer from 1 to 100");
  }

  const vendorName = data.vendorName;
  if (
    vendorName !== undefined &&
    (typeof vendorName !== "string" || vendorName.length > 200)
  ) {
    throw new HttpsError("invalid-argument", "vendorName must be a string up to 200 characters");
  }

  const sort = data.sort === undefined ? "date_desc" : data.sort;
  if (typeof sort !== "string" || !(sort in SORTS)) {
    throw new HttpsError("invalid-argument", "Unsupported sort option");
  }

  let cursor: Cursor | undefined;
  if (data.cursor !== undefined) {
    if (typeof data.cursor !== "string" || data.cursor.length > 2048) {
      throw new HttpsError("invalid-argument", "Invalid cursor");
    }
    try {
      const decoded = JSON.parse(Buffer.from(data.cursor, "base64url").toString("utf8")) as Cursor;
      if (
        !decoded ||
        typeof decoded.id !== "string" ||
        (typeof decoded.value !== "string" && typeof decoded.value !== "number")
      ) {
        throw new Error("Malformed cursor");
      }
      cursor = decoded;
    } catch {
      throw new HttpsError("invalid-argument", "Invalid cursor");
    }
  }

  return {pageSize, vendorName, sort: sort as SortOption, cursor};
}

function scalar(value: BigQueryValue<string> | string | number | null): string | number | null {
  if (value && typeof value === "object" && "value" in value) {
    return (value as BigQueryValue<string>).value ?? null;
  }
  return value as string | number | null;
}

function encodeCursor(row: AdminTransactionRow): string {
  return Buffer.from(JSON.stringify({
    value: scalar(row.cursor_value),
    id: row.id,
  })).toString("base64url");
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
  const configured = Number(process.env.ADMIN_BIGQUERY_MAX_BYTES_BILLED);
  return Number.isSafeInteger(configured) && configured > 0 ?
    configured :
    DEFAULT_MAXIMUM_BYTES_BILLED;
}

export async function listAdminBigQueryTransactionsHandler(
  request: CallableRequest<Input>,
) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User not authenticated");
  }
  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required");
  }

  const {pageSize, vendorName, sort, cursor} = parseInput(request.data || {});
  const sortConfig = SORTS[sort];
  const comparison = sortConfig.direction === "ASC" ? ">" : "<";
  const params: Record<string, string | number> = {
    limit: pageSize + 1,
  };
  const types: Record<string, string> = {
    limit: "INT64",
  };
  const where = [];

  if (vendorName) {
    where.push("vendor_name = @vendorName");
    params.vendorName = vendorName;
    types.vendorName = "STRING";
  }
  if (cursor) {
    where.push(
      `(${sortConfig.cursor} ${comparison} @cursorValue OR ` +
      `(${sortConfig.cursor} = @cursorValue AND id ${comparison} @cursorId))`,
    );
    params.cursorValue = cursor.value;
    params.cursorId = cursor.id;
    types.cursorValue = sortConfig.type;
    types.cursorId = "STRING";
  }

  const sql = `
    SELECT
      *,
      ${sortConfig.cursor} AS cursor_value
    FROM (
      SELECT
        *,
        MAX(export_timestamp) OVER () AS freshness_timestamp,
        COALESCE(created_at, TIMESTAMP('1970-01-01')) AS sort_created_at,
        COALESCE(total_amount, 0) AS sort_total_amount,
        COALESCE(vendor_name, '') AS sort_vendor_name
      FROM ${VIEW}
    )
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY ${sortConfig.column} ${sortConfig.direction}, id ${sortConfig.direction}
    LIMIT @limit
  `;

  const startedAt = Date.now();
  const byteBudget = getMaximumBytesBilled();
  try {
    const [job] = await bigquery.createQueryJob({
      query: sql,
      params,
      types,
      location: LOCATION,
      maximumBytesBilled: byteBudget.toString(),
      useLegacySql: false,
    });
    const [rawRows] = await job.getQueryResults();
    await job.getMetadata();
    const rows = rawRows as AdminTransactionRow[];
    const hasNextPage = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    const stats = getQueryStats(job);
    const freshnessValue = pageRows.length ?
      scalar(pageRows[0].freshness_timestamp) :
      null;
    const freshness = typeof freshnessValue === "string" ?
      freshnessValue :
      null;

    logger.info("Admin BigQuery transactions query completed", {
      adminUid: request.auth.uid,
      durationMs: Date.now() - startedAt,
      resultCount: pageRows.length,
      vendorName: vendorName || null,
      sort,
      hasCursor: Boolean(cursor),
      maximumBytesBilled: byteBudget,
      ...stats,
    });

    return {
      transactions: pageRows.map((row) => ({
        id: row.id,
        rawDate: scalar(row.created_at),
        transactionId: row.transaction_id || row.id,
        vendorName: row.vendor_name || "Unknown Vendor",
        totalAmountNum: row.total_amount || 0,
        type: row.type || "N/A",
        cashbackAmount: row.cashback_amount,
        creatorCashbackAmount: row.creator_cashback_amount,
        creatorCode: row.creator_code,
        creatorCodeOwnerId: row.creator_code_owner_id,
        creatorUid: row.creator_uid,
        discountAmount: row.discount_amount,
        discountCode: row.discount_code,
        discountType: row.discount_type,
        discountValue: row.discount_value,
        finalAmount: row.final_amount,
        purchaseUrl: row.purchase_url,
        offerId: row.offer_id,
        pin: row.pin,
        userId: row.user_id,
        vendorId: row.vendor_id,
        redemptionCardAmount: row.redemption_card_amount,
        remainingAmount: row.remaining_amount,
      })),
      nextCursor: hasNextPage && pageRows.length ?
        encodeCursor(pageRows[pageRows.length - 1]) :
        null,
      query: {
        durationMs: Date.now() - startedAt,
        ...stats,
      },
      freshness,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const rejectedByByteBudget =
      /maximum bytes billed|bytes billed limit|limit for bytes billed|bytesBilledLimitExceeded/i
        .test(message);
    logger.error("Admin BigQuery transactions query failed", {
      adminUid: request.auth.uid,
      durationMs: Date.now() - startedAt,
      vendorName: vendorName || null,
      sort,
      hasCursor: Boolean(cursor),
      maximumBytesBilled: byteBudget,
      rejectedByByteBudget,
      error,
    });
    throw new HttpsError(
      rejectedByByteBudget ? "resource-exhausted" : "internal",
      rejectedByByteBudget ?
        "Query exceeded the configured BigQuery byte budget" :
        "Unable to query BigQuery transactions",
    );
  }
}
