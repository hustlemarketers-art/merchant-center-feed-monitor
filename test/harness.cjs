'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const SCRIPT=fs.readFileSync(path.join(__dirname,'..','merchant-center-feed-monitor.js'),'utf8');
function product(id, options={}) {
  const o=Object.assign({label:'US',lang:'en',price:20,currency:'USD',approved:['US'],disapproved:[],pending:[],labels:['high-margin','','','',''],source:'1001',availability:'IN_STOCK',issues:[]},options);
  const destinations=o.destinations||[{reportingContext:'SHOPPING_ADS',approvedCountries:o.approved,disapprovedCountries:o.disapproved,pendingCountries:o.pending},{reportingContext:'FREE_LISTINGS',approvedCountries:['US'],disapprovedCountries:[],pendingCountries:[]}];
  return {name:'accounts/111/products/'+o.lang+'~'+o.label+'~'+id,offerId:id,feedLabel:o.label,contentLanguage:o.lang,dataSource:'accounts/111/dataSources/'+o.source,archived:o.archived||false,
    productAttributes:{title:o.title||'Product '+id,price:{amountMicros:String(o.price*1e6),currencyCode:o.currency},availability:o.availability,customLabel0:o.labels[0],customLabel1:o.labels[1],customLabel2:o.labels[2],customLabel3:o.labels[3],customLabel4:o.labels[4],link:'https://example.invalid/products/'+encodeURIComponent(id)},
    productStatus:{creationDate:o.created||'2026-01-01T00:00:00Z',googleExpirationDate:o.expires||'2027-01-01T00:00:00Z',destinationStatuses:destinations,itemLevelIssues:o.issues}};
}
function catalog(n=30,o={}) {return Array.from({length:n},(_,i)=>product('sku-'+i,o));}
function spend(id,cost=50,o={}) {return {segments:{productItemId:id.toLowerCase(),productFeedLabel:o.label||'US',productLanguage:o.langResource||'languageConstants/1000'},metrics:{clicks:10,costMicros:cost*1e6,conversions:2,conversionsValue:cost*3}};}
function getters(o) {if(Array.isArray(o))return o.map(getters);if(!o||typeof o!=='object')return o;const x={};Object.keys(o).forEach(k=>x['get'+k[0].toUpperCase()+k.slice(1)]=()=>getters(o[k]));return x;}
class Sheet {
  constructor(name,env){this.name=name;this.env=env;this.data=[];this.maxRows=1000;this.maxCols=26;this.formulas=[];}
  getLastRow(){let n=this.data.length;while(n&&!(this.data[n-1]||[]).some(v=>v!==''&&v!==undefined))n--;return n;}
  getLastColumn(){return this.data.reduce((n,r)=>Math.max(n,r.length),0);}
  getMaxRows(){return this.maxRows;}getMaxColumns(){return this.maxCols;}
  insertRowsAfter(at,n){this.maxRows+=n;}insertColumnsAfter(at,n){this.maxCols+=n;}
  setFrozenRows(){}getName(){return this.name;}
  getRange(r,c,n=1,m=1){
    if(r+n-1>this.maxRows||c+m-1>this.maxCols)throw new Error('Requested range outside grid');
    const s=this;return {
      getValues(){return Array.from({length:n},(_,i)=>Array.from({length:m},(_,j)=>(s.data[r+i-1]||[])[c+j-1]??''));},
      setNumberFormat(){return this;},
      setValues(values){
        s.env.sheetWrites++;
        if(s.env.failSheetName===s.name)throw new Error('Simulated sheet write failure');
        if(values.length!==n||values.some(x=>x.length!==m))throw new Error('Wrong grid size');
        values.forEach((row,i)=>{while(s.data.length<r+i)s.data.push([]);row.forEach((v,j)=>{
          if(typeof v==='string'&&v.startsWith("'"))v=v.slice(1);
          else if(typeof v==='string'&&v.startsWith('=')){s.formulas.push(v);v=v==='=1+1'?2:'FORMULA';}
          s.data[r+i-1][c+j-1]=v;
        });});return this;
      },
      clearContent(){for(let i=0;i<n;i++)for(let j=0;j<m;j++)if(s.data[r+i-1])s.data[r+i-1][c+j-1]='';return this;}
    };
  }
  rows(){return this.data.slice(1,this.getLastRow());}
}
class Spreadsheet {
  constructor(env){this.env=env;this.sheets={};}
  getSheetByName(n){return this.sheets[n]||null;}
  insertSheet(n){return this.sheets[n]=new Sheet(n,this.env);}
  getUrl(){return 'https://docs.google.com/spreadsheets/d/fake-v2';}
}
function makeEnv(options={}) {
  const env={now:Date.parse('2026-10-01T08:00:00Z'),merchants:{'111':catalog()},adsRows:{'111':[]},queries:[],logs:[],mail:[],mailAttempts:0,webhooks:[],webhookCodes:[],registrations:[],properties:{},created:0,sheetWrites:0,catalogCalls:[],sourceCalls:[],sourceResults:{},selected:[],preview:!!options.preview,...options};
  const ss=env.ss=new Spreadsheet(env);
  class Clock extends Date {constructor(...args){super(...(args.length?args:[env.now]));}static now(){return env.now;}}
  const iterator=rows=>{let i=0;return {hasNext:()=>i<rows.length,next:()=>rows[i++]};};
  const context={Date:Clock,Logger:{log:s=>env.logs.push(String(s))},Utilities:{sleep:n=>{env.now+=n;},DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(algo,s)=>Array.from(crypto.createHash('sha256').update(s,'utf8').digest())},
    PropertiesService:{getScriptProperties:()=>({getProperty:k=>env.properties[k]||null,setProperty:(k,v)=>{env.properties[k]=v;}})},
    LockService:{getScriptLock:()=>({tryLock:()=>!env.locked,releaseLock:()=>{env.released=true;}})},
    SpreadsheetApp:{create:()=>{env.created++;return ss;},openByUrl:()=>ss,flush:()=>{}},
    MailApp:{sendEmail:m=>{env.mailAttempts++;if(env.mailError)throw new Error(env.mailError);env.mail.push(m);}},
    UrlFetchApp:{fetch:(url,o)=>{env.webhooks.push({url,options:o});if(env.webhookException)throw new Error(env.webhookException);const code=env.webhookCodes.length?env.webhookCodes.shift():200;return {getResponseCode:()=>code};}},
    AdsApp:{currentAccount:()=>({getCustomerId:()=>env.currentAdsId||'123-456-7890',getCurrencyCode:()=>env.adsCurrency||'USD',getTimeZone:()=> 'Etc/UTC'}),getExecutionInfo:()=>({isPreview:()=>env.preview}),search:q=>{
      env.queries.push(q);if(env.adsError)throw new Error(env.adsError);
      if(q.includes('FROM language_constant'))return iterator([{languageConstant:{resourceName:'languageConstants/1000',code:'en'}},{languageConstant:{resourceName:'languageConstants/1002',code:'fr'}},{languageConstant:{resourceName:'languageConstants/1005',code:'ja'}}]);
      const m=q.match(/product_merchant_id = (\d+)/);return iterator(env.adsRows[m?m[1]:'111']||[]);
    }},
    MerchantApiProducts:{Accounts:{Products:{list:(parent,opts)=>{
      env.catalogCalls.push({parent,opts});if(env.catalogError)throw new Error(env.catalogError);
      if(env.catalogHook)return env.catalogHook(parent,opts);
      const rows=env.merchants[parent.split('/')[1]];if(!rows)throw new Error('PERMISSION_DENIED');
      const offset=Number(opts.pageToken||0),end=offset+opts.pageSize;
      const r={products:rows.slice(offset,end),nextPageToken:end<rows.length?String(end):undefined};
      return env.getterStyle?getters(r):r;
    }}}},
    MerchantApiDataSources:{Accounts:{DataSources:{FileUploads:{get:name=>{env.sourceCalls.push(name);if(env.sourceError)throw new Error(env.sourceError);return env.sourceResults[name]||{uploadTime:new Clock().toISOString(),processingState:'SUCCEEDED',itemsTotal:'30'};}}}}},
    MerchantApiAccounts:{Accounts:{DeveloperRegistration:{registerGcp:(body,parent)=>{env.registrations.push({body,parent});return {name:parent};}}}}
  };
  if(options.manager)context.AdsManagerApp={accounts:()=>({withIds:ids=>({get:()=>iterator(ids.filter(id=>(env.managedIds||[]).includes(id)).map(id=>({id})))})}),select:a=>{env.selected.push(a.id);env.currentAdsId=a.id;}};
  vm.createContext(context);vm.runInContext(SCRIPT,context);
  env.context=context;env.run=s=>vm.runInContext(s,context);
  env.config=c=>env.run('Object.assign(CONFIG,'+JSON.stringify(c)+')');
  env.config({FEEDS:[{name:'Store',merchantId:'111'}]});
  env.monitor=c=>{env.config({RUN_MODE:'MONITOR',...c});return env.run('main()');};
  env.next=()=>{env.now+=86400000;};
  env.state=()=>env.run('loadState_(SpreadsheetApp.openByUrl("https://docs.google.com/spreadsheets/d/fake-v2"))');
  env.checks=()=>Object.values(env.state().incidents).filter(i=>i.active).map(i=>i.check);
  env.table=n=>ss.getSheetByName(n);
  return env;
}
module.exports={makeEnv,product,catalog,spend};
