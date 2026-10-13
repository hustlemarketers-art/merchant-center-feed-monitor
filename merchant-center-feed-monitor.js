/**
 * Merchant Center Feed Health Monitor 2.0.1
 * Ishant Sharma / Hustle Marketers. MIT. See README.md and docs/SOURCES.md.
 * Google Ads script: TEST reads only. MONITOR writes private report/state Sheets
 * and sends configured alerts. REGISTER changes developer registration only.
 * No bids, budgets, products, feed rules or campaign settings are modified.
 */
const CONFIG = {
  RUN_MODE: 'TEST', // TEST | MONITOR | REGISTER
  INSTANCE_ID: 'default',
  FEEDS: [
    // { name: 'My store', merchantId: '1234567', adsCustomerId: '123-456-7890',
    //   countries: ['US'], contributionMarginPct: 40, conversionValueIsRevenue: true,
    //   allowEmpty: false, monitorSpend: true,
    //   fileDataSources: [{ id: '123', maxAgeHours: 30 }] }
  ],
  SPREADSHEET_URL: '', // blank: finds or creates a report you own in Drive (see docs/SETUP.md). Pasting the URL is recommended.
  EMAILS: [],
  WEBHOOK_URL: '', // HTTPS Slack or Google Chat incoming webhook
  HEARTBEAT_URL: '', // optional external missed-run monitor; pinged only on complete runs
  SEND_IN_PREVIEW: false,
  SEND_WHEN_HEALTHY: false,
  MONITORED_CONTEXTS: ['SHOPPING_ADS', 'FREE_LISTINGS'],
  SPEND_DATE_RANGE: 'LAST_30_DAYS',
  MIN_GROUP_SIZE: 20,
  ELIGIBLE_DROP_PCT: 20,
  // "Products disapproved" opens per country/surface when ANY of these is true (or when
  // nothing is approved there). A few routine disapprovals stay visible in the report only.
  DISAPPROVED_ALERT_MIN_PRODUCTS: 10,
  DISAPPROVED_ALERT_MIN_PCT: 5,
  DISAPPROVED_ALERT_MIN_CLICKS: 1, // any disapproved product with this many Ads clicks; 0 = off
  DISAPPROVAL_SPIKE_MIN: 10,
  LABEL_FILL_DROP_POINTS: 20,
  ID_CHURN_PCT: 30,
  NEW_ID_PATTERN_SHARE_PCT: 20,
  NEW_PRODUCTS_PCT: 30,
  MIN_PRICE_BY_CURRENCY: { USD: 0.10, EUR: 0.10, GBP: 0.10, CAD: 0.10, AUD: 0.10 },
  PRICE_CHANGE_FACTOR: 2, // same-currency changes on spending products
  EXPIRY_WARNING_DAYS: 3,
  ALERT_OUT_OF_STOCK: false,
  OUT_OF_STOCK_PCT: 50,
  REMIND_AFTER_HOURS: 72, // reminders for open CRITICAL incidents
  REMIND_WARNINGS_AFTER_HOURS: 168, // reminders for open WARNING incidents; 0 = never
  CHANGE_MIN_PRODUCTS: 5, // product-list incidents notify CHANGED only when the count moves
  CHANGE_MIN_PCT: 20,     // by at least this many products AND this % since the last notice
  BASELINE_MAX_AGE_DAYS: 7,
  MAX_PRODUCTS_PER_FEED: 50000, // protective cap, not a live-tested capacity guarantee. About
                                // 75,000-100,000 fits the state budget depending on ID length;
                                // raise only after timing a run.
  MAX_ADS_ROWS: 100000,
  PRICE_WATCH_TOP_N: 500,
  MAX_REPORT_ROWS: 5000, // DISPLAY ONLY; never truncates state
  MAX_ALERTS_PER_MESSAGE: 40,
  MAX_RUNTIME_MINUTES: 25,
  RESERVE_SECONDS: 150,
  MAX_STATE_CHARS: 12000000,
  MAX_EVENT_ROWS: 10000,
  // Incident controls suppress delivery only; monitoring and visible incidents continue.
  SNOOZES: [
    // { merchantId: '1234567', check: 'Custom label fill dropped', until: '2026-10-20T12:00:00Z' }
  ],
  SERVICE_NAMES: { Products: 'MerchantApiProducts', Accounts: 'MerchantApiAccounts', DataSources: 'MerchantApiDataSources' },
  REGISTER_MERCHANT_ID: '', // explicitly select your registration business account
  DEVELOPER_EMAIL: '',
  CONFIRM_REGISTRATION: false
};
const VERSION = '2.0.1';
const SCHEMA = 2;
const DAY_MS = 86400000;
const ORDER = { CRITICAL: 0, WARNING: 1, INFO: 2 };
const TAB = { CONTROL: 'Monitor v2 Control', LOCK: 'Monitor v2 Lock', A: 'Monitor v2 State A', B: 'Monitor v2 State B',
  RUNS: 'Monitor v2 Runs', GROUPS: 'Monitor v2 Markets', PRODUCTS: 'Monitor v2 Products',
  INCIDENTS: 'Monitor v2 Incidents', EVENTS: 'Monitor v2 Events', DELIVERY: 'Monitor v2 Delivery' };

function main() {
  validateConfig_();
  if (CONFIG.RUN_MODE === 'TEST') return runTest_();
  if (CONFIG.RUN_MODE === 'REGISTER') return runRegister_();
  // Google Ads scripts do not document LockService or PropertiesService (Google has
  // confirmed PropertiesService is unsupported), so neither may be required here.
  // LockService is used only when the runtime offers it; the report Sheet lease below
  // is what prevents overlapping writers inside Google Ads.
  const scriptLock = optionalScriptLock_();
  if (scriptLock && !scriptLock.tryLock(1000)) throw new Error('Another run is active. No second writer was started.');
  let lease = null;
  try {
    const ss = openSpreadsheet_();
    lease = acquireLease_(ss);
    return runMonitor_(ss, lease);
  } catch(e) { if (!e.leaseBusy) fatalNotice_(e); throw e; }
  finally { if (lease) releaseLease_(lease); if (scriptLock) scriptLock.releaseLock(); }
}
function optionalScriptLock_() {
  try { return typeof LockService !== 'undefined' && LockService && typeof LockService.getScriptLock === 'function' ? LockService.getScriptLock() : null; }
  catch (e) { return null; }
}
function optionalScriptProperties_() {
  try { return typeof PropertiesService !== 'undefined' && PropertiesService && typeof PropertiesService.getScriptProperties === 'function' ? PropertiesService.getScriptProperties() : null; }
  catch (e) { return null; }
}
// A lease row in the report spreadsheet. Sheets has no atomic compare-and-set, so a
// short pause and re-read detects the rare case of two runs starting together.
function acquireLease_(ss) {
  const sheet = sheet_(ss, TAB.LOCK);
  ensureGrid_(sheet, 2, 3);
  const now = Date.now(), current = sheet.getRange(2, 1, 1, 2).getValues()[0];
  const holder = text_(current[0]), until = Number(current[1]) || 0;
  if (holder && until > now) throw busy_('Another run is active (report lease held until ' + iso_(until) + '). No second writer was started.');
  const token = leaseToken_(), expires = now + (CONFIG.MAX_RUNTIME_MINUTES + 10) * 60000;
  const lease = { sheet, token };
  try {
    sheet.getRange(1, 1, 1, 3).setValues([['Run lease owner', 'Lease expires (ms)', 'Lease expires UTC']]);
    sheet.getRange(2, 1, 1, 3).setValues([[token, expires, iso_(expires)]]);
    SpreadsheetApp.flush();
    Utilities.sleep(1000);
    if (!ownsLease_(lease)) throw busy_('Another run started at the same moment. No second writer was started.');
  } catch (e) { if (!e.leaseBusy) releaseLease_(lease); throw e; }
  return lease;
}
function ownsLease_(lease) { return text_(lease.sheet.getRange(2, 1).getValues()[0][0]) === lease.token; }
function releaseLease_(lease) {
  try {
    if (ownsLease_(lease)) lease.sheet.getRange(2, 1, 1, 3).setValues([['', '', '']]);
  } catch (e) { log_('Lease release failed; it expires automatically: ' + error_(e)); }
}
function leaseToken_() {
  try { if (typeof Utilities.getUuid === 'function') return Utilities.getUuid(); } catch (e) { /* fall through */ }
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
}
function busy_(message) { const e = new Error(message); e.leaseBusy = true; return e; }
// Settings added in 2.0.1. A CONFIG block copied from 2.0.0 lacks them; use these defaults.
const DEFAULTS_2_0_1 = { DISAPPROVED_ALERT_MIN_PRODUCTS: 10, DISAPPROVED_ALERT_MIN_PCT: 5, DISAPPROVED_ALERT_MIN_CLICKS: 1,
  REMIND_WARNINGS_AFTER_HOURS: 168, CHANGE_MIN_PRODUCTS: 5, CHANGE_MIN_PCT: 20 };
function validateConfig_() {
  Object.keys(DEFAULTS_2_0_1).forEach(k => { if (CONFIG[k] === undefined) CONFIG[k] = DEFAULTS_2_0_1[k]; });
  CONFIG.RUN_MODE = String(CONFIG.RUN_MODE).toUpperCase();
  if (!['TEST', 'MONITOR', 'REGISTER'].includes(CONFIG.RUN_MODE)) throw new Error('Use TEST, MONITOR or REGISTER.');
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(CONFIG.INSTANCE_ID)) throw new Error('INSTANCE_ID must be 1–60 letters, digits, underscores or hyphens.');
  if (!Array.isArray(CONFIG.FEEDS) || !CONFIG.FEEDS.length) throw new Error('Add at least one merchant to CONFIG.FEEDS.');
  const seen = new Set();
  CONFIG.FEEDS.forEach(f => {
    f.merchantId = String(f.merchantId || '').trim();
    if (!/^\d+$/.test(f.merchantId) || seen.has(f.merchantId)) throw new Error('Each merchantId must be numeric and occur once.');
    seen.add(f.merchantId); f.name = String(f.name || f.merchantId);
    if (f.adsCustomerId && !/^\d{3}-?\d{3}-?\d{4}$/.test(String(f.adsCustomerId))) throw new Error('Invalid adsCustomerId.');
    if (f.countries && (!Array.isArray(f.countries) || f.countries.some(c => !/^[A-Z]{2}$/.test(c)))) throw new Error('countries must contain uppercase two-letter country codes.');
    if (f.contributionMarginPct !== undefined && (!Number.isFinite(f.contributionMarginPct) || f.contributionMarginPct < 0 || f.contributionMarginPct > 100)) throw new Error('contributionMarginPct must be 0–100.');
    (f.fileDataSources || []).forEach(s => { if (!/^\d+$/.test(String(s.id)) || !Number.isFinite(s.maxAgeHours) || s.maxAgeHours <= 0) throw new Error('File sources require numeric id and positive maxAgeHours.'); });
  });
  if (!Array.isArray(CONFIG.EMAILS) || CONFIG.EMAILS.some(x => !/^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(x))) throw new Error('EMAILS must be an array of email addresses.');
  ['WEBHOOK_URL', 'HEARTBEAT_URL'].forEach(k => { if (CONFIG[k] && !/^https:\/\/[^\s]+$/.test(CONFIG[k])) throw new Error(k + ' must use HTTPS.'); });
  if (CONFIG.SPREADSHEET_URL && !/^https:\/\/docs\.google\.com\/spreadsheets\/d\//.test(CONFIG.SPREADSHEET_URL)) throw new Error('SPREADSHEET_URL must be a Google Sheets URL.');
  if (!['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS'].includes(CONFIG.SPEND_DATE_RANGE)) throw new Error('Unsupported SPEND_DATE_RANGE.');
  if (!CONFIG.MONITORED_CONTEXTS.length || CONFIG.MONITORED_CONTEXTS.some(c => !['SHOPPING_ADS', 'FREE_LISTINGS'].includes(c))) throw new Error('Use SHOPPING_ADS and/or FREE_LISTINGS contexts.');
  ['MAX_PRODUCTS_PER_FEED','MAX_ADS_ROWS','MAX_REPORT_ROWS','MAX_ALERTS_PER_MESSAGE','MAX_EVENT_ROWS','PRICE_WATCH_TOP_N','MAX_STATE_CHARS','DISAPPROVAL_SPIKE_MIN','DISAPPROVED_ALERT_MIN_PRODUCTS','CHANGE_MIN_PRODUCTS'].forEach(k => { if (!Number.isInteger(CONFIG[k]) || CONFIG[k] < 1) throw new Error(k + ' must be a positive integer.'); });
  ['MIN_GROUP_SIZE','ELIGIBLE_DROP_PCT','LABEL_FILL_DROP_POINTS','ID_CHURN_PCT','NEW_PRODUCTS_PCT','NEW_ID_PATTERN_SHARE_PCT','OUT_OF_STOCK_PCT','DISAPPROVED_ALERT_MIN_PCT','CHANGE_MIN_PCT'].forEach(k => { if (!Number.isFinite(CONFIG[k]) || CONFIG[k] < 0 || (k !== 'MIN_GROUP_SIZE' && CONFIG[k] > 100)) throw new Error('Invalid threshold '+k); });
  ['PRICE_CHANGE_FACTOR','BASELINE_MAX_AGE_DAYS','REMIND_AFTER_HOURS','REMIND_WARNINGS_AFTER_HOURS','DISAPPROVED_ALERT_MIN_CLICKS','EXPIRY_WARNING_DAYS','RESERVE_SECONDS'].forEach(k=>{if(!Number.isFinite(CONFIG[k])||CONFIG[k]<0)throw new Error('Invalid threshold '+k);});
  if (!(CONFIG.PRICE_CHANGE_FACTOR > 1) || !(CONFIG.BASELINE_MAX_AGE_DAYS > 0) || !(CONFIG.REMIND_AFTER_HOURS > 0)) throw new Error('Invalid price, baseline or reminder threshold.');
  Object.keys(CONFIG.MIN_PRICE_BY_CURRENCY).forEach(c=>{if(!/^[A-Z]{3}$/.test(c)||!Number.isFinite(CONFIG.MIN_PRICE_BY_CURRENCY[c])||CONFIG.MIN_PRICE_BY_CURRENCY[c]<0)throw new Error('Invalid currency price threshold');});
  if (!(CONFIG.MAX_RUNTIME_MINUTES >= 4 && CONFIG.MAX_RUNTIME_MINUTES <= 28) || CONFIG.RESERVE_SECONDS < 60 || CONFIG.RESERVE_SECONDS >= CONFIG.MAX_RUNTIME_MINUTES * 60) throw new Error('Invalid runtime/reserve settings.');
  CONFIG.SNOOZES.forEach(s => { if (!Number.isFinite(Date.parse(s.until))) throw new Error('Snooze until must be an ISO timestamp.'); });
}

// One Products API scan supplies exact per-context, per-country status, prices,
// labels and issues. No aggregate status query or separately capped disapproval scan.
function readCatalog_(feed, deadline, cap) {
  const service = service_('Products');
  const out = [], seenTokens = new Set();
  let token = '', calls = 0;
  while (true) {
    if (Date.now() >= deadline) return { items: out, complete: false, reason: 'Catalog deadline', calls };
    const remaining = cap - out.length;
    if (remaining <= 0) return { items: out, complete: false, reason: 'Catalog has more than MAX_PRODUCTS_PER_FEED ('+cap+') products. Raise MAX_PRODUCTS_PER_FEED after checking the run time in the Runs tab', calls };
    const opts = { pageSize: Math.min(1000, remaining) };
    if (token) opts.pageToken = token;
    const response = retry_(() => service.Accounts.Products.list('accounts/' + feed.merchantId, opts), deadline);
    calls++;
    if(!response || typeof response!=='object')throw new Error('Invalid Products API response');
    const rawProducts=value_(response,'products'), rawToken=value_(response,'nextPageToken');
    if(rawProducts!==undefined && !Array.isArray(rawProducts))throw new Error('Invalid products collection');
    if(rawToken!==undefined && rawToken!==null && typeof rawToken!=='string')throw new Error('Invalid pagination token');
    const batch = array_(value_(response, 'products'));
    out.push(...batch.slice(0, remaining));
    token = value_(response, 'nextPageToken') || '';
    if (batch.length > remaining) return { items: out, complete: false, reason: 'Response exceeded remaining cap', calls };
    if (!token) return { items: out, complete: true, reason: '', calls };
    if (seenTokens.has(token)) return { items: out, complete: false, reason: 'Repeated pagination token', calls };
    seenTokens.add(token);
  }
}
function normalise_(raw) {
  const offer = text_(value_(raw, 'offerId')), label = text_(value_(raw, 'feedLabel')), lang = text_(value_(raw, 'contentLanguage')).toLowerCase();
  if (!offer || !label || !lang) throw new Error('Product identity fields missing; refusing an ambiguous baseline.');
  const attrs = value_(raw, 'productAttributes');
  if (!attrs) throw new Error('productAttributes missing; check the enabled Products API version.');
  const status = value_(raw, 'productStatus');
  if (!status) throw new Error('productStatus missing; status coverage cannot be established.');
  const contexts = {};
  array_(value_(status, 'destinationStatuses')).forEach(d => {
    const c = text_(value_(d, 'reportingContext'));
    if (!c) return;
    const country = {};
    [['approvedCountries','APPROVED'],['pendingCountries','PENDING'],['disapprovedCountries','DISAPPROVED']].forEach(pair => {
      array_(value_(d, pair[0])).forEach(x => { country[text_(x)] = pair[1]; });
    });
    contexts[c] = country;
  });
  const issues = array_(value_(status, 'itemLevelIssues')).map(i => ({ code: text_(value_(i,'code')),
    context: text_(value_(i,'reportingContext')), countries: array_(value_(i,'applicableCountries')),
    severity: text_(value_(i,'severity')), detail: text_(value_(i,'description') || value_(i,'detail')),
    attribute: text_(value_(i,'attribute')), url: safeUrl_(value_(i,'documentation')) }));
  const price = value_(attrs,'price'), micros = value_(price,'amountMicros');
  const amount = micros === undefined || micros === null || micros === '' ? null : Number(micros) / 1e6;
  const sale = value_(attrs,'salePrice');
  const saleMicros = value_(sale,'amountMicros');
  return { key: productKey_(offer,label,lang), offer, label, lang,
    title: text_(value_(attrs,'title')), price: Number.isFinite(amount) ? amount : null,
    currency: text_(value_(price,'currencyCode')), availability: text_(value_(attrs,'availability')).toUpperCase(),
    labels: [0,1,2,3,4].map(i => text_(value_(attrs,'customLabel'+i))),
    source: text_(value_(raw,'dataSource')), contexts, issues,
    created: parseTime_(value_(status,'creationDate')), expires: parseTime_(value_(status,'googleExpirationDate')),
    link: safeUrl_(value_(attrs,'link')), archived: value_(raw,'archived') === true,
    salePrice: saleMicros === undefined ? null : Number(saleMicros)/1e6,
    saleCurrency: text_(value_(sale,'currencyCode')), salePeriod: value_(attrs,'salePriceEffectiveDate') || null };
}
// Compact per-product status for state: only monitored contexts, countries grouped by
// status, e.g. "F:A=US|S:A=CA,US;D=GB". Older v2.0.0 state stored an object; both decode.
const CONTEXT_CODES={SHOPPING_ADS:'S',FREE_LISTINGS:'F'}, STATUS_CODES={APPROVED:'A',PENDING:'P',DISAPPROVED:'D'};
function encodeContexts_(contexts) {
  return CONFIG.MONITORED_CONTEXTS.slice().sort().filter(c=>contexts[c]).map(c=> {
    const by={};Object.keys(contexts[c]).sort().forEach(country=>{const st=STATUS_CODES[contexts[c][country]];if(st)(by[st]=by[st]||[]).push(country);});
    return (CONTEXT_CODES[c]||c)+':'+Object.keys(by).sort().map(st=>st+'='+by[st].join(',')).join(';');
  }).join('|');
}
function decodeContexts_(v) {
  if(v&&typeof v==='object')return v;
  const out={}, contextNames={}, statusNames={};
  Object.keys(CONTEXT_CODES).forEach(k=>{contextNames[CONTEXT_CODES[k]]=k;});
  Object.keys(STATUS_CODES).forEach(k=>{statusNames[STATUS_CODES[k]]=k;});
  text_(v).split('|').filter(Boolean).forEach(part=> {
    const at=part.indexOf(':'), context=contextNames[part.slice(0,at)]||part.slice(0,at), map=out[context]={};
    part.slice(at+1).split(';').filter(Boolean).forEach(group=>{const [st,list]=group.split('=');(list||'').split(',').filter(Boolean).forEach(country=>{map[country]=statusNames[st];});});
  });
  return out;
}
function productKey_(offer,label,lang) { return JSON.stringify([String(offer),String(label),String(lang).toLowerCase()]); }
function joinKey_(offer,label,lang) { return productKey_(String(offer).toLowerCase(),label,lang); }
function countryKey_(p,context,country) { return JSON.stringify([context,country,p.label,p.lang]); }
function groupKey_(p) { return JSON.stringify([p.label,p.lang]); }

function readSpend_(feed, deadline) {
  if (feed.monitorSpend === false) return { complete: true, disabled: true, map: {}, currency: '', note: 'Spend monitoring disabled' };
  if (Date.now() >= deadline) return { complete: false, map: {}, currency: '', note: 'Spend stage not checked: deadline' };
  try {
    if (typeof AdsApp === 'undefined') throw new Error('Google Ads service unavailable');
    if (typeof AdsManagerApp !== 'undefined') {
      if (!feed.adsCustomerId) throw new Error('Set adsCustomerId for each MCC merchant');
      const accounts = AdsManagerApp.accounts().withIds([String(feed.adsCustomerId)]).get();
      if (!accounts.hasNext()) throw new Error('Configured Ads account is not accessible from this manager');
      AdsManagerApp.select(accounts.next());
    } else if (feed.adsCustomerId && digits_(AdsApp.currentAccount().getCustomerId()) !== digits_(feed.adsCustomerId)) {
      throw new Error('adsCustomerId does not match the current single Ads account');
    }
    const currency = AdsApp.currentAccount().getCurrencyCode();
    const languages = {};
    let languageRows = retry_(() => AdsApp.search('SELECT language_constant.resource_name, language_constant.code FROM language_constant'), deadline);
    while (languageRows.hasNext()) {
      if (Date.now() >= deadline) throw new Error('Deadline reading language constants');
      const r = languageRows.next(); languages[r.languageConstant.resourceName] = r.languageConstant.code;
    }
    const q = 'SELECT segments.product_item_id, segments.product_feed_label, segments.product_language, ' +
      'metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value ' +
      'FROM shopping_performance_view WHERE segments.product_merchant_id = ' + feed.merchantId +
      " AND segments.product_channel = 'ONLINE' AND segments.date DURING " + CONFIG.SPEND_DATE_RANGE + ' AND metrics.impressions > 0';
    const rows = retry_(() => AdsApp.search(q), deadline), map = {};
    let n = 0;
    while (rows.hasNext()) {
      if (Date.now() >= deadline || n >= CONFIG.MAX_ADS_ROWS) throw new Error('Incomplete Ads report (deadline or row cap)');
      const r = rows.next(); n++;
      const seg = r.segments || {}, m = r.metrics || {};
      const lang = languages[seg.productLanguage] || (/^[a-z]{2,3}(-[a-zA-Z]{2,4})?$/.test(seg.productLanguage || '') ? seg.productLanguage : '');
      if (!lang || seg.productFeedLabel === undefined || !seg.productItemId) throw new Error('Ads identity/language could not be resolved');
      const k = joinKey_(seg.productItemId,seg.productFeedLabel,lang);
      const a = map[k] || (map[k] = { cost: 0, clicks: 0, conversions: 0, value: 0 });
      [['cost','costMicros',1e6],['clicks','clicks',1],['conversions','conversions',1],['value','conversionsValue',1]].forEach(x => {
        const num = Number(m[x[1]] || 0) / x[2];
        if (!Number.isFinite(num)) throw new Error('Non-numeric Ads metric');
        a[x[0]] += num;
      });
    }
    return { complete: true, disabled: false, map, currency, note: '', rows: n };
  } catch (e) { return { complete: false, map: {}, currency: '', note: error_(e) }; }
}
function assignSpend_(products, spend) {
  const counts = {};
  products.forEach(p => { const k=joinKey_(p.offer,p.label,p.lang); counts[k]=(counts[k]||0)+1; });
  let ambiguous = 0;
  products.forEach(p => {
    const k=joinKey_(p.offer,p.label,p.lang);
    if (counts[k] > 1) ambiguous++;
    p.spend = spend.complete && !spend.disabled && counts[k] === 1 ? (spend.map[k] || {cost:0,clicks:0,conversions:0,value:0}) : null;
    p.spendCurrency = spend.currency;
  });
  const matched=new Set(products.map(p=>joinKey_(p.offer,p.label,p.lang)));
  return {ambiguous,unmatched:spend.complete?Object.keys(spend.map).filter(k=>!matched.has(k)).length:0};
}
function readFileSources_(feed, deadline) {
  const statuses = [], issues = [];
  (feed.fileDataSources || []).forEach(s => {
    try {
      if (Date.now() >= deadline) throw new Error('File source not checked: deadline');
      const name='accounts/'+feed.merchantId+'/dataSources/'+s.id+'/fileUploads/latest';
      const r=retry_(() => service_('DataSources').Accounts.DataSources.FileUploads.get(name), deadline);
      const at=parseTime_(value_(r,'uploadTime')), status=text_(value_(r,'processingState'));
      if(!['SUCCEEDED','FAILED','IN_PROGRESS'].includes(status))throw new Error('File upload processing state unavailable or unsupported');
      statuses.push({id:String(s.id), time:at, status, items:text_(value_(r,'itemsTotal'))});
      if (!at || Date.now()-at>s.maxAgeHours*3600000 || status==='FAILED') issues.push({id:String(s.id),detail:'Last upload '+(at?iso_(at):'unknown')+'; processing '+status});
    } catch(e) { issues.push({id:String(s.id),detail:'Coverage unknown: '+error_(e), unknown:true}); }
  });
  return { statuses, issues, complete: !issues.some(x=>x.unknown) };
}

function inspectFeed_(feed, previous, existing, scan, spend, sourceStatus, now) {
  const alerts=[], products=[], ids=new Set();
  let invalid=0;
  scan.items.forEach(raw => { try {
    const p=normalise_(raw);
    if(ids.has(p.key)) throw new Error('Duplicate full product identity');
    ids.add(p.key); if(!p.archived) products.push(p);
  } catch(e) { invalid++; } });
  const join=assignSpend_(products,spend), ambiguous=join.ambiguous;
  const watched=new Set(products.filter(p=>p.spend&&p.spend.cost>0).sort((a,b)=>b.spend.cost-a.spend.cost).slice(0,CONFIG.PRICE_WATCH_TOP_N).map(p=>p.key));
  const complete=scan.complete && !invalid;
  function add(check, group, severity, detail, action, affected, reference, kind) {
    const candidates=affected || [];
    const ranked=candidates.slice().sort((a,b)=>priority_(b,feed)-priority_(a,feed));
    const a={id:incidentId_(feed.merchantId,check,group), merchantId:feed.merchantId, feedName:feed.name,
      check, group, severity, detail, action, count:candidates.length, samples:ranked.slice(0,5).map(p=>p.offer+' ['+p.label+'/'+p.lang+']'),
      cost:round_(candidates.reduce((n,p)=>n+(p.spend?p.spend.cost:0),0)), currency:spend.currency,
      fingerprint:hash_(candidates.map(p=>p.key).sort().join('\n')), reference:reference===undefined?null:reference, kind:kind||'CONDITION'};
    alerts.push(a); return a;
  }
  function reference(check,group,fallback) { const i=existing[incidentId_(feed.merchantId,check,group)]; return i && i.active && i.reference!==null ? i.reference : fallback; }
  if(!complete) add('Catalog coverage incomplete','', 'CRITICAL', scan.reason+(invalid?'; '+invalid+' invalid product records':''), 'Resolve the API, identity, row cap or deadline issue. Prior baseline is retained.');
  if(!spend.complete) add('Spend unavailable','', 'WARNING', spend.note, 'Check Ads account access, quota, language mapping and the configured time window. Feed health still runs.');
  if(ambiguous) add('Ambiguous Ads identity','', 'WARNING', ambiguous+' case-colliding products were not assigned spend.', 'Use unique case-insensitive offer IDs within each feed label and language; no duplicate spend was allocated.');
  if(join.unmatched && scan.complete) add('Historical Ads identities not in catalog','', 'WARNING',join.unmatched+' Ads product identities had historical activity but were not found in this catalog.','Check removals, feed-label/language mapping, archived products and account selection. No spend was assigned to a different product.');
  sourceStatus.issues.forEach(s=>add(s.unknown?'File source coverage unknown':'File source failed or stale',s.id,'WARNING',s.detail,'Check the configured file source upload and schedule in Merchant Center.'));
  if(complete && !products.length && !feed.allowEmpty) add('Empty catalog','', 'CRITICAL','No non-archived products returned.', 'Check account selection, product expiration, deletions and primary data source processing.');
  const fresh=previous && now-previous.at<=CONFIG.BASELINE_MAX_AGE_DAYS*DAY_MS;
  if(previous && !fresh) add('Baseline stale','', 'WARNING', 'Last complete baseline: '+iso_(previous.at), 'Check scheduling. Change checks wait for a fresh baseline; absolute checks continue.',[],null,'EVENT');
  const groups={}, markets={}, sources={}, compact={}, disapproved=[], tiny=[], missingPrice=[], currencyChanges=[], priceChanges=[], expiring=[];
  const history=previous ? (previous.history||[]).filter(h=>now-Date.parse(h.date+'T00:00:00Z')<=CONFIG.BASELINE_MAX_AGE_DAYS*DAY_MS && h.date!==date_(now)) : [];
  products.forEach(p=> {
    const gk=groupKey_(p), g=groups[gk]||(groups[gk]={total:0,fill:[0,0,0,0,0],prefixes:Object.create(null),recent:0,ids:0});
    g.total++; p.labels.forEach((v,i)=>{if(v.trim())g.fill[i]++;});
    const prefix=prefix_(p.offer); g.prefixes[prefix]=(g.prefixes[prefix]||0)+1;
    if(p.created && p.created<=now && now-p.created<=2*DAY_MS)g.recent++;
    if(fresh && !Object.prototype.hasOwnProperty.call(previous.products,p.key)) g.ids++;
    if(p.source) sources[p.source]=(sources[p.source]||0)+1;
    const known=previous && previous.products[p.key], knownContexts=known?decodeContexts_(known[2]):null;
    p.blocked=[]; p.newBlocked=[]; p.limited=[];
    CONFIG.MONITORED_CONTEXTS.forEach(context=> {
      Object.keys(p.contexts[context]||{}).forEach(country=> {
        if(feed.countries && feed.countries.length && !feed.countries.includes(country))return;
        const mk=countryKey_(p,context,country), m=markets[mk]||(markets[mk]={context,country,label:p.label,lang:p.lang,total:0,approved:0,disapproved:0,pending:0,outOfStock:0,limited:0,affected:[]});
        const s=p.contexts[context][country];m.total++;
        if(s==='APPROVED')m.approved++;
        if(s==='DISAPPROVED') { m.disapproved++;m.affected.push(p);p.blocked.push(context+':'+country);
          if(!knownContexts || !knownContexts[context] || knownContexts[context][country]!=='DISAPPROVED')p.newBlocked.push(context+':'+country);
        }
        if(s==='PENDING')m.pending++;
        if(p.availability==='OUT_OF_STOCK')m.outOfStock++;
        if(p.issues.some(i=>i.severity==='DEMOTED' && i.context===context && (!i.countries.length||i.countries.includes(country)))) {m.limited++;p.limited.push(context+':'+country);}
      });
    });
    if(p.blocked.length)disapproved.push(p);
    if(p.price===null || !p.currency)missingPrice.push(p);
    else if(p.price<=0 || (CONFIG.MIN_PRICE_BY_CURRENCY[p.currency]!==undefined && p.price<CONFIG.MIN_PRICE_BY_CURRENCY[p.currency]))tiny.push(p);
    if(p.expires && p.expires-now<=CONFIG.EXPIRY_WARNING_DAYS*DAY_MS)expiring.push(p);
    if(fresh && known && spend.complete && (watched.has(p.key) || (existing[incidentId_(feed.merchantId,'Price changed',p.key)]||{}).active)) {
      const old=reference('Price changed',p.key,{price:known[0],currency:known[1]});
      if(p.currency!==old.currency)currencyChanges.push(p);
      else if(old.price>0 && p.price>0 && Math.max(p.price/old.price,old.price/p.price)>=CONFIG.PRICE_CHANGE_FACTOR) {
        priceChanges.push(p);add('Price changed',p.key,'WARNING',old.price+' → '+p.price+' '+p.currency+' (regular price; not a forecast of loss).','Verify store price, micros conversion and intentional repricing. Sale price is reported separately.',[p],old);
      }
    }
    compact[p.key]=[p.price,p.currency,encodeContexts_(p.contexts)]; // labels/source per product were never read back
  });
  Object.keys(groups).forEach(k=>{groups[k].fill=groups[k].fill.map(n=>round_(100*n/groups[k].total));});
  if(complete && products.length && !Object.keys(markets).length) add('No monitored destination status','', 'WARNING', 'Products exist but no requested context/country status was returned.', 'Check intended destinations and country filters. This is not an all-clear.');
  if(complete && feed.countries && feed.countries.length) feed.countries.forEach(c=> {
    if(products.length && !Object.values(markets).some(m=>m.country===c))add('Expected country missing',c,'CRITICAL','No monitored product statuses for configured country '+c+'.','Check target-country settings and per-surface approval. A feed label alone does not establish country coverage.');
  });
  Object.keys(markets).forEach(k=> {
    const m=markets[k], title=[m.context,m.country,m.label,m.lang].join(' / ');
    if(m.disapproved) {
      // Open only when the disapprovals matter: all products blocked, a minimum count or
      // share, or a product that had Ads clicks. Once open, stay open until none remain
      // (no false "recovered" while disapprovals are still there).
      const reasons=disapprovalReasons_(m), wasOpen=(existing[incidentId_(feed.merchantId,'Products disapproved',k)]||{}).active;
      if(reasons.length||wasOpen) add('Products disapproved',k,m.approved===0?'CRITICAL':'WARNING',m.disapproved+'/'+m.total+' products disapproved in '+title+(reasons.length?' ('+reasons.join('; ')+')':'')+'.','Use issue codes and Google help links in Products; historical product spend can overlap between country alerts.',m.affected);
    }
    if(complete && m.approved===0 && m.total>0 && !m.disapproved) add('No approved products',k,'WARNING',title+': zero approved; '+m.pending+' pending.','Check processing and review status in Merchant Center.');
    if(complete && fresh) {
      const values=history.filter(h=>h.markets[k]).map(h=>h.markets[k].approved);
      if(!values.length && previous.markets[k])values.push(previous.markets[k].approved);
      const average=values.length?values.reduce((a,b)=>a+b,0)/values.length:0;
      const ref=reference('Eligible products dropped',k,average);
      if(ref>=CONFIG.MIN_GROUP_SIZE && m.approved<ref*(1-CONFIG.ELIGIBLE_DROP_PCT/100))add('Eligible products dropped',k,m.approved===0?'CRITICAL':'WARNING',title+': '+m.approved+' approved vs reference '+round_(ref)+'.','Check country-specific disapprovals, processing and recent removals.',[],ref);
      const old=previous.markets[k];
      if(old && m.disapproved-old.disapproved>=CONFIG.DISAPPROVAL_SPIKE_MIN)add('Disapprovals rising',k,'WARNING',(m.disapproved-old.disapproved)+' additional disapprovals in '+title+'.','Compare issue codes and recent source changes.',m.affected,null,'EVENT');
    }
    if(CONFIG.ALERT_OUT_OF_STOCK && m.total>=CONFIG.MIN_GROUP_SIZE && 100*m.outOfStock/m.total>=CONFIG.OUT_OF_STOCK_PCT)add('High out-of-stock share',k,'WARNING',m.outOfStock+'/'+m.total+' products out of stock in '+title+'.','Confirm inventory accuracy and expected seasonal changes. Out-of-stock products need not be deleted.');
  });
  const expectedMarkets=Object.assign({},previous?previous.expectedMarkets:{}), expectedGroups=Object.assign({},previous?previous.expectedGroups:{});
  if(complete) {
    Object.keys(expectedMarkets).forEach(k=> {if(!markets[k] && expectedMarkets[k].approved>=CONFIG.MIN_GROUP_SIZE)add('Country/surface group gone',k,'CRITICAL',k+' has no statuses; previously '+expectedMarkets[k].approved+' approved.','Check destination, country and feed-label settings. This remains open until coverage returns.');});
    Object.keys(expectedGroups).forEach(k=> {if(!groups[k] && expectedGroups[k]>=CONFIG.MIN_GROUP_SIZE)add('Feed label gone',k,'CRITICAL','No products in feed-label/language group '+k+'.','Check primary source, sync, expiration and intentional removals.');});
    Object.keys(markets).forEach(k=> {expectedMarkets[k]={approved:Math.max((expectedMarkets[k]||{}).approved||0,markets[k].approved)};});
    Object.keys(groups).forEach(k=> {expectedGroups[k]=Math.max(expectedGroups[k]||0,groups[k].total);});
  }
  if(complete && fresh) Object.keys(groups).forEach(k=> {
    const g=groups[k],old=previous.groups[k];if(!old)return;
    g.fill.forEach((pct,i)=> {
      const id=k+':'+i,was=reference('Custom label fill dropped',id,old.fill[i]);
      if(was>=10 && was-pct>=CONFIG.LABEL_FILL_DROP_POINTS)add('Custom label fill dropped',id,'WARNING','custom_label_'+i+' fill '+was+'% → '+pct+'% in '+k+'.','Inspect supplemental rules and apps. This is a symptom; the cause is not proven.',[],was);
    });
    if(g.total>=CONFIG.MIN_GROUP_SIZE) {
      Object.keys(g.prefixes).forEach(prefix=> { const share=100*g.prefixes[prefix]/g.total;
        if(share>=CONFIG.NEW_ID_PATTERN_SHARE_PCT && !Object.prototype.hasOwnProperty.call(old.prefixes,prefix)) add('Offer ID pattern changed',k+':'+prefix,'WARNING','New pattern '+prefix+' covers '+round_(share)+'% of '+k+'.','Check ID stability and ID-based rules. All previous prefixes are retained, not only the top five.',[],null,'EVENT');
      });
      if(100*g.ids/g.total>=CONFIG.ID_CHURN_PCT)add('Many new offer IDs',k,'WARNING',g.ids+'/'+g.total+' identities are new since the last complete scan.','Confirm a planned launch or ID migration. Numeric-only ID changes are included.',[],null,'EVENT');
      if(100*g.recent/g.total>=CONFIG.NEW_PRODUCTS_PCT)add('Many recently created products',k,'WARNING',g.recent+'/'+g.total+' products were created in the last 48 hours.','Confirm a planned catalog launch or migration.',[],null,'EVENT');
    }
  });
  if(complete && fresh) {
    const expectedSources=Object.assign({},previous.sources);
    Object.values(existing).filter(i=>i.merchantId===feed.merchantId && i.active && i.check==='Primary source empty').forEach(i=>{expectedSources[i.group]=CONFIG.MIN_GROUP_SIZE;});
    Object.keys(expectedSources).forEach(s=> {if(expectedSources[s]>=CONFIG.MIN_GROUP_SIZE && !sources[s])add('Primary source empty',s,'WARNING','Previously observed primary data source now has no products: '+s,'Check source processing. Supplemental sources require separate configured file-upload checks.');});
  }
  if(tiny.length)add('Zero or tiny prices','',tiny.some(p=>p.spend&&p.spend.cost>0)?'CRITICAL':'WARNING',tiny.length+' products have zero/negative prices or fall below their configured currency threshold.','Verify amountMicros: 15.99 units = 15990000 micros. Check legitimate low-priced items.',tiny);
  if(missingPrice.length)add('Price data missing','', 'WARNING',missingPrice.length+' products lack a usable price or currency.','Check product data and API field coverage.',missingPrice);
  if(currencyChanges.length)add('Product currency changed','', 'WARNING',currencyChanges.length+' spending products changed currency; price ratios were not calculated.','Confirm currency/feed changes. No exchange-rate assumptions were made.',currencyChanges,null,'EVENT');
  if(expiring.length)add('Products expiring','', 'WARNING',expiring.length+' products expire within '+CONFIG.EXPIRY_WARNING_DAYS+' days or are expired.','Check source refreshes and expiration dates.',expiring);
  const newSpenders=disapproved.filter(p=>p.spend&&p.spend.cost>0&&p.newBlocked.length);
  if(newSpenders.length)add('Spending products newly disapproved','', 'WARNING',newSpenders.length+' spending products have a newly observed blocked context/country.','Prioritize the Products report. Cost is historical, not money currently being spent on a disapproved product.',newSpenders,null,'EVENT');
  const safeMarkets={};Object.keys(markets).forEach(k=>{const m=markets[k];safeMarkets[k]={context:m.context,country:m.country,label:m.label,lang:m.lang,total:m.total,approved:m.approved,disapproved:m.disapproved,pending:m.pending,outOfStock:m.outOfStock,limited:m.limited};});
  const next=complete?{scope:scope_(feed),at:now, products:compact, groups, markets:safeMarkets,sources,expectedMarkets,expectedGroups,
    history:history.concat([{date:date_(now),markets:safeMarkets}]).slice(-8)}:previous;
  return {feed,products,groups,markets:safeMarkets,disapproved,alerts,next,catalogComplete:complete,
    complete:complete&&spend.complete&&sourceStatus.complete&&!ambiguous,baselineStale:!!previous&&!fresh,spend,sourceStatus,read:scan.items.length,reason:scan.reason,at:now};
}
function disapprovalReasons_(m) {
  const reasons=[];
  if(m.approved===0)reasons.push('no approved products');
  if(m.disapproved>=CONFIG.DISAPPROVED_ALERT_MIN_PRODUCTS)reasons.push('at least '+CONFIG.DISAPPROVED_ALERT_MIN_PRODUCTS+' products');
  if(m.total&&100*m.disapproved/m.total>=CONFIG.DISAPPROVED_ALERT_MIN_PCT)reasons.push(round_(100*m.disapproved/m.total)+'% of products');
  const clicked=CONFIG.DISAPPROVED_ALERT_MIN_CLICKS>0?m.affected.filter(p=>p.spend&&p.spend.clicks>=CONFIG.DISAPPROVED_ALERT_MIN_CLICKS).length:0;
  if(clicked)reasons.push(clicked+' had Ads clicks in '+CONFIG.SPEND_DATE_RANGE);
  return reasons;
}
function priority_(p,feed) { return feed.conversionValueIsRevenue===true && Number.isFinite(feed.contributionMarginPct) && p.spend ? p.spend.value*feed.contributionMarginPct/100 : (p.spend?p.spend.cost:0); }
function incidentId_(merchant,check,group) { return JSON.stringify([merchant,check,group]); }
function prefix_(id) { const m=id.match(/^(shopify_[a-z]{2}_)/i);return m?m[1]:(id.match(/^[^0-9]*/)[0].slice(0,40)||'(numeric prefix)'); }

function freshState_() { return {schema:SCHEMA,instance:CONFIG.INSTANCE_ID,generation:0,feeds:{},incidents:{},outbox:[],sequence:0,lastRun:0}; }
function updateIncidents_(state,result,now) {
  const observed=new Set();
  function queue(i,type) {
    state.sequence++;
    state.outbox.push({id:state.sequence,at:now,type,incident:JSON.parse(JSON.stringify(i)),receipts:{}});
  }
  result.alerts.forEach(a=> {
    observed.add(a.id);
    const old=state.incidents[a.id];
    const reopen=!old || !old.active;
    const changed=old && !reopen && materialChange_(old,a);
    const remindHours=a.severity==='CRITICAL'?CONFIG.REMIND_AFTER_HOURS:CONFIG.REMIND_WARNINGS_AFTER_HOURS;
    const remind=old && remindHours>0 && now-(old.queuedAt||0)>=remindHours*3600000;
    const i=Object.assign({},old||{},a,{active:true,firstSeen:reopen?now:old.firstSeen,lastSeen:now,
      notifiedCount:old&&!reopen?(old.notifiedCount!==undefined?old.notifiedCount:old.count):a.count});
    state.incidents[a.id]=i;
    // Avoid repeated reminder copies while an earlier revision is still pending.
    const pending=state.outbox.some(e=>e.incident.id===a.id && pendingForCurrentChannels_(e));
    if(reopen || changed || (remind&&!pending&&a.kind!=='EVENT')) { i.queuedAt=now;i.notifiedCount=a.count;queue(i,reopen?'OPEN':changed?'CHANGED':'REMINDER'); }
  });
  // Never infer recovery from a truncated, failed or skipped observation. Each check
  // recovers only when the data it depends on was read completely in this run, so an
  // Ads reporting outage no longer keeps Merchant Center incidents open forever.
  Object.values(state.incidents).forEach(i=> {
    if(i.merchantId!==result.feed.merchantId || !i.active || observed.has(i.id))return;
    // The check can no longer be evaluated because its source was removed from CONFIG:
    // close it as a recorded event, without claiming a recovery.
    if(noLongerMonitored_(i,result)) {i.active=false;i.resolvedAt=now;i.kind='EVENT';return;}
    if(!recoveryObserved_(i,result))return;
    if(result.baselineStale && ['Price changed','Eligible products dropped','Custom label fill dropped','Primary source empty'].includes(i.check))return;
    // A vanished market is not evidence that its approvals recovered.
    if(['Products disapproved','No approved products','Eligible products dropped'].includes(i.check)&&!result.markets[i.group])return;
    if(i.check==='Price changed'&&!result.products.some(p=>p.key===i.group))return;
    i.active=false;i.resolvedAt=now;
    if(i.kind!=='EVENT')queue(i,'RECOVERED');
  });
  // Retire old events only after all currently configured destinations received them.
  state.outbox=state.outbox.filter(e=>now-e.at<30*DAY_MS || pendingForCurrentChannels_(e));
  Object.keys(state.incidents).forEach(k=>{const i=state.incidents[k];if(!i.active&&now-(i.resolvedAt||i.lastSeen)>30*DAY_MS&&!state.outbox.some(e=>e.incident.id===k))delete state.incidents[k];});
}
// Checks whose evidence is a list of products. For these, a CHANGED notice needs a
// material change in the number of affected products since the last notice, not just
// one product swapping in or out. Other checks notify on any change in evidence.
const COUNT_CHECKS=['Products disapproved','Zero or tiny prices','Price data missing','Products expiring'];
function materialChange_(old,a) {
  if(ORDER[a.severity]<ORDER[old.severity])return true;
  if(a.fingerprint===old.fingerprint)return false;
  if(!COUNT_CHECKS.includes(a.check))return true;
  const before=Number(old.notifiedCount!==undefined?old.notifiedCount:old.count)||0;
  return Math.abs(a.count-before)>=Math.max(CONFIG.CHANGE_MIN_PRODUCTS,Math.ceil(before*CONFIG.CHANGE_MIN_PCT/100));
}
const SPEND_CHECKS=['Price changed','Historical Ads identities not in catalog','Spending products newly disapproved'];
const FILE_CHECKS=['File source failed or stale','File source coverage unknown'];
function noLongerMonitored_(i,result) {
  if(FILE_CHECKS.includes(i.check))return !(result.feed.fileDataSources||[]).some(s=>String(s.id)===i.group);
  return !!result.spend.disabled&&['Historical Ads identities not in catalog','Spending products newly disapproved'].includes(i.check);
}
function recoveryObserved_(i,result) {
  if(i.check==='Spend unavailable')return !!result.spend.complete;
  if(FILE_CHECKS.includes(i.check))return result.sourceStatus.statuses.some(s=>s.id===i.group);
  if(!result.catalogComplete)return false;
  // With spend disabled, open price incidents are still re-checked against the catalog,
  // so a complete (disabled) spend stage is valid evidence for "Price changed".
  if(SPEND_CHECKS.includes(i.check))return !!result.spend.complete;
  return true;
}
function channels_() {
  const channels=[];
  if(CONFIG.EMAILS.length)channels.push({key:'email:'+hash_(CONFIG.EMAILS.slice().sort().join(',')),type:'email'});
  if(CONFIG.WEBHOOK_URL)channels.push({key:'webhook:'+hash_(CONFIG.WEBHOOK_URL),type:'webhook'});
  return channels;
}
function pendingForCurrentChannels_(event) { const c=channels_();return !c.length||c.some(x=>!event.receipts[x.key]); }
function snoozed_(i,now) { return CONFIG.SNOOZES.some(s=>(!s.merchantId||s.merchantId===i.merchantId)&&(!s.check||s.check===i.check)&&Date.parse(s.until)>now); }
function deliveryBatch_(state,channel,now) {
  return state.outbox.filter(e=>!e.receipts[channel.key]&&!snoozed_(e.incident,now))
    .sort((a,b)=>ORDER[a.incident.severity]-ORDER[b.incident.severity]||a.at-b.at||a.id-b.id).slice(0,CONFIG.MAX_ALERTS_PER_MESSAGE);
}
function deliver_(state,ss,results,deadline) {
  const attempts=[];
  if(!sendAllowed_()) {log_('Preview: notifications suppressed; outbox remains pending.');return attempts;}
  channels_().forEach(channel=> {
    const batch=deliveryBatch_(state,channel,Date.now());
    const healthy=results.length===CONFIG.FEEDS.length&&results.every(r=>r.complete)&&!Object.values(state.incidents).some(i=>i.active);
    if(!batch.length && !(CONFIG.SEND_WHEN_HEALTHY&&healthy))return;
    if(Date.now()>=deadline) {attempts.push([iso_(Date.now()),channel.type,'DEFERRED','Delivery deadline; events retained']);return;}
    let body=messageText_(batch,results,ss.getUrl());
    if(channel.type==='webhook') {
      while(batch.length>1 && body.length>6000) {batch.pop();body=messageText_(batch,results,ss.getUrl());}
      if(body.length>6000)body=body.slice(0,5600)+'\nMessage shortened. Full evidence: '+ss.getUrl();
    }
    const subject='[MCFM '+(batch.some(e=>e.type!=='RECOVERED'&&e.incident.severity==='CRITICAL')?'CRITICAL':batch.length?'UPDATE':'OK')+'] '+date_(Date.now())+' | '+batch.length+' events';
    const html=channel.type==='email'?messageHtml_(batch,results,ss.getUrl()):'';
    try {
      if(channel.type==='email') retry_(()=>MailApp.sendEmail({to:CONFIG.EMAILS.join(','),subject,body,htmlBody:html}),deadline);
      else post_(CONFIG.WEBHOOK_URL,{text:subject+'\n'+body},deadline);
      batch.forEach(e=>{e.receipts[channel.key]=iso_(Date.now());});
      saveState_(ss,state); // Commit receipts after each successful destination.
      attempts.push([iso_(Date.now()),channel.type,'ACCEPTED',batch.map(e=>e.id).join(',')]);
    } catch(e) {
      attempts.push([iso_(Date.now()),channel.type,'FAILED',error_(e)]);
      log_('Delivery failed for '+channel.type+': '+error_(e)+'. Events retained for retry.');
      // Continue to the other channel; never let email failure block webhooks.
    }
  });
  return attempts;
}
function post_(url,payload,deadline) {
  return retry_(()=> {
    const r=UrlFetchApp.fetch(url,{method:'post',contentType:'application/json',payload:JSON.stringify(payload),muteHttpExceptions:true,followRedirects:false});
    const code=r.getResponseCode();
    if(code<200||code>=300)throw new Error('Webhook HTTP '+code);
    return r;
  },deadline);
}
function messageText_(batch,results,url) {
  const lines=['Merchant Center Feed Health Monitor '+VERSION, ''];
  results.slice(0,10).forEach(r=>lines.push(r.feed.name.slice(0,160)+': '+r.products.length+' products; catalog '+(r.catalogComplete?'complete':'INCOMPLETE')+'; spend '+(r.spend.disabled?'disabled':r.spend.complete?'complete':'UNKNOWN')));
  if(results.length>10)lines.push((results.length-10)+' additional merchants are in the report.');
  batch.forEach(e=>{const i=e.incident;lines.push('\n#'+e.id+' '+e.type+' '+i.severity+' | '+i.feedName+' | '+i.check+'\n'+i.detail+'\nNext: '+i.action+(i.samples.length?'\nExamples: '+i.samples.join('; '):'')+'\nObserved: '+iso_(e.at));});
  lines.push('\nReport: '+url,'Historical spend is not current loss. Product totals may overlap between incidents.','Events not included in this batch remain queued.');
  return lines.join('\n');
}
function messageHtml_(batch,results,url) {
  return '<div style="font:14px/1.5 Arial,sans-serif;color:#18323b"><h2>Merchant Center feed health</h2><p>'+results.map(r=>esc_(r.feed.name)+': '+r.products.length+' products; '+(r.complete?'checks complete':'<b>coverage incomplete</b>')).join('<br>')+'</p>'+batch.map(e=>'<section style="border-left:4px solid '+(e.type==='RECOVERED'?'#157f52':e.incident.severity==='CRITICAL'?'#b42318':'#ad6800')+';padding:10px;margin:10px 0;background:#f3f6f7"><b>#'+e.id+' '+esc_(e.type+' | '+e.incident.feedName+' | '+e.incident.check)+'</b><p>'+esc_(e.incident.detail)+'</p><p>'+esc_(e.incident.action)+'</p><small>'+esc_(e.incident.samples.join('; '))+'</small></section>').join('')+'<p><a href="'+esc_(url)+'">Open report and delivery history</a></p><p>Historical spend is not current loss. Remaining events stay queued. Built by Ishant Sharma, Hustle Marketers.</p></div>';
}

// Alternating state slots: write/check/flush the inactive slot, then commit a
// single control pointer. Corrupt/incomplete state never silently becomes empty.
// Report lookup order: SPREADSHEET_URL, then Script Properties (Apps Script only), then
// a spreadsheet the authorizing user owns in Drive with this script's report name,
// then a new spreadsheet. Google Ads scripts support DriveApp but not PropertiesService.
function openSpreadsheet_() {
  if(CONFIG.SPREADSHEET_URL)return SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
  const props=optionalScriptProperties_(), key='MCFM_V2_SHEET_'+CONFIG.INSTANCE_ID;
  const remembered=props?props.getProperty(key):null;
  if(remembered)return SpreadsheetApp.openByUrl(remembered);
  const name=reportName_(), found=findOwnedReport_(name);
  if(found){if(props)props.setProperty(key,found.getUrl());log_('Using existing report "'+name+'": '+found.getUrl());return found;}
  // Never create a report that the next run could not find again (that would reset history every day).
  if(!props&&!driveSearchAvailable_())throw new Error('Set CONFIG.SPREADSHEET_URL: this runtime has neither Script Properties nor Drive search to find the report again.');
  const ss=SpreadsheetApp.create(name);
  if(props)props.setProperty(key,ss.getUrl());
  log_('Report created: '+ss.getUrl()+' . Recommended: copy this URL into CONFIG.SPREADSHEET_URL.');return ss;
}
function reportName_() {
  let account='';
  try{if(typeof AdsApp!=='undefined')account=digits_(AdsApp.currentAccount().getCustomerId());}catch(e){account='';}
  return 'Merchant Center Feed Health Monitor v2 - '+(account?'Ads '+account+' - ':'')+CONFIG.INSTANCE_ID;
}
function driveSearchAvailable_() {return typeof DriveApp!=='undefined'&&!!DriveApp&&typeof DriveApp.searchFiles==='function';}
function findOwnedReport_(name) {
  if(!driveSearchAvailable_())return null;
  const q="title = '"+name.replace(/\\/g,'\\\\').replace(/'/g,"\\'")+"' and 'me' in owners and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false";
  const matches=[];
  try{const files=DriveApp.searchFiles(q);while(files.hasNext())matches.push(files.next());}
  catch(e){throw new Error('Drive search for the report failed ('+error_(e)+'). Set CONFIG.SPREADSHEET_URL.');}
  if(matches.length>1)throw new Error(matches.length+' spreadsheets you own are named "'+name+'". Set CONFIG.SPREADSHEET_URL to the one this script should use.');
  return matches.length?SpreadsheetApp.openById(matches[0].getId()):null;
}
function loadState_(ss) {
  const control=ss.getSheetByName(TAB.CONTROL);
  if(!control||control.getLastRow()<2) {
    if([TAB.A,TAB.B].some(n=>{const s=ss.getSheetByName(n);return s&&s.getLastRow()>1;}))throw new Error('State exists without a committed pointer. Restore the control sheet or use a new dedicated spreadsheet.');
    return freshState_();
  }
  const ptr=control.getRange(2,1,1,2).getValues()[0], slot=text_(ptr[0]), generation=Number(ptr[1]);
  if(!['A','B'].includes(slot)||!Number.isInteger(generation))throw new Error('Invalid state commit pointer');
  const sheet=ss.getSheetByName(TAB[slot]);
  if(!sheet||sheet.getLastRow()<2)throw new Error('Committed state slot missing');
  const rows=sheet.getRange(2,1,sheet.getLastRow()-1,2).getValues();
  const meta=JSON.parse(text_(rows[0][1]));
  const chunks=rows.slice(1);
  if(meta.generation!==generation||chunks.length!==meta.chunks||chunks.some((r,i)=>Number(r[0])!==i))throw new Error('State generation/chunks mismatch');
  const serialized=chunks.map(r=>decodeCell_(r[1])).join('');
  if(serialized.length!==meta.length||sha_(serialized)!==meta.checksum)throw new Error('State checksum mismatch; stop to avoid losing history');
  const state=JSON.parse(serialized);
  if(state.schema!==SCHEMA||state.instance!==CONFIG.INSTANCE_ID||state.generation!==generation)throw new Error('State schema or instance mismatch');
  return state;
}
function saveState_(ss,state) {
  const control=sheet_(ss,TAB.CONTROL);
  const old=control.getLastRow()>1?text_(control.getRange(2,1).getValues()[0][0]):'B';
  const slot=old==='A'?'B':'A';
  const next=state.generation+1, previous=state.generation;
  state.generation=next;
  const serialized=JSON.stringify(state);
  if(serialized.length>CONFIG.MAX_STATE_CHARS) {state.generation=previous;throw new Error('State size limit reached. Split merchants across scripts; no baseline committed.');}
  if(serialized.length>0.8*CONFIG.MAX_STATE_CHARS)log_('Warning: saved state uses '+Math.round(100*serialized.length/CONFIG.MAX_STATE_CHARS)+'% of MAX_STATE_CHARS. Plan to split merchants across scripts.');
  const chunks=[];for(let i=0;i<serialized.length;i+=30000)chunks.push(serialized.slice(i,i+30000));
  try {
    writeTable_(ss,TAB[slot],['Chunk','Payload'],[['meta',JSON.stringify({generation:next,chunks:chunks.length,length:serialized.length,checksum:sha_(serialized)})]].concat(chunks.map((c,i)=>[i,'chunk:'+c])));
    SpreadsheetApp.flush();
    ensureGrid_(control,2,2);
    control.getRange(1,1,1,2).setValues([['Active slot','Generation']]);
    control.getRange(2,1,1,2).setValues([[slot,next]]);
    SpreadsheetApp.flush();
  } catch(e) {state.generation=previous;throw e;}
}
function sheet_(ss,name) {return ss.getSheetByName(name)||ss.insertSheet(name);}
function ensureGrid_(sheet,rows,cols) {
  if(sheet.getMaxRows()<rows)sheet.insertRowsAfter(sheet.getMaxRows(),rows-sheet.getMaxRows());
  if(sheet.getMaxColumns()<cols)sheet.insertColumnsAfter(sheet.getMaxColumns(),cols-sheet.getMaxColumns());
}
function safeCell_(v) {
  if(typeof v==='number')return Number.isFinite(v)?v:'';
  if(typeof v==='boolean')return v;
  const s=text_(v);
  // Prefix formula-looking and apostrophe-leading strings. Sheets consumes one
  // quote as a literal-text marker; decodeCell_ is only used for state chunks.
  return /^[\s\u0000-\u001f]*[=+\-@']/.test(s)?"'"+s:s;
}
function decodeCell_(v) {const s=text_(v);if(!s.startsWith('chunk:'))throw new Error('Invalid state chunk encoding');return s.slice(6);}
function writeTable_(ss,name,headers,rows) {
  const sheet=sheet_(ss,name);ensureGrid_(sheet,rows.length+1,headers.length);
  const oldRows=sheet.getLastRow();
  sheet.getRange(1,1,1,headers.length).setValues([headers]);
  for(let start=0;start<rows.length;start+=500) {
    const batch=rows.slice(start,start+500).map(r=>r.map(safeCell_));
    sheet.getRange(start+2,1,batch.length,headers.length).setNumberFormat('@').setValues(batch);
  }
  if(oldRows>rows.length+1)sheet.getRange(rows.length+2,1,oldRows-rows.length-1,Math.max(sheet.getLastColumn(),headers.length)).clearContent();
  sheet.setFrozenRows(1);return sheet;
}
function appendTable_(ss,name,headers,rows,limit) {
  const sheet=sheet_(ss,name), old=sheet.getLastRow()>1?sheet.getRange(2,1,sheet.getLastRow()-1,headers.length).getValues():[];
  return writeTable_(ss,name,headers,old.concat(rows).slice(-limit));
}

function runMonitor_(ss, lease) {
  const started=Date.now(), deadline=started+CONFIG.MAX_RUNTIME_MINUTES*60000;
  const readDeadline=deadline-CONFIG.RESERVE_SECONDS*1000;
  const state=loadState_(ss),results=[];
  const previousSequence=state.sequence;
  CONFIG.FEEDS.forEach(feed=> {
    let scan={items:[],complete:false,reason:'Not checked: runtime budget exhausted'},spend={map:{},complete:false,currency:'',note:'Not checked: runtime budget exhausted'},sources={statuses:[],issues:[],complete:false};
    if(Date.now()<readDeadline) {
      try { scan=readCatalog_(feed,readDeadline,CONFIG.MAX_PRODUCTS_PER_FEED); }
      catch(e) {scan={items:[],complete:false,reason:error_(e)};}
      // Failure of Ads reporting cannot prevent the independent Merchant scan.
      spend=readSpend_(feed,readDeadline);
      sources=readFileSources_(feed,readDeadline);
    }
    if(state.feeds[feed.merchantId] && state.feeds[feed.merchantId].scope!==scope_(feed)) {
      delete state.feeds[feed.merchantId];
      Object.values(state.incidents).filter(i=>i.merchantId===feed.merchantId&&i.active).forEach(i=>{i.active=false;i.resolvedAt=Date.now();i.kind='EVENT';});
      log_(feed.name+': monitoring scope changed; starting a new baseline, prior conditions retired without a recovery claim.');
    }
    const result=inspectFeed_(feed,state.feeds[feed.merchantId]||null,state.incidents,scan,spend,sources,Date.now());
    updateIncidents_(state,result,Date.now());
    if(result.catalogComplete)state.feeds[feed.merchantId]=result.next;
    results.push(result);
  });
  state.lastRun=Date.now();
  // Sheets has no atomic lock: confirm this run still holds the lease before writing state.
  if(lease&&!ownsLease_(lease))throw busy_('Another run took over the report lease. This run stopped before writing state.');
  // First durable commit contains ALL product state and queued incidents.
  saveState_(ss,state);
  writeReports_(ss,state,results);
  const delivery=deliver_(state,ss,results,deadline);
  if(CONFIG.HEARTBEAT_URL && sendAllowed_() && results.every(r=>r.complete) && !delivery.some(d=>d[2]!=='ACCEPTED')) {
    try {post_(CONFIG.HEARTBEAT_URL,{status:'complete',version:VERSION,at:iso_(Date.now())},deadline);delivery.push([iso_(Date.now()),'heartbeat','ACCEPTED','']);}
    catch(e) {delivery.push([iso_(Date.now()),'heartbeat','FAILED',error_(e)]);log_('Heartbeat failed: '+error_(e));}
  }
  appendTable_(ss,TAB.DELIVERY,['At UTC','Channel','Status','Detail'],delivery,CONFIG.MAX_EVENT_ROWS);
  appendTable_(ss,TAB.EVENTS,['Event ID','Observed UTC','Type','Merchant','Check','Severity','Evidence','Next action'],state.outbox.filter(e=>e.id>previousSequence).map(e=>[e.id,iso_(e.at),e.type,e.incident.merchantId,e.incident.check,e.incident.severity,e.incident.detail,e.incident.action]),CONFIG.MAX_EVENT_ROWS);
  results.forEach(r=>log_(r.feed.name+': '+r.products.length+' products; '+(r.complete?'complete':'INCOMPLETE')+'; '+r.alerts.length+' observations.'));
  log_('Report: '+ss.getUrl()+' | elapsed '+Math.round((Date.now()-started)/1000)+'s. Delivery acceptance is recorded separately.');
  return {results,delivery,report:ss.getUrl(),newEvents:state.sequence-previousSequence};
}
function writeReports_(ss,state,results) {
  appendTable_(ss,TAB.RUNS,['Run UTC','Merchant','Name','Products read','Catalog coverage','Spend coverage','File-source coverage','Total visible products','Report displayed','Evidence'],results.map(r=>[iso_(r.at),r.feed.merchantId,r.feed.name,r.read,r.catalogComplete?'COMPLETE':'INCOMPLETE',r.spend.disabled?'DISABLED':r.spend.complete?'COMPLETE':'UNKNOWN',r.sourceStatus.complete?'COMPLETE':'UNKNOWN',r.products.length,Math.min(CONFIG.MAX_REPORT_ROWS,r.products.length),r.reason||r.spend.note||'']),CONFIG.MAX_EVENT_ROWS);
  const marketRows=[];
  results.forEach(r=>Object.values(r.markets).forEach(m=>marketRows.push([iso_(r.at),r.feed.merchantId,r.feed.name,m.context,m.country,m.label,m.lang,m.total,m.approved,m.disapproved,m.pending,m.limited,m.outOfStock,r.catalogComplete?'COMPLETE':'INCOMPLETE'])));
  writeTable_(ss,TAB.GROUPS,['Observed UTC','Merchant','Name','Context','Country','Feed label','Language','Products','Approved','Disapproved','Pending','Demoted','Out of stock','Catalog coverage'],marketRows);
  const productRows=[];
  results.forEach(r=>r.products.slice().sort((a,b)=>Number(b.blocked.length>0)-Number(a.blocked.length>0)||priority_(b,r.feed)-priority_(a,r.feed)).slice(0,CONFIG.MAX_REPORT_ROWS).forEach(p=> {
    const modeled=r.feed.conversionValueIsRevenue===true&&Number.isFinite(r.feed.contributionMarginPct)&&p.spend ? round_(p.spend.value*r.feed.contributionMarginPct/100):'';
    productRows.push([iso_(r.at),r.feed.merchantId,r.feed.name,p.offer,p.label,p.lang,p.title,p.blocked.join(', '),p.newBlocked.join(', '),p.limited.join(', '),p.price===null?'':p.price,p.currency,p.salePrice===null?'':p.salePrice,p.saleCurrency,p.availability,p.spend?round_(p.spend.cost):'',p.spendCurrency,p.spend?p.spend.clicks:'',p.spend?round_(p.spend.conversions):'',p.spend?round_(p.spend.value):'',modeled,p.issues.filter(i=>CONFIG.MONITORED_CONTEXTS.includes(i.context)).map(i=>i.code+' ['+i.context+' '+i.countries.join(',')+']: '+i.detail).join(' | ').slice(0,20000),p.issues.map(i=>i.url).filter(Boolean).join('\n').slice(0,20000),p.link,p.key]);
  }));
  writeTable_(ss,TAB.PRODUCTS,['Observed UTC','Merchant','Name','Offer ID','Feed label','Language','Title','Disapproved contexts/countries','Newly observed blocks','Demoted contexts/countries','Regular price','Product currency','Sale price','Sale currency','Availability','Historical Ads cost (all countries)','Ads currency','Clicks','Conversions','Conversion value','Modeled historical contribution before ads','Issue details','Google issue help URLs','Landing page','Full identity'],productRows);
  const incidents=Object.values(state.incidents).sort((a,b)=>Number(b.active)-Number(a.active)||ORDER[a.severity]-ORDER[b.severity]||b.lastSeen-a.lastSeen);
  writeTable_(ss,TAB.INCIDENTS,['Incident ID','Merchant','Name','Status','Type','Severity','Check','Scope','First seen UTC','Last seen UTC','Evidence','Next action','Examples','Historical cost (overlap possible)','Ads currency','Snoozed'],incidents.map(i=>[i.id,i.merchantId,i.feedName,i.active?'OPEN':i.kind==='EVENT'?'RECORDED':'RECOVERED',i.kind,i.severity,i.check,i.group,iso_(i.firstSeen),iso_(i.lastSeen),i.detail,i.action,i.samples.join('; '),i.cost,i.currency,snoozed_(i,Date.now())?'YES':'NO']));
}
function runTest_() {
  const results=[], testReportName=reportName_(); // before readSpend_ can select a client account
  CONFIG.FEEDS.forEach(feed=> {
    function check(name,fn) {try {const message=fn();results.push({merchantId:feed.merchantId,check:name,ok:true,message});log_('PASS '+feed.name+' | '+name+': '+message);}catch(e){results.push({merchantId:feed.merchantId,check:name,ok:false,message:error_(e)});log_('FAIL '+feed.name+' | '+name+': '+error_(e));}}
    check('Merchant products and destination fields',()=> {
      const scan=readCatalog_(feed,Date.now()+60000,5);const products=scan.items.map(normalise_);
      if(!products.length)return 'No products returned. Access succeeds; catalog health is unverified.';
      if(!products.some(p=>Object.keys(p.contexts).length))throw new Error('No destination statuses in sample. Check actual response and intended destinations.');
      return products.length+' sample products. Contexts: '+Array.from(new Set(products.flatMap(p=>Object.keys(p.contexts)))).join(', ')+'. This is a sample, not full monitoring.';
    });
    check('Google Ads identity and spend',()=>{const s=readSpend_(feed,Date.now()+60000);if(!s.complete)throw new Error(s.note);return s.disabled?'Intentionally disabled':Object.keys(s.map).length+' product identities; currency '+s.currency;});
    if((feed.fileDataSources||[]).length)check('Configured file data sources',()=>{const s=readFileSources_(feed,Date.now()+60000);if(!s.complete)throw new Error(s.issues.map(i=>i.detail).join('; '));return s.statuses.length+' uploads read; '+s.issues.length+' freshness/processing observations.';});
  });
  // Runtime checks for what MONITOR needs beyond the Merchant and Ads APIs. Read-only.
  function runtimeCheck(name,fn){try{const message=fn();results.push({merchantId:'',check:name,ok:true,message});log_('PASS runtime | '+name+': '+message);}catch(e){results.push({merchantId:'',check:name,ok:false,message:error_(e)});log_('FAIL runtime | '+name+': '+error_(e));}}
  runtimeCheck('Report spreadsheet',()=> {
    if(CONFIG.SPREADSHEET_URL)return 'Opens '+SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL).getUrl();
    if(optionalScriptProperties_())return 'No SPREADSHEET_URL; the created report URL is remembered in Script Properties.';
    if(!driveSearchAvailable_())throw new Error('No SPREADSHEET_URL and Drive search is unavailable. Set CONFIG.SPREADSHEET_URL.');
    const name=testReportName, found=findOwnedReport_(name);
    return found?'Will reuse your existing report "'+name+'".':'MONITOR will create "'+name+'" in your Drive and find it again on later runs. Copying its URL into CONFIG.SPREADSHEET_URL is still recommended.';
  });
  runtimeCheck('Overlapping-run protection',()=>optionalScriptLock_()?'LockService plus a lease row in the report.':'LockService is not available here (expected in Google Ads scripts). MONITOR uses a lease row in the report Sheet instead.');
  runtimeCheck('State checksum',()=> {
    if(sha_('abc')!=='ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')throw new Error('SHA-256 self-test failed; state cannot be verified.');
    return typeof Utilities.computeDigest==='function'?'Utilities.computeDigest SHA-256 works.':'Built-in JavaScript SHA-256 works (Utilities.computeDigest not available).';
  });
  log_('TEST finished: '+results.filter(r=>!r.ok).length+' failed checks. No Sheets, registration, email or webhook writes performed.');
  return results;
}
function runRegister_() {
  if(isPreview_())throw new Error('REGISTER changes developer registration. Use Run, not Preview, after reviewing setup.');
  if(!CONFIG.CONFIRM_REGISTRATION || !/^\d+$/.test(String(CONFIG.REGISTER_MERCHANT_ID)) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(CONFIG.DEVELOPER_EMAIL))throw new Error('REGISTER requires explicit REGISTER_MERCHANT_ID, DEVELOPER_EMAIL and CONFIRM_REGISTRATION=true.');
  const r=service_('Accounts').Accounts.DeveloperRegistration.registerGcp({developerEmail:CONFIG.DEVELOPER_EMAIL},'accounts/'+CONFIG.REGISTER_MERCHANT_ID+'/developerRegistration');
  log_('Registration requested. Allow activation time, then reset RUN_MODE to TEST and CONFIRM_REGISTRATION to false.');return r;
}
function service_(kind) {
  const name=CONFIG.SERVICE_NAMES[kind];
  if(typeof globalThis!=='undefined'&&globalThis[name])return globalThis[name];
  if(name==='MerchantApiProducts'&&typeof MerchantApiProducts!=='undefined')return MerchantApiProducts;
  if(name==='MerchantApiAccounts'&&typeof MerchantApiAccounts!=='undefined')return MerchantApiAccounts;
  if(name==='MerchantApiDataSources'&&typeof MerchantApiDataSources!=='undefined')return MerchantApiDataSources;
  throw new Error('Advanced API service '+name+' unavailable. Enable the relevant Merchant API sub-API and verify its identifier in the Ads editor.');
}
function retry_(fn,deadline) {
  for(let attempt=0;attempt<3;attempt++) {
    if(Date.now()>=deadline)throw new Error('Operation deadline reached');
    try {return fn();}catch(e){if(attempt===2||!/429|\b50[0234]\b|RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|timed? ?out|backend|temporar/i.test(error_(e)))throw e;
      const delay=(attempt+1)*1000;if(Date.now()+delay>=deadline)throw e;Utilities.sleep(delay);
    }
  }
}
function value_(o,path) {return String(path).split('.').reduce((v,k)=>{if(v===null||v===undefined)return undefined;const g='get'+k[0].toUpperCase()+k.slice(1);return v[k]!==undefined?v[k]:typeof v[g]==='function'?v[g]():undefined;},o);}
function array_(x) {return Array.isArray(x)?x:[];}
function text_(x) {return x===undefined||x===null?'':String(x);}
function digits_(s) {return text_(s).replace(/\D/g,'');}
function parseTime_(v) {const n=Date.parse(text_(v));return Number.isFinite(n)?n:null;}
function iso_(n) {return new Date(n).toISOString();}
function date_(n) {return iso_(n).slice(0,10);}
function round_(n) {return Math.round(n*100)/100;}
function safeUrl_(v) {const s=text_(v);return /^https?:\/\/[^\s]+$/i.test(s)?s:'';}
function error_(e) {return text_(e&&e.message?e.message:e).replace(/https?:\/\/\S+/g,'[URL redacted]').slice(0,1500);}
function esc_(s) {return text_(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function hash_(s) {let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return (h>>>0).toString(16);}
// SHA-256 of the UTF-8 text. Uses Utilities.computeDigest when the runtime has it and a
// plain JavaScript implementation otherwise; both give identical results.
function sha_(s) {
  try {
    if(typeof Utilities.computeDigest==='function'&&Utilities.DigestAlgorithm&&Utilities.Charset)
      return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,s,Utilities.Charset.UTF_8).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
  } catch(e) { /* use the JavaScript implementation */ }
  return sha256Hex_(s);
}
// UTF-8 encode into a typed array with room for SHA-256 padding (memory-light for large state).
function utf8Padded_(s) {
  const code=i=>{let c=s.charCodeAt(i);
    if(c>=0xd800&&c<=0xdbff&&i+1<s.length){const d=s.charCodeAt(i+1);if(d>=0xdc00&&d<=0xdfff)return [0x10000+((c-0xd800)<<10)+(d-0xdc00),2];}
    return [c>=0xd800&&c<=0xdfff?0xfffd:c,1];}; // lone surrogates become U+FFFD, as TextEncoder does
  let n=0;
  for(let i=0;i<s.length;){const r=code(i);n+=r[0]<0x80?1:r[0]<0x800?2:r[0]<0x10000?3:4;i+=r[1];}
  const total=Math.ceil((n+9)/64)*64, out=new Uint8Array(total);
  let o=0;
  for(let i=0;i<s.length;){const r=code(i),c=r[0];i+=r[1];
    if(c<0x80)out[o++]=c;
    else if(c<0x800){out[o++]=0xc0|c>>6;out[o++]=0x80|c&63;}
    else if(c<0x10000){out[o++]=0xe0|c>>12;out[o++]=0x80|c>>6&63;out[o++]=0x80|c&63;}
    else{out[o++]=0xf0|c>>18;out[o++]=0x80|c>>12&63;out[o++]=0x80|c>>6&63;out[o++]=0x80|c&63;}
  }
  out[n]=0x80;
  const bits=n*8, high=Math.floor(bits/0x100000000), low=bits>>>0;
  [high>>>24&255,high>>>16&255,high>>>8&255,high&255,low>>>24&255,low>>>16&255,low>>>8&255,low&255].forEach((b,j)=>{out[total-8+j]=b;});
  return out;
}
function sha256Hex_(s) {
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const bytes=utf8Padded_(s);
  const h=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19], w=new Uint32Array(64);
  const rotr=(x,n)=>(x>>>n)|(x<<(32-n));
  for(let i=0;i<bytes.length;i+=64) {
    for(let t=0;t<16;t++)w[t]=bytes[i+4*t]<<24|bytes[i+4*t+1]<<16|bytes[i+4*t+2]<<8|bytes[i+4*t+3];
    for(let t=16;t<64;t++) {
      const s0=rotr(w[t-15],7)^rotr(w[t-15],18)^(w[t-15]>>>3), s1=rotr(w[t-2],17)^rotr(w[t-2],19)^(w[t-2]>>>10);
      w[t]=w[t-16]+s0+w[t-7]+s1;
    }
    let a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],k=h[7];
    for(let t=0;t<64;t++) {
      const t1=(k+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+K[t]+w[t])>>>0;
      const t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      k=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+k)>>>0;
  }
  return h.map(x=>x.toString(16).padStart(8,'0')).join('');
}
function isPreview_() {return typeof AdsApp!=='undefined'&&AdsApp.getExecutionInfo().isPreview();}
function sendAllowed_() {return !isPreview_()||CONFIG.SEND_IN_PREVIEW;}
function log_(s) {Logger.log(s);}

function fatalNotice_(error) {
  const message='Monitor could not complete or commit its run. Check the Ads script log and retained state. '+error_(error);
  log_('CRITICAL: '+message);
  if(!sendAllowed_())return;
  if(CONFIG.EMAILS.length)try{MailApp.sendEmail({to:CONFIG.EMAILS.join(','),subject:'[MCFM CRITICAL] Monitor run failed',body:message});}catch(e){log_('Fatal email failed: '+error_(e));}
  if(CONFIG.WEBHOOK_URL)try{post_(CONFIG.WEBHOOK_URL,{text:message},Date.now()+5000);}catch(e){log_('Fatal webhook failed: '+error_(e));}
}

function scope_(feed) { return JSON.stringify([CONFIG.MONITORED_CONTEXTS.slice().sort(),(feed.countries||[]).slice().sort()]); }
