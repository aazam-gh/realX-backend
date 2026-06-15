import {createHash} from "crypto";
import {getFunctions} from "firebase-admin/functions";
import {
  FieldPath,
  FieldValue,
  Firestore,
  QueryDocumentSnapshot,
  Timestamp,
} from "firebase-admin/firestore";
import {CallableRequest, HttpsError, onCall} from "firebase-functions/v2/https";
import {onTaskDispatched} from "firebase-functions/v2/tasks";
import * as logger from "firebase-functions/logger";
import {
  Expo,
  ExpoPushErrorTicket,
  ExpoPushMessage,
  ExpoPushReceiptId,
  ExpoPushTicket,
} from "expo-server-sdk";

const REGION = "me-central1";
const DAILY_NOTIFICATION_LIMIT = 2;
const TOKEN_PAGE_SIZE = 100;
const RECEIPT_TASK_SIZE = 200;
const INVALID_TOKEN_ERRORS = new Set([
  "DeviceNotRegistered",
  "InvalidCredentials",
]);

type BroadcastTask = {
  campaignId: string;
  cursor?: string;
};

type ReceiptEntry = {
  receiptId: ExpoPushReceiptId;
  token: string;
  tokenDocId: string;
  userId?: string;
};

type ReceiptTask = {
  campaignId: string;
  entries: ReceiptEntry[];
};

type TokenEntry = {
  token: string;
  tokenDocId: string;
  userId?: string;
};

const getQatarDateKey = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Qatar",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const valueFor = (type: string) =>
    parts.find((part) => part.type === type)?.value || "";
  return `${valueFor("year")}-${valueFor("month")}-${valueFor("day")}`;
};

const taskId = (...parts: string[]) =>
  createHash("sha256").update(parts.join(":")).digest("hex");

const getTaskQueue = <T>(functionName: string) =>
  getFunctions().taskQueue<T>(`locations/${REGION}/functions/${functionName}`);

const isAlreadyEnqueuedError = (
  error: unknown
) => {
  const code = String((error as {code?: unknown})?.code || "").toLowerCase();
  return code.includes("already-exists") ||
    code.includes("task-already-exists");
};

const enqueueBroadcastTask = async (data: BroadcastTask) => {
  try {
    await getTaskQueue<BroadcastTask>("processNotificationBroadcast").enqueue(
      data,
      {
        id: taskId("broadcast", data.campaignId, data.cursor || "start"),
        dispatchDeadlineSeconds: 300,
      }
    );
  } catch (error) {
    if (!isAlreadyEnqueuedError(error)) throw error;
  }
};

const enqueueReceiptTask = async (
  campaignId: string,
  pageKey: string,
  chunkIndex: number,
  entries: ReceiptEntry[]
) => {
  try {
    await getTaskQueue<ReceiptTask>("processNotificationReceipts").enqueue(
      {campaignId, entries},
      {
        id: taskId("receipts", campaignId, pageKey, String(chunkIndex)),
        scheduleDelaySeconds: 15 * 60,
        dispatchDeadlineSeconds: 300,
      }
    );
  } catch (error) {
    if (!isAlreadyEnqueuedError(error)) {
      logger.error("Unable to enqueue notification receipt cleanup", {
        campaignId,
        pageKey,
        chunkIndex,
        error,
      });
    }
  }
};

const cleanupInvalidTokens = async (
  db: Firestore,
  entries: TokenEntry[]
) => {
  const uniqueEntries = Array.from(
    new Map(entries.map((entry) => [entry.tokenDocId, entry])).values()
  );

  for (let offset = 0; offset < uniqueEntries.length; offset += 200) {
    const batch = db.batch();
    uniqueEntries.slice(offset, offset + 200).forEach((entry) => {
      batch.delete(db.collection("pushTokens").doc(entry.tokenDocId));
      if (entry.userId) {
        batch.set(
          db.collection("students").doc(entry.userId),
          {
            expoPushTokens: FieldValue.arrayRemove(entry.token),
            updatedAt: FieldValue.serverTimestamp(),
          },
          {merge: true}
        );
      }
    });
    await batch.commit();
  }
};

const tokenEntryFromDoc = (
  doc: QueryDocumentSnapshot
): TokenEntry | null => {
  const data = doc.data();
  const token = data.token;
  if (!Expo.isExpoPushToken(token)) return null;

  return {
    token,
    tokenDocId: doc.id,
    userId: typeof data.userId === "string" ? data.userId : undefined,
  };
};

export const createNotificationFunctions = (db: Firestore) => {
  const expo = new Expo();

  const registerPushToken = onCall(
    {region: REGION, cors: true, enforceAppCheck: true},
    async (request: CallableRequest) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "User not authenticated");
      }

      const token = request.data?.token;
      if (!Expo.isExpoPushToken(token)) {
        throw new HttpsError("invalid-argument", "Invalid Expo push token");
      }

      const tokenDocRef = db.collection("pushTokens").doc(token);
      const studentRef = db.collection("students").doc(request.auth.uid);
      await db.runTransaction(async (tx) => {
        const matchingTokens = await tx.get(
          db.collection("pushTokens").where("token", "==", token)
        );
        const tokenDoc = matchingTokens.docs.find((doc) => doc.id === token);
        const previousUserIds = new Set(
          matchingTokens.docs
            .map((doc) => doc.data().userId)
            .filter((userId): userId is string =>
              typeof userId === "string" && userId !== request.auth?.uid
            )
        );
        previousUserIds.forEach((previousUserId) => {
          tx.set(
            db.collection("students").doc(previousUserId),
            {
              expoPushTokens: FieldValue.arrayRemove(token),
              updatedAt: FieldValue.serverTimestamp(),
            },
            {merge: true}
          );
        });
        matchingTokens.docs.forEach((doc) => {
          if (doc.id !== token) tx.delete(doc.ref);
        });

        tx.set(
          tokenDocRef,
          {
            token,
            userId: request.auth?.uid,
            platform:
              typeof request.data?.platform === "string" ?
                request.data.platform :
                null,
            createdAt:
              tokenDoc?.data()?.createdAt || FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
          },
          {merge: true}
        );
        tx.set(
          studentRef,
          {
            expoPushTokens: FieldValue.arrayUnion(token),
            updatedAt: FieldValue.serverTimestamp(),
          },
          {merge: true}
        );
      });

      return {success: true};
    }
  );

  const unregisterPushToken = onCall(
    {region: REGION, cors: true, enforceAppCheck: true},
    async (request: CallableRequest) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "User not authenticated");
      }

      const token = request.data?.token;
      if (!Expo.isExpoPushToken(token)) {
        throw new HttpsError("invalid-argument", "Valid token is required");
      }

      const studentRef = db.collection("students").doc(request.auth.uid);
      await db.runTransaction(async (tx) => {
        const matchingTokens = await tx.get(
          db.collection("pushTokens").where("token", "==", token)
        );
        matchingTokens.docs.forEach((doc) => {
          if (doc.data().userId === request.auth?.uid) tx.delete(doc.ref);
        });
        tx.set(
          studentRef,
          {
            expoPushTokens: FieldValue.arrayRemove(token),
            updatedAt: FieldValue.serverTimestamp(),
          },
          {merge: true}
        );
      });

      return {success: true};
    }
  );

  const sendNotification = onCall(
    {region: REGION, cors: true},
    async (request: CallableRequest) => {
      if (!request.auth) {
        throw new HttpsError("unauthenticated", "User not authenticated");
      }
      if (!request.auth.token.admin) {
        throw new HttpsError("permission-denied", "Admin access required");
      }

      const title = String(request.data?.title || "").trim();
      const body = String(request.data?.body || "").trim();
      const imageUrl = String(request.data?.imageUrl || "").trim();
      const topic = String(request.data?.topic || "all-users");

      if (!title || !body || title.length > 100 || body.length > 500) {
        throw new HttpsError(
          "invalid-argument",
          "Title and body are required and must be within length limits"
        );
      }
      if (topic !== "all-users") {
        throw new HttpsError(
          "invalid-argument",
          "Only the all-users audience is currently supported"
        );
      }
      if (imageUrl) {
        try {
          const parsedUrl = new URL(imageUrl);
          if (parsedUrl.protocol !== "https:") throw new Error("Not HTTPS");
        } catch {
          throw new HttpsError(
            "invalid-argument",
            "Image URL must be a valid HTTPS URL"
          );
        }
      }

      const campaignRef = db.collection("notifications").doc();
      const dateKey = getQatarDateKey();
      const quotaRef = db.collection("notificationDailyLimits").doc(dateKey);

      await db.runTransaction(async (tx) => {
        const quotaDoc = await tx.get(quotaRef);
        const sentToday = Number(quotaDoc.data()?.count || 0);
        if (sentToday >= DAILY_NOTIFICATION_LIMIT) {
          throw new HttpsError(
            "resource-exhausted",
            `Daily notification limit of ${DAILY_NOTIFICATION_LIMIT} reached`
          );
        }

        tx.set(
          quotaRef,
          {
            count: sentToday + 1,
            dateKey,
            updatedAt: FieldValue.serverTimestamp(),
          },
          {merge: true}
        );
        tx.create(campaignRef, {
          title,
          body,
          imageUrl: imageUrl || null,
          topic,
          sentBy: request.auth?.uid,
          queuedAt: FieldValue.serverTimestamp(),
          status: "queued",
          sentCount: 0,
          failedCount: 0,
          invalidTokenCount: 0,
          totalRegistered: 0,
          dateKey,
        });
      });

      try {
        await enqueueBroadcastTask({campaignId: campaignRef.id});
      } catch (error) {
        await db.runTransaction(async (tx) => {
          const quotaDoc = await tx.get(quotaRef);
          tx.update(campaignRef, {
            status: "failed",
            error: "Unable to enqueue broadcast",
            failedAt: FieldValue.serverTimestamp(),
          });
          tx.set(
            quotaRef,
            {
              count: Math.max(0, Number(quotaDoc.data()?.count || 1) - 1),
              updatedAt: FieldValue.serverTimestamp(),
            },
            {merge: true}
          );
        });
        throw new HttpsError("internal", "Unable to queue notification");
      }

      return {
        success: true,
        campaignId: campaignRef.id,
        status: "queued",
      };
    }
  );

  const processNotificationBroadcast = onTaskDispatched<BroadcastTask>(
    {
      region: REGION,
      retryConfig: {
        maxAttempts: 5,
        minBackoffSeconds: 10,
        maxBackoffSeconds: 300,
      },
      rateLimits: {maxConcurrentDispatches: 1, maxDispatchesPerSecond: 2},
      timeoutSeconds: 300,
      memory: "512MiB",
      maxInstances: 1,
    },
    async (request) => {
      const {campaignId, cursor} = request.data;
      if (!campaignId) throw new Error("Missing campaignId");

      const campaignRef = db.collection("notifications").doc(campaignId);
      const campaignDoc = await campaignRef.get();
      if (!campaignDoc.exists) throw new Error("Notification campaign missing");

      const campaign = campaignDoc.data() || {};
      if (campaign.status === "sent" || campaign.status === "failed") return;

      const pageKey = taskId("page", cursor || "start");
      const pageRef = campaignRef.collection("pages").doc(pageKey);
      const pageDoc = await pageRef.get();
      if (pageDoc.data()?.status === "completed") {
        const nextCursor = pageDoc.data()?.nextCursor;
        if (typeof nextCursor === "string") {
          await enqueueBroadcastTask({campaignId, cursor: nextCursor});
        }
        return;
      }

      await pageRef.set(
        {
          status: "processing",
          cursor: cursor || null,
          startedAt: FieldValue.serverTimestamp(),
        },
        {merge: true}
      );
      await campaignRef.update({
        status: "processing",
        startedAt: campaign.startedAt || FieldValue.serverTimestamp(),
      });

      let tokenQuery = db
        .collection("pushTokens")
        .orderBy(FieldPath.documentId())
        .limit(TOKEN_PAGE_SIZE);
      if (cursor) tokenQuery = tokenQuery.startAfter(cursor);

      const tokenSnapshot = await tokenQuery.get();
      const scannedCount = tokenSnapshot.size;
      const validEntries = tokenSnapshot.docs
        .map(tokenEntryFromDoc)
        .filter((entry): entry is TokenEntry => entry !== null);
      const uniqueEntries = Array.from(
        new Map(validEntries.map((entry) => [entry.token, entry])).values()
      );

      const messages: ExpoPushMessage[] = uniqueEntries.map((entry) => ({
        to: entry.token,
        title: campaign.title,
        body: campaign.body,
        sound: "sound.wav",
        channelId: "reelx_general",
        ...(campaign.imageUrl ? {
          richContent: {image: campaign.imageUrl},
        } : {}),
        data: {
          type: "admin_broadcast",
          campaignId,
          imageUrl: campaign.imageUrl || null,
        },
      }));

      const tickets: ExpoPushTicket[] = [];
      for (const chunk of expo.chunkPushNotifications(messages)) {
        tickets.push(...await expo.sendPushNotificationsAsync(chunk));
      }

      const invalidEntries: TokenEntry[] = [];
      const receiptEntries: ReceiptEntry[] = [];
      let sentCount = 0;
      let failedCount = 0;

      tickets.forEach((ticket, index) => {
        const entry = uniqueEntries[index];
        if (!entry) return;

        if (ticket.status === "ok") {
          sentCount += 1;
          receiptEntries.push({
            receiptId: ticket.id,
            token: entry.token,
            tokenDocId: entry.tokenDocId,
            userId: entry.userId,
          });
          return;
        }

        failedCount += 1;
        const error = (ticket as ExpoPushErrorTicket).details?.error;
        if (error && INVALID_TOKEN_ERRORS.has(error)) {
          invalidEntries.push(entry);
        }
      });

      if (invalidEntries.length > 0) {
        await cleanupInvalidTokens(db, invalidEntries);
      }

      for (
        let offset = 0;
        offset < receiptEntries.length;
        offset += RECEIPT_TASK_SIZE
      ) {
        await enqueueReceiptTask(
          campaignId,
          pageKey,
          offset / RECEIPT_TASK_SIZE,
          receiptEntries.slice(offset, offset + RECEIPT_TASK_SIZE)
        );
      }

      const lastDoc = tokenSnapshot.docs[tokenSnapshot.docs.length - 1];
      const nextCursor =
        tokenSnapshot.size === TOKEN_PAGE_SIZE && lastDoc ? lastDoc.id : null;
      const batch = db.batch();
      batch.set(
        pageRef,
        {
          status: "completed",
          completedAt: FieldValue.serverTimestamp(),
          nextCursor,
          scannedCount,
          sentCount,
          failedCount,
          invalidTokenCount: invalidEntries.length,
        },
        {merge: true}
      );
      batch.update(campaignRef, {
        totalRegistered: FieldValue.increment(scannedCount),
        sentCount: FieldValue.increment(sentCount),
        failedCount: FieldValue.increment(failedCount),
        invalidTokenCount: FieldValue.increment(invalidEntries.length),
        updatedAt: FieldValue.serverTimestamp(),
        ...(nextCursor ? {} : {
          status: "sent",
          sentAt: FieldValue.serverTimestamp(),
        }),
      });
      await batch.commit();

      if (nextCursor) {
        await enqueueBroadcastTask({campaignId, cursor: nextCursor});
      }
    }
  );

  const processNotificationReceipts = onTaskDispatched<ReceiptTask>(
    {
      region: REGION,
      retryConfig: {
        maxAttempts: 5,
        minBackoffSeconds: 30,
        maxBackoffSeconds: 300,
      },
      rateLimits: {maxConcurrentDispatches: 2, maxDispatchesPerSecond: 2},
      timeoutSeconds: 300,
      memory: "256MiB",
      maxInstances: 2,
    },
    async (request) => {
      const entries = request.data.entries || [];
      if (entries.length === 0) return;

      const receiptIds = entries.map((entry) => entry.receiptId);
      const receipts = await expo.getPushNotificationReceiptsAsync(receiptIds);
      const invalidEntries = entries.filter((entry) => {
        const receipt = receipts[entry.receiptId];
        return receipt?.status === "error" &&
          !!receipt.details?.error &&
          INVALID_TOKEN_ERRORS.has(receipt.details.error);
      });

      if (invalidEntries.length > 0) {
        await cleanupInvalidTokens(db, invalidEntries);
        await db
          .collection("notifications")
          .doc(request.data.campaignId)
          .update({
            invalidTokenCount: FieldValue.increment(invalidEntries.length),
            updatedAt: Timestamp.now(),
          });
      }
    }
  );

  return {
    processNotificationBroadcast,
    processNotificationReceipts,
    registerPushToken,
    sendNotification,
    unregisterPushToken,
  };
};
