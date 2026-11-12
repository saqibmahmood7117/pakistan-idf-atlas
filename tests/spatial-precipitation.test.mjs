import test from 'node:test';
import assert from 'node:assert/strict';
import {retrieveOpenMeteoSpatial,precipitationColor} from '../lib/spatial-precipitation.ts';
import {parseCmip6NcssNetcdf} from '../lib/cmip6-netcdf.ts';
const geometry={type:'Polygon',coordinates:[[[71.5,33.5],[72.5,33.5],[72.5,34.5],[71.5,34.5],[71.5,33.5]]]};
test('spatial retrieval uses actual returned coordinates, the same sampling mesh, exact timestamps and mm units',async()=>{
 const result=await retrieveOpenMeteoSpatial({source:'era5',resolution:'daily',geometry,timestamp:'2020-01-02',fetchJson:async input=>{
 const url=new URL(input);assert.equal(url.searchParams.get('models'),'era5');assert.equal(url.searchParams.get('start_date'),'2020-01-02');assert.equal(url.searchParams.get('end_date'),'2020-01-02');assert.equal(url.searchParams.get('daily'),'precipitation_sum');
 return url.searchParams.get('latitude').split(',').map((_,i)=>({latitude:34+i*.25,longitude:72,daily_units:{precipitation_sum:'mm'},daily:{time:['2020-01-02'],precipitation_sum:[i===0?null:10+i]}}));
 }});
 assert.ok(result.cells.length>1);assert.equal(result.cells[0].precipitationMm,null);assert.equal(result.cells[1].precipitationMm,11);assert.equal(result.cells[1].latitude,34.25);assert.equal(result.cells[1].latitudeSize,.25);assert.match(result.note,/not a complete raster/);
});
test('spatial missing data and wrong units are not replaced with invented rainfall',async()=>{
 const base={source:'ifs',resolution:'hourly',geometry,timestamp:'2020-01-02T03:00'};
 await assert.rejects(()=>retrieveOpenMeteoSpatial({...base,fetchJson:async input=>new URL(input).searchParams.get('latitude').split(',').map(()=>({latitude:34,longitude:72,hourly_units:{precipitation:'mm'},hourly:{time:['2020-01-02T02:00'],precipitation:[12]}}))}),/No valid/);
 await assert.rejects(()=>retrieveOpenMeteoSpatial({...base,fetchJson:async input=>new URL(input).searchParams.get('latitude').split(',').map(()=>({latitude:34,longitude:72,hourly_units:{precipitation:'cm'},hourly:{time:[base.timestamp],precipitation:[12]}}))}),/depth in mm/);
 assert.notEqual(precipitationColor(null,10),precipitationColor(0,10));
});
test('NASA spatial snapshot preserves raw source values and does not alter daily aggregation',()=>{
 const fixture=Buffer.from('Q0RGAQAAAAIAAAAKAAAAAwAAAAR0aW1lAAAAAAAAAANsYXQAAAAAAgAAAANsb24AAAAAAgAAAAAAAAAAAAAACwAAAAQAAAADbGF0AAAAAAEAAAABAAAADAAAAAEAAAAFdW5pdHMAAAAAAAACAAAADWRlZ3JlZXNfbm9ydGgAAAAAAAAFAAAACAAAAawAAAADbG9uAAAAAAEAAAACAAAADAAAAAEAAAAFdW5pdHMAAAAAAAACAAAADGRlZ3JlZXNfZWFzdAAAAAUAAAAIAAABtAAAAAR0aW1lAAAAAQAAAAAAAAAMAAAAAgAAAAV1bml0cwAAAAAAAAIAAAAeZGF5cyBzaW5jZSAyMDQxLTAxLTAxIDAwOjAwOjAwAAAAAAAIY2FsZW5kYXIAAAACAAAACHN0YW5kYXJkAAAABgAAAAgAAAG8AAAAAnByAAAAAAADAAAAAAAAAAEAAAACAAAADAAAAAIAAAAFdW5pdHMAAAAAAAACAAAACmtnIG0tMiBzLTEAAAAAAApfRmlsbFZhbHVlAAAAAAAFAAAAAXzwAAAAAAAFAAAAEAAAAcRCCAAAQgkAAEKPAABCj4AAP+AAAAAAAAA40bcXOVG3FzmdSVI50bcXP/gAAAAAAAA6AxJvOh1JUjo3gDQ6UbcX','base64');
 const small={type:'Polygon',coordinates:[[[71.7,34.2],[71.8,34.2],[71.8,34.3],[71.7,34.3],[71.7,34.2]]]};
 const original=parseCmip6NcssNetcdf(fixture,'district',small),mapped=parseCmip6NcssNetcdf(fixture,'district',small,'2041-01-02');assert.deepEqual(mapped.records,original.records);assert.equal(original.spatialCells.length,0);assert.equal(mapped.spatialCells.length,1);assert.ok(Math.abs(mapped.spatialCells[0].precipitationMm-69.12)<.0001);assert.equal(parseCmip6NcssNetcdf(fixture,'district',small,'2041-01-03').spatialCells.length,0);
});
