import test from 'node:test';
import assert from 'node:assert/strict';
import { cmipBiasSpatialKey, districtBiasReference, matchCmipHistoricalBaseline } from '../lib/cmip6-bias-context.ts';
import { monthlyMultiplicativeQdm } from '../lib/cmip6-extremes.ts';
const geometry={type:'Polygon',coordinates:[[[71.5,33.5],[72.5,33.5],[72.5,34.5],[71.5,34.5],[71.5,33.5]]]};
const input={mode:'district',district:'Peshawar',latitude:34,longitude:72,geometry,boundaryCode:'PK123',boundaryVersion:'V1'};
const series=(start,end,value)=>{
 const rows=[];
 for(let time=Date.UTC(start,0,1);time<Date.UTC(end+1,0,1);time+=86400000)rows.push({date:new Date(time).toISOString().slice(0,10),precipitationMm:value,qc:'test district daily mean'});
 return rows;
};

test('district calibration identity includes mode, polygon and boundary version, not unrelated point coordinates',()=>{
 const key=cmipBiasSpatialKey(input);
 assert.equal(cmipBiasSpatialKey({...input,latitude:25,longitude:65}),key);
 assert.notEqual(cmipBiasSpatialKey({...input,district:'Other district'}),key);
 assert.notEqual(cmipBiasSpatialKey({...input,boundaryVersion:'V2'}),key);
 assert.notEqual(cmipBiasSpatialKey({...input,geometry:{...geometry,coordinates:[[[71.4,33.5],...geometry.coordinates[0].slice(1)]]}}),key);
 assert.notEqual(cmipBiasSpatialKey({...input,mode:'point'}),key);
});

test('district automatic correction uses ERA5 and refuses to relabel a point gauge',()=>{
 assert.equal(districtBiasReference('district','auto',30),'era5');
 assert.equal(districtBiasReference('district','era5',0),'era5');
 assert.throws(()=>districtBiasReference('district','gauge',30),/not a district spatial reference/);
 assert.equal(districtBiasReference('point','auto',30),'gauge');
 assert.equal(districtBiasReference('point','auto',10),'era5');
});

test('two separately adequate baseline records still require common eligible years',()=>{
 const matched=matchCmipHistoricalBaseline(series(1985,2004,2),series(1995,2014,4));
 assert.equal(matched.years.length,10);
 assert.equal(matched.years[0],1995);
 assert.ok(matched.model.every(row=>Number(row.date.slice(0,4))>=1995));
});

test('district monthly QDM corrects the aggregated series using matched complete baseline years',()=>{
 const matched=matchCmipHistoricalBaseline(series(1985,2014,2),series(1985,2014,4));
 assert.equal(matched.years.length,30);
 const result=monthlyMultiplicativeQdm(series(2041,2043,5),matched.model,matched.reference);
 assert.equal(result.summaries.length,12);
 assert.ok(result.records.every(row=>row.precipitationMm===10));
 const missing=series(1985,2014,4).filter(row=>!row.date.startsWith('1990-'));
 assert.ok(!matchCmipHistoricalBaseline(matched.model,missing).years.includes(1990));
});
