#!/usr/bin/env node

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');

const REQUIRED_PROJECT = 'reelx-backend';
const RECEIPT_PATH = path.join(__dirname, '.online-vendor-cleanup-dry-run.json');
const args = new Set(process.argv.slice(2));
const projectFlagIndex = process.argv.indexOf('--project');
const projectId = projectFlagIndex >= 0 ? process.argv[projectFlagIndex + 1] : '';
const execute = args.has('--execute');

if (projectId !== REQUIRED_PROJECT) {
  throw new Error(`Refusing to run: pass --project ${REQUIRED_PROJECT} explicitly.`);
}
if (execute && !args.has('--confirm-delete-online-vendor-history')) {
  throw new Error('Execution requires --confirm-delete-online-vendor-history.');
}

admin.initializeApp({ projectId });
const db = admin.firestore();

async function collectTargets() {
  const [transactions, counters, configs] = await Promise.all([
    db.collection('transactions').where('type', '==', 'online_redemption').get(),
    db.collectionGroup('onlineRedemptionCounters').get(),
    db.collection('vendorOnlineRedemptionConfigs').get(),
  ]);
  const configsWithLimit = configs.docs.filter((doc) =>
    Object.prototype.hasOwnProperty.call(doc.data(), 'dailyLimitPerUser')
  );
  return { transactions, counters, configsWithLimit };
}

async function main() {
  const targets = await collectTargets();
  const summary = {
    projectId,
    mode: execute ? 'execute' : 'dry-run',
    onlineRedemptionTransactions: targets.transactions.size,
    onlineRedemptionCounters: targets.counters.size,
    configsWithDailyLimit: targets.configsWithLimit.length,
    generatedAt: new Date().toISOString(),
  };

  if (!execute) {
    fs.writeFileSync(RECEIPT_PATH, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify(summary, null, 2));
    console.log('Dry run complete. Review counts before using --execute.');
    return;
  }

  if (!fs.existsSync(RECEIPT_PATH)) {
    throw new Error('Run the dry-run command first; no local dry-run receipt exists.');
  }
  const receipt = JSON.parse(fs.readFileSync(RECEIPT_PATH, 'utf8'));
  const receiptAgeMs = Date.now() - Date.parse(receipt.generatedAt);
  if (receipt.projectId !== REQUIRED_PROJECT || receipt.mode !== 'dry-run' || receiptAgeMs > 24 * 60 * 60 * 1000) {
    throw new Error('Dry-run receipt is invalid or older than 24 hours. Run dry-run again.');
  }

  const writer = db.bulkWriter();
  for (const doc of targets.transactions.docs) writer.delete(doc.ref);
  for (const doc of targets.counters.docs) writer.delete(doc.ref);
  for (const doc of targets.configsWithLimit) {
    writer.update(doc.ref, {
      dailyLimitPerUser: admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
  await writer.close();

  const remaining = await collectTargets();
  const result = {
    ...summary,
    remaining: {
      onlineRedemptionTransactions: remaining.transactions.size,
      onlineRedemptionCounters: remaining.counters.size,
      configsWithDailyLimit: remaining.configsWithLimit.length,
    },
  };
  console.log(JSON.stringify(result, null, 2));
  if (Object.values(result.remaining).some((count) => count !== 0)) {
    throw new Error('Cleanup verification failed: legacy documents or fields remain.');
  }
  fs.unlinkSync(RECEIPT_PATH);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
