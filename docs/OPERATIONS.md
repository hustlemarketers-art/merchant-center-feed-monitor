# Operations and limits

## Reading an alert

Each incident identifies the merchant, check, scope, severity, evidence, examples, and next action. Country/surface incidents use reporting context, country, feed label, and language. Product spend is historical across countries, so overlapping country alerts must not be summed as separate financial losses.

`OPEN` is a newly observed condition or event. `CHANGED` means severity escalated, the affected product changed for a single-product check, or, for product-list checks, the number of affected products moved by at least `CHANGE_MIN_PRODUCTS` and `CHANGE_MIN_PCT` since the last notice. `REMINDER` is a repeated open condition after the configured interval: 72 hours for critical, weekly for warnings by default. `RECOVERED` means a condition was no longer observed in a complete eligible check. One-time change events are recorded without a recovery claim.

"Products disapproved" opens for a country/surface when nothing is approved there, when disapprovals reach `DISAPPROVED_ALERT_MIN_PRODUCTS` or `DISAPPROVED_ALERT_MIN_PCT`, or when a disapproved product had at least `DISAPPROVED_ALERT_MIN_CLICKS` Ads clicks. Below those thresholds the products still appear in the Markets and Products tabs. Once open, the incident stays open until no disapprovals remain in that country/surface, so it never claims recovery while some remain.

Each check recovers only when the data it depends on was read completely in that run. Merchant Center checks need a complete catalog scan. Price changes and historical Ads identities also need complete Ads spend. "Spend unavailable" recovers when Ads reporting works again. File-source checks recover when that source was read. If a file source is removed from `CONFIG`, or spend monitoring is turned off with `monitorSpend: false`, incidents that can no longer be evaluated close as recorded events without a recovery claim. "Price changed" keeps being checked against the catalog and can still recover with spend disabled. An Ads outage therefore no longer keeps Merchant Center incidents open. A missing market cannot prove its approvals recovered. A missing product cannot prove its price recovered. Stale history does not close existing price/approval/label/source conditions. These checks resume when a fresh comparable observation is available.

A complete run can still contain serious feed problems. Completeness describes observation coverage, not health. The optional OK notification is allowed only when all merchants have complete coverage and there are no active incidents.

## Baselines and state

The Products report is capped independently per merchant. Default `MAX_REPORT_ROWS` is 5,000. This is only the visible report. Full identities, regular prices, currencies and monitored destination statuses remain in durable state up to the catalog/state limits. Statuses are stored compactly (for example `F:A=US|S:A=CA,US;D=GB`): about 60 to 85 characters per product with short offer IDs in the offline measurements, and about 120 with long Shopify-style IDs.

Only a complete, valid catalog replaces the merchant's catalog baseline. Ads reporting can fail independently; it does not erase Merchant evidence. A successful empty catalog is stored as a real observation. Incomplete catalogs never replace a previous complete baseline.

Approval averages use retained calendar-day observations within `BASELINE_MAX_AGE_DAYS`, normally seven days, rather than blindly using the last seven executions. At most eight dated summaries are retained. Previously substantial market/feed-label groups remain expected until they reappear or the scope is explicitly reset. This avoids silently forgetting a prolonged disappearance. Persistent relative incidents retain the reference against which they first triggered.

State uses alternating A/B tabs with a SHA-256 checksum, chunk counts, generation numbers, and a control pointer. An inactive slot is written and flushed before the pointer changes. Invalid committed state causes a visible failure instead of silently creating a blank history. This is an application-level safeguard, not a transactional guarantee from Google Sheets.

Do not manually edit Control or State A/B. A report tab is disposable; state tabs are not. Back up the whole spreadsheet before maintenance. If a write fails, rerun after fixing Sheets access or quota. If committed state is corrupt, restore the whole Sheet from a known coherent version or deliberately start a new dedicated Sheet. A fresh Sheet resets comparison history and can produce new first-run events.

Changing country/context configuration starts a new catalog baseline and retires existing conditions for that merchant without claiming recovery. Pending historical events remain dated in the outbox. Removing a merchant from configuration does not automatically erase its saved history or incidents. Use a fresh dedicated Sheet when intentionally reorganizing the monitored merchant set.

## Delivery and retention

The first successful state commit includes the observed incidents and outbox. Each email/webhook channel has a separate receipt. A failed email does not prevent webhook delivery. Temporary API/server failures receive bounded retries; rejected 4xx webhooks remain pending for a later run after configuration is corrected.

Default batches contain at most 40 events. Webhook batches are also bounded by text size; omitted events remain pending. Very long single-event text is shortened with a link to the full report. Change events or recovery events that occurred while delivery was broken remain in chronological evidence even when delivered later.

Delivery is **at least once**, not exactly once. A process crash after an external service accepts a message but before its receipt is durably saved can cause a duplicate. Check event IDs when identifying duplicates. Changing addresses or the webhook URL creates a new destination identity, so retained events can be sent there again.

Delivered outbox events older than 30 days are removed once no currently configured channel still needs them. Pending events are retained. With no channels configured, events remain pending and can eventually hit the state-size guard. Runs, Events, and Delivery tabs retain the last 10,000 rows by default. These bounded logs are not an unlimited audit archive.

Snoozes suppress both incident and recovery delivery matching the rule. The report continues updating. Events become eligible after the snooze expires; use observation timestamps to distinguish delayed history from current conditions.

## Capacity

Defaults: 50,000 products per merchant, 100,000 Ads report rows, 12 million serialized state characters, a 25-minute overall budget, and a 150-second reporting/delivery reserve. These are protective limits, not a measured live-account capacity promise. In the offline harness, state for 100,000 products with short IDs across 5 countries and 2 surfaces was 8.3 million characters, inside the 12 million budget; with long Shopify-style IDs the same catalog would be close to the limit, so about 75,000 is the practical ceiling there. A log warning appears when saved state passes 80% of the budget. Google publishes no fixed per-minute Merchant API read quota; product calls are budgeted at roughly twice the account's offer quota per day and reset at 12:00 UTC. Google Ads scripts stop after 30 minutes (60 with `executeInParallel` callbacks, which this script does not use).

A catalog with a continuation token at the row limit is incomplete. A response ending exactly at the limit without another token is complete. Repeated pagination tokens and malformed product identities also produce incomplete coverage. Exceeding a state limit fails before replacing the committed snapshot.

The included offline 10,000-product case verifies retained identities and pagination logic in the local harness. It does not measure Google network latency, Apps Script memory, Sheets limits, Mail quotas, Merchant quotas, or manager-account execution time. Split large merchant sets across independent scripts and dedicated Sheets after measuring your own run.

The runtime reserve is cooperative. A single blocking Google API call can still exceed the deadline. An external missed-run monitor is useful because no in-process handler can notify you if the script never starts or is terminated before it can send.

## What the checks cannot establish

- File-upload freshness covers only configured file data sources. A successful upload may still have individual item errors; inspect Merchant Center. API/Shopify app freshness is not universally monitored.
- Primary-source loss and custom-label changes are symptoms. They do not prove a supplemental feed or app is the cause.
- Demoted item issues appear in product and market reports. The script does not claim a full Merchant account suspension/appeals monitor.
- Regular-price changes use matched historical spending products, a watch limit, and the configured factor. Sale prices are displayed but do not have a sale-window anomaly detector.
- Optional contribution uses historical Ads conversion value and one manual merchant margin assumption. It excludes ad cost subtraction, order-level COGS, refunds, shipping, and actual lost-profit estimation.
- Product membership is not a transactionally consistent snapshot across multiple Google API pages. Updates during a scan may be observed across different page times.
- The tool has no automatic remediation, campaign optimization, Microsoft Ads integration, or built-in store connection.

## Troubleshooting

| Observation | Next step |
| --- | --- |
| Advanced API unavailable | Enable the correct Merchant sub-API and check its actual identifier in editor autocomplete. |
| Permission or registration error | Verify the authorizing user's account access and developer registration. Run TEST again after resolving it. |
| Spend unknown | Check account selection, the language constants query, report row limit, and Ads access. Merchant checks continue. |
| Catalog incomplete | Inspect the Runs evidence and execution log. Resolve cap, quota, malformed response, access, or runtime issues. |
| File source coverage unknown | Confirm it is a file-based source, use its numeric source ID, enable Data sources API, and inspect permissions. |
| Old incident after an intended migration | Inspect its scope and timestamp. Snooze the incident while reviewing it, or deliberately begin a new dedicated baseline for the new merchant configuration. |
| "Another run is active" | A run holds the lease in the `Monitor v2 Lock` tab. Wait for it to finish. A crashed run's lease expires after the runtime limit plus 10 minutes. Do not clear the row while a run may still be writing. |
| Several reports with the same name | Set `SPREADSHEET_URL` to the report this script should use. |
| Delivery FAILED | Correct the channel configuration, service response, or quota issue. The next run retries queued events. |
| No report after a fatal error | Check the execution log and Google scheduling status. The script attempts a critical notification if a channel is configured, but the same service/access outage may prevent that too. |
| State checksum/pointer error | Preserve the Sheet and logs. Restore coherent state or start a new dedicated Sheet deliberately. Do not delete only one slot. |

## Data handling

The script reads Merchant products and Ads performance, stores account/product evidence in the selected Google Sheet, and sends selected evidence to configured recipients/webhooks. There is no vendor telemetry or automatic upload to Hustle Marketers or anyone else. An optional heartbeat sends only completion status, version, and timestamp to its configured endpoint.

Limit access to the report. Keep configured private copies out of public repositories. External text is escaped in HTML and formula-like Sheet values are written as literal text. Test these behaviors with your actual Google runtime before relying on the report as an exported data source.
