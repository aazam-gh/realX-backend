import {BigQuery, Job} from "@google-cloud/bigquery";
import {HttpsError, CallableRequest} from "firebase-functions/v2/https";
import * as logger from "firebase-functions/logger";

/* eslint-disable require-jsdoc, max-len */

const PROJECT_ID = "reelx-backend";
const LOCATION = "US";
const VIEW = "`reelx-backend.firestore_export.students_admin_v1`";
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 100;
const DEFAULT_MAXIMUM_BYTES_BILLED = 256 * 1024 * 1024;

const bigquery = new BigQuery({projectId: PROJECT_ID});

const SORTS = {
  name_asc: {
    column: "sort_full_name",
    cursor: "sort_full_name",
    direction: "ASC",
    type: "STRING",
  },
  name_desc: {
    column: "sort_full_name",
    cursor: "sort_full_name",
    direction: "DESC",
    type: "STRING",
  },
  student_id_asc: {
    column: "sort_student_id",
    cursor: "sort_student_id",
    direction: "ASC",
    type: "STRING",
  },
  student_id_desc: {
    column: "sort_student_id",
    cursor: "sort_student_id",
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
  sort?: unknown;
  cursor?: unknown;
}

interface BigQueryValue<T> {
  value?: T;
}

interface AdminStudentRow {
  id: string;
  export_timestamp: BigQueryValue<string> | string | null;
  first_name: string;
  last_name: string;
  full_name: string;
  email: string | null;
  student_id: string | null;
  gender: string | null;
  dob: string | null;
  role: string;
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

function encodeCursor(row: AdminStudentRow): string {
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

export async function listAdminBigQueryStudentsHandler(
  request: CallableRequest<Input>,
) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User not authenticated");
  }

  if (request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required");
  }

  const {pageSize, search, sort, cursor} = parseInput(request.data || {});
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
      LOWER(full_name) LIKE @search OR
      LOWER(COALESCE(email, '')) LIKE @search OR
      LOWER(COALESCE(student_id, '')) LIKE @search
    )`);
    params.search = `%${search}%`;
    types.search = "STRING";
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
        COALESCE(full_name, '') AS sort_full_name,
        COALESCE(student_id, '') AS sort_student_id
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

    const rows = rawRows as AdminStudentRow[];
    const hasNextPage = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);
    const stats = getQueryStats(job);

    const freshnessValue = pageRows.length ?
      scalar(pageRows[0].freshness_timestamp) :
      null;

    const freshness = typeof freshnessValue === "string" ?
      freshnessValue :
      null;

    logger.info("Admin BigQuery students query completed", {
      adminUid: request.auth.uid,
      durationMs: Date.now() - startedAt,
      resultCount: pageRows.length,
      search: search || null,
      sort,
      hasCursor: Boolean(cursor),
      maximumBytesBilled: byteBudget,
      ...stats,
    });

    return {
      students: pageRows.map((row) => ({
        id: row.id,
        firstName: row.first_name || "",
        lastName: row.last_name || "",
        fullName: row.full_name || "",
        email: row.email,
        studentId: row.student_id,
        gender: row.gender,
        dob: row.dob,
        role: row.role || "student",
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

    logger.error("Admin BigQuery students query failed", {
      adminUid: request.auth.uid,
      durationMs: Date.now() - startedAt,
      search: search || null,
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
        "Unable to query BigQuery students",
    );
  }
}
