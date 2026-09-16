# Isolated offer-demand forecasting

This directory is an analytics-only pipeline. It reads production transaction
exports but writes only to the dedicated `realx-forecasting-*` GCP project.

Never run these queries with production as the destination project. The SQL
intentionally excludes user identifiers, PINs, purchase URLs, and redemption
secrets. `type = 'offer'` is the initial observed-demand target.

The pipeline order is:

1. `bigquery/01_staging.sql`
2. `bigquery/02_features.sql`
3. `bigquery/00_readiness.sql` and rolling validation
4. `bigquery/03_forecast_table.sql`
5. Run `bigquery/04_experimental_model.sql` only after the readiness gate passes.

Deploy the isolated callable with:

```sh
FORECASTING_PROJECT_ID=realx-forecasting-dev npm run deploy:forecasting
```

The deployment guard refuses `reelx-backend`, `realx-dev`, and any project
outside the `realx-forecasting-*` namespace.
