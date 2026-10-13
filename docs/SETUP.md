# Setup

## 1. Create the script

Open the Google Ads Scripts area in the intended Ads account or manager account, create a script, and paste the complete contents of `merchant-center-feed-monitor.js`. Use the Google account that has access to the relevant Merchant Center and Ads accounts. Authorize the script when Google requests it.

Enable the **Merchant API Products v1** advanced API. Enable **Merchant API Data sources v1** only if you configure file-source checks. Enable **Merchant API Accounts v1** only if you need the registration mode. The Merchant Reports API is not used by v2.

Check the identifiers offered by the editor's autocomplete. The defaults are `MerchantApiProducts`, `MerchantApiDataSources`, and `MerchantApiAccounts`; set `SERVICE_NAMES` to the editor's actual identifiers if they differ. Do not substitute the legacy Content API's field structure. `TEST` reports a missing service explicitly.

The official [advanced APIs guide](https://developers.google.com/google-ads/scripts/docs/integrations/advanced-apis) explains enabling services and authorization. Existing older scripts may also need the relevant service enabled in their associated Cloud project.

## 2. Configure one merchant first

Edit these entries in the existing `CONFIG` object. These IDs and addresses are placeholders:

```js
RUN_MODE: 'TEST',
INSTANCE_ID: 'store_monitor',
FEEDS: [{
  name: 'My store',
  merchantId: '1234567',
  adsCustomerId: '123-456-7890',
  countries: ['US'],
  monitorSpend: true,
  allowEmpty: false
}],
SPREADSHEET_URL: '',
EMAILS: [],
WEBHOOK_URL: '',
HEARTBEAT_URL: '',
SEND_IN_PREVIEW: false,
SEND_WHEN_HEALTHY: false,
```

Keep IDs in quotes. Each merchant may occur only once. A manager script must specify an accessible `adsCustomerId` for every merchant that uses spend monitoring. A single-account script checks a supplied Ads ID against its current account.

Omit `countries` to monitor all returned countries. `countries: ['US']` limits checks to the US and alerts if that configured country has no monitored statuses. `MONITORED_CONTEXTS` selects Shopping ads, free listings, or both. It monitors the returned targeted destinations; it does not assert that every product must target both surfaces.

Set `monitorSpend: false` if you only want Merchant data and do not have usable Ads access. Spend and contribution columns then remain empty. `allowEmpty: true` is only for an intentionally empty merchant.

## 3. Register only if required

Follow Google's [developer registration guide](https://developers.google.com/merchant/api/guides/quickstart/registration). Select the Merchant Center account representing the developer's business, with the required verified business details and direct admin access. Do not automatically use a client's account or simply the first monitored merchant.

If registration is needed, explicitly set:

```js
RUN_MODE: 'REGISTER',
REGISTER_MERCHANT_ID: 'YOUR_REGISTRATION_BUSINESS_MERCHANT_ID',
DEVELOPER_EMAIL: 'YOUR_DEVELOPER_CONTACT',
CONFIRM_REGISTRATION: true,
```

Replace both placeholders. Keep a valid `FEEDS` configuration present. Use **Run**, not Preview. This mode changes developer registration and may cause Google to send a developer contact invitation. It is not a read-only test. Review the account and contact before running it.

After registration, allow Google's activation time, return to `RUN_MODE: 'TEST'`, and set `CONFIRM_REGISTRATION: false`. Registration does not grant access to unrelated merchants.

## 4. Run the read-only test

In `TEST`, run the script and inspect its logs. It samples up to five products, checks destination fields, reads the configured Ads report, and checks optional file-upload resources. It also checks what MONITOR needs from the runtime: where the report spreadsheet will come from, how overlapping runs are prevented, and that the SHA-256 state checksum works. It makes no Sheet, email, webhook, or registration writes.

Resolve every `FAIL`. A successful connection with an empty product sample says health is unverified. A successful small sample is not proof of full-catalog completeness or quota capacity.

## 5. Create the first report

Set `RUN_MODE: 'MONITOR'` and leave notifications empty for the first report if you want to inspect it before delivery. Run the script. It uses `SPREADSHEET_URL` if supplied. Otherwise it looks in your Drive for a spreadsheet **you own** named `Merchant Center Feed Health Monitor v2 - Ads <customer ID digits> - <INSTANCE_ID>` (for example `... - Ads 1234567890 - default`) and creates it on the first run. In a manager account the manager's ID is used. Google Ads scripts do not support Script Properties, so this name is how later runs find the same report. Copying the logged URL into `SPREADSHEET_URL` is still recommended. If two spreadsheets you own have that name, the run stops and asks for `SPREADSHEET_URL`. Renaming the report, moving it to a shared drive or transferring ownership means the name lookup no longer finds it, so set `SPREADSHEET_URL` before doing any of those.

Use one dedicated spreadsheet per script. If you run more than one copy of the script in the same Google Ads account, give each copy its own `INSTANCE_ID` or `SPREADSHEET_URL`. A lease row in the `Monitor v2 Lock` tab stops two runs from writing to the same report at once, including a manual Run while a scheduled run is still going. A crashed run's lease expires on its own after the runtime limit plus 10 minutes. Do not share a state spreadsheet across scripts or run copied scripts against the same Sheet.

Review Runs for complete catalog/spend coverage, Products for correct identities and prices, and Markets for the expected countries and surfaces. Absolute problems alert on the first scan. Relative changes need a valid earlier baseline.

Google Ads Preview can still cause non-Ads side effects. This implementation suppresses notifications in Preview unless `SEND_IN_PREVIEW` is true, but **MONITOR Preview still writes Sheets and queued state**. Use `TEST` when you need no writes.

## 6. Enable and verify delivery

Add your real addresses to `EMAILS`, or your Slack/Google Chat incoming webhook to `WEBHOOK_URL`. Keep secrets out of public GitHub commits. The script sends account and product evidence to these explicitly configured destinations.

Queued events from report-only runs will be eligible for delivery after a channel is configured. Read their observation timestamps. If the account is healthy and no event exists, temporarily set `SEND_WHEN_HEALTHY: true` for a controlled delivery test, confirm receipt, then restore the desired setting.

Inspect the Delivery tab as well as the actual inbox/channel. `ACCEPTED` means the send call succeeded or the webhook returned a 2xx status. It does not prove inbox delivery or that a human read the message.

## 7. Schedule and observe

Schedule the script in Google Ads at the cadence your account and quotas support. Start with one merchant, observe duration and quota usage, and expand gradually. This package does not create a schedule automatically.

Optionally configure `HEARTBEAT_URL` for an external service that accepts an HTTPS POST. Configure the service itself to warn if an expected heartbeat is missing. The script only posts a completion signal; it cannot detect its own failure to start. A heartbeat indicates completed coverage and no failed/deferred delivery attempt in that run, not that the catalog is healthy or that every queued batch has drained.

## Optional settings

| Setting | Use |
| --- | --- |
| `DISAPPROVED_ALERT_MIN_PRODUCTS`, `DISAPPROVED_ALERT_MIN_PCT`, `DISAPPROVED_ALERT_MIN_CLICKS` | When a country/surface "Products disapproved" alert opens. Defaults: 10 products, 5% of the products there, or any disapproved product with at least 1 Ads click in `SPEND_DATE_RANGE`. Nothing approved there always alerts. Set `DISAPPROVED_ALERT_MIN_PRODUCTS: 1` to alert on any disapproval. An open alert stays open until no disapprovals remain there. |
| `REMIND_AFTER_HOURS`, `REMIND_WARNINGS_AFTER_HOURS` | Reminders for open incidents: 72 hours for critical, 168 hours (weekly) for warnings. `0` turns warning reminders off. |
| `CHANGE_MIN_PRODUCTS`, `CHANGE_MIN_PCT` | Product-list incidents (disapprovals, tiny or missing prices, expiring products) send a CHANGED notice only when the affected count moves by at least 5 products and 20% since the last notice. Severity escalation always notifies. |
| `MAX_PRODUCTS_PER_FEED` | Default 50,000. Larger catalogs report incomplete coverage with a clear message. Depending on offer ID length, state for roughly 75,000 to 100,000 products across 5 countries fits the default state budget (long Shopify-style IDs use about 120 characters per product). Raise the cap only after timing a run in the Runs tab. |
| `fileDataSources: [{id: '123', maxAgeHours: 30}]` in a feed | Reads the latest upload for an explicitly configured file source, including a supplemental file source. Detects failure/staleness and reports unknown access/status. Does not measure all API-based syncs. |
| `MIN_PRICE_BY_CURRENCY` | Set a meaningful tiny-price threshold for each currency you sell in. An unlisted currency has no positive tiny-price threshold; zero/negative prices still alert. |
| `PRICE_CHANGE_FACTOR` | Default 2 means at least a 2x increase or a halving in regular price on a watched spending product. Sale prices are reported separately. |
| `PRICE_WATCH_TOP_N` | Prioritizes up to 500 products with the largest historical spend by default. Existing price incidents continue to be watched. |
| `contributionMarginPct: 40` and `conversionValueIsRevenue: true` | Enables historical conversion value multiplied by 40% as modeled contribution before ad costs. Use only when the revenue interpretation and margin assumption are valid. No store or COGS data is imported. |
| `SNOOZES` | Optional rules such as `{merchantId: '1234567', check: 'Custom label fill dropped', until: '2026-10-20T12:00:00Z'}` suppress delivery until an explicit timestamp. Monitoring and visible incidents continue. |

For multiple merchants, add one `FEEDS` entry per merchant and verify each independently. Keep account IDs, webhook URLs, report links, and customer data out of public examples.

## Upgrade from v2.0.0

Paste the 2.0.1 script over the old one and copy your `CONFIG` values into it. A `CONFIG` block pasted unchanged from 2.0.0 also works: the new settings take their defaults. The same spreadsheet and state are used: 2.0.1 reads v2.0.0 state and rewrites it in a more compact form on the next complete scan. A new `Monitor v2 Lock` tab appears. Run TEST again before the next scheduled MONITOR run.

## Upgrade from v1

Back up the old script and Sheet. Paste v2 into a new script and manually port the relevant settings. Enable Products v1. Use a new dedicated spreadsheet for the cleanest migration. V2 uses new tab names and a new state schema; it does not import v1 baselines or automatically migrate the old report.

After verifying v2, disable the old schedule to avoid duplicate notifications. Do not copy hidden state tabs individually: the control pointer and both state slots belong together.
