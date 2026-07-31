import * as admin from "firebase-admin";
import {HttpsError, onCall} from "firebase-functions/v2/https";

import {
  isOpportunityAvailable,
  requireHttpsActionUrl,
  requireOpportunityId,
  requireOpportunityRequestId,
} from "./opportunitySecurity.js";

/**
 * Converts validation failures into safe callable errors.
 * @param {unknown} error Validation error.
 * @return {HttpsError} Callable-safe error.
 */
function toHttpsError(error: unknown): HttpsError {
  if (error instanceof HttpsError) return error;
  const message = error instanceof Error ?
    error.message :
    "Invalid opportunity request";
  return new HttpsError("invalid-argument", message);
}

/**
 * Creates opportunity callables backed by the canonical Firestore instance.
 * @param {admin.firestore.Firestore} db Canonical Firestore instance.
 * @return {{getOpportunityAction: Function}} Opportunity callables.
 */
export function createOpportunityFunctions(
  db: admin.firestore.Firestore,
) {
  const getOpportunityAction = onCall(
    {
      enforceAppCheck: true,
      cors: true,
    },
    async (request) => {
      if (!request.auth) {
        throw new HttpsError(
          "unauthenticated",
          "Sign in to access this opportunity",
        );
      }

      let opportunityId: string;
      let requestId: string;
      try {
        opportunityId = requireOpportunityId(request.data?.opportunityId);
        requestId = requireOpportunityRequestId(request.data?.requestId);
      } catch (error) {
        throw toHttpsError(error);
      }

      const opportunityRef = db.collection("opportunities").doc(opportunityId);
      const actionConfigRef = db
        .collection("opportunityActionConfigs")
        .doc(opportunityId);
      const studentRef = db.collection("students").doc(request.auth.uid);

      const [opportunityDoc, actionConfigDoc, studentDoc] = await Promise.all([
        opportunityRef.get(),
        actionConfigRef.get(),
        studentRef.get(),
      ]);

      if (!opportunityDoc.exists) {
        throw new HttpsError("not-found", "Opportunity not found");
      }
      if (!studentDoc.exists) {
        throw new HttpsError(
          "permission-denied",
          "A verified student account is required",
        );
      }

      const opportunity = opportunityDoc.data() || {};
      if (!isOpportunityAvailable(opportunity, Date.now())) {
        throw new HttpsError(
          "failed-precondition",
          "This opportunity is not currently available",
        );
      }
      if (!actionConfigDoc.exists) {
        throw new HttpsError(
          "failed-precondition",
          "This opportunity does not have an action configured",
        );
      }

      let actionUrl: string;
      try {
        actionUrl = requireHttpsActionUrl(actionConfigDoc.data()?.actionUrl);
      } catch (error) {
        throw toHttpsError(error);
      }

      const uid = request.auth.uid;
      const actionRef = db
        .collection("opportunityActionRequests")
        .doc(`${uid}_${requestId}`);
      const dayKey = new Date().toISOString().slice(0, 10);
      const dayRef = db
        .collection("opportunityAnalytics")
        .doc(opportunityId)
        .collection("days")
        .doc(dayKey);
      const now = admin.firestore.Timestamp.now();
      const expiresAt = admin.firestore.Timestamp.fromMillis(
        now.toMillis() + 7 * 24 * 60 * 60 * 1000,
      );

      const tracked = await db.runTransaction(async (tx) => {
        const existing = await tx.get(actionRef);
        if (existing.exists) return false;

        tx.create(actionRef, {
          opportunityId,
          userId: uid,
          requestId,
          createdAt: now,
          expiresAt,
        });
        tx.set(dayRef, {
          opportunityId,
          date: dayKey,
          qualifiedActions: admin.firestore.FieldValue.increment(1),
          updatedAt: now,
        }, {merge: true});
        return true;
      });

      return {actionUrl, tracked};
    },
  );

  return {getOpportunityAction};
}
