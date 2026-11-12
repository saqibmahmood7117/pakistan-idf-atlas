import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
