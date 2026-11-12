import test from 'node:test';
import assert from 'node:assert/strict';
import {PAKISTAN_IMD} from '../lib/pakistan-duration-scaling.ts';
import {scaleDailyDurations,fitPowerEquation,powerIntensityAtDuration} from '../lib/idf-design.ts';
test('Pakistan published IMD preset reproduces Section 3.2 Eq 1 and its supported durations',()=>{
 const daily={method:'gev',durationMinutes:1440,returnPeriodYears:10,depthMm:100,intensityMmHr:100/24,ciLower:80/24,ciUpper:120/24,derived:false};
 const rows=scaleDailyDurations([daily],PAKISTAN_IMD.alpha,PAKISTAN_IMD.durationsMinutes);
 assert.deepEqual(rows.map(r=>r.durationMinutes),[60,120,180,240,360,720,1440]);assert.deepEqual(rows.at(-1),daily);
 assert.ok(Math.abs(rows[0].depthMm-100/Math.cbrt(24))<1e-12);
 assert.ok(Math.abs(rows[3].depthMm-100/Math.cbrt(6))<1e-12);
 assert.ok(rows.slice(0,-1).every(r=>r.derived));assert.ok(rows.every(r=>r.durationMinutes>=60));
 const fit=fitPowerEquation(rows,10);assert.ok(Math.abs(fit.exponent+2/3)<1e-12);
 assert.equal(powerIntensityAtDuration(rows,10,30),null);assert.ok(powerIntensityAtDuration(rows,10,90)>0);
 assert.match(PAKISTAN_IMD.basis,/not a district-fitted/);assert.equal(PAKISTAN_IMD.doi,'10.3390/atmos16111271');
});
test('published preset rejects unsupported durations while custom defaults remain separate',()=>{
 const daily={method:'gev',durationMinutes:1440,returnPeriodYears:2,depthMm:24,intensityMmHr:1,ciLower:.8,ciUpper:1.2,derived:false};
 assert.equal(scaleDailyDurations([daily],.4).length,10);
 assert.deepEqual(scaleDailyDurations([daily],1/3,[NaN,-1,0,1500,60,60,1440]).map(r=>r.durationMinutes),[60,1440]);
});
