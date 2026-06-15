/* eslint-disable @typescript-eslint/no-var-requires, require-jsdoc */
const admin = require("firebase-admin");
const sharp = require("sharp");

const DEFAULT_PREFIXES = [
  "banners/",
  "trending-offer-banners/",
  "vendors/",
  "categories/",
  "brands/",
  "universities/",
  "events/",
  "featured-brand-showcase/",
];
const SUPPORTED_CONTENT_TYPES = new Set(["image/jpeg", "image/png"]);
const WEBP_CONVERTED_METADATA_KEY = "convertedToWebp";
const WEBP_QUALITY = 80;
const PAGE_SIZE = 250;

const execute = process.argv.includes("--execute");
const showHelp = process.argv.includes("--help");
const concurrency = positiveInteger(process.env.WEBP_BACKFILL_CONCURRENCY, 3);

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function selectedPrefixes() {
  return (process.env.WEBP_BACKFILL_PREFIXES || DEFAULT_PREFIXES.join(","))
    .split(",")
    .map((prefix) => prefix.trim())
    .filter(Boolean);
}

function isPublicMediaPath(filePath, prefix) {
  if (prefix !== "vendors/") return true;

  return /^vendors\/[^/]+\/branding\//.test(filePath);
}

function createSummary() {
  return {
    scanned: 0,
    eligible: 0,
    converted: 0,
    skipped: 0,
    failed: 0,
    originalBytes: 0,
    convertedBytes: 0,
  };
}

async function processFile(file, prefix, summary) {
  summary.scanned += 1;

  try {
    const [metadata] = await file.getMetadata();
    const contentType = metadata.contentType;
    const customMetadata = metadata.metadata || {};

    if (
      !isPublicMediaPath(file.name, prefix) ||
      contentType === "image/webp" ||
      customMetadata[WEBP_CONVERTED_METADATA_KEY] === "true" ||
      !SUPPORTED_CONTENT_TYPES.has(contentType)
    ) {
      summary.skipped += 1;
      return;
    }

    summary.eligible += 1;

    if (!execute) {
      console.log(JSON.stringify({
        action: "would-convert",
        filePath: file.name,
        contentType,
        bytes: Number(metadata.size || 0),
      }));
      return;
    }

    const generation = metadata.generation;
    const sourceFile = file.bucket.file(file.name, {generation});
    const destinationFile = file.bucket.file(file.name);
    const [source] = await sourceFile.download();
    const converted = await sharp(source)
      .webp({quality: WEBP_QUALITY})
      .toBuffer();

    await destinationFile.save(converted, {
      resumable: false,
      preconditionOpts: {ifGenerationMatch: generation},
      metadata: {
        cacheControl: metadata.cacheControl,
        contentDisposition: metadata.contentDisposition,
        contentEncoding: metadata.contentEncoding,
        contentLanguage: metadata.contentLanguage,
        contentType: "image/webp",
        metadata: {
          ...customMetadata,
          [WEBP_CONVERTED_METADATA_KEY]: "true",
        },
      },
    });

    summary.converted += 1;
    summary.originalBytes += source.length;
    summary.convertedBytes += converted.length;

    console.log(JSON.stringify({
      action: "converted",
      filePath: file.name,
      originalBytes: source.length,
      convertedBytes: converted.length,
      savedBytes: source.length - converted.length,
    }));
  } catch (error) {
    summary.failed += 1;
    console.error(JSON.stringify({
      action: "failed",
      filePath: file.name,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

async function processInBatches(files, prefix, summary) {
  for (let index = 0; index < files.length; index += concurrency) {
    const batch = files.slice(index, index + concurrency);
    await Promise.all(batch.map((file) => processFile(file, prefix, summary)));
  }
}

async function processPrefix(bucket, prefix, summary) {
  let pageToken;

  do {
    const [files, nextQuery] = await bucket.getFiles({
      autoPaginate: false,
      maxResults: PAGE_SIZE,
      pageToken,
      prefix,
    });

    await processInBatches(files, prefix, summary);
    pageToken = nextQuery?.pageToken;
  } while (pageToken);
}

async function main() {
  if (showHelp) {
    console.log([
      "Usage:",
      "  WEBP_BACKFILL_BUCKET=<bucket> npm run backfill:webp",
      "  WEBP_BACKFILL_BUCKET=<bucket> npm run backfill:webp -- --execute",
      "",
      "Optional environment variables:",
      "  WEBP_BACKFILL_PREFIXES=banners/,categories/",
      "  WEBP_BACKFILL_CONCURRENCY=3",
      "",
      "The default mode is dry-run. Writes require --execute.",
    ].join("\n"));
    return;
  }

  if (!process.env.WEBP_BACKFILL_BUCKET) {
    throw new Error("WEBP_BACKFILL_BUCKET is required");
  }

  admin.initializeApp({
    storageBucket: process.env.WEBP_BACKFILL_BUCKET,
  });

  const bucket = admin.storage().bucket();
  const prefixes = selectedPrefixes();
  const summary = createSummary();

  console.log(JSON.stringify({
    action: "start",
    mode: execute ? "execute" : "dry-run",
    bucket: bucket.name,
    prefixes,
    concurrency,
  }));

  for (const prefix of prefixes) {
    await processPrefix(bucket, prefix, summary);
  }

  console.log(JSON.stringify({
    action: "complete",
    mode: execute ? "execute" : "dry-run",
    ...summary,
    savedBytes: summary.originalBytes - summary.convertedBytes,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
