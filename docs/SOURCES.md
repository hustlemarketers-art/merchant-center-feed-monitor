# Official implementation references

Reviewed for this release on October 13, 2026. Links describe the API contracts; they do not establish that this package has passed a live-account integration test. No third-party marketing claim is used as test evidence.

| Reference | Implementation decision |
| --- | --- |
| [Google Ads Scripts advanced APIs](https://developers.google.com/google-ads/scripts/docs/integrations/advanced-apis) | Enable Merchant sub-APIs in the script and use the authorizing user's permissions. Verify actual service identifiers in the editor. |
| [Merchant Products v1 resource](https://developers.google.com/merchant/api/reference/rest/products_v1/accounts.products) | Read `productAttributes`, full identity, primary data source, per-context/country destination statuses, and item-level issues. |
| [Products list](https://developers.google.com/merchant/api/reference/rest/products_v1/accounts.products/list) | Follow pagination to completion and distinguish a truncated scan from an empty catalog. |
| [Google Ads Shopping performance view](https://developers.google.com/google-ads/api/fields/v22/shopping_performance_view) | Join historical online Shopping metrics to a specific merchant and product identity. The linked field reference is version-specific; live TEST must confirm the Ads Scripts runtime query. |
| [Google Ads segments](https://developers.google.com/google-ads/api/fields/v22/segments) | `product_language` is a language-constant resource reference; resolve it to a language code. Keep feed label separate from target country. |
| [Language constant fields](https://developers.google.com/google-ads/api/fields/v22/language_constant) | Resolve `resource_name` to `code` for language matching. |
| [File upload resource](https://developers.google.com/merchant/api/reference/rest/datasources_v1/accounts.dataSources.fileUploads) | File-only upload time and processing state. Recognized states are `SUCCEEDED`, `FAILED`, and `IN_PROGRESS`; success may still contain item errors. |
| [Latest file upload](https://developers.google.com/merchant/api/reference/rest/datasources_v1/accounts.dataSources.fileUploads/get) | Use the `fileUploads/latest` resource alias for configured file data sources. |
| [Developer registration](https://developers.google.com/merchant/api/guides/quickstart/registration) | Require deliberate selection of the developer's registration business/account and explain developer-contact effects. |
| [registerGcp method](https://developers.google.com/merchant/api/reference/rest/accounts_v1/accounts.developerRegistration/registerGcp) | Use the explicit registration mode and its required resource path. |
| [Merchant API quotas](https://developers.google.com/merchant/api/guides/quotas-limits/quotas) | Treat capacity as account-dependent and incomplete coverage as visible rather than successful. |
| [Google Ads Scripts Preview](https://developers.google.com/google-ads/scripts/docs/preview) | Distinguish the script's read-only TEST from Preview, which is not a universal no-side-effect environment. |
| [Apps Script Range.setValues](https://developers.google.com/apps-script/reference/spreadsheet/range#setValues(Object)) | Escape formula-like external text and preserve explicit state chunk encoding. |

Thresholds, incident rules, state design, financial assumptions, and capacity defaults are implementation choices. Google does not certify those choices or guarantee that alerts will be delivered.

## Added for 2.0.1

- [Google Ads Scripts forum: PropertiesService is not supported in Google Ads scripts](https://groups.google.com/g/adwords-scripts/c/EwyTLOL6nrw) (Google Ads Scripts team, September 3, 2019).
- [Google Ads scripts: External Data Integration](https://developers.google.com/google-ads/scripts/docs/features/external-data) lists Spreadsheet, Drive, Charts, Mail, URL Fetch and JDBC; it does not list LockService or PropertiesService.
- [Google Ads scripts limits](https://developers.google.com/google-ads/scripts/docs/limits): 30-minute execution limit, 60 minutes for manager scripts using `executeInParallel` with a callback.
- [Merchant API quotas](https://developers.google.com/merchant/api/guides/quotas-limits/quotas): product calls are budgeted at about twice the offer quota per day, daily limits reset at 12:00 UTC, and exact per-minute limits come from `quotas.list`.
- [Disapproved Products Alerts script](https://nilsrooijmans.com/google-ads-script-disapproved-products-alerts/) by Nils Rooijmans alerts on disapproved products with at least `MIN_CLICKS` (default 1) clicks in the last 30 days; the basis for `DISAPPROVED_ALERT_MIN_CLICKS`.
- [Optmyzr: alert when disapproved products cross a limit](https://updates.optmyzr.com/en/get-notified-when-the-number-of-disapproved-products-crosses-a-limit) uses a count or percentage threshold; the basis for `DISAPPROVED_ALERT_MIN_PRODUCTS` and `DISAPPROVED_ALERT_MIN_PCT`.
- [Drive search query terms](https://developers.google.com/workspace/drive/api/guides/ref-search-terms) and [DriveApp.searchFiles](https://developers.google.com/apps-script/reference/drive/drive-app#searchFiles(String)): `DriveApp` uses the Drive v2 field `title` (v3 renamed it `name`), with `'me' in owners`, `mimeType` and `trashed` filters and `\'` to escape quotes. If the search fails, the script asks for `SPREADSHEET_URL` instead of guessing.

