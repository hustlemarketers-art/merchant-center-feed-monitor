# Changelog

## 2.0.1 - 2026-10-13

Fixes found while reviewing 2.0.0 before live testing. Existing 2.0.0 state keeps working, and a `CONFIG` block copied from 2.0.0 runs with defaults for the new settings.

### Runs inside Google Ads scripts
- MONITOR no longer requires `LockService` or `PropertiesService`. Google has confirmed `PropertiesService` is not supported in Google Ads scripts, and `LockService` is not among the documented services, so in Google Ads 2.0.0 would have stopped with a "not defined" error before doing anything. TEST did not touch either service, so it could not catch this.
- Overlapping runs are now prevented by a lease row in a new `Monitor v2 Lock` tab of the report spreadsheet. `LockService` is still used when a runtime offers it. A crashed run's lease expires after the runtime limit plus 10 minutes.
- Without `SPREADSHEET_URL`, the report is found again through Drive: a spreadsheet you own named `Merchant Center Feed Health Monitor v2 - Ads <customer ID> - <INSTANCE_ID>`. Two matches stop the run and ask for `SPREADSHEET_URL`. Script Properties are still used when available.
- The state checksum falls back to a built-in JavaScript SHA-256 if `Utilities.computeDigest` is unavailable. Results are identical, so state written by either verifies with the other.
- TEST now also checks the report spreadsheet source, overlapping-run protection and the checksum, without writing anything. If the Drive search fails, the script asks for `SPREADSHEET_URL` instead of guessing. In a manager account TEST names the report exactly as MONITOR will.
- The lease is cleared if acquiring it fails part-way, and ownership is re-checked just before the first state write, so a run that lost the lease stops without writing.
- MONITOR refuses to create a report it could not find again (no `SPREADSHEET_URL`, no Script Properties and no Drive search), instead of starting fresh history every run.

### Recoveries are no longer blocked by Ads reporting
- Each check now recovers when the data it depends on was read completely. Merchant Center checks need a complete catalog; price and Ads-identity checks also need complete spend; "Spend unavailable" recovers when Ads reporting returns; file-source checks recover when that source was read. In 2.0.0 any Ads problem (access, a missing MCC `adsCustomerId`, one row without a feed label) kept every incident for that merchant open indefinitely.
- Incidents whose source was removed from `CONFIG` close as recorded events without a recovery claim: file-source checks when the source is no longer configured, and Ads-only checks when `monitorSpend: false`. "Price changed" still recovers with spend disabled, because open price incidents are re-checked against the catalog.

### Less alert noise
- "Products disapproved" opens for a country/surface only when nothing is approved there, when at least `DISAPPROVED_ALERT_MIN_PRODUCTS` (10) or `DISAPPROVED_ALERT_MIN_PCT` (5%) of products are disapproved, or when a disapproved product had at least `DISAPPROVED_ALERT_MIN_CLICKS` (1) Ads click. Routine disapprovals stay in the report. Once open, the incident stays open until no disapprovals remain, so it never reports a false recovery.
- Warning reminders are weekly (`REMIND_WARNINGS_AFTER_HOURS: 168`, `0` = off). Critical reminders stay at 72 hours.
- Product-list incidents send CHANGED only when the affected count moves by at least `CHANGE_MIN_PRODUCTS` (5) and `CHANGE_MIN_PCT` (20%) since the last notice. Severity escalation always notifies.

### Capacity
- Per-product state is 3.5 to 4.8 times smaller: only monitored destinations are stored, countries are grouped by status, and unused per-product labels and source names are no longer saved. 2.0.0 state is read and rewritten in the compact form.
- Default `MAX_PRODUCTS_PER_FEED` raised from 20,000 to 50,000. The incomplete-coverage message now says to raise it after timing a run. A log warning appears when state passes 80% of `MAX_STATE_CHARS`.

### Package
- 31 new regression tests in `test/v2.0.1.test.cjs`; 27 of them fail on 2.0.0. An independent review of the patch found four follow-up issues, all fixed and covered by these tests. One 2.0.0 test now uses 2,000 products instead of 400 so its state still spans several chunks after compaction.
- Node.js 22 or later (tested on 22 and 24 in CI). Public docs no longer mention unrelated products or internal review notes.

## 2.0.0 - 2026-10-13

Reworked the monitor for country-level accuracy, reliable state and dependable delivery.

- Replaced aggregate status detection and a separate disapproval scan with one paginated Products API scan using per-destination, per-country statuses.
- Added first-run absolute checks and correct empty-catalog observations.
- Replaced offer-ID-only history with full offer/feed-label/language identity. Resolved Ads language constants and prevented ambiguous case matching.
- Made prices currency-aware and kept sale values separate from regular-price comparisons.
- Separated complete stored state from the visible Products report cap.
- Added checksummed alternating state slots, a commit pointer, script locking, an auto-remembered report URL, and explicit incomplete-coverage handling.
- Added calendar-day history, persistent incident references, full prefix membership, numeric ID churn, and market disappearance checks.
- Added optional file-upload freshness/failure checks, expiration checks, and out-of-stock reporting.
- Added durable event queues, per-channel receipts, bounded retries, independent email/webhook handling, message-size limits, reminders, snoozes, recovery safeguards, and an optional completion heartbeat.
- Guarded developer registration with an explicit business merchant ID, contact, confirmation flag, and non-Preview execution.
- Added formula-like text escaping, HTML escaping, report grid expansion, configured capacity guards, and deadline-aware scanning.
- Added an opt-in modeled historical contribution column with explicit margin/revenue assumptions.
- Added dependency-free offline tests, synthetic alert generation, official references, installation instructions, and live acceptance steps.

### Migration and validation

V2 starts a new state schema and does not import v1 history. Port configuration deliberately and verify in a live account before scheduling. The release's offline test result is recorded in `docs/VALIDATION.md`; no production deployment or live delivery verification is included.
