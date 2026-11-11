import test from 'node:test';
import assert from 'node:assert/strict';
const workerUrl=new URL('../dist/server/index.js',import.meta.url);
const { default:worker }=await import(workerUrl.href);
const env={ASSETS:{fetch:async()=>new Response('Not found',{status:404})}};
const ctx={waitUntil(){},passThroughOnException(){}};
const call=(body)=>worker.fetch(new Request('http://localhost/api/online-precipitation',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),
}),env,ctx);

// Initialize the Worker request runtime before replacing its provider fetch.
await call({action:'start',source:'ifs',mode:'point',start:'2016-01-01',end:'2016-01-02',latitude:34,longitude:72});

test('IFS API requests the explicit model and preserves units, missingness and provenance', async()=>{
 const original=globalThis.fetch;
 try {
  for(const resolution of ['daily','hourly']){
   globalThis.fetch=async(input)=>{
    const url=new URL(String(input));
    assert.equal(url.hostname,'archive-api.open-meteo.com');
    assert.equal(url.searchParams.get('models'),'ecmwf_ifs');
    assert.equal(url.searchParams.get('timezone'),'UTC');
    assert.equal(url.searchParams.get(resolution),resolution==='daily'?'precipitation_sum':'precipitation');
    return Response.json({latitude:34,longitude:72,
     daily_units:{precipitation_sum:'mm'},hourly_units:{precipitation:'mm'},
     daily:{time:['2020-01-01','2020-01-02','2020-01-03'],precipitation_sum:[0,1.2,null]},
     hourly:{time:['2020-01-01T00:00','2020-01-01T01:00','2020-01-01T02:00'],precipitation:[0,1.2,null]},
    });
   };
   const response=await call({action:'start',source:'ifs',resolution,mode:'point',start:'2020-01-01',end:'2020-01-03',latitude:34,longitude:72});
   assert.equal(response.status,200,await response.clone().text());
   const data=await response.json();
   assert.equal(data.status,'complete');
   assert.equal((data.records??data.hourlyRecords).length,2);
   assert.equal((data.records??data.hourlyRecords)[0].precipitationMm,0);
   assert.equal(data.metadata.source,'ifs');
   assert.equal(data.metadata.temporalResolution,resolution);
   assert.match(data.metadata.dataset,/ECMWF IFS/);
   assert.match(data.metadata.sourceCaveat,/short record/);
   assert.equal(data.metadata.returnedLatitude,34);
  }
 } finally {globalThis.fetch=original;}
});

test('IFS API rejects unsupported units instead of fitting a mislabelled record', async()=>{
 const original=globalThis.fetch;
 try {
  globalThis.fetch=async()=>Response.json({daily_units:{precipitation_sum:'m'},daily:{time:['2020-01-01'],precipitation_sum:[0.02]}});
  const response=await call({action:'start',source:'ifs',mode:'point',start:'2020-01-01',end:'2020-01-01',latitude:34,longitude:72});
  const data=await response.json();
  assert.equal(data.status,'error');
  assert.match(data.error,/expected mm/);
 } finally {globalThis.fetch=original;}
});

test('IFS district result discloses the representative request mesh', async()=>{
 const original=globalThis.fetch;
 try {
  globalThis.fetch=async(input)=>{
   const url=new URL(String(input));
   return Response.json(url.searchParams.get('latitude').split(',').map((latitude,index)=>({
    latitude:Number(latitude),longitude:Number(url.searchParams.get('longitude').split(',')[index]),
    daily_units:{precipitation_sum:'mm'},daily:{time:['2020-01-01'],precipitation_sum:[3]},
   })));
  };
  const response=await call({action:'start',source:'ifs',mode:'district',start:'2020-01-01',end:'2020-01-01',districtName:'Test polygon',geometry:{type:'Polygon',coordinates:[[[71.5,33.5],[72.5,33.5],[72.5,34.5],[71.5,34.5],[71.5,33.5]]]}});
  const data=await response.json();
  assert.equal(data.status,'complete');
  assert.equal(data.records[0].precipitationMm,3);
  assert.equal(data.metadata.extractedGridCells,4);
  assert.equal(data.metadata.gridSamplingLimited,true);
  assert.match(data.metadata.spatialMethod,/request-mesh/);
  assert.match(data.metadata.spatialMethod,/not exact native-grid/);
 } finally {globalThis.fetch=original;}
});
