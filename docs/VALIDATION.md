# Validation record

Release: 2.0.1. Date: October 13, 2026. Local runtime: Node.js v22.22.0. (2.0.0 was recorded on Node.js v24.19.0; CI runs both 22 and 24.)

## Automated evidence

**117 offline tests passed, 0 failed** (86 from 2.0.0 plus 31 added in 2.0.1). The complete output is included in `test-results.tap`. The final source also passed `node --check`. Tests run against the exact script file through a VM with simulated Merchant, Ads, Sheets, email, webhook, lock, clock, and registration services.

Run again with:

```sh
npm run check
npm test
```

The harness simulates Google service behavior, including paginated data, getter-style responses, language references, Sheet row limits, formula-like strings, malformed responses, deadline failures, and write failures. It is not a substitute for executing against Google's runtime.

The 2.0.0 harness provided `LockService` and `PropertiesService`, which Google Ads scripts do not document, so 2.0.0 passed offline even though, in Google Ads, its MONITOR mode would stop at the first of those calls. The 2.0.1 tests remove both services to model the Google Ads runtime. 27 of the 31 new tests fail when run against the 2.0.0 script. Each 2.0.1 fix was also removed one at a time to confirm that at least one new test fails without it.

## 2.0.1 fixes and regression coverage

| Problem in 2.0.0 | Change and tested scenario |
| --- | --- |
| MONITOR required `LockService` and `PropertiesService` | Runs with both removed; a Sheet lease blocks overlapping runs, expires after a crash and is released after a failed run; the report is found again in Drive with an exact name-and-owner query; duplicate report names or a failed Drive search stop the run and ask for `SPREADSHEET_URL`; TEST reports these runtime checks without writing. |
| Checksum depended on `Utilities.computeDigest` | JavaScript SHA-256 matches Node's SHA-256 for ASCII, Unicode and lone surrogates; state saved with one implementation loads with the other. |
| Any Ads problem blocked all recoveries | Merchant incidents recover during an Ads outage; price checks do not recover without spend; "Spend unavailable" recovers when Ads returns; an incomplete catalog still never recovers. |
| One routine disapproval emailed every 72 hours | One of 500 disapproved stays in the report only; a disapproved product with clicks alerts; count and share thresholds alert and are tunable; open alerts stay open until none remain; warning reminders are weekly, critical stay at 72 hours; one-product churn does not send CHANGED, a material change and escalation do. |
| Review follow-ups | A removed file source and `monitorSpend: false` close incidents without false recovery and let the healthy notice resume; TEST names the report as MONITOR does in a manager account; a 2.0.0 `CONFIG` block runs with defaults; a failed lease acquisition clears its own lease; a run that loses its lease stops before writing state; MONITOR will not create a report it cannot find again. |
| 20,000-product default and large state | Compact state under 100 characters per product for 5 countries; 2.0.0 state is read and rewritten compactly; the cap message says how to raise it; invalid new settings are rejected before writes. |

## 2.0.0 fixes and regression coverage

| Previous risk | Implemented change and tested scenario |
| --- | --- |
| Aggregate status hid Shopping problems | Shopping ads disapproved while free listings remain approved triggers an alert. |
| Shared feed label hid country failures | A US failure under a GLOBAL label is separate from Canada's status. Country disappearance is detected independently. |
| Offer-only joins produced false price/spend results | Same offer across labels, currencies, or languages stays separate; language constants resolve; case collisions do not duplicate cost. |
| Capped report became the baseline | Display capped to 100 products while a 10,000-product scan preserves all 10,000 identities in state. |
| Capped or malformed API data looked complete | Continued pagination at the limit, repeated tokens, malformed collections, bad identities, and deadlines retain the previous complete baseline. |
| First bad scan reported all good | Fully disapproved and empty first scans alert immediately and do not send OK. |
| Ads errors prevented independent feed checks | Merchant health still runs while spend is marked unknown. |
| Failed sends lost incidents | HTTP 500, HTTP 400, email failure, independent channel acceptance, and later retries preserve pending events. |
| Unbounded/oversized batches lost evidence | Event-count and webhook-text limits retain omitted events without acknowledging them. |
| State writes could lose valid history | Inactive-slot failure, checksum corruption, state-size overflow, and overlapping execution do not silently replace valid state with an empty history. |
| Delivery and health were conflated | Preview behavior, delivery acceptance, deferred work, and conditional heartbeat behavior are tested separately. |
| Repeated problems were noisy or closed too early | Deduplication, reminders, snoozes, complete-scan recovery, stale references, and disappeared-market recovery safeguards have regression cases. |
| ID/source/label checks were incomplete | Numeric-only churn, previously seen lower-ranked prefixes, retained label-drop references, and primary-source disappearance are covered. |
| Registration chose the wrong account or acted unexpectedly | Explicit business registration account, explicit confirmation, and refusal to register during Preview are tested. |
| External strings could be interpreted | Leading-zero IDs, formula-like cells, Unicode state chunks, and HTML escaping have test cases. |
| Supplemental freshness was overclaimed | Optional file-upload checks handle stale/failed/unknown states and documented `IN_PROGRESS`; universal API/app sync coverage is not claimed. |

Other tests cover currency thresholds, missing price fields, expiration, stock share, configured contribution assumptions, Ads row caps, manager/single-account selection, and report grid growth.

## Required live acceptance checks

These checks remain **not performed** because no live account was connected for this implementation.

1. Enable the Merchant sub-APIs in the actual Ads Scripts editor and verify the configured service names and resource methods with TEST. Confirm the runtime lines: report spreadsheet, overlapping-run protection (expected: lease row, LockService not available) and state checksum.
2. Confirm the authorizing user's Merchant/Ads access and, where necessary, the developer-registration business identity. Do not register a client by default.
3. Compare a known approved and disapproved product across country and surface with Merchant Center's actual UI, including applicable issue codes.
4. Compare one multi-label or multilingual product's identity and historical cost with an Ads report using the same date window.
5. Verify amountMicros, product currency, sale price display, and any chosen margin/revenue assumption against known data.
6. Verify the report Sheet is created/reopened correctly and literal-text escaping works in the actual Sheets runtime. With `SPREADSHEET_URL` blank, confirm the second run reuses the same report (log: "Using existing report"). Run a second complete scan and inspect retained history. Confirm the `Monitor v2 Lock` row is empty after each run.
7. Verify a real email and/or webhook reaches the intended destination. Inspect both the message and Delivery tab. Check credentials without exposing them publicly.
8. Observe a known recovery or a controlled test configuration in a dedicated test script/Sheet. Do not deliberately break live product data just to test the monitor.
9. Measure run duration and quotas with your actual catalog size. Confirm row/state limits leave sufficient reporting and delivery time.
10. Schedule the script and verify a later scheduled run. If a heartbeat is configured, independently confirm that the watchdog alerts after an intentionally missed test heartbeat.

## Claims supported by this release

Implemented source, offline regression results, documented API field mapping, and a reproducible synthetic alert are provided. Live uptime, actual provider delivery, production scale, business ROI, and superiority over competitors have not been established.
