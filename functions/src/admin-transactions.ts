import type {Firestore} from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import {
  CallableRequest,
  HttpsError,
  onCall,
} from "firebase-functions/v2/https";

import {
  parseRequiredString,
  requireAdmin,
} from "./callable-security.js";

/* eslint-disable require-jsdoc */

const REGION = "me-central1";

export function createAdminTransactionFunctions(db: Firestore) {
  const deleteTransaction = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      const adminUid = requireAdmin(request);
      const transactionId = parseRequiredString(
        request.data?.transactionId,
        "transactionId",
      );
      const transactionRef = db.collection("transactions").doc(transactionId);

      try {
        const snapshot = await transactionRef.get();
        if (!snapshot.exists) {
          throw new HttpsError("not-found", "Transaction not found");
        }

        await transactionRef.delete();

        logger.info("Transaction deleted", {
          adminUid,
          transactionId,
        });

        return {success: true as const};
      } catch (error) {
        if (error instanceof HttpsError) {
          logger.error("Transaction delete rejected", {
            adminUid,
            transactionId,
            code: error.code,
            message: error.message,
          });
          throw error;
        }

        logger.error("Transaction delete failed", {
          adminUid,
          transactionId,
          error,
        });
        throw new HttpsError("internal", "Failed to delete transaction");
      }
    },
  );

  return {deleteTransaction};
}
