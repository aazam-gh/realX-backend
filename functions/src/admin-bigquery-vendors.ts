import {BigQuery, Job} from "@google-cloud/bigquery";
import {HttpsError, CallableRequest} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

/* eslint-disable require-jsdoc, max-len */

const PROJECT_ID = "reelx-backend";
const LOCATION = "US";
const VIEW = "`reelx-backend.firestore_export.vendors_admin_v1`";
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAXIMUM_BYTES_BILLED = 256 * 1024 * 1024;

const bigquery = new BigQuery({projectId: PROJECT_ID});

const SORTS = {
  name_asc: {
    column: "sort_name",
    cursor: "sort_name",
    direction: "ASC",
    type: "STRING",
  },
  name_desc: {
    column: "sort_name",
    cursor: "sort_name",
    direction: "DESC",
    type: "STRING",
  },
  category_asc: {
    column: "sort_main_category",
    cursor: "sort_main_category",
    direction: "ASC",
    type: "STRING",
  },
  category_desc: {
    column: "sort_main_category",
    cursor: "sort_main_category",
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
  search?: unknown;
  vendorType?: unknown;
  xcard?: unknown;
  sort?: unknown;
  cursor?: unknown;
}

interface BigQueryValue<T> {
  value?: T;
}

interface AdminVendorRow {
  id: string;
  export_timestamp: BigQueryValue<string> | string | null;
  name: string;
  contact: string | null;
  email: string | null;
  profile_picture: string | null;
  vendor_type: string | null;
  xcard: boolean | null;
  main_category: string | null;
  subcategory: string | null;
  is_trending: boolean | null;
  latitude: number | null;
  longitude: number | null;
  lat: number | null;
  lng: number | null;
  raw_data: string | null;
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

  const search = data.search;
  if (
    search !== undefined &&
    (typeof search !== "string" || search.length > 200)
  ) {
    throw new HttpsError("invalid-argument", "search must be a string up to 200 characters");
  }

  const vendorType = data.vendorType;
  if (
    vendorType !== undefined &&
    vendorType !== "all" &&
    vendorType !== "in_store" &&
    vendorType !== "online"
  ) {
    throw new HttpsError("invalid-argument", "Unsupported vendorType");
  }

  const xcard = data.xcard;
  if (
    xcard !== undefined &&
    xcard !== "all" &&
    xcard !== "enabled" &&
    xcard !== "disabled"
  ) {
    throw new HttpsError("invalid-argument", "Unsupported xcard filter");
  }

  const sort = data.sort === undefined ? "name_asc" : data.sort;
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

  return {
    pageSize,
    search: typeof search === "string" ? search.trim().toLowerCase() : "",
    vendorType: typeof vendorType === "string" ? vendorType : "all",
    xcard: typeof xcard === "string" ? xcard : "all",
    sort: sort as SortOption,
    cursor,
  };
}

function scalar(value: BigQueryValue<string> | string | number | null): string | number | null {
  if (value && typeof value === "object" && "value" in value) {
    return (value as BigQueryValue<string>).value ?? null;
  }
  return value as string | number | null;
}

function encodeCursor(row: AdminVendorRow): string {
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

export async function listAdminBigQueryVendorsHandler(
  request: CallableRequest<Input>,
) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User not authenticated");
  }
  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required");
  }

  const {pageSize, search, vendorType, xcard, sort, cursor} =
    parseInput(request.data || {});
  const sortConfig = SORTS[sort];
  const comparison = sortConfig.direction === "ASC" ? ">" : "<";
  const params: Record<string, string | number | boolean> = {
    limit: pageSize + 1,
  };
  const types: Record<string, string> = {
    limit: "INT64",
  };
  const where = [];

  if (search) {
    where.push(`(
      LOWER(name) LIKE @search OR
      LOWER(COALESCE(email, '')) LIKE @search OR
      LOWER(COALESCE(contact, '')) LIKE @search OR
      LOWER(COALESCE(main_category, '')) LIKE @search
    )`);
    params.search = `%${search}%`;
    types.search = "STRING";
  }

  if (vendorType !== "all") {
    where.push("vendor_type = @vendorType");
    params.vendorType = vendorType;
    types.vendorType = "STRING";
  }

  if (xcard !== "all") {
    where.push("xcard = @xcard");
    params.xcard = xcard === "enabled";
    types.xcard = "BOOL";
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
        COALESCE(name, '') AS sort_name,
        COALESCE(main_category, '') AS sort_main_category
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

    const rows = rawRows as AdminVendorRow[];
    const hasNextPage = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    const stats = getQueryStats(job);
    const freshnessValue = pageRows.length ?
      scalar(pageRows[0].freshness_timestamp) :
      null;
    const freshness = typeof freshnessValue === "string" ?
      freshnessValue :
      null;

    logger.info("Admin BigQuery vendors query completed", {
      adminUid: request.auth.uid,
      durationMs: Date.now() - startedAt,
      resultCount: pageRows.length,
      search: search || null,
      vendorType,
      xcard,
      sort,
      hasCursor: Boolean(cursor),
      maximumBytesBilled: byteBudget,
      ...stats,
    });

    return {
      vendors: pageRows.map((row) => ({
        id: row.id,
        name: row.name || "Unnamed Vendor",
        contact: row.contact || row.email || "",
        email: row.email,
        profilePicture: row.profile_picture || "",
        vendorType: row.vendor_type || "in_store",
        xcard: row.xcard === true,
        mainCategory: row.main_category,
        subcategory: row.subcategory,
        isTrending: row.is_trending === true,
        latitude: row.latitude,
        longitude: row.longitude,
        lat: row.lat,
        lng: row.lng,
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

    logger.error("Admin BigQuery vendors query failed", {
      adminUid: request.auth.uid,
      durationMs: Date.now() - startedAt,
      search: search || null,
      vendorType,
      xcard,
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
        "Unable to query BigQuery vendors",
    );
  }
}
