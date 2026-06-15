# Production Deployment

`realX-backend` is the only production owner of first-party Cloud Functions,
Firestore rules and indexes, and Storage rules for `reelx-backend`.

## Required Checks

Run `npm run check` before every deployment. The check validates Functions,
tests the exact 35-function export manifest, compares it with production, and
rejects plaintext secret environment variables.

## Deployments

Use the guarded deployment command from a clean `main` branch:

```sh
npm run deploy:prod -- functions
npm run deploy:prod -- firestore:rules
npm run deploy:prod -- firestore:indexes
npm run deploy:prod -- storage
```

For an emergency named-function deployment, run all checks first, then use:

```sh
firebase deploy --dry-run --only functions:FUNCTION_NAME --project reelx-backend
firebase deploy --only functions:FUNCTION_NAME --project reelx-backend
```

Never use `--force`. Record the commit SHA, operator, scope, dry-run output, and
post-deployment validation results.

## Secret Rotation

Create a new provider key, store it with
`firebase functions:secrets:set RESEND_API_KEY --project reelx-backend`, deploy
`sendOtp` and `approveVerificationRequest`, verify both email flows, and then
revoke the old provider key.

Never add API keys to `functions/.env*`. Firebase environment files are only
for non-secret configuration.

The Firebase migration removes plaintext exposure but does not create or revoke
keys in the Resend provider account. Provider-side rotation is complete only
after a new Resend key is created, stored as a new Secret Manager version,
validated through both email flows, and the old Resend key is revoked.

## Recovery

Use Firestore PITR for surgical recovery within seven days. Use scheduled
backups for longer retention and restore them into a new database before
promoting recovered data.
