/* eslint-disable max-len */
import {createHash} from "crypto";
import * as admin from "firebase-admin";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {CallableRequest, HttpsError, onCall} from "firebase-functions/v2/https";
import {
  BADRGO_PILOT_CAMPAIGN_ID,
  BADRGO_PILOT_PUBLIC_LIMIT,
  BADRGO_PILOT_RESERVED_LIMIT,
  BADRGO_PILOT_TOTAL_CODES,
  getEffectivePilotCampaignStatus,
  getPilotCodeDocumentId,
  normalizePilotCodes,
  PilotCampaignStatus,
} from "./pilotCampaignSecurity.js";

const REGION = "me-central1";
const BRAND_NAME = "Badrgo";
const DEFAULT_TITLE = "Your next ride is on us";
const DEFAULT_TITLE_AR = "مشوارك القادم علينا";
const DEFAULT_DESCRIPTION =
  "The first 80 eligible realX users can claim one complimentary ride code.";
const DEFAULT_DESCRIPTION_AR =
  "أول ٨٠ مستخدمًا مؤهلًا في realX يمكنهم الحصول على رمز رحلة مجانية واحدة.";

type CampaignPool = "public" | "reserved";

type CampaignCopy = {
  title: string;
  titleAr: string;
  description: string;
  descriptionAr: string;
  instructions: string;
  instructionsAr: string;
  destinationUrl: string;
};

const textValue = (value: unknown, fallback = "", maxLength = 500) => {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength) || fallback;
};

const requireHttpsUrl = (value: unknown) => {
  const candidate = textValue(value, "", 500);
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:") throw new Error("Not HTTPS");
    return parsed.toString();
  } catch {
    throw new HttpsError("invalid-argument", "Destination URL must use HTTPS");
  }
};

const optionalTimestamp = (value: unknown, fieldName: string) => {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new HttpsError("invalid-argument", `${fieldName} must be a valid date`);
  }
  return admin.firestore.Timestamp.fromDate(date);
};

const timestampIso = (value: unknown) => {
  if (value && typeof (value as { toDate?: unknown }).toDate === "function") {
    return (value as admin.firestore.Timestamp).toDate().toISOString();
  }
  return null;
};

const isExpoPushToken = (token: unknown): token is string =>
  typeof token === "string" &&
  (token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken["));

const identityDocumentId = (campaignId: string, uid: string, email?: string | null) => {
  const identity = email?.trim().toLowerCase() || `uid:${uid}`;
  return createHash("sha256").update(`${campaignId}:${identity}`).digest("hex");
};

const campaignCopyFromData = (data: admin.firestore.DocumentData): CampaignCopy => ({
  title: textValue(data.title, DEFAULT_TITLE, 120),
  titleAr: textValue(data.titleAr, DEFAULT_TITLE_AR, 120),
  description: textValue(data.description, DEFAULT_DESCRIPTION, 500),
  descriptionAr: textValue(data.descriptionAr, DEFAULT_DESCRIPTION_AR, 500),
  instructions: textValue(data.instructions, "", 800),
  instructionsAr: textValue(data.instructionsAr, "", 800),
  destinationUrl: textValue(data.destinationUrl, "", 500),
});

export const createPilotCampaignFunctions = (db: admin.firestore.Firestore) => {
  const campaignRef = db.collection("pilotCampaigns").doc(BADRGO_PILOT_CAMPAIGN_ID);

  const assertAdmin = async (request: CallableRequest) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Login required");
    }
    if (request.auth.token.admin === true) return request.auth.uid;

    const studentDoc = await db.collection("students").doc(request.auth.uid).get();
    if (!studentDoc.exists || studentDoc.data()?.admin !== true) {
      throw new HttpsError("permission-denied", "Admin access required");
    }
    return request.auth.uid;
  };

  const readClaimResult = async (
    claimData: admin.firestore.DocumentData,
    codeRef: admin.firestore.DocumentReference
  ) => {
    const codeDoc = await codeRef.get();
    if (!codeDoc.exists || typeof codeDoc.data()?.code !== "string") {
      throw new HttpsError("internal", "Assigned coupon could not be recovered");
    }
    return {
      code: codeDoc.data()?.code as string,
      pool: claimData.pool as CampaignPool,
      claimedAt: timestampIso(claimData.claimedAt),
    };
  };

  const assignCoupon = async ({
    uid,
    email,
    pool,
    assignedBy,
  }: {
    uid: string;
    email?: string | null;
    pool: CampaignPool;
    assignedBy?: string;
  }) => {
    const studentRef = db.collection("students").doc(uid);
    const claimRef = campaignRef.collection("claims").doc(uid);

    const transactionResult = await db.runTransaction(async (tx) => {
      // The student profile is the canonical verified identity. Do not trust a
      // caller-supplied email (or a stale auth-token email) for one-per-user
      // enforcement.
      const studentDoc = await tx.get(studentRef);
      if (!studentDoc.exists) {
        throw new HttpsError("not-found", "Student profile not found");
      }

      const studentData = studentDoc.data() || {};
      const canonicalEmail = typeof studentData.email === "string" ?
        studentData.email.trim().toLowerCase() : email?.trim().toLowerCase() || null;
      const identityRef = db.collection("pilotCampaignIdentityClaims").doc(
        identityDocumentId(BADRGO_PILOT_CAMPAIGN_ID, uid, canonicalEmail)
      );
      const [campaignDoc, claimDoc, identityDoc] = await Promise.all([
        tx.get(campaignRef),
        tx.get(claimRef),
        tx.get(identityRef),
      ]);

      if (!campaignDoc.exists) {
        throw new HttpsError("failed-precondition", "Campaign is not configured");
      }
      if (studentData.redemptionDisabled === true || studentData.accountType === "browse_only") {
        throw new HttpsError("permission-denied", "This account cannot claim coupons");
      }

      if (claimDoc.exists) {
        const claimData = claimDoc.data() || {};
        return {
          existing: true,
          claimData,
          codeRef: campaignRef.collection("codes").doc(claimData.codeDocumentId),
        };
      }
      if (identityDoc.exists) {
        throw new HttpsError("already-exists", "This verified identity already has a coupon");
      }

      const campaignData = campaignDoc.data() || {};
      const status = getEffectivePilotCampaignStatus({
        status: (campaignData.status || "draft") as PilotCampaignStatus,
        startsAtMs: campaignData.startsAt?.toMillis?.(),
        endsAtMs: campaignData.endsAt?.toMillis?.(),
        publicAssignedCount: Number(campaignData.publicAssignedCount || 0),
      });
      if (pool === "public" && status !== "active") {
        const message = status === "sold_out" ? "All public coupons have been claimed" :
          "This campaign is not accepting claims";
        throw new HttpsError("failed-precondition", message);
      }
      if (pool === "reserved" && campaignData.status === "ended") {
        throw new HttpsError("failed-precondition", "This campaign has ended");
      }

      const assignedField = pool === "public" ?
        "publicAssignedCount" : "reservedAssignedCount";
      const nextField = pool === "public" ?
        "nextPublicSequence" : "nextReservedSequence";
      const limit = pool === "public" ?
        BADRGO_PILOT_PUBLIC_LIMIT : BADRGO_PILOT_TOTAL_CODES;
      const assignedCount = Number(campaignData[assignedField] || 0);
      const nextSequence = Number(
        campaignData[nextField] ??
        (pool === "public" ? 0 : BADRGO_PILOT_PUBLIC_LIMIT)
      );

      if (assignedCount >= (pool === "public" ? BADRGO_PILOT_PUBLIC_LIMIT : BADRGO_PILOT_RESERVED_LIMIT) ||
          nextSequence >= limit) {
        throw new HttpsError("resource-exhausted", `No ${pool} coupons remain`);
      }

      const codeRef = campaignRef.collection("codes").doc(
        getPilotCodeDocumentId(nextSequence)
      );
      const codeDoc = await tx.get(codeRef);
      const codeData = codeDoc.data() || {};
      if (!codeDoc.exists || codeData.status !== "available" || codeData.pool !== pool) {
        throw new HttpsError("internal", "Coupon inventory is inconsistent");
      }

      const claimedAt = admin.firestore.Timestamp.now();
      tx.update(codeRef, {
        status: "assigned",
        assignedToUid: uid,
        assignedAt: claimedAt,
        assignedBy: assignedBy || uid,
      });
      tx.create(claimRef, {
        campaignId: BADRGO_PILOT_CAMPAIGN_ID,
        userId: uid,
        userEmail: canonicalEmail,
        codeDocumentId: codeRef.id,
        pool,
        status: "assigned",
        claimedAt,
        assignedBy: assignedBy || uid,
      });
      tx.create(identityRef, {
        campaignId: BADRGO_PILOT_CAMPAIGN_ID,
        userId: uid,
        claimPath: claimRef.path,
        createdAt: claimedAt,
      });
      tx.update(campaignRef, {
        [assignedField]: assignedCount + 1,
        [nextField]: nextSequence + 1,
        updatedAt: claimedAt,
      });

      return {
        existing: false,
        claimData: {pool, claimedAt},
        codeRef,
      };
    });

    const claim = await readClaimResult(
      transactionResult.claimData,
      transactionResult.codeRef
    );
    return {...claim, existing: transactionResult.existing};
  };

  const getBadrgoPilotCampaign = onCall(
    {region: REGION, enforceAppCheck: true},
    async (request: CallableRequest) => {
      const campaignDoc = await campaignRef.get();
      if (!campaignDoc.exists) return {exists: false, status: "unavailable"};

      const data = campaignDoc.data() || {};
      const copy = campaignCopyFromData(data);
      const publicAssignedCount = Number(data.publicAssignedCount || 0);
      const effectiveStatus = getEffectivePilotCampaignStatus({
        status: (data.status || "draft") as PilotCampaignStatus,
        startsAtMs: data.startsAt?.toMillis?.(),
        endsAtMs: data.endsAt?.toMillis?.(),
        publicAssignedCount,
      });

      let claim = null;
      if (request.auth) {
        const claimDoc = await campaignRef.collection("claims").doc(request.auth.uid).get();
        if (claimDoc.exists) {
          const claimData = claimDoc.data() || {};
          claim = await readClaimResult(
            claimData,
            campaignRef.collection("codes").doc(claimData.codeDocumentId)
          );
        }
      }

      const publiclyVisible = effectiveStatus === "active" ||
        effectiveStatus === "scheduled" || effectiveStatus === "sold_out" || !!claim;
      if (!publiclyVisible) {
        return {exists: true, status: "unavailable", claim};
      }

      return {
        exists: true,
        campaignId: BADRGO_PILOT_CAMPAIGN_ID,
        brandName: BRAND_NAME,
        status: effectiveStatus,
        publicLimit: BADRGO_PILOT_PUBLIC_LIMIT,
        publicAssignedCount,
        remaining: Math.max(0, BADRGO_PILOT_PUBLIC_LIMIT - publicAssignedCount),
        startsAt: timestampIso(data.startsAt),
        endsAt: timestampIso(data.endsAt),
        ...copy,
        claim,
      };
    }
  );

  const claimBadrgoPilotCoupon = onCall(
    {region: REGION, enforceAppCheck: true},
    async (request: CallableRequest) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
      const result = await assignCoupon({
        uid: request.auth.uid,
        email: typeof request.auth.token.email === "string" ? request.auth.token.email : null,
        pool: "public",
      });
      console.info("Badrgo pilot coupon claim completed", {
        uid: request.auth.uid,
        pool: result.pool,
        existing: result.existing,
      });
      return result;
    }
  );

  const configureBadrgoPilotCampaign = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const adminUid = await assertAdmin(request);
      let codes: string[];
      try {
        codes = normalizePilotCodes(request.data?.codes);
      } catch (error) {
        throw new HttpsError(
          "invalid-argument",
          error instanceof Error ? error.message : "Invalid coupon codes"
        );
      }

      const startsAt = optionalTimestamp(request.data?.startsAt, "Start time");
      const endsAt = optionalTimestamp(request.data?.endsAt, "End time");
      if (startsAt && endsAt && startsAt.toMillis() >= endsAt.toMillis()) {
        throw new HttpsError("invalid-argument", "End time must be after start time");
      }
      const copy: CampaignCopy = {
        title: textValue(request.data?.title, DEFAULT_TITLE, 120),
        titleAr: textValue(request.data?.titleAr, DEFAULT_TITLE_AR, 120),
        description: textValue(request.data?.description, DEFAULT_DESCRIPTION, 500),
        descriptionAr: textValue(request.data?.descriptionAr, DEFAULT_DESCRIPTION_AR, 500),
        instructions: textValue(request.data?.instructions, "", 800),
        instructionsAr: textValue(request.data?.instructionsAr, "", 800),
        destinationUrl: requireHttpsUrl(request.data?.destinationUrl),
      };

      await db.runTransaction(async (tx) => {
        const existing = await tx.get(campaignRef);
        const existingData = existing.data() || {};
        if (Number(existingData.publicAssignedCount || 0) > 0 ||
            Number(existingData.reservedAssignedCount || 0) > 0) {
          throw new HttpsError(
            "failed-precondition",
            "A campaign with assigned coupons cannot be reconfigured"
          );
        }

        const now = admin.firestore.Timestamp.now();
        tx.set(campaignRef, {
          campaignId: BADRGO_PILOT_CAMPAIGN_ID,
          brandName: BRAND_NAME,
          status: "draft",
          uiApproved: false,
          totalCodes: BADRGO_PILOT_TOTAL_CODES,
          publicLimit: BADRGO_PILOT_PUBLIC_LIMIT,
          reservedLimit: BADRGO_PILOT_RESERVED_LIMIT,
          publicAssignedCount: 0,
          reservedAssignedCount: 0,
          nextPublicSequence: 0,
          nextReservedSequence: BADRGO_PILOT_PUBLIC_LIMIT,
          startsAt,
          endsAt,
          ...copy,
          configuredBy: adminUid,
          configuredAt: now,
          updatedAt: now,
        }, {merge: false});

        codes.forEach((code, sequence) => {
          tx.set(
            campaignRef.collection("codes").doc(getPilotCodeDocumentId(sequence)),
            {
              sequence,
              pool: sequence < BADRGO_PILOT_PUBLIC_LIMIT ? "public" : "reserved",
              code,
              status: "available",
              configuredAt: now,
            },
            {merge: false}
          );
        });
      });

      return {
        success: true,
        campaignId: BADRGO_PILOT_CAMPAIGN_ID,
        status: "draft",
        totalCodes: codes.length,
      };
    }
  );

  const setBadrgoPilotCampaignStatus = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const adminUid = await assertAdmin(request);
      const requestedStatus = request.data?.status as PilotCampaignStatus;
      if (!["active", "paused", "ended"].includes(requestedStatus)) {
        throw new HttpsError("invalid-argument", "Unsupported campaign status");
      }

      await db.runTransaction(async (tx) => {
        const campaignDoc = await tx.get(campaignRef);
        if (!campaignDoc.exists) {
          throw new HttpsError("failed-precondition", "Configure the campaign first");
        }
        const data = campaignDoc.data() || {};
        if (data.status === "ended" && requestedStatus !== "ended") {
          throw new HttpsError("failed-precondition", "An ended campaign cannot be reopened");
        }
        if (requestedStatus === "active") {
          if (request.data?.uiApproved !== true) {
            throw new HttpsError(
              "failed-precondition",
              "Partner UI approval must be confirmed before activation"
            );
          }
          if (Number(data.totalCodes || 0) !== BADRGO_PILOT_TOTAL_CODES) {
            throw new HttpsError("failed-precondition", "The complete code inventory is required");
          }
        }

        tx.update(campaignRef, {
          status: requestedStatus,
          uiApproved: requestedStatus === "active" ? true : data.uiApproved === true,
          statusUpdatedBy: adminUid,
          statusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      return {success: true, status: requestedStatus};
    }
  );

  const getBadrgoPilotAdminSummary = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      await assertAdmin(request);
      const campaignDoc = await campaignRef.get();
      if (!campaignDoc.exists) return {exists: false};
      const data = campaignDoc.data() || {};
      return {
        exists: true,
        campaignId: BADRGO_PILOT_CAMPAIGN_ID,
        brandName: BRAND_NAME,
        status: data.status || "draft",
        uiApproved: data.uiApproved === true,
        totalCodes: Number(data.totalCodes || 0),
        publicLimit: BADRGO_PILOT_PUBLIC_LIMIT,
        reservedLimit: BADRGO_PILOT_RESERVED_LIMIT,
        publicAssignedCount: Number(data.publicAssignedCount || 0),
        reservedAssignedCount: Number(data.reservedAssignedCount || 0),
        startsAt: timestampIso(data.startsAt),
        endsAt: timestampIso(data.endsAt),
        ...campaignCopyFromData(data),
      };
    }
  );

  const assignBadrgoReservedCoupon = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const adminUid = await assertAdmin(request);
      const requestedUid = textValue(request.data?.uid, "", 128);
      const requestedEmail = textValue(request.data?.email, "", 320).toLowerCase();
      if (!requestedUid && !requestedEmail) {
        throw new HttpsError("invalid-argument", "A Firebase UID or email is required");
      }

      let userRecord: admin.auth.UserRecord;
      try {
        userRecord = requestedUid ?
          await admin.auth().getUser(requestedUid) :
          await admin.auth().getUserByEmail(requestedEmail);
      } catch {
        throw new HttpsError("not-found", "Firebase user not found");
      }

      const result = await assignCoupon({
        uid: userRecord.uid,
        email: userRecord.email || requestedEmail || null,
        pool: "reserved",
        assignedBy: adminUid,
      });
      return {
        success: true,
        uid: userRecord.uid,
        email: userRecord.email || null,
        existing: result.existing,
        reservedAssigned: result.pool === "reserved",
      };
    }
  );

  const sendBadrgoPilotClaimedNotification = onDocumentCreated(
    {
      region: REGION,
      document: "pilotCampaigns/{campaignId}/claims/{uid}",
      retry: false,
    },
    async (event) => {
      if (event.params.campaignId !== BADRGO_PILOT_CAMPAIGN_ID) return;
      const uid = event.params.uid;
      const deliveryRef = db.collection("pilotCampaignNotificationDeliveries")
        .doc(`${BADRGO_PILOT_CAMPAIGN_ID}_${uid}`);

      const shouldSend = await db.runTransaction(async (tx) => {
        const deliveryDoc = await tx.get(deliveryRef);
        if (deliveryDoc.exists) return false;
        tx.create(deliveryRef, {
          campaignId: BADRGO_PILOT_CAMPAIGN_ID,
          userId: uid,
          status: "processing",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return true;
      });
      if (!shouldSend) return;

      const studentDoc = await db.collection("students").doc(uid).get();
      const studentData = studentDoc.data() || {};
      const tokens = [...new Set([
        ...(Array.isArray(studentData.expoPushTokens) ? studentData.expoPushTokens : []),
        ...(Array.isArray(studentData.pushTokens) ? studentData.pushTokens : []),
        studentData.expoPushToken,
        studentData.pushToken,
      ].filter(isExpoPushToken))];

      if (tokens.length === 0) {
        await deliveryRef.update({
          status: "skipped_no_token",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return;
      }

      try {
        const response = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Accept-Encoding": "gzip, deflate",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(tokens.map((to) => ({
            to,
            sound: "sound.wav",
            title: "Your Badrgo ride is ready",
            body: "Open realX to view and copy your personal ride code.",
            data: {
              type: "pilot_coupon_claimed",
              campaignId: BADRGO_PILOT_CAMPAIGN_ID,
              path: "/pilot/badrgo",
            },
            channelId: "reelx_general",
          }))),
        });

        await deliveryRef.update({
          status: response.ok ? "sent" : "failed",
          responseStatus: response.status,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (error) {
        await deliveryRef.update({
          status: "failed",
          error: error instanceof Error ? error.message.slice(0, 300) : "Push request failed",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
    }
  );

  return {
    assignBadrgoReservedCoupon,
    claimBadrgoPilotCoupon,
    configureBadrgoPilotCampaign,
    getBadrgoPilotAdminSummary,
    getBadrgoPilotCampaign,
    sendBadrgoPilotClaimedNotification,
    setBadrgoPilotCampaignStatus,
  };
};


