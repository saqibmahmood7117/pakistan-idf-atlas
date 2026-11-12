import test from 'node:test';
import assert from 'node:assert/strict';
import {scaleDailyDurations,fitPowerEquation,powerIntensityAtDuration} from '../lib/idf-design.ts';
const daily={method:'gev',durationMinutes:1440,returnPeriodYears:10,depthMm:240,intensityMmHr:10,ciLower:8,ciUpper:12,derived:false};
test('daily scaling preserves corrected daily values and converts depth/intensity consistently',()=>{
 const rows=scaleDailyDurations([daily],.33);assert.equal(rows.length,10);assert.deepEqual(rows.at(-1),daily);
 const hour=rows.find(r=>r.durationMinutes===60);assert.ok(Math.abs(hour.depthMm-240*(1/24)**.33)<1e-10);assert.equal(hour.intensityMmHr,hour.depthMm);assert.equal(hour.derived,true);assert.ok(Math.abs(hour.ciLower-8*(1/24)**(-.67))<1e-10);
 const fit=fitPowerEquation(rows,10);assert.ok(Math.abs(fit.exponent+.67)<1e-10);assert.ok(Math.abs(fit.rSquared-1)<1e-10);assert.ok(Math.abs(powerIntensityAtDuration(rows,10,60)-hour.intensityMmHr)<1e-8);
 assert.notEqual(scaleDailyDurations([daily],.4)[4].depthMm,hour.depthMm);
});
test('daily scaling ignores existing sub-daily rows and rejects invalid exponents',()=>{
 for(const alpha of [0,1,NaN,Infinity,-1])assert.deepEqual(scaleDailyDurations([daily],alpha),[]);
 assert.deepEqual(scaleDailyDurations([{...daily,durationMinutes:60}],.33),[]);
 assert.equal(scaleDailyDurations([daily,{...daily,durationMinutes:60}],.33).length,10);
});
