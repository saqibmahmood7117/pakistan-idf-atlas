import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nativeArchiveRequest} from '../lib/native-subdaily-source.ts';
const file='https://esgf.ceda.ac.uk/thredds/fileServer/esg_cmip6/CMIP6/ScenarioMIP/CSIRO-ARCCSS/ACCESS-CM2/ssp245/r1i1p1f1/3hr/pr/gn/v20191108/pr_3hr_ACCESS-CM2_ssp245_r1i1p1f1_gn_201501010130-202412312230.nc';
test('native catalogue queries actual 3hr files and extracts source year coverage',async()=>{
 const original=globalThis.fetch;try{globalThis.fetch=async input=>{const u=new URL(input);assert.equal(u.searchParams.get('table_id'),'3hr');assert.equal(u.searchParams.get('variable_id'),'pr');assert.equal(u.searchParams.get('member_id'),'r1i1p1f1');return Response.json({response:{docs:[{url:[file.replaceAll('ssp245','ssp370')+'|application/netcdf|HTTPServer']}]}});};
 const r=await nativeArchiveRequest({action:'catalogue',scenario:'ssp370'});assert.equal(r.files[0].firstYear,2015);assert.equal(r.files[0].lastYear,2024);assert.equal(r.intervalMinutes,180);
 }finally{globalThis.fetch=original;}
});
test('native year retrieval requests NCSS intervals, never a daily product',async()=>{
 const original=globalThis.fetch;try{globalThis.fetch=async input=>{const u=new URL(input);assert.match(u.pathname,/ncss\/grid/);assert.equal(u.searchParams.get('time_start'),'2020-01-01T00:00:00Z');assert.equal(u.searchParams.get('latitude'),'34.00000');assert.equal(u.searchParams.get('var'),'pr');return new Response(readFileSync(new URL('./fixtures/native-3h-point.nc',import.meta.url)));};
 const r=await nativeArchiveRequest({action:'year',scenario:'ssp245',year:2020,fileUrl:file,mode:'point',latitude:34,longitude:72});assert.equal(r.records.length,24);assert.equal(r.providerUrl,file);
 }finally{globalThis.fetch=original;}
});
test('native source rejects arbitrary hosts, credentials, daily files and missing district polygons',async()=>{
 const base={action:'year',scenario:'ssp245',year:2020,fileUrl:file,mode:'point',latitude:34,longitude:72};
 for(const fileUrl of [file.replace('esgf.ceda.ac.uk','example.com'),file.replace('https://','https://user:pass@'),file.replaceAll('3hr','day')])await assert.rejects(()=>nativeArchiveRequest({...base,fileUrl}),/verified native/);
 await assert.rejects(()=>nativeArchiveRequest({...base,mode:'district'}),/polygon/);
});
