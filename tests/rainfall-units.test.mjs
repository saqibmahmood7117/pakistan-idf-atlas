import test from 'node:test';
import assert from 'node:assert/strict';
import {mmHrToInchHr,intensityPair} from '../lib/rainfall-units.ts';
import {scaleDailyDurations} from '../lib/idf-design.ts';
test('international-inch reference intensities and derived duration results retain physical equivalence',()=>{
 assert.equal(mmHrToInchHr(25.4),1);assert.equal(mmHrToInchHr(254),10);assert.equal(mmHrToInchHr(0),0);
 const row={method:'gev',durationMinutes:1440,returnPeriodYears:10,depthMm:609.6,intensityMmHr:25.4,ciLower:12.7,ciUpper:50.8,derived:false};
 const rows=scaleDailyDurations([row],.33);for(const r of rows){assert.ok(Math.abs(mmHrToInchHr(r.intensityMmHr)*r.durationMinutes/60-r.depthMm/25.4)<1e-10);assert.ok(mmHrToInchHr(r.ciUpper)>=mmHrToInchHr(r.ciLower));}
 assert.equal(intensityPair(25.4),'25.400 mm/hr | 1.0000 inch/hr');assert.equal(row.intensityMmHr,25.4);
});
