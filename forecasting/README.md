# Isolated offer-demand forecasting

This directory is an analytics-only pipeline. Phase 1 uses a deterministic
synthetic transaction dataset dedicated to offer-demand forecasting. It writes
only to the dedicated `realx-forecasting-*` GCP project.

Never run these queries with production as the destination project. The SQL
intentionally excludes user identifiers, PINs, purchase URLs, and redemption
secrets. `type = 'offer'` is the initial observed-demand target.

The pipeline order is:

1. `node forecasting/generate-synthetic.mjs`
2. `node scripts/load-synthetic-forecasting-data.mjs`
3. `bigquery/01_synthetic_staging.sql`
4. `bigquery/02_features.sql`
5. `bigquery/00_readiness.sql`
6. `bigquery/03_forecast_table.sql`
7. `bigquery/05_publish_seasonal_naive.sql`
8. Run `bigquery/04_experimental_model.sql` only after the readiness gate passes.

`bigquery/01_staging.sql` remains available as an optional read-only production
source comparison. It is not used by the Phase 1 synthetic pipeline.

Run the complete synthetic Phase 1 pipeline with:

```sh
npm run run:synthetic-forecasting
```

The loader refuses production and regular development Firebase projects.

Deploy the isolated callable with:

```sh
FORECASTING_PROJECT_ID=realx-forecasting-dev npm run deploy:forecasting
```

The deployment guard refuses `reelx-backend`, `realx-dev`, and any project
outside the `realx-forecasting-*` namespace.
