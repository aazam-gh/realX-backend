import * as admin from 'firebase-admin';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { geohashForLocation } from 'geofire-common';

const isValidCoordinate = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export const createGeospatialFunctions = (db: admin.firestore.Firestore) => {
  const syncVendorGeohash = onDocumentWritten(
    'vendors/{vendorId}',
    async (event) => {
      const afterData = event.data?.after?.data();
      if (!afterData) return;

      const lat = afterData.lat;
      const lng = afterData.lng;

      if (!isValidCoordinate(lat, -90, 90) || !isValidCoordinate(lng, -180, 180)) {
        if (typeof afterData.geohash === 'string' && afterData.geohash.length > 0) {
          await event.data?.after?.ref.set(
            { geohash: admin.firestore.FieldValue.delete() },
            { merge: true }
          );
        }
        return;
      }

      const nextGeohash = geohashForLocation([lat, lng]).slice(0, 5);
      if (afterData.geohash === nextGeohash) return;

      await event.data?.after?.ref.set(
        {
          geohash: nextGeohash,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }
  );

  const backfillVendorGeohashes = onCall(
    { enforceAppCheck: true },
    async (request: CallableRequest) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Login required');
      }

      const adminDoc = await db.collection('students').doc(request.auth.uid).get();
      if (!adminDoc.exists || adminDoc.data()?.admin !== true) {
        throw new HttpsError('permission-denied', 'Admin access required');
      }

      const requestedLimit = Number(request.data?.limit || 500);
      const batchLimit = Math.min(Math.max(requestedLimit, 1), 1000);
      const snapshot = await db.collection('vendors').limit(batchLimit).get();

      if (snapshot.empty) {
        return { scanned: 0, updated: 0 };
      }

      const writeBatch = db.batch();
      let updated = 0;

      snapshot.docs.forEach((vendorDoc) => {
        const data = vendorDoc.data();
        const lat = data?.lat;
        const lng = data?.lng;

        if (!isValidCoordinate(lat, -90, 90) || !isValidCoordinate(lng, -180, 180)) return;

        const nextGeohash = geohashForLocation([lat, lng]).slice(0, 5);
        if (data?.geohash === nextGeohash) return;

        writeBatch.set(
          vendorDoc.ref,
          {
            geohash: nextGeohash,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        updated++;
      });

      if (updated > 0) {
        await writeBatch.commit();
      }

      return { scanned: snapshot.size, updated, limit: batchLimit };
    }
  );

  return { backfillVendorGeohashes, syncVendorGeohash };
};
