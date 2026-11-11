import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {nativeCellOverlap,parseNativeThreeHourly,nativeDurationMaxima,independentlyCorrectNativeDurations} from '../lib/native-subdaily.ts';
import {frequencyQuantile} from '../lib/observed-idf.ts';
test('real CEDA NCSS subset preserves native intervals, flux conversion and grid location',()=>{
 const parsed=parseNativeThreeHourly(readFileSync(new URL('./fixtures/native-3h-point.nc',import.meta.url)));
 assert.equal(parsed.records.length,24);assert.equal(parsed.records[0].timestamp,'2020-01-01T00:00');
 assert.equal(parsed.records[1].timestamp,'2020-01-01T03:00');
 assert.equal(parsed.returnedLatitude,34.375);assert.equal(parsed.returnedLongitude,72.1875);
 assert.ok(Math.abs(parsed.records[0].precipitationMm-0.000027717103)<1e-10);
});
test('district overlap includes a small polygon between grid centers and subtracts holes',()=>{
 const outer=[[72,34],[72.2,34],[72.2,34.2],[72,34.2],[72,34]];
 const hole=[[72.05,34.05],[72.15,34.05],[72.15,34.15],[72.05,34.15],[72.05,34.05]];
 const full=nativeCellOverlap({type:'Polygon',coordinates:[outer]},34.375,72.1875);
 const cut=nativeCellOverlap({type:'Polygon',coordinates:[outer,hole]},34.375,72.1875);
 assert.ok(full>0);assert.ok(Math.abs(cut/full-.75)<1e-8);
 assert.equal(nativeCellOverlap({type:'Polygon',coordinates:[outer]},30,65),0);
});
function records(start,end,factor=1,hourly=false){const rows=[];for(let year=start;year<=end;year++){
 for(let t=Date.UTC(year,0,1);t<Date.UTC(year+1,0,1);t+=10800000){const day=(t-Date.UTC(year,0,1))/86400000;
 const value=factor*(1+(year-start)*.07)*(1+Math.pow(Math.max(0,Math.sin(day*.1)),4));
 for(let j=0;j<(hourly?3:1);j++)rows.push({timestamp:new Date(t+j*3600000).toISOString().slice(0,16),precipitationMm:hourly?value/3:value});
 }}return rows;}
test('rolling maxima refuse unsupported durations and gaps never become windows',()=>{
 assert.throws(()=>nativeDurationMaxima([],180,60),/unsupported/);
 const full=records(1985,1985);assert.equal(nativeDurationMaxima(full,180,360).length,1);
 assert.equal(nativeDurationMaxima(full.slice(0,100),180,360).length,0);
});
test('each native duration independently corrects fitted quantiles and audits common years',()=>{
 const hist=records(1985,2004),future=records(2041,2048,1.4),ref=records(1985,2004,2,true);
 const result=independentlyCorrectNativeDurations(hist,future,ref);
 assert.equal(result.rows.length,32);assert.deepEqual(result.audit.map(a=>a.durationMinutes),[180,360,720,1440]);
 for(const row of result.rows){const quantile=frequencyQuantile(nativeDurationMaxima(future,180,row.durationMinutes).map(v=>v.depthMm),row.returnPeriodYears,'gev');
 assert.ok(Math.abs(row.depthMm-quantile*2)<1e-7);assert.equal(row.derived,false);assert.ok(Number.isFinite(row.ciLower)&&row.ciUpper>=row.ciLower);}
 assert.ok(result.audit.every(a=>a.baselineYears.length===20&&a.futureYears.length===8));
 assert.throws(()=>independentlyCorrectNativeDurations(records(1985,2003),future,ref),/at least 20/);
});
test('real CEDA NCSS district subset aggregates intersecting native grid cells',()=>{
 const geometry={type:'Polygon',coordinates:[[[71.5,33.5],[72.5,33.5],[72.5,34.5],[71.5,34.5],[71.5,33.5]]]};
 const r=parseNativeThreeHourly(readFileSync(new URL('./fixtures/native-3h-grid.nc',import.meta.url)),geometry);
 assert.equal(r.gridCells,2);assert.equal(r.records.length,24);
 assert.ok(Math.abs(r.records[0].precipitationMm-0.00002254535913623292)<1e-12);
});
