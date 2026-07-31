import type {Auth} from "firebase-admin/auth";
import {
  FieldPath,
  FieldValue,
  Timestamp,
} from "firebase-admin/firestore";
import type {
  DocumentSnapshot,
  Firestore,
  Query,
} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
  CallableRequest,
  HttpsError,
  onCall,
} from "firebase-functions/v2/https";

import {
  parseOptionalString,
  parseRequiredString,
  requireAdmin,
  requireAuthUid,
} from "./callable-security.js";

/* eslint-disable require-jsdoc, max-len */

const REGION = "me-central1";
const HOLDING_GROUP_MAX_VENDORS = 30;
const HOLDING_TRANSACTION_MAX_PAGE_SIZE = 100;

interface HoldingGroup {
  name: string;
  status: "active" | "disabled";
  vendorIds: string[];
}

interface HoldingGroupUser {
  groupId: string;
  email: string;
  displayName: string;
  role: "owner" | "viewer";
  status: "active" | "disabled";
}

interface HoldingTransactionCursor {
  createdAtMillis: number;
  id: string;
}

function parseHoldingVendorIds(value: unknown) {
  if (!Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "vendorIds must be an array");
  }
  const vendorIds = value.map((vendorId) => {
    if (typeof vendorId !== "string" || !vendorId.trim()) {
      throw new HttpsError(
        "invalid-argument",
        "vendorIds must contain only non-empty strings",
      );
    }
    return vendorId.trim();
  });
  const uniqueVendorIds = [...new Set(vendorIds)];
  if (uniqueVendorIds.length !== vendorIds.length) {
    throw new HttpsError(
      "invalid-argument",
      "vendorIds cannot contain duplicates",
    );
  }
  if (uniqueVendorIds.length > HOLDING_GROUP_MAX_VENDORS) {
    throw new HttpsError(
      "invalid-argument",
      `A holding group can include at most ${HOLDING_GROUP_MAX_VENDORS} vendors`,
    );
  }
  return uniqueVendorIds;
}

async function assertVendorsExist(db: Firestore, vendorIds: string[]) {
  if (!vendorIds.length) return;
  const snapshots = await Promise.all(
    vendorIds.map((vendorId) => db.collection("vendors").doc(vendorId).get()),
  );
  const missing = snapshots
    .filter((snapshot) => !snapshot.exists)
    .map((snapshot) => snapshot.id);
  if (missing.length) {
    throw new HttpsError(
      "not-found",
      `Vendor not found: ${missing.join(", ")}`,
    );
  }
}

async function getActiveHoldingAccess(db: Firestore, uid: string) {
  const userSnap = await db.collection("holdingGroupUsers").doc(uid).get();
  if (!userSnap.exists) {
    throw new HttpsError("permission-denied", "Holding account required");
  }
  const user = userSnap.data() as HoldingGroupUser;
  if (user.status !== "active") {
    throw new HttpsError("permission-denied", "Holding account is disabled");
  }
  const groupSnap = await db.collection("holdingGroups").doc(user.groupId).get();
  if (!groupSnap.exists) {
    throw new HttpsError("failed-precondition", "Holding group not found");
  }
  const group = groupSnap.data() as HoldingGroup;
  if (group.status !== "active") {
    throw new HttpsError("permission-denied", "Holding group is disabled");
  }
  const vendorIds = Array.isArray(group.vendorIds) ? group.vendorIds : [];
  return {
    uid,
    groupId: user.groupId,
    user,
    group,
    vendorIds,
  };
}

function timestampToMillis(value: unknown) {
  if (value instanceof Timestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return 0;
}

function timestampToIso(value: unknown) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

function encodeHoldingCursor(cursor: HoldingTransactionCursor) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeHoldingCursor(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 2048) {
    throw new HttpsError("invalid-argument", "Invalid cursor");
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as HoldingTransactionCursor;
    if (
      !decoded ||
      !Number.isSafeInteger(decoded.createdAtMillis) ||
      typeof decoded.id !== "string"
    ) {
      throw new Error("Malformed cursor");
    }
    return decoded;
  } catch {
    throw new HttpsError("invalid-argument", "Invalid cursor");
  }
}

function mapTransactionSnapshot(snapshot: DocumentSnapshot) {
  const data = snapshot.data() || {};
  return {
    id: snapshot.id,
    vendorId: data.vendorId || null,
    vendorName: data.vendorName || "Unknown Vendor",
    userId: data.userId || null,
    type: data.type || "N/A",
    status: data.status || "N/A",
    totalAmount: Number(data.totalAmount || 0),
    discountAmount: Number(data.discountAmount || 0),
    discountType: data.discountType || null,
    discountValue: data.discountValue ?? null,
    finalAmount: Number(data.finalAmount || 0),
    createdAt: timestampToIso(data.createdAt),
    createdAtMillis: timestampToMillis(data.createdAt),
    pin: data.pin || null,
    offerId: data.offerId || null,
    cashbackAmount: data.cashbackAmount ?? null,
    creatorCashbackAmount: data.creatorCashbackAmount ?? null,
    creatorCode: data.creatorCode ?? null,
    creatorCodeOwnerId: data.creatorCodeOwnerId ?? null,
    creatorUid: data.creatorUid ?? null,
    redemptionCardAmount: data.redemptionCardAmount ?? null,
    remainingAmount: data.remainingAmount ?? null,
  };
}

async function getHoldingVendorSummaries(
  db: Firestore,
  vendorIds: string[],
) {
  if (!vendorIds.length) return [];
  const snapshots = await Promise.all(
    vendorIds.map((vendorId) => db.collection("vendors").doc(vendorId).get()),
  );
  return snapshots
    .filter((snapshot) => snapshot.exists)
    .map((snapshot) => {
      const data = snapshot.data() || {};
      return {
        id: snapshot.id,
        name: data.name || "Unnamed Vendor",
        nameAr: data.nameAr || null,
        email: data.email || null,
        status: data.status || null,
        vendorType: data.vendorType || null,
        profilePicture: data.profilePicture || data.logo || data.logoUrl || null,
        activeOffers: Array.isArray(data.offers) ? data.offers.length : 0,
      };
    });
}

export function createHoldingFunctions(db: Firestore, auth: Auth) {
  const listHoldingGroups = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      requireAdmin(request);
      const [groupsSnap, usersSnap] = await Promise.all([
        db.collection("holdingGroups").orderBy("name", "asc").get(),
        db.collection("holdingGroupUsers").get(),
      ]);
      const usersByGroup = new Map<string, unknown[]>();
      usersSnap.docs.forEach((docSnap) => {
        const data = docSnap.data();
        const groupId = data.groupId;
        if (typeof groupId !== "string") return;
        const users = usersByGroup.get(groupId) || [];
        users.push({
          uid: docSnap.id,
          email: data.email || "",
          displayName: data.displayName || "",
          role: data.role || "viewer",
          status: data.status || "disabled",
        });
        usersByGroup.set(groupId, users);
      });
      const groups = groupsSnap.docs.map((docSnap) => {
        const data = docSnap.data();
        const vendorIds = Array.isArray(data.vendorIds) ? data.vendorIds : [];
        return {
          id: docSnap.id,
          name: data.name || "Unnamed Group",
          status: data.status || "disabled",
          vendorIds,
          users: usersByGroup.get(docSnap.id) || [],
          createdAt: timestampToIso(data.createdAt),
          updatedAt: timestampToIso(data.updatedAt),
        };
      });
      return {groups};
    },
  );

  const createHoldingGroup = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const adminUid = requireAdmin(request);
      const name = parseRequiredString(request.data?.name, "name");
      const vendorIds = parseHoldingVendorIds(request.data?.vendorIds || []);
      await assertVendorsExist(db, vendorIds);

      const groupRef = db.collection("holdingGroups").doc();
      await groupRef.set({
        name,
        status: "active",
        vendorIds,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: adminUid,
        updatedBy: adminUid,
      });
      logger.info("Holding group created", {
        groupId: groupRef.id,
        vendorCount: vendorIds.length,
        adminUid,
      });
      return {groupId: groupRef.id, success: true};
    },
  );

  const updateHoldingGroup = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const adminUid = requireAdmin(request);
      const groupId = parseRequiredString(request.data?.groupId, "groupId");
      const name = parseOptionalString(request.data?.name, "name");
      const status = request.data?.status;
      const update: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: adminUid,
      };

      if (name !== undefined) update.name = name;
      if (status !== undefined) {
        if (status !== "active" && status !== "disabled") {
          throw new HttpsError(
            "invalid-argument",
            "status must be active or disabled",
          );
        }
        update.status = status;
      }
      if (request.data?.vendorIds !== undefined) {
        const vendorIds = parseHoldingVendorIds(request.data.vendorIds);
        await assertVendorsExist(db, vendorIds);
        update.vendorIds = vendorIds;
      }

      const groupRef = db.collection("holdingGroups").doc(groupId);
      const groupSnap = await groupRef.get();
      if (!groupSnap.exists) {
        throw new HttpsError("not-found", "Holding group not found");
      }
      await groupRef.update(update);
      logger.info("Holding group updated", {groupId, adminUid});
      return {success: true};
    },
  );

  const createHoldingGroupUser = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const adminUid = requireAdmin(request);
      const groupId = parseRequiredString(request.data?.groupId, "groupId");
      const email = parseRequiredString(request.data?.email, "email");
      const password = parseRequiredString(request.data?.password, "password");
      const displayName = parseRequiredString(
        request.data?.displayName,
        "displayName",
      );
      const role = request.data?.role || "viewer";
      if (role !== "owner" && role !== "viewer") {
        throw new HttpsError(
          "invalid-argument",
          "role must be owner or viewer",
        );
      }

      const groupSnap = await db.collection("holdingGroups").doc(groupId).get();
      if (!groupSnap.exists) {
        throw new HttpsError("not-found", "Holding group not found");
      }

      const user = await auth.createUser({
        email,
        password,
        displayName,
        emailVerified: true,
      });
      await auth.setCustomUserClaims(user.uid, {
        accountType: "holding_group",
      });
      await db.collection("holdingGroupUsers").doc(user.uid).set({
        groupId,
        email,
        displayName,
        role,
        status: "active",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        createdBy: adminUid,
        updatedBy: adminUid,
      });
      logger.info("Holding group user created", {
        uid: user.uid,
        groupId,
        adminUid,
      });
      return {uid: user.uid, success: true};
    },
  );

  const disableHoldingGroupUser = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const adminUid = requireAdmin(request);
      const uid = parseRequiredString(request.data?.uid, "uid");
      const userRef = db.collection("holdingGroupUsers").doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) {
        throw new HttpsError("not-found", "Holding user not found");
      }
      await Promise.all([
        userRef.update({
          status: "disabled",
          updatedAt: FieldValue.serverTimestamp(),
          updatedBy: adminUid,
        }),
        auth.updateUser(uid, {disabled: true}),
      ]);
      logger.info("Holding group user disabled", {uid, adminUid});
      return {success: true};
    },
  );

  const deleteHoldingGroupUser = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const adminUid = requireAdmin(request);
      const uid = parseRequiredString(request.data?.uid, "uid");
      await Promise.allSettled([
        auth.deleteUser(uid),
        db.collection("holdingGroupUsers").doc(uid).delete(),
      ]);
      logger.info("Holding group user deleted", {uid, adminUid});
      return {success: true};
    },
  );

  const getMyHoldingProfile = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const uid = requireAuthUid(request);
      const access = await getActiveHoldingAccess(db, uid);
      const vendors = await getHoldingVendorSummaries(db, access.vendorIds);
      return {
        uid,
        groupId: access.groupId,
        groupName: access.group.name,
        role: access.user.role,
        status: access.user.status,
        vendorIds: access.vendorIds,
        vendors,
      };
    },
  );

  const getHoldingDashboard = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const uid = requireAuthUid(request);
      const access = await getActiveHoldingAccess(db, uid);
      const range = request.data?.range || "7d";
      if (range !== "7d" && range !== "30d" && range !== "90d") {
        throw new HttpsError("invalid-argument", "Unsupported range");
      }
      const vendorIds = access.vendorIds;
      const vendors = await getHoldingVendorSummaries(db, vendorIds);
      const rangeDays = range === "7d" ? 7 : range === "30d" ? 30 : 90;
      const startDate = new Date();
      startDate.setHours(0, 0, 0, 0);
      startDate.setDate(startDate.getDate() - (rangeDays - 1));
      const daily: Record<string, {
        date: string;
        redemptions: number;
        revenue: number;
      }> = {};
      for (let i = rangeDays - 1; i >= 0; i--) {
        const day = new Date();
        day.setHours(0, 0, 0, 0);
        day.setDate(day.getDate() - i);
        const key = day.toISOString().split("T")[0];
        daily[key] = {date: key, redemptions: 0, revenue: 0};
      }
      const totals = {
        totalRevenue: 0,
        totalRedemptions: 0,
        totalDiscount: 0,
        pendingTransactions: 0,
        activeOffers: vendors.reduce(
          (sum, vendor) => sum + vendor.activeOffers,
          0,
        ),
      };
      const breakdown = new Map(vendors.map((vendor) => [vendor.id, {
        vendorId: vendor.id,
        vendorName: vendor.name,
        totalRevenue: 0,
        totalRedemptions: 0,
        totalDiscount: 0,
        pendingTransactions: 0,
        activeOffers: vendor.activeOffers,
      }]));

      if (vendorIds.length) {
        const snapshot = await db.collection("transactions")
          .where("vendorId", "in", vendorIds)
          .get();
        snapshot.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const vendorId = data.vendorId;
          const vendorStats = breakdown.get(vendorId);
          if (!vendorStats) return;
          if (data.status === "pending") {
            totals.pendingTransactions += 1;
            vendorStats.pendingTransactions += 1;
          }
          if (data.status !== "completed") return;
          const finalAmount = Number(data.finalAmount || 0);
          const discountAmount = Number(data.discountAmount || 0);
          totals.totalRevenue += finalAmount;
          totals.totalDiscount += discountAmount;
          totals.totalRedemptions += 1;
          vendorStats.totalRevenue += finalAmount;
          vendorStats.totalDiscount += discountAmount;
          vendorStats.totalRedemptions += 1;
          const createdAt = data.createdAt;
          if (createdAt instanceof Timestamp && createdAt.toDate() >= startDate) {
            const key = createdAt.toDate().toISOString().split("T")[0];
            if (daily[key]) {
              daily[key].redemptions += 1;
              daily[key].revenue += finalAmount;
            }
          }
        });
      }

      return {
        groupId: access.groupId,
        groupName: access.group.name,
        totals,
        chartData: Object.values(daily),
        vendors: Array.from(breakdown.values()),
      };
    },
  );

  const listHoldingTransactions = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const uid = requireAuthUid(request);
      const access = await getActiveHoldingAccess(db, uid);
      const pageSizeInput = request.data?.pageSize ?? 50;
      if (
        typeof pageSizeInput !== "number" ||
        !Number.isInteger(pageSizeInput) ||
        pageSizeInput < 1 ||
        pageSizeInput > HOLDING_TRANSACTION_MAX_PAGE_SIZE
      ) {
        throw new HttpsError(
          "invalid-argument",
          `pageSize must be from 1 to ${HOLDING_TRANSACTION_MAX_PAGE_SIZE}`,
        );
      }
      const vendorId = parseOptionalString(request.data?.vendorId, "vendorId");
      const cursor = decodeHoldingCursor(request.data?.cursor);
      let vendorIds = access.vendorIds;
      if (vendorId) {
        if (!vendorIds.includes(vendorId)) {
          throw new HttpsError("permission-denied", "Vendor is not assigned");
        }
        vendorIds = [vendorId];
      }
      if (!vendorIds.length) {
        return {transactions: [], nextCursor: null};
      }

      let txQuery: Query = db.collection("transactions")
        .where("vendorId", "in", vendorIds)
        .orderBy("createdAt", "desc")
        .orderBy(FieldPath.documentId(), "desc");
      if (cursor) {
        txQuery = txQuery.startAfter(
          Timestamp.fromMillis(cursor.createdAtMillis),
          cursor.id,
        );
      }
      const snapshot = await txQuery.limit(pageSizeInput + 1).get();
      const pageDocs = snapshot.docs.slice(0, pageSizeInput);
      const transactions = pageDocs.map(mapTransactionSnapshot);
      const nextDoc = snapshot.docs.length > pageSizeInput ?
        snapshot.docs[pageSizeInput - 1] :
        null;
      const nextCursor = nextDoc ? encodeHoldingCursor({
        createdAtMillis: timestampToMillis(nextDoc.data().createdAt),
        id: nextDoc.id,
      }) : null;
      return {transactions, nextCursor};
    },
  );

  const getHoldingTransaction = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const uid = requireAuthUid(request);
      const access = await getActiveHoldingAccess(db, uid);
      const transactionId = parseRequiredString(
        request.data?.transactionId,
        "transactionId",
      );
      const snapshot = await db.collection("transactions").doc(transactionId)
        .get();
      if (!snapshot.exists) {
        throw new HttpsError("not-found", "Transaction not found");
      }
      const data = snapshot.data() || {};
      if (!access.vendorIds.includes(data.vendorId)) {
        throw new HttpsError(
          "permission-denied",
          "Transaction is not assigned",
        );
      }
      return {transaction: mapTransactionSnapshot(snapshot)};
    },
  );

  return {
    createHoldingGroup,
    createHoldingGroupUser,
    deleteHoldingGroupUser,
    disableHoldingGroupUser,
    getHoldingDashboard,
    getHoldingTransaction,
    getMyHoldingProfile,
    listHoldingGroups,
    listHoldingTransactions,
    updateHoldingGroup,
  };
}
