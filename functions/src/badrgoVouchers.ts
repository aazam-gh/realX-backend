/* eslint-disable max-len */
import {randomUUID} from "crypto";
import * as admin from "firebase-admin";
import {onDocumentCreated} from "firebase-functions/v2/firestore";
import {CallableRequest, HttpsError, onCall} from "firebase-functions/v2/https";
import {
  BADRGO_MAX_IMPORT_CODES,
  BADRGO_VOUCHER_PROGRAM_ID,
  BADRGO_VOUCHER_TIME_ZONE,
  getNextQatarWeekIso,
  getQatarWeekKey,
  getVoucherEligibility,
  identityHash,
  normalizeImportId,
  normalizeVoucherCode,
  normalizeVoucherCodes,
  sha256,
  voucherCodeDocumentId,
  VoucherProgramStatus,
} from "./badrgoVoucherSecurity.js";

const REGION = "me-central1";
const PROGRAM_COLLECTION = "voucherPrograms";
const DEFAULT_TITLE = "Your next ride is on us";
const DEFAULT_TITLE_AR = "مشوارك القادم علينا";

const textValue = (value: unknown, fallback = "", maxLength = 500) => {
  if (typeof value !== "string") return fallback;
  return value.trim().slice(0, maxLength) || fallback;
};

const timestampIso = (value: unknown) => {
  if (value && typeof (value as {toDate?: unknown}).toDate === "function") {
    return (value as admin.firestore.Timestamp).toDate().toISOString();
  }
  return null;
};

const assertAdmin = async (
  db: admin.firestore.Firestore,
  request: CallableRequest
) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
  if (request.auth.token.admin === true) return request.auth.uid;
  const studentDoc = await db.collection("students").doc(request.auth.uid).get();
  if (!studentDoc.exists || studentDoc.data()?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required");
  }
  return request.auth.uid;
};

const isExpoPushToken = (token: unknown): token is string =>
  typeof token === "string" &&
  (token.startsWith("ExponentPushToken[") || token.startsWith("ExpoPushToken["));

export const createBadrgoVoucherFunctions = (db: admin.firestore.Firestore) => {
  const programRef = db.collection(PROGRAM_COLLECTION).doc(BADRGO_VOUCHER_PROGRAM_ID);
  const codesRef = programRef.collection("voucherCodes");
  const claimsRef = programRef.collection("claims");
  const userStatesRef = programRef.collection("userStates");
  const identityStatesRef = programRef.collection("identityStates");
  const locksRef = programRef.collection("eligibilityLocks");
  const batchesRef = programRef.collection("inventoryBatches");
  const redemptionImportsRef = programRef.collection("redemptionImports");

  const readClaim = async (claimId: string | null | undefined) => {
    if (!claimId) return null;
    const claimDoc = await claimsRef.doc(claimId).get();
    if (!claimDoc.exists) return null;
    const claimData = claimDoc.data() || {};
    const codeSnapshot = typeof claimData.codeSnapshot === "string" ? claimData.codeSnapshot : null;
    const codeDoc = codeSnapshot ? null : await codesRef.doc(String(claimData.codeDocumentId || "missing")).get();
    const code = codeSnapshot || (codeDoc?.exists && typeof codeDoc.data()?.code === "string" ? codeDoc.data()?.code as string : null);
    if (!code) return null;
    return {
      id: claimDoc.id,
      code,
      status: claimData.status || "assigned",
      periodKey: claimData.periodKey || null,
      claimedAt: timestampIso(claimData.claimedAt),
      redeemedAt: timestampIso(claimData.redeemedAt),
    };
  };

  const getBadrgoVoucherProgram = onCall(
    {region: REGION, enforceAppCheck: true, maxInstances: 20},
    async (request: CallableRequest) => {
      const programDoc = await programRef.get();
      if (!programDoc.exists) return {exists: false, status: "unavailable", claim: null};
      const data = programDoc.data() || {};
      const availableCount = Math.max(0, Number(data.availableCount || 0));
      const configuredStatus = (data.status || "paused") as VoucherProgramStatus;
      const status = configuredStatus === "active" && availableCount === 0 ? "out_of_stock" : configuredStatus;
      const periodKey = getQatarWeekKey();
      let claim = null;
      let userState: admin.firestore.DocumentData | null = null;
      let recentClaims: Array<Record<string, unknown>> = [];

      if (request.auth) {
        const userStateDoc = await userStatesRef.doc(request.auth.uid).get();
        userState = userStateDoc.exists ? userStateDoc.data() || {} : null;
        claim = await readClaim(userState?.currentClaimId);
        const history = await claimsRef
          .where("userId", "==", request.auth.uid)
          .orderBy("claimedAt", "desc")
          .limit(10)
          .get();
        recentClaims = history.docs.map((doc) => {
          const item = doc.data();
          return {
            id: doc.id,
            status: item.status,
            periodKey: item.periodKey,
            claimedAt: timestampIso(item.claimedAt),
            redeemedAt: timestampIso(item.redeemedAt),
          };
        });
      }

      const reason = getVoucherEligibility({
        authenticated: !!request.auth,
        programStatus: configuredStatus,
        availableCount,
        currentClaimStatus: userState?.currentClaimStatus,
        lastClaimPeriodKey: userState?.lastClaimPeriodKey,
        periodKey,
      });

      return {
        exists: true,
        programId: BADRGO_VOUCHER_PROGRAM_ID,
        brandName: "Badrgo",
        status,
        availableCount,
        totalCodes: Number(data.totalCodes || 0),
        assignedActiveCount: Number(data.assignedActiveCount || 0),
        redeemedCount: Number(data.redeemedCount || 0),
        title: textValue(data.title, DEFAULT_TITLE, 120),
        titleAr: textValue(data.titleAr, DEFAULT_TITLE_AR, 120),
        description: textValue(data.description, "Claim a Badrgo ride code when you are eligible.", 500),
        descriptionAr: textValue(data.descriptionAr, "احصل على رمز رحلة من بدر جو عند استحقاقك.", 500),
        instructions: textValue(data.instructions, "Use your current code before requesting another code in a future week.", 800),
        instructionsAr: textValue(data.instructionsAr, "استخدم رمزك الحالي قبل طلب رمز آخر في أسبوع لاحق.", 800),
        destinationUrl: textValue(data.destinationUrl, "https://go.badrgo.com/invite?code=R1AA52", 500),
        claim,
        currentClaim: claim,
        recentClaims,
        eligibility: {
          canClaim: reason === "eligible",
          reason,
          periodKey,
          nextEligibleAt: reason === "already_claimed_this_week" ? getNextQatarWeekIso() : null,
        },
      };
    }
  );

  const claimBadrgoVoucher = onCall(
    {region: REGION, enforceAppCheck: true, maxInstances: 20},
    async (request: CallableRequest) => {
      if (!request.auth) throw new HttpsError("unauthenticated", "Login required");
      const uid = request.auth.uid;
      const studentRef = db.collection("students").doc(uid);
      const periodKey = getQatarWeekKey();
      const claimId = sha256(`${BADRGO_VOUCHER_PROGRAM_ID}:${uid}:${periodKey}`);
      const claimRef = claimsRef.doc(claimId);

      const result = await db.runTransaction(async (tx) => {
        const [studentDoc, programDoc, userStateDoc, existingClaimDoc] = await Promise.all([
          tx.get(studentRef),
          tx.get(programRef),
          tx.get(userStatesRef.doc(uid)),
          tx.get(claimRef),
        ]);
        if (!studentDoc.exists) throw new HttpsError("not-found", "Student profile not found");
        const studentData = studentDoc.data() || {};
        if (studentData.redemptionDisabled === true || studentData.accountType === "browse_only") {
          throw new HttpsError("permission-denied", "This account cannot claim vouchers");
        }
        if (!programDoc.exists) throw new HttpsError("failed-precondition", "The voucher program is not configured");

        const canonicalEmail = typeof studentData.email === "string" ? studentData.email.trim().toLowerCase() : null;
        const personHash = identityHash(uid, canonicalEmail);
        const identityStateRef = identityStatesRef.doc(personHash);
        const lockRef = locksRef.doc(sha256(`${personHash}:${periodKey}`));
        const [identityStateDoc, lockDoc] = await Promise.all([
          tx.get(identityStateRef),
          tx.get(lockRef),
        ]);

        if (existingClaimDoc.exists || lockDoc.exists) {
          return {claimId: existingClaimDoc.exists ? claimRef.id : String(lockDoc.data()?.claimId || claimRef.id), existing: true};
        }
        const userState = userStateDoc.data() || {};
        const identityState = identityStateDoc.data() || {};
        if (userState.currentClaimStatus === "assigned" || identityState.currentClaimStatus === "assigned") {
          throw new HttpsError("failed-precondition", "Use your current ride code before claiming another");
        }
        if (userState.lastClaimPeriodKey === periodKey || identityState.lastClaimPeriodKey === periodKey) {
          throw new HttpsError("already-exists", "A ride code was already claimed for this week");
        }

        const programData = programDoc.data() || {};
        if (programData.status !== "active") throw new HttpsError("failed-precondition", "The voucher program is not accepting claims");
        if (Number(programData.availableCount || 0) <= 0) throw new HttpsError("resource-exhausted", "No ride codes are currently available");

        const availableQuery = codesRef
          .where("status", "==", "available")
          .orderBy("importedAt", "asc")
          .limit(1);
        const availableSnapshot = await tx.get(availableQuery);
        if (availableSnapshot.empty) throw new HttpsError("resource-exhausted", "No ride codes are currently available");
        const codeDoc = availableSnapshot.docs[0];
        const claimedAt = admin.firestore.Timestamp.now();
        const claimData = {
          userId: uid,
          userEmail: canonicalEmail,
          identityHash: personHash,
          codeDocumentId: codeDoc.id,
          codeSnapshot: codeDoc.data().code,
          status: "assigned",
          periodKey,
          claimedAt,
          assignedBy: uid,
        };

        tx.update(codeDoc.ref, {status: "assigned", assignedClaimId: claimId, assignedToUid: uid, assignedAt: claimedAt});
        tx.create(claimRef, claimData);
        tx.create(lockRef, {claimId, userId: uid, periodKey, createdAt: claimedAt});
        const stateData = {currentClaimId: claimId, currentClaimStatus: "assigned", lastClaimId: claimId, lastClaimPeriodKey: periodKey, updatedAt: claimedAt};
        tx.set(userStatesRef.doc(uid), stateData, {merge: true});
        tx.set(identityStateRef, {...stateData, userId: uid}, {merge: true});
        tx.update(programRef, {
          availableCount: admin.firestore.FieldValue.increment(-1),
          assignedActiveCount: admin.firestore.FieldValue.increment(1),
          totalClaims: admin.firestore.FieldValue.increment(1),
          updatedAt: claimedAt,
        });
        return {claimId, existing: false};
      });

      const claim = await readClaim(result.claimId);
      if (!claim) throw new HttpsError("internal", "Assigned ride code could not be recovered");
      console.info("Badrgo voucher claim completed", {uid, claimId: result.claimId, existing: result.existing});
      return {...claim, existing: result.existing};
    }
  );

  const importBadrgoVoucherCodes = onCall(
    {region: REGION, cors: true, timeoutSeconds: 300, memory: "256MiB", maxInstances: 5},
    async (request: CallableRequest) => {
      const adminUid = await assertAdmin(db, request);
      let codes: string[];
      try {
        codes = normalizeVoucherCodes(request.data?.codes);
      } catch (error) {
        throw new HttpsError("invalid-argument", error instanceof Error ? error.message : "Invalid codes");
      }
      const importId = normalizeImportId(request.data?.importId) || randomUUID();
      const batchRef = batchesRef.doc(importId);
      const now = admin.firestore.Timestamp.now();
      const requestFingerprint = sha256(codes.slice().sort().join("\n"));
      const batchState = await db.runTransaction(async (tx) => {
        const [batchDoc, programDoc] = await Promise.all([tx.get(batchRef), tx.get(programRef)]);
        if (batchDoc.exists) {
          const data = batchDoc.data() || {};
          if (data.requestFingerprint !== requestFingerprint) {
            throw new HttpsError("already-exists", "This import ID belongs to a different code batch");
          }
          return data.status === "complete" || data.status === "partial" ? "complete" : "resume";
        }
        if (!programDoc.exists) {
          tx.create(programRef, {
            programId: BADRGO_VOUCHER_PROGRAM_ID,
            brandName: "Badrgo",
            status: "paused",
            timeZone: BADRGO_VOUCHER_TIME_ZONE,
            title: DEFAULT_TITLE,
            titleAr: DEFAULT_TITLE_AR,
            totalCodes: 0,
            availableCount: 0,
            assignedActiveCount: 0,
            redeemedCount: 0,
            totalClaims: 0,
            createdAt: now,
            updatedAt: now,
          });
        }
        tx.create(batchRef, {status: "processing", requestedCount: codes.length, requestFingerprint, inventoryCounted: false, importedBy: adminUid, createdAt: now});
        return "started";
      });
      if (batchState === "complete") {
        const existing = await batchRef.get();
        return {importId, ...(existing.data() || {}), existing: true};
      }

      const writer = db.bulkWriter();
      writer.onWriteError((error) => error.code !== 6 && error.failedAttempts < 3);
      const outcomes = await Promise.all(codes.map(async (code, index) => {
        try {
          await writer.create(codesRef.doc(voucherCodeDocumentId(code)), {
            code,
            status: "available",
            batchId: importId,
            importedAt: now,
            importedBy: adminUid,
            sourceIndex: index,
          });
          return "accepted" as const;
        } catch (error) {
          return (error as {code?: number}).code === 6 ? "duplicate" as const : "failed" as const;
        }
      }));
      await writer.close();
      const failedCount = outcomes.filter((value) => value === "failed").length;
      const importedCountSnapshot = await codesRef.where("batchId", "==", importId).count().get();
      const acceptedCount = importedCountSnapshot.data().count;
      const duplicateCount = Math.max(0, codes.length - acceptedCount - failedCount);
      await db.runTransaction(async (tx) => {
        const batchDoc = await tx.get(batchRef);
        if (batchDoc.data()?.inventoryCounted !== true) {
          tx.update(programRef, {
            totalCodes: admin.firestore.FieldValue.increment(acceptedCount),
            availableCount: admin.firestore.FieldValue.increment(acceptedCount),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        tx.update(batchRef, {
          status: failedCount > 0 ? "partial" : "complete",
          acceptedCount,
          duplicateCount,
          failedCount,
          inventoryCounted: true,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      return {success: failedCount === 0, importId, requestedCount: codes.length, acceptedCount, duplicateCount, failedCount};
    }
  );

  const importBadrgoVoucherRedemptions = onCall(
    {region: REGION, cors: true, timeoutSeconds: 300, memory: "256MiB", maxInstances: 5},
    async (request: CallableRequest) => {
      const adminUid = await assertAdmin(db, request);
      let codes: string[];
      try {
        codes = normalizeVoucherCodes(request.data?.codes);
      } catch (error) {
        throw new HttpsError("invalid-argument", error instanceof Error ? error.message : "Invalid codes");
      }
      const importId = normalizeImportId(request.data?.importId) || randomUUID();
      const importRef = redemptionImportsRef.doc(importId);
      const requestFingerprint = sha256(codes.slice().sort().join("\n"));
      const importState = await db.runTransaction(async (tx) => {
        const importDoc = await tx.get(importRef);
        if (importDoc.exists) {
          const data = importDoc.data() || {};
          if (data.requestFingerprint !== requestFingerprint) {
            throw new HttpsError("already-exists", "This import ID belongs to a different redemption report");
          }
          return data.status === "complete" ? "complete" : "resume";
        }
        tx.create(importRef, {
          status: "processing",
          requestedCount: codes.length,
          requestFingerprint,
          importedBy: adminUid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return "started";
      });
      if (importState === "complete") {
        const existingImport = await importRef.get();
        return {importId, ...(existingImport.data() || {}), existing: true};
      }
      const codeDocs = await db.getAll(...codes.map((code) => codesRef.doc(voucherCodeDocumentId(code))));
      let matchedCount = 0;
      let alreadyRedeemedCount = 0;
      let unmatchedCount = 0;
      const now = admin.firestore.Timestamp.now();

      for (const codeDoc of codeDocs) {
        const codeData = codeDoc.data() || {};
        if (!codeDoc.exists || !codeData.assignedClaimId) {
          unmatchedCount += 1;
          continue;
        }
        if (codeData.status === "redeemed") {
          alreadyRedeemedCount += 1;
          continue;
        }
        const claimRef = claimsRef.doc(String(codeData.assignedClaimId));
        const updated = await db.runTransaction(async (tx) => {
          const claimDoc = await tx.get(claimRef);
          if (!claimDoc.exists || claimDoc.data()?.status === "redeemed") return false;
          const claimData = claimDoc.data() || {};
          tx.update(codeDoc.ref, {status: "redeemed", redeemedAt: now, redemptionImportId: importId});
          tx.update(claimRef, {status: "redeemed", redeemedAt: now, redemptionImportId: importId});
          tx.set(userStatesRef.doc(String(claimData.userId)), {currentClaimStatus: "redeemed", updatedAt: now}, {merge: true});
          tx.set(identityStatesRef.doc(String(claimData.identityHash)), {currentClaimStatus: "redeemed", updatedAt: now}, {merge: true});
          tx.update(programRef, {
            assignedActiveCount: admin.firestore.FieldValue.increment(-1),
            redeemedCount: admin.firestore.FieldValue.increment(1),
            updatedAt: now,
          });
          return true;
        });
        if (updated) matchedCount += 1;
      }
      await importRef.update({
        status: "complete",
        requestedCount: codes.length,
        matchedCount,
        alreadyRedeemedCount,
        unmatchedCount,
        completedAt: now,
      });
      return {success: true, importId, requestedCount: codes.length, matchedCount, alreadyRedeemedCount, unmatchedCount};
    }
  );

  const getBadrgoVoucherAdminSummary = onCall(
    {region: REGION, cors: true, maxInstances: 10},
    async (request: CallableRequest) => {
      await assertAdmin(db, request);
      const [programDoc, batches, redemptions, claims, legacyProgram, migrationDoc] = await Promise.all([
        programRef.get(),
        batchesRef.orderBy("createdAt", "desc").limit(20).get(),
        redemptionImportsRef.orderBy("completedAt", "desc").limit(10).get(),
        claimsRef.orderBy("claimedAt", "desc").limit(20).get(),
        db.collection("pilotCampaigns").doc("badrgo-first-ride-2026").get(),
        programRef.collection("migrations").doc("legacy-pilot-v1").get(),
      ]);
      if (!programDoc.exists) {
        return {
          exists: false,
          maxImportCodes: BADRGO_MAX_IMPORT_CODES,
          legacyMigrationAvailable: legacyProgram.exists && !migrationDoc.exists,
        };
      }
      const data = programDoc.data() || {};
      return {
        exists: true,
        programId: BADRGO_VOUCHER_PROGRAM_ID,
        status: data.status || "paused",
        timeZone: BADRGO_VOUCHER_TIME_ZONE,
        totalCodes: Number(data.totalCodes || 0),
        availableCount: Number(data.availableCount || 0),
        assignedActiveCount: Number(data.assignedActiveCount || 0),
        redeemedCount: Number(data.redeemedCount || 0),
        totalClaims: Number(data.totalClaims || 0),
        maxImportCodes: BADRGO_MAX_IMPORT_CODES,
        legacyMigrationAvailable: legacyProgram.exists && !migrationDoc.exists,
        title: textValue(data.title, DEFAULT_TITLE, 120),
        titleAr: textValue(data.titleAr, DEFAULT_TITLE_AR, 120),
        description: textValue(data.description, "", 500),
        descriptionAr: textValue(data.descriptionAr, "", 500),
        instructions: textValue(data.instructions, "", 800),
        instructionsAr: textValue(data.instructionsAr, "", 800),
        destinationUrl: textValue(data.destinationUrl, "", 500),
        batches: batches.docs.map((doc) => ({id: doc.id, ...doc.data(), createdAt: timestampIso(doc.data().createdAt), completedAt: timestampIso(doc.data().completedAt)})),
        redemptionImports: redemptions.docs.map((doc) => ({id: doc.id, ...doc.data(), completedAt: timestampIso(doc.data().completedAt)})),
        recentClaims: claims.docs.map((doc) => {
          const claim = doc.data();
          return {id: doc.id, userId: claim.userId, userEmail: claim.userEmail || null, status: claim.status, periodKey: claim.periodKey, claimedAt: timestampIso(claim.claimedAt), redeemedAt: timestampIso(claim.redeemedAt)};
        }),
      };
    }
  );

  const setBadrgoVoucherProgramStatus = onCall(
    {region: REGION, cors: true, maxInstances: 10},
    async (request: CallableRequest) => {
      const adminUid = await assertAdmin(db, request);
      const status = request.data?.status as VoucherProgramStatus;
      if (!["active", "paused", "ended"].includes(status)) throw new HttpsError("invalid-argument", "Unsupported program status");
      await db.runTransaction(async (tx) => {
        const programDoc = await tx.get(programRef);
        if (!programDoc.exists) throw new HttpsError("failed-precondition", "Import inventory first");
        const data = programDoc.data() || {};
        if (data.status === "ended" && status !== "ended") throw new HttpsError("failed-precondition", "An ended program cannot be reopened");
        if (status === "active" && Number(data.availableCount || 0) <= 0) throw new HttpsError("failed-precondition", "Import available codes before activation");
        tx.update(programRef, {status, statusUpdatedBy: adminUid, statusUpdatedAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp()});
      });
      return {success: true, status};
    }
  );

  const updateBadrgoVoucherProgram = onCall(
    {region: REGION, cors: true, maxInstances: 10},
    async (request: CallableRequest) => {
      const adminUid = await assertAdmin(db, request);
      const destinationUrl = textValue(request.data?.destinationUrl, "", 500);
      if (destinationUrl) {
        try {
          if (new URL(destinationUrl).protocol !== "https:") throw new Error("HTTPS required");
        } catch {
          throw new HttpsError("invalid-argument", "Destination URL must use HTTPS");
        }
      }
      await programRef.set({
        title: textValue(request.data?.title, DEFAULT_TITLE, 120),
        titleAr: textValue(request.data?.titleAr, DEFAULT_TITLE_AR, 120),
        description: textValue(request.data?.description, "", 500),
        descriptionAr: textValue(request.data?.descriptionAr, "", 500),
        instructions: textValue(request.data?.instructions, "", 800),
        instructionsAr: textValue(request.data?.instructionsAr, "", 800),
        destinationUrl,
        updatedBy: adminUid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, {merge: true});
      return {success: true};
    }
  );

  const migrateBadrgoPilotToVoucherProgram = onCall(
    {region: REGION, cors: true, timeoutSeconds: 120, maxInstances: 1},
    async (request: CallableRequest) => {
      const adminUid = await assertAdmin(db, request);
      const migrationRef = programRef.collection("migrations").doc("legacy-pilot-v1");
      const migrationDoc = await migrationRef.get();
      if (migrationDoc.exists) return {success: true, existing: true, ...(migrationDoc.data() || {})};

      const legacyRef = db.collection("pilotCampaigns").doc("badrgo-first-ride-2026");
      const [legacyProgram, legacyCodes, legacyClaims] = await Promise.all([
        legacyRef.get(),
        legacyRef.collection("codes").get(),
        legacyRef.collection("claims").get(),
      ]);
      if (!legacyProgram.exists) return {success: true, migratedCodes: 0, migratedClaims: 0};
      if (legacyCodes.size > 100) {
        throw new HttpsError("failed-precondition", "Unexpected legacy inventory size");
      }

      const claimsByCodeId = new Map(
        legacyClaims.docs.map((doc) => [String(doc.data().codeDocumentId || ""), doc])
      );
      const targetRefs = legacyCodes.docs.map((doc) => {
        const code = normalizeVoucherCode(doc.data().code);
        return {legacy: doc, code, target: codesRef.doc(voucherCodeDocumentId(code))};
      });
      const existingTargets = targetRefs.length > 0 ?
        await db.getAll(...targetRefs.map((item) => item.target)) : [];
      const existingIds = new Set(existingTargets.filter((doc) => doc.exists).map((doc) => doc.id));
      const batch = db.batch();
      const now = admin.firestore.Timestamp.now();
      let migratedCodes = 0;
      let availableCount = 0;
      let assignedActiveCount = 0;
      let migratedClaims = 0;

      for (const item of targetRefs) {
        if (existingIds.has(item.target.id)) continue;
        const legacyData = item.legacy.data();
        const legacyClaim = claimsByCodeId.get(item.legacy.id);
        const assigned = legacyData.status === "assigned" && !!legacyClaim;
        const claimId = assigned && legacyClaim ?
          "legacy_" + sha256(legacyClaim.id).slice(0, 48) : null;
        batch.create(item.target, {
          code: item.code,
          status: assigned ? "assigned" : "available",
          batchId: "legacy-pilot-v1",
          importedAt: legacyData.configuredAt || now,
          importedBy: adminUid,
          legacyCodeDocumentId: item.legacy.id,
          assignedClaimId: claimId,
          assignedToUid: assigned && legacyClaim ? legacyClaim.data().userId : null,
          assignedAt: assigned && legacyClaim ? legacyClaim.data().claimedAt : null,
        });
        migratedCodes += 1;
        if (assigned && claimId && legacyClaim) {
          const claimData = legacyClaim.data();
          const uid = String(claimData.userId || legacyClaim.id);
          const personHash = identityHash(uid, claimData.userEmail || null);
          batch.set(claimsRef.doc(claimId), {
            userId: uid,
            userEmail: claimData.userEmail || null,
            identityHash: personHash,
            codeDocumentId: item.target.id,
            codeSnapshot: item.code,
            status: "assigned",
            periodKey: "legacy-pilot",
            claimedAt: claimData.claimedAt || now,
            assignedBy: claimData.assignedBy || adminUid,
            migratedFrom: legacyClaim.ref.path,
          });
          const state = {
            currentClaimId: claimId,
            currentClaimStatus: "assigned",
            lastClaimId: claimId,
            lastClaimPeriodKey: "legacy-pilot",
            updatedAt: now,
          };
          batch.set(userStatesRef.doc(uid), state, {merge: true});
          batch.set(identityStatesRef.doc(personHash), {...state, userId: uid}, {merge: true});
          assignedActiveCount += 1;
          migratedClaims += 1;
        } else {
          availableCount += 1;
        }
      }

      batch.set(programRef, {
        programId: BADRGO_VOUCHER_PROGRAM_ID,
        brandName: "Badrgo",
        status: "paused",
        timeZone: BADRGO_VOUCHER_TIME_ZONE,
        title: DEFAULT_TITLE,
        titleAr: DEFAULT_TITLE_AR,
        totalCodes: admin.firestore.FieldValue.increment(migratedCodes),
        availableCount: admin.firestore.FieldValue.increment(availableCount),
        assignedActiveCount: admin.firestore.FieldValue.increment(assignedActiveCount),
        totalClaims: admin.firestore.FieldValue.increment(migratedClaims),
        redeemedCount: admin.firestore.FieldValue.increment(0),
        updatedAt: now,
      }, {merge: true});
      batch.set(batchesRef.doc("legacy-pilot-v1"), {
        status: "complete",
        requestedCount: legacyCodes.size,
        acceptedCount: migratedCodes,
        duplicateCount: legacyCodes.size - migratedCodes,
        failedCount: 0,
        inventoryCounted: true,
        importedBy: adminUid,
        createdAt: now,
        completedAt: now,
      });
      batch.set(migrationRef, {migratedCodes, migratedClaims, migratedBy: adminUid, completedAt: now});
      batch.update(legacyRef, {status: "paused", migratedToVoucherProgramAt: now});
      await batch.commit();
      return {success: true, migratedCodes, migratedClaims};
    }
  );

  const sendBadrgoVoucherClaimedNotification = onDocumentCreated(
    {region: REGION, document: "voucherPrograms/{programId}/claims/{claimId}", retry: false, maxInstances: 10},
    async (event) => {
      if (event.params.programId !== BADRGO_VOUCHER_PROGRAM_ID) return;
      const claim = event.data?.data() || {};
      const uid = String(claim.userId || "");
      if (!uid) return;
      const deliveryRef = programRef.collection("notificationDeliveries").doc(event.params.claimId);
      const shouldSend = await db.runTransaction(async (tx) => {
        const existing = await tx.get(deliveryRef);
        if (existing.exists) return false;
        tx.create(deliveryRef, {userId: uid, claimId: event.params.claimId, status: "processing", createdAt: admin.firestore.FieldValue.serverTimestamp()});
        return true;
      });
      if (!shouldSend) return;
      const studentData = (await db.collection("students").doc(uid).get()).data() || {};
      const tokens = [...new Set([
        ...(Array.isArray(studentData.expoPushTokens) ? studentData.expoPushTokens : []),
        ...(Array.isArray(studentData.pushTokens) ? studentData.pushTokens : []),
        studentData.expoPushToken,
        studentData.pushToken,
      ].filter(isExpoPushToken))];
      if (tokens.length === 0) {
        await deliveryRef.update({status: "skipped_no_token", completedAt: admin.firestore.FieldValue.serverTimestamp()});
        return;
      }
      try {
        const response = await fetch("https://exp.host/--/api/v2/push/send", {
          method: "POST",
          headers: {"Accept": "application/json", "Content-Type": "application/json"},
          body: JSON.stringify(tokens.map((to) => ({
            to,
            sound: "sound.wav",
            title: "Your Badrgo ride is ready",
            body: "Open realX to view and copy your ride code.",
            data: {type: "badrgo_voucher_claimed", path: "/pilot/badrgo", claimId: event.params.claimId},
            channelId: "reelx_general",
          }))),
        });
        await deliveryRef.update({status: response.ok ? "sent" : "failed", responseStatus: response.status, completedAt: admin.firestore.FieldValue.serverTimestamp()});
      } catch (error) {
        await deliveryRef.update({status: "failed", error: error instanceof Error ? error.message.slice(0, 300) : "Push request failed", completedAt: admin.firestore.FieldValue.serverTimestamp()});
      }
    }
  );

  return {
    claimBadrgoVoucher,
    getBadrgoVoucherAdminSummary,
    getBadrgoVoucherProgram,
    importBadrgoVoucherCodes,
    importBadrgoVoucherRedemptions,
    migrateBadrgoPilotToVoucherProgram,
    sendBadrgoVoucherClaimedNotification,
    setBadrgoVoucherProgramStatus,
    updateBadrgoVoucherProgram,
  };
};
