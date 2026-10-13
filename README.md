# Merchant Center Feed Health Monitor

**Version 2.0.1 | Ishant Sharma, Hustle Marketers | MIT**

A Google Ads script that monitors Merchant Center products, explains which country and destination are affected, and prioritizes investigation using historical Shopping performance.

Version 2.0.1 makes MONITOR mode start inside Google Ads scripts, stops Ads reporting outages from blocking Merchant Center recoveries, and cuts alert noise from routine disapprovals. See [CHANGELOG.md](CHANGELOG.md). The package includes automated offline tests and a setup checklist. It has **not yet been run against live Google Ads, Merchant Center, Sheets, email, or webhook accounts**. Complete the live checklist in [docs/VALIDATION.md](docs/VALIDATION.md) before depending on scheduled alerts.

## Start here

1. Read [the setup guide](docs/SETUP.md).
2. Copy `merchant-center-feed-monitor.js` into a new Google Ads script.
3. Fill in `CONFIG.FEEDS`, enable Merchant API Products, and keep `RUN_MODE: 'TEST'`.
4. Review every TEST line, including the report spreadsheet, overlapping-run protection and state checksum checks. Then run `MONITOR` with a dedicated report spreadsheet.
5. Verify actual alert delivery and schedule the script.

No npm installation is needed to run the Google Ads script. Node.js is only needed for the included offline tests.

## What it does

| Area | Implemented behavior |
| --- | --- |
| Country and destination health | Reads approved, pending, and disapproved status separately for Shopping ads and free listings in each returned country. A feed label is not treated as a country. |
| Immediate alerts | Detects empty catalogs, countries with nothing approved, meaningful disapprovals, missing/tiny prices, expiration, and configured file-source failures without needing a healthy first baseline. |
| Meaningful disapprovals | A country/surface alert opens when nothing is approved there, when at least 10 products or 5% of products are disapproved, or when a disapproved product had Ads clicks. Routine one-off disapprovals stay visible in the report without an email. All three thresholds are configurable. |
| Changes over time | Detects approval drops, vanished markets/feed labels, custom-label fill drops, ID churn, new ID patterns, product creation spikes, and lost primary sources. |
| Product identity | Keeps offer ID, feed label, and language together. Resolves Ads language references. Refuses ambiguous case-colliding spend assignments. |
| Prices | Uses micros conversion, currency-specific tiny-price thresholds, same-currency regular-price comparisons, and separate sale-price reporting. |
| Investigation priority | Adds historical Ads cost, clicks, conversions, and conversion value. Optional modeled contribution uses an explicitly supplied revenue and margin assumption. |
| Incident handling | Tracks open conditions, material changes, reminders (72 hours for critical, weekly for warnings), recovery events, and optional delivery snoozes. Merchant Center conditions recover on a complete catalog scan even when Ads spend is temporarily unavailable. |
| Delivery | Persists queued events, retries temporary failures, records each destination's acceptance, checks webhook HTTP status, and keeps oversized batches queued. |
| Reliable state | Stores compact full product state separately from capped reports, uses checksummed alternating snapshots, and retains the previous complete catalog after failed or partial reads. |
| Reporting | Creates Markets, Products, Incidents, Runs, Events, and Delivery tabs with evidence, examples, next actions, and Google issue help URLs. |
| Operational checks | Reports unknown coverage, keeps a runtime reserve, prevents overlapping runs with a lease row in the report spreadsheet, and supports an optional external completion heartbeat. |

## Package contents

- `merchant-center-feed-monitor.js`: the complete Google Ads script.
- `docs/SETUP.md`: installation, registration, configuration, and scheduling.
- `docs/OPERATIONS.md`: alert meanings, recovery rules, retention, limits, and troubleshooting.
- `docs/VALIDATION.md`: test evidence, fix-to-test mapping, and live acceptance checklist.
- `docs/SOURCES.md`: official references and research used in implementation.
- `docs/example-alert.html`: an alert generated from synthetic data by this implementation.
- `docs/test-results.tap`: the recorded offline test run.
- `test/`: dependency-free test harness and regression tests.
- `.github/workflows/test.yml`: automated tests on Node.js 22 and 24 when uploaded to GitHub.
- `CHANGELOG.md`, `LICENSE`, `package.json`, and `SHA256SUMS`.

## Run the tests

Use Node.js 22 or later, then:

```sh
npm run check
npm test
```

Tests use simulated services. They do not send messages, register a developer, access accounts, or change ads. The included TAP report records the actual local run.

## Scope

This is a focused feed-health monitor. It does not change bids, budgets, campaigns, products, or feed rules. `MONITOR` writes report/state Sheets and sends notifications you configure. `REGISTER` is a separate, explicit developer-registration operation.

It does not include Microsoft Ads support, automatic issue repair, store order or COGS data, or a hosted dashboard. Historical spend and modeled contribution are not forecasts of current losses.

The practical value is the combination of transparent country/destination evidence, careful product matching, persistent delivery, and auditable source code.

Created by [Ishant Sharma / Hustle Marketers](https://github.com/hustlemarketers-art). No external account has been connected or production deployment performed by this package.
