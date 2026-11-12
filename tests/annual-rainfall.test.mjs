import test from 'node:test';import assert from 'node:assert/strict';
import {annualRainfallSummary} from '../lib/annual-rainfall.ts';
const daily=(year,value)=>{const rows=[];for(let t=Date.UTC(year,0,1);t<Date.UTC(year+1,0,1);t+=86400000)rows.push({timestamp:new Date(t).toISOString().slice(0,10),precipitationMm:value});return rows;};
test('annual rainfall sums depths, accounts for leap years and averages year totals rather than maxima',()=>{
 const result=annualRainfallSummary([...daily(2019,1),...daily(2020,2)]);assert.equal(result.meanMm,(365+732)/2);assert.equal(result.totalMm,1097);assert.deepEqual(result.completeYears,[2019,2020]);assert.equal(result.excludedYears.length,0);
});
test('partial years and entirely missing years are not zero-filled into a full-period mean',()=>{
 const result=annualRainfallSummary([...daily(2019,1),...daily(2021,2),...daily(2022,3).slice(0,100)]);assert.equal(result.meanMm,(365+730)/2);assert.deepEqual(result.excludedYears,[2020,2022]);assert.equal(result.years.find(row=>row.year===2020).totalMm,null);assert.equal(result.totalMm,365+730+300);
});
test('365-day source calendars retain complete model leap years without inventing a leap day',()=>{
 const rows=daily(2020,1).filter(r=>r.timestamp!=='2020-02-29');assert.equal(annualRainfallSummary(rows,{calendar:'365_day'}).meanMm,365);assert.equal(annualRainfallSummary(rows).meanMm,null);
});
test('zeros remain valid, duplicates are not double-counted, invalid values are excluded',()=>{
 const rows=daily(2019,0);const result=annualRainfallSummary([...rows,rows[0],{timestamp:'2019-02-30',precipitationMm:100},{timestamp:'2019-01-01',precipitationMm:-1}]);assert.equal(result.meanMm,0);assert.equal(result.duplicates,1);assert.equal(result.invalidRecords,2);
});
test('preceding-hour totals are assigned to their actual source-calendar interval year',()=>{
 const rows=[];for(let t=Date.UTC(2020,0,1)+3600000;t<=Date.UTC(2021,0,1);t+=3600000)rows.push({timestamp:new Date(t).toISOString().slice(0,16),precipitationMm:1});const result=annualRainfallSummary(rows,{hourlyIntervalEnding:true});assert.deepEqual(result.completeYears,[2020]);assert.equal(result.meanMm,8784);assert.equal(annualRainfallSummary(rows.slice(0,-1),{hourlyIntervalEnding:true}).meanMm,null);
});
test('unsupported calendars do not produce an asserted annual climatology',()=>{const result=annualRainfallSummary(daily(2020,1),{calendar:'360_day'});assert.equal(result.meanMm,null);assert.match(result.error,/Unsupported/);});
