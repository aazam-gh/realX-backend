# Online vendor legacy cleanup

Deploy the unlimited compatibility functions, Firestore rules, indexes, and TTL
policy before running this script from `realX-backend/functions`.

```sh
npm run cleanup:online-vendors -- --project reelx-backend
npm run cleanup:online-vendors -- --project reelx-backend --execute --confirm-delete-online-vendor-history
```

Execution requires a dry-run receipt created within the previous 24 hours. The
script re-queries Firestore after its bulk write and fails unless all remaining
legacy counts are zero. Reapply `docs/transactions_admin_v1.sql`, then verify:

```sh
bq query --use_legacy_sql=false \
  'SELECT COUNT(*) AS online_rows FROM `reelx-backend.firestore_export.transactions_admin_v1` WHERE type = "online_redemption"'
```
