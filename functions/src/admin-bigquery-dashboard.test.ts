import assert from "node:assert/strict";
import test from "node:test";

import {
  getAdminBigQueryDashboardHandler,
  normalizeAdminBigQueryDashboardRow,
} from "./admin-bigquery-dashboard.js";

test("normalizes BigQuery scalar wrappers and missing values", () => {
  const result = normalizeAdminBigQueryDashboardRow({
    stats: {
      transacting_students: {value: "21"},
      transacting_vendors: "11",
      offer_redemptions: 48,
      transactions: null,
    },
    monthly_revenue: [
      {month: "Jul", amount: {value: "1763.48"}},
    ],
    top_vendors: [
      {name: "Qatar Cinema", sales: "150"},
    ],
    recent_activity: [
      {
        id: "transaction-1",
        student_name: "Student abc123",
        vendor_name: "Qatar Cinema",
        amount: "75",
        created_at: "2026-07-30T17:23:15.000Z",
        status: "completed",
      },
    ],
    freshness: "2026-07-30T17:23:15.000Z",
  });

  assert.deepEqual(result.stats, {
    transactingStudents: 21,
    transactingVendors: 11,
    offerRedemptions: 48,
    transactions: 0,
  });
  assert.equal(result.monthlyRevenue[0].amount, 1763.48);
  assert.equal(result.topVendors[0].sales, 150);
  assert.equal(result.recentActivity[0].amount, 75);
});

test("rejects unauthenticated dashboard requests", async () => {
  await assert.rejects(
    getAdminBigQueryDashboardHandler({data: {}} as never),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "unauthenticated",
  );
});

test("requires the strict admin custom claim", async () => {
  await assert.rejects(
    getAdminBigQueryDashboardHandler({
      data: {},
      auth: {
        uid: "non-admin",
        token: {admin: false},
      },
    } as never),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "permission-denied",
  );
});
