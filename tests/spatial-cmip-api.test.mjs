import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {summarizeCmip6Grid} from '../lib/cmip6-netcdf.ts';
const {default:worker}=await import('../dist/server/index.js');
const env={ASSETS:{fetch:async()=>new Response('not found',{status:404})}},ctx={waitUntil(){},passThroughOnException(){}};
const call=body=>worker.fetch(new Request('http://localhost/api/cmip6-precipitation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),env,ctx);
await call({action:'unsupported'});
const body={action:'year',model:'ACCESS-CM2',scenario:'ssp245',member:'r1i1p1f1',year:2041,fileName:'pr_day_ACCESS-CM2_ssp245_r1i1p1f1_gn_2041.nc',mode:'district',geometry:{type:'Polygon',coordinates:[[[71.7,34.2],[71.8,34.2],[71.8,34.3],[71.7,34.3],[71.7,34.2]]]},spatialDate:'2041-01-02'};
test('NASA spatial API requests one real date, returns native cells, and excludes other timestamps',async()=>{
 const original=globalThis.fetch;try{globalThis.fetch=async input=>{const url=new URL(String(input));assert.equal(url.hostname,'ds.nccs.nasa.gov');assert.equal(url.searchParams.get('time_start'),'2041-01-02T00:00:00Z');assert.equal(url.searchParams.get('time_end'),'2041-01-02T23:59:59Z');assert.equal(url.searchParams.get('time'),null);assert.equal(url.searchParams.get('accept'),'netCDF');return new Response(readFileSync(new URL('./fixtures/nex-daily-spatial.nc',import.meta.url)));};
 const response=await call(body),result=await response.json();assert.equal(response.status,200,JSON.stringify(result));assert.equal(result.spatialCells.length,1);assert.ok(Math.abs(result.spatialCells[0].precipitationMm-69.12)<.0001);assert.deepEqual(result.records.map(r=>r.date),['2041-01-02']);assert.match(result.providerSubsetUrl,/time_start/);
 }finally{globalThis.fetch=original;}
});
test('NASA spatial API rejects invalid or mismatched dates before upstream retrieval',async()=>{
 for(const spatialDate of ['2041-02-30','2042-01-01',5]){const response=await call({...body,spatialDate});assert.equal(response.status,400);}
});

test('the Peshawar recovery cache supplies the matching historical and future annual files during a NASA outage', async () => {
 const boundaries = JSON.parse(readFileSync(new URL('../public/data/uploaded-districts.geojson', import.meta.url)));
 const geometry = boundaries.features.find(feature => feature.properties.adm2_name === 'Peshawar').geometry;
 const selection = {model:'ACCESS-CM2',member:'r1i1p1f1',mode:'district',geometry};
 const original = globalThis.fetch;
 let upstreamRequests = 0;
 try {
  globalThis.fetch = async () => { upstreamRequests++; return new Response('unavailable', {status:500}); };
  for (const [scenario, startYear, endYear] of [['historical',1985,2014],['ssp245',2041,2070]]) {
   const catalogue = await call({action:'catalogue',...selection,scenario,startYear,endYear});
   assert.equal(catalogue.status, 200);
   const {files, retrievalService} = await catalogue.json();
   assert.equal(files.length, 30);
   assert.match(retrievalService, /verified v2\.0 regional subset/);
   for (const file of [files[0],files.at(-1)]) {
    const response = await call({action:'year',...selection,scenario,...file});
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.extractedGridCells, 2);
    assert.equal(result.nearestCellFallback, false);
    assert.ok(result.records.length >= 365 && result.records.length <= 366);
    assert.equal(result.records[0].date, `${file.year}-01-01`);
    assert.equal(result.records.at(-1).date, `${file.year}-12-31`);
   }
   const response = await call({
    action:'year',...selection,scenario,...files[0],spatialDate:`${startYear}-01-15`,
   });
   const result = await response.json();
   assert.equal(response.status, 200, JSON.stringify(result));
   assert.equal(result.records.length, 1);
   assert.equal(result.spatialCells.length, 2);
   assert.match(result.providerSubsetUrl, /nex-gddp-cmip6\.s3\.us-west-2\.amazonaws\.com/);
  }
  assert.equal(upstreamRequests, 0);
 } finally { globalThis.fetch = original; }
});

test('the archive respects district geometry during an upstream failure', async () => {
 const original = globalThis.fetch;
 let upstreamRequests = 0;
 try {
  globalThis.fetch = async () => { upstreamRequests++; return new Response('file unavailable', {status:404}); };
  const response = await call({
   ...body, fileName:'pr_day_ACCESS-CM2_ssp245_r1i1p1f1_gn_2041_v2.0.nc',
  });
  const result = await response.json();
  assert.equal(upstreamRequests, 1);
  assert.equal(response.status, 502);
  assert.match(result.error, /HTTP 404 for ACCESS-CM2 ssp245 r1i1p1f1, 2041/);
 } finally { globalThis.fetch = original; }
});

test('an unavailable NASA subset resolves to the exact archive file for another model grid', async () => {
 const original = globalThis.fetch;
 try {
  globalThis.fetch = async input => {
   assert.match(String(input), /GFDL-CM4_gr2\/ssp585\/r1i1p1f1\/pr/);
   return new Response('temporarily unavailable', {status:500});
  };
  const fileName = 'pr_day_GFDL-CM4_ssp585_r1i1p1f1_gr2_2041_v2.0.nc';
  const response = await call({
   ...body, model:'GFDL-CM4 (gr2)', scenario:'ssp585', fileName, allowArchive:true,
  });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.status, 'archive');
  assert.equal(result.year, 2041);
  assert.equal(result.sourceFileUrl, `https://nex-gddp-cmip6.s3.us-west-2.amazonaws.com/NEX-GDDP-CMIP6/GFDL-CM4_gr2/ssp585/r1i1p1f1/pr/${fileName}`);
 } finally { globalThis.fetch = original; }
});

test('the public archive catalogue selects only matching v2 files and preserves the member', async () => {
 const original = globalThis.fetch;
 const prefix = 'NEX-GDDP-CMIP6/NorESM2-MM/ssp245/';
 const fileName = 'pr_day_NorESM2-MM_ssp245_r1i1p1f1_gn_2041';
 try {
  globalThis.fetch = async input => {
   const url = new URL(String(input));
   if (url.hostname === 'ds.nccs.nasa.gov') return new Response('unavailable', {status:404});
   assert.equal(url.hostname, 'nex-gddp-cmip6.s3.us-west-2.amazonaws.com');
   if (url.searchParams.get('delimiter') === '/') {
    assert.equal(url.searchParams.get('prefix'), prefix);
    return new Response(`<CommonPrefixes><Prefix>${encodeURIComponent(prefix+'r1i1p1f1/')}</Prefix></CommonPrefixes>`);
   }
   assert.equal(url.searchParams.get('prefix'), prefix+'r1i1p1f1/pr/');
   const key = prefix+'r1i1p1f1/pr/'+fileName;
   return new Response(`<Key>${encodeURIComponent(key+'.nc')}</Key><Key>${encodeURIComponent(key+'_v2.0.nc')}</Key>`);
  };
  const response = await call({
   action:'catalogue', model:'NorESM2-MM', scenario:'ssp245', member:'auto',
   startYear:2041, endYear:2041, allowArchive:true,
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.selectedMember, 'r1i1p1f1');
  assert.deepEqual(result.files, [{year:2041, fileName:fileName+'_v2.0.nc'}]);
 } finally { globalThis.fetch = original; }
});

test('a district smaller than the cell spacing uses the area of its native-cell intersections', () => {
 const geometry = {type:'Polygon', coordinates:[[[71.20, 34.09],[71.30, 34.09],[71.30, 34.16],[71.20, 34.16],[71.20, 34.09]]]};
 const result = summarizeCmip6Grid({
  timeValues:[0], timeUnits:'days since 2041-01-01', calendar:'proleptic_gregorian',
  latitudes:[34.125], longitudes:[71.125,71.375], sourceUnits:'mm/day', scaleFactor:1,
  addOffset:0, missingValues:[], readRate:(_time,_lat,lon) => lon === 0 ? 2 : 6,
 }, {mode:'district', geometry}, '2041-01-01');
 assert.equal(result.gridSelection, 'overlap');
 assert.equal(result.extractedGridCells, 2);
 assert.equal(result.nearestCellFallback, false);
 assert.equal(result.records[0].precipitationMm, 4);
 assert.equal(result.spatialCells.length, 2);
});
