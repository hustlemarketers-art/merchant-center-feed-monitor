'use strict';
// Regression tests for the 2.0.1 fixes. Same simulated services as monitor.test.cjs.
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {makeEnv,product,catalog,spend}=require('./harness.cjs');
const notifications={EMAILS:['owner@example.invalid'],WEBHOOK_URL:'https://hooks.example.invalid/test'};
const URL='https://docs.google.com/spreadsheets/d/fake-v2';
const LOCK='Monitor v2 Lock';
function blocked(n=30){return catalog(n,{approved:[],disapproved:['US'],issues:[{code:'missing_gtin',severity:'DISAPPROVED',reportingContext:'SHOPPING_ADS',applicableCountries:['US'],description:'Provide a valid GTIN',documentation:'https://support.google.com/merchants/answer/6324461'}]});}
// n products where the first `bad` are disapproved for Shopping ads in the US.
function someBlocked(n,bad,offset=0){return Array.from({length:n},(_,i)=>product('sku-'+i,(i>=offset&&i<offset+bad)?{approved:[],disapproved:['US']}:{}));}
// Remove the services that Google Ads scripts do not provide.
function adsRuntime(e){delete e.context.LockService;delete e.context.PropertiesService;return e;}
function withDrive(e,files=[]){
  e.driveQueries=[];
  e.context.DriveApp={searchFiles:q=>{e.driveQueries.push(q);let i=0;return {hasNext:()=>i<files.length,next:()=>files[i++]};}};
  e.context.SpreadsheetApp.openById=()=>e.ss;
  const create=e.context.SpreadsheetApp.create;
  e.context.SpreadsheetApp.create=name=>{e.createdName=name;files.push({getId:()=>'id-'+files.length});return create(name);};
  return e;
}
const events=(e,check,type)=>e.state().outbox.filter(x=>x.incident.check===check&&(!type||x.type===type));

// ---- Fix 1: MONITOR must start in the Google Ads runtime -------------------------

test('MONITOR runs without LockService or PropertiesService (Google Ads runtime)',()=>{
  const e=adsRuntime(makeEnv());
  const r=e.monitor({SPREADSHEET_URL:URL});
  assert.equal(r.results[0].catalogComplete,true);
  assert.equal(Object.keys(e.state().feeds['111'].products).length,30);
  assert.equal(e.table(LOCK).data[1][0],'','lease released after the run');
});

test('without SPREADSHEET_URL the report is found again in Drive, not created twice',()=>{
  const files=[];const e=withDrive(adsRuntime(makeEnv()),files);
  e.monitor();e.next();e.monitor();
  assert.equal(e.created,1);
  assert.match(e.createdName,/^Merchant Center Feed Health Monitor v2 - Ads 1234567890 - default$/);
  assert.match(e.driveQueries[0],/'me' in owners/);
  assert.match(e.driveQueries[0],/trashed = false/);
  assert.ok(e.logs.some(l=>/Using existing report/.test(l)));
});

test('two owned reports with the same name stop the run and ask for SPREADSHEET_URL',()=>{
  const e=withDrive(adsRuntime(makeEnv()),[{getId:()=>'a'},{getId:()=>'b'}]);
  assert.throws(()=>e.monitor(),/Set CONFIG.SPREADSHEET_URL/);
  assert.equal(e.created,0);
});

test('report lease blocks an overlapping run without LockService and expires on its own',()=>{
  const e=adsRuntime(makeEnv());
  e.monitor(Object.assign({SPREADSHEET_URL:URL},notifications));
  const mailBefore=e.mail.length, writesBefore=e.sheetWrites;
  e.table(LOCK).data[1]=['other-run',e.now+10*60000,''];
  assert.throws(()=>e.monitor(),/Another run is active/);
  assert.equal(e.mail.length,mailBefore,'a busy lease is not a failure notice');
  assert.equal(e.sheetWrites,writesBefore,'nothing written while another run holds the lease');
  e.table(LOCK).data[1]=['crashed-run',e.now-1,''];
  e.next();
  assert.equal(e.monitor().results[0].catalogComplete,true);
});

test('lease is released when a run fails',()=>{
  const e=adsRuntime(makeEnv({failSheetName:'Monitor v2 State A'}));
  assert.throws(()=>e.monitor({SPREADSHEET_URL:URL}),/Simulated sheet write failure/);
  assert.equal(e.table(LOCK).data[1][0],'');
});

test('TEST checks report storage, run protection and checksum without writing',()=>{
  const e=withDrive(adsRuntime(makeEnv()));
  const r=e.run('main()');
  assert.ok(r.every(x=>x.ok),JSON.stringify(r.filter(x=>!x.ok)));
  const byName=Object.fromEntries(r.map(x=>[x.check,x.message]));
  assert.match(byName['Overlapping-run protection'],/lease row/);
  assert.match(byName['Report spreadsheet'],/will create/i);
  assert.match(byName['State checksum'],/SHA-256 works/);
  assert.equal(e.sheetWrites,0);assert.equal(e.created,0);
});

test('TEST fails clearly when there is no SPREADSHEET_URL, no properties and no Drive',()=>{
  const e=adsRuntime(makeEnv());
  const r=e.run('main()').find(x=>x.check==='Report spreadsheet');
  assert.equal(r.ok,false);assert.match(r.message,/Set CONFIG.SPREADSHEET_URL/);
});

test('JavaScript SHA-256 matches Utilities.computeDigest, so state written by either verifies',()=>{
  const e=makeEnv();
  for(const s of ['','abc','a'.repeat(64),'汉字 € 😀','lone \uD800 surrogate',JSON.stringify(blocked())])
    assert.equal(e.run('sha256Hex_('+JSON.stringify(s)+')'),crypto.createHash('sha256').update(s,'utf8').digest('hex'));
  const digest=e.context.Utilities.computeDigest;
  delete e.context.Utilities.computeDigest;
  e.monitor({SPREADSHEET_URL:URL});
  e.context.Utilities.computeDigest=digest;e.next();
  assert.equal(e.monitor().results[0].catalogComplete,true,'state saved with the fallback loads with computeDigest');
});

// ---- Fix 2: Merchant incidents recover even when Ads spend is unavailable ----------

test('Merchant incidents recover while Ads spend is unavailable',()=>{
  const e=makeEnv({merchants:{'111':blocked()},adsError:'PERMISSION_DENIED'});
  e.monitor(notifications);
  assert.ok(e.checks().includes('Products disapproved'));
  e.next();e.merchants['111']=catalog();e.monitor();
  assert.equal(events(e,'Products disapproved','RECOVERED').length,1);
  assert.deepEqual(e.checks(),['Spend unavailable'],'spend outage stays open on its own');
});

test('spend-dependent price check does not recover while spend is unavailable',()=>{
  const e=makeEnv({adsRows:{'111':[spend('sku-0',200)]}});
  e.monitor();e.next();
  e.merchants['111']=catalog();e.merchants['111'][0]=product('sku-0',{price:40});e.monitor();
  assert.ok(e.checks().includes('Price changed'));
  e.next();e.adsError='PERMISSION_DENIED';e.merchants['111']=catalog();e.monitor();
  assert.ok(e.checks().includes('Price changed'),'no recovery claim without spend data');
  assert.equal(events(e,'Price changed','RECOVERED').length,0);
  e.next();delete e.adsError;e.monitor();
  assert.ok(!e.checks().includes('Price changed'));
  assert.equal(events(e,'Price changed','RECOVERED').length,1);
});

test('Spend unavailable recovers when Ads reporting returns',()=>{
  const e=makeEnv({adsError:'PERMISSION_DENIED'});
  e.monitor();assert.ok(e.checks().includes('Spend unavailable'));
  e.next();delete e.adsError;e.monitor();
  assert.deepEqual(e.checks(),[]);
});

test('an incomplete catalog still never produces a recovery',()=>{
  const e=makeEnv({merchants:{'111':blocked()}});
  e.monitor();e.next();e.catalogError='UNAVAILABLE';e.monitor();
  assert.equal(events(e,'Products disapproved','RECOVERED').length,0);
});

// ---- Fix 3: fewer, more meaningful disapproval notices ------------------------------

test('a few routine disapprovals stay in the report without an alert',()=>{
  const e=makeEnv({merchants:{'111':someBlocked(500,1,7)}});
  e.monitor(notifications);
  assert.ok(!e.checks().includes('Products disapproved'));
  assert.equal(e.mail.length,0);
  const row=e.table('Monitor v2 Products').rows()[0];
  assert.equal(row[3],'sku-7');assert.match(row[7],/SHOPPING_ADS:US/);
  const market=e.table('Monitor v2 Markets').rows().find(r=>r[3]==='SHOPPING_ADS');
  assert.equal(Number(market[9]),1,'still counted in Markets');
});

test('one disapproved product with Ads clicks opens an alert (like a MIN_CLICKS rule)',()=>{
  const e=makeEnv({merchants:{'111':someBlocked(500,1,7)},adsRows:{'111':[spend('sku-7',25)]}});
  e.monitor(notifications);
  const i=Object.values(e.state().incidents).find(x=>x.check==='Products disapproved');
  assert.ok(i&&i.active);assert.match(i.detail,/had Ads clicks/);
});

test('count and share thresholds open alerts; both can be tuned',()=>{
  const share=makeEnv({merchants:{'111':someBlocked(100,6)}});share.monitor();
  assert.ok(share.checks().includes('Products disapproved'),'6% is above the 5% default');
  const count=makeEnv({merchants:{'111':someBlocked(1000,10)}});count.monitor();
  assert.ok(count.checks().includes('Products disapproved'),'10 products meets the count default');
  const strict=makeEnv({merchants:{'111':someBlocked(100,6)}});strict.monitor({DISAPPROVED_ALERT_MIN_PCT:10,DISAPPROVED_ALERT_MIN_PRODUCTS:50});
  assert.ok(!strict.checks().includes('Products disapproved'));
  const legacy=makeEnv({merchants:{'111':someBlocked(500,1)}});legacy.monitor({DISAPPROVED_ALERT_MIN_PRODUCTS:1});
  assert.ok(legacy.checks().includes('Products disapproved'),'set 1 to alert on any disapproval');
});

test('an open disapproval alert stays open until none remain (no false recovery)',()=>{
  const e=makeEnv({merchants:{'111':someBlocked(500,12)}});
  e.monitor();assert.ok(e.checks().includes('Products disapproved'));
  e.next();e.merchants['111']=someBlocked(500,3);e.monitor();
  assert.ok(e.checks().includes('Products disapproved'));
  assert.equal(events(e,'Products disapproved','RECOVERED').length,0);
  e.next();e.merchants['111']=someBlocked(500,0);e.monitor();
  assert.equal(events(e,'Products disapproved','RECOVERED').length,1);
});

test('warning reminders are weekly; critical reminders stay at 72 hours',()=>{
  const w=makeEnv({merchants:{'111':someBlocked(500,12)}});
  w.monitor(notifications);assert.equal(w.mail.length,1);
  w.now+=73*3600000;w.monitor();assert.equal(w.mail.length,1,'no warning reminder after 3 days');
  w.now+=96*3600000;w.monitor();assert.equal(w.mail.length,2);assert.match(w.mail[1].body,/REMINDER/);
  const c=makeEnv({merchants:{'111':blocked()}});
  c.monitor(notifications);c.now+=73*3600000;c.monitor();assert.equal(c.mail.length,2);
  const off=makeEnv({merchants:{'111':someBlocked(500,12)}});
  off.monitor(Object.assign({REMIND_WARNINGS_AFTER_HOURS:0},notifications));off.now+=400*3600000;off.monitor();
  assert.equal(off.mail.filter(m=>/REMINDER/.test(m.body)).length,0);
});

test('small churn in a disapproved list does not send CHANGED; a material change does',()=>{
  const e=makeEnv({merchants:{'111':someBlocked(500,12)}});
  e.monitor();
  e.next();e.merchants['111']=someBlocked(500,12,1);e.monitor();
  assert.equal(events(e,'Products disapproved','CHANGED').length,0,'one product swapped');
  e.next();e.merchants['111']=someBlocked(500,15,1);e.monitor();
  assert.equal(events(e,'Products disapproved','CHANGED').length,0,'+3 is below 5 products');
  e.next();e.merchants['111']=someBlocked(500,20,1);e.monitor();
  assert.equal(events(e,'Products disapproved','CHANGED').length,1,'+8 since the last notice');
  e.next();e.merchants['111']=blocked(500);e.monitor();
  assert.equal(events(e,'Products disapproved','CHANGED').length,2,'escalation to CRITICAL always notifies');
});

// ---- Capacity and state ---------------------------------------------------------------

test('catalog above the cap gets an actionable message',()=>{
  const e=makeEnv();e.monitor({MAX_PRODUCTS_PER_FEED:25});
  const i=Object.values(e.state().incidents).find(x=>x.check==='Catalog coverage incomplete');
  assert.match(i.detail,/Raise MAX_PRODUCTS_PER_FEED/);
});

test('per-product state is compact (under 100 characters per product)',()=>{
  const e=makeEnv({merchants:{'111':Array.from({length:1000},(_,i)=>product('sku-'+i,{destinations:[
    {reportingContext:'SHOPPING_ADS',approvedCountries:['US','CA','GB','AU','DE'],disapprovedCountries:[],pendingCountries:[]},
    {reportingContext:'FREE_LISTINGS',approvedCountries:['US','CA','GB','AU','DE'],disapprovedCountries:[],pendingCountries:[]},
    {reportingContext:'DISPLAY_ADS',approvedCountries:['US'],disapprovedCountries:[],pendingCountries:[]}]}))}});
  e.monitor();
  const chars=e.table('Monitor v2 State A').rows().reduce((n,r)=>n+String(r[1]).length,0);
  assert.ok(chars/1000<100,Math.round(chars/1000)+' characters per product');
  assert.equal(e.state().feeds['111'].products['["sku-0","US","en"]'][2],'F:A=AU,CA,DE,GB,US|S:A=AU,CA,DE,GB,US');
});

test('state saved by v2.0.0 (object statuses, labels, source) is read correctly',()=>{
  const e=makeEnv({merchants:{'111':blocked()},adsRows:{'111':[spend('sku-0',200)]}});
  e.monitor();
  assert.equal(events(e,'Spending products newly disapproved').length,1);
  e.run(`(function(){const ss=SpreadsheetApp.openByUrl('${URL}');const st=loadState_(ss);
    Object.values(st.feeds['111'].products).forEach(v=>{v[2]=decodeContexts_(v[2]);v.push(['high-margin','','','',''],'accounts/111/dataSources/1001');});
    saveState_(ss,st);})()`);
  assert.equal(typeof Object.values(e.state().feeds['111'].products)[0][2],'object');
  e.next();e.monitor();
  assert.equal(events(e,'Spending products newly disapproved').length,1,'not "new" again after reading old-format state');
  assert.equal(typeof Object.values(e.state().feeds['111'].products)[0][2],'string','rewritten in compact form');
});

test('invalid 2.0.1 settings are rejected before any writes',()=>{
  for(const bad of [{DISAPPROVED_ALERT_MIN_PCT:150},{DISAPPROVED_ALERT_MIN_PRODUCTS:0},{CHANGE_MIN_PRODUCTS:0},{REMIND_WARNINGS_AFTER_HOURS:-1},{DISAPPROVED_ALERT_MIN_CLICKS:-1}]) {
    const e=makeEnv();assert.throws(()=>e.monitor(bad),/must be|Invalid/);assert.equal(e.sheetWrites,0);
  }
});

test('a failing Drive search asks for SPREADSHEET_URL instead of guessing',()=>{
  const e=adsRuntime(makeEnv());
  e.context.DriveApp={searchFiles:()=>{throw new Error('Invalid query');}};
  assert.throws(()=>e.monitor(),/Drive search for the report failed.*Set CONFIG.SPREADSHEET_URL/);
  assert.equal(e.created,0);
});

test('Drive query matches the exact report name and owner',()=>{
  const files=[];const e=withDrive(adsRuntime(makeEnv()),files);
  e.monitor({INSTANCE_ID:'store_1'});
  assert.match(e.driveQueries[0],/^title = 'Merchant Center Feed Health Monitor v2 - Ads 1234567890 - store_1' and 'me' in owners/);
  assert.equal(e.run(`reportName_()`).includes("'"),false,'INSTANCE_ID validation keeps quotes out of the name');
});

// ---- Follow-up fixes from the independent review --------------------------------------

test('a file source removed from CONFIG closes its incident without a recovery claim',()=>{
  const e=makeEnv();
  e.config({FEEDS:[{name:'Store',merchantId:'111',fileDataSources:[{id:'55',maxAgeHours:30}]}]});
  e.sourceResults['accounts/111/dataSources/55/fileUploads/latest']={uploadTime:new Date(e.now).toISOString(),processingState:'FAILED',itemsTotal:'30'};
  e.monitor(Object.assign({SEND_WHEN_HEALTHY:true},notifications));
  assert.ok(e.checks().includes('File source failed or stale'));
  e.next();e.config({FEEDS:[{name:'Store',merchantId:'111'}]});e.monitor();
  assert.deepEqual(e.checks(),[]);
  assert.equal(events(e,'File source failed or stale','RECOVERED').length,0);
  assert.match(e.mail[e.mail.length-1].subject,/\[MCFM OK\]/,'healthy notice resumes');
});

test('with monitorSpend:false, price incidents still recover and Ads-only incidents close quietly',()=>{
  const e=makeEnv({adsRows:{'111':[spend('sku-0',200),spend('gone-sku',50)]}});
  e.monitor();e.next();
  e.merchants['111']=catalog();e.merchants['111'][0]=product('sku-0',{price:40});e.monitor();
  assert.ok(e.checks().includes('Price changed'));
  assert.ok(e.checks().includes('Historical Ads identities not in catalog'));
  e.next();e.config({FEEDS:[{name:'Store',merchantId:'111',monitorSpend:false}]});e.merchants['111']=catalog();e.monitor();
  assert.deepEqual(e.checks(),[]);
  assert.equal(events(e,'Price changed','RECOVERED').length,1);
  assert.equal(events(e,'Historical Ads identities not in catalog','RECOVERED').length,0);
});

test('TEST names the report the same way MONITOR does in a manager account',()=>{
  const e=withDrive(adsRuntime(makeEnv({manager:true,managedIds:['222-333-4444'],currentAdsId:'999-888-7777'})));
  e.config({FEEDS:[{name:'Store',merchantId:'111',adsCustomerId:'222-333-4444'}]});
  const r=e.run('main()').find(x=>x.check==='Report spreadsheet');
  assert.match(r.message,/Ads 9998887777/);
  e.currentAdsId='999-888-7777';e.monitor();
  assert.match(e.createdName,/Ads 9998887777/);
});

test('a CONFIG block copied from 2.0.0 (without the new keys) still runs with defaults',()=>{
  const e=makeEnv({merchants:{'111':someBlocked(500,1)}});
  e.run('["DISAPPROVED_ALERT_MIN_PRODUCTS","DISAPPROVED_ALERT_MIN_PCT","DISAPPROVED_ALERT_MIN_CLICKS","REMIND_WARNINGS_AFTER_HOURS","CHANGE_MIN_PRODUCTS","CHANGE_MIN_PCT"].forEach(k=>delete CONFIG[k])');
  e.monitor();
  assert.equal(e.run('CONFIG.DISAPPROVED_ALERT_MIN_PRODUCTS'),10);
  assert.ok(!e.checks().includes('Products disapproved'));
});

test('if acquiring the lease fails after writing it, the lease is cleared',()=>{
  const e=adsRuntime(makeEnv());
  e.monitor({SPREADSHEET_URL:URL});e.next();
  const sheet=e.table(LOCK), original=sheet.getRange.bind(sheet);let reads=0;
  sheet.getRange=(...args)=>{const r=original(...args),get=r.getValues;r.getValues=()=>{reads++;if(reads===2)throw new Error('Service error: Spreadsheets');return get();};return r;};
  assert.throws(()=>e.monitor(),/Service error/);
  sheet.getRange=original;
  assert.equal(sheet.data[1][0],'');
  e.next();assert.equal(e.monitor().results[0].catalogComplete,true,'next run is not blocked');
});

test('a run that loses its lease mid-run stops before writing state',()=>{
  const e=adsRuntime(makeEnv());
  e.monitor(Object.assign({SPREADSHEET_URL:URL},notifications));e.next();
  const generation=e.state().generation, mail=e.mail.length;
  e.catalogHook=(parent,opts)=>{e.table(LOCK).data[1][0]='other-run';delete e.catalogHook;return {products:catalog(),nextPageToken:undefined};};
  assert.throws(()=>e.monitor(),/took over the report lease/);
  assert.equal(e.state().generation,generation,'no new state committed');
  assert.equal(e.mail.length,mail,'a busy lease is not a failure notice');
});

test('MONITOR refuses to create a report it could not find again',()=>{
  const e=adsRuntime(makeEnv());
  assert.throws(()=>e.monitor(),/Set CONFIG.SPREADSHEET_URL/);
  assert.equal(e.created,0);
});
