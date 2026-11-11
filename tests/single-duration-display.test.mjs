import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveIdfDurationsFrom24Hours, fitPowerEquation } from '../lib/idf-design.ts';
const daily={method:'gev',durationMinutes:1440,returnPeriodYears:10,depthMm:240,intensityMmHr:10,ciLower:8,ciUpper:12,derived:false};

test('optional assumed disaggregation preserves the 24h result and labels shorter durations as derived',()=>{
 const rows=deriveIdfDurationsFrom24Hours([daily],.33);
 assert.equal(rows.length,10);
 assert.deepEqual(rows.find(row=>row.durationMinutes===1440),daily);
 const hour=rows.find(row=>row.durationMinutes===60);
 assert.ok(Math.abs(hour.depthMm-240*(60/1440)**.33)<1e-10);
 assert.equal(hour.intensityMmHr,hour.depthMm);
 assert.equal(hour.derived,true);
 assert.ok(Math.abs(hour.ciLower-8*(60/1440)**(-.67))<1e-10);
 assert.ok(Math.abs(fitPowerEquation(rows,10).exponent+.67)<1e-10);
});

test('invalid assumptions or non-24h input do not fabricate duration curves',()=>{
 for(const exponent of [0,1,-.5,NaN,Infinity])assert.deepEqual(deriveIdfDurationsFrom24Hours([daily],exponent),[]);
 assert.deepEqual(deriveIdfDurationsFrom24Hours([{...daily,durationMinutes:60}],.33),[]);
});
