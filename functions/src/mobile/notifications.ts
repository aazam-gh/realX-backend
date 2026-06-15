import * as admin from 'firebase-admin';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';

const isExpoPushToken = (token: unknown): token is string =>
  typeof token === 'string' &&
  (token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken['));

export const createNotificationFunctions = (db: admin.firestore.Firestore) => {
  const sendCreatorCodeUsedPush = async ({
    creatorUid,
    vendorName,
    cashbackAmount,
    transactionId,
  }: {
    creatorUid: string;
    vendorName: string;
    cashbackAmount: number;
    transactionId: string;
  }) => {
    const creatorRef = db.collection('students').doc(creatorUid);
    const creatorDoc = await creatorRef.get();
    if (!creatorDoc.exists) return;

    const creatorData = creatorDoc.data() || {};
    const tokenCandidates = [
      ...(Array.isArray(creatorData.expoPushTokens) ? creatorData.expoPushTokens : []),
      ...(Array.isArray(creatorData.pushTokens) ? creatorData.pushTokens : []),
      creatorData.expoPushToken,
      creatorData.pushToken,
    ].filter(isExpoPushToken);
    const tokens = [...new Set(tokenCandidates)];
    if (tokens.length === 0) return;

    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-type': 'application/json',
      },
      body: JSON.stringify(tokens.map((to) => ({
        to,
        sound: 'sound.wav',
        title: 'Your code was used!',
        body: `Someone used your code at ${vendorName}. You earned XP ${cashbackAmount.toFixed(2)} XPoints!`,
        data: { type: 'creator_code_used', transactionId, vendorName, cashbackAmount },
        channelId: 'reelx_general',
      }))),
    });

    const payload = await response.json() as {
      data?: Array<{ status?: string; details?: { error?: string } }>;
    };
    const invalidTokens = (payload.data || [])
      .map((ticket, index) => ({ ticket, index }))
      .filter(({ ticket }) =>
        ticket.status === 'error' &&
        ['DeviceNotRegistered', 'InvalidCredentials', 'MessageTooBig'].includes(ticket.details?.error || '')
      )
      .map(({ index }) => tokens[index])
      .filter((token): token is string => typeof token === 'string');

    if (invalidTokens.length === 0) return;

    await creatorRef.set({
      expoPushTokens: tokens.filter((token) => !invalidTokens.includes(token)),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  };

  const registerPushToken = onCall(
    { enforceAppCheck: true },
    async (request: CallableRequest) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'User not authenticated');
      }

      const token = request.data?.token;
      if (!isExpoPushToken(token)) {
        throw new HttpsError('invalid-argument', 'Invalid Expo push token');
      }

      const tokenDocRef = db.collection('pushTokens').doc(token);
      const studentRef = db.collection('students').doc(request.auth.uid);
      await db.runTransaction(async (tx) => {
        const matchingTokens = await tx.get(
          db.collection('pushTokens').where('token', '==', token)
        );
        const tokenDoc = matchingTokens.docs.find((doc) => doc.id === token);
        const previousUserIds = new Set(
          matchingTokens.docs
            .map((doc) => doc.data().userId)
            .filter((userId): userId is string =>
              typeof userId === 'string' && userId !== request.auth?.uid
            )
        );
        previousUserIds.forEach((previousUserId) => {
          tx.set(db.collection('students').doc(previousUserId), {
            expoPushTokens: admin.firestore.FieldValue.arrayRemove(token),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        });
        matchingTokens.docs.forEach((doc) => {
          if (doc.id !== token) tx.delete(doc.ref);
        });

        tx.set(tokenDocRef, {
          token,
          userId: request.auth?.uid,
          platform: typeof request.data?.platform === 'string' ? request.data.platform : null,
          createdAt: tokenDoc?.data()?.createdAt || admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        tx.set(studentRef, {
          expoPushTokens: admin.firestore.FieldValue.arrayUnion(token),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });

      return { success: true };
    }
  );

  const unregisterPushToken = onCall(
    { enforceAppCheck: true },
    async (request: CallableRequest) => {
      if (!request.auth) {
        throw new HttpsError('unauthenticated', 'User not authenticated');
      }

      const token = request.data?.token;
      if (!isExpoPushToken(token)) {
        throw new HttpsError('invalid-argument', 'Valid token is required');
      }

      const studentRef = db.collection('students').doc(request.auth.uid);
      await db.runTransaction(async (tx) => {
        const matchingTokens = await tx.get(
          db.collection('pushTokens').where('token', '==', token)
        );
        matchingTokens.docs.forEach((doc) => {
          if (doc.data().userId === request.auth?.uid) tx.delete(doc.ref);
        });
        tx.set(studentRef, {
          expoPushTokens: admin.firestore.FieldValue.arrayRemove(token),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });

      return { success: true };
    }
  );

  return { registerPushToken, sendCreatorCodeUsedPush, unregisterPushToken };
};
