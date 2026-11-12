import {ERA5_DISTRICT_CELL_LIMIT,LIVE_SOURCE_CONFIG,reanalysisDistrictGrid,type OnlineGeometry} from './online-precipitation.ts';
export type SpatialRainCell={latitude:number;longitude:number;precipitationMm:number|null;weight?:number;latitudeSize?:number;longitudeSize?:number};
export type SpatialRainSnapshot={timestamp:string;cells:SpatialRainCell[];source:string;note:string;retrievedAt:string;sourceUrl?:string};
export function precipitationColor(value:number|null,max:number){if(value===null||!Number.isFinite(value)||value<0)return '#dce3e5';const q=Math.min(1,Math.max(0,value/Math.max(max,.001)));return `rgb(${Math.round(232-226*q)},${Math.round(247-138*q)},${Math.round(246-127*q)})`;}
export async function retrieveOpenMeteoSpatial({source,resolution,geometry,timestamp,fetchJson}:{source:'era5'|'ifs';resolution:'daily'|'hourly';geometry:OnlineGeometry;timestamp:string;fetchJson:(url:string)=>Promise<unknown>}):Promise<SpatialRainSnapshot>{
 const config=LIVE_SOURCE_CONFIG[source],grid=reanalysisDistrictGrid(source,geometry,ERA5_DISTRICT_CELL_LIMIT[resolution]);
 const url=new URL('https://archive-api.open-meteo.com/v1/archive');
 url.searchParams.set('latitude',grid.points.map(p=>p.latitude.toFixed(4)).join(','));url.searchParams.set('longitude',grid.points.map(p=>p.longitude.toFixed(4)).join(','));
 url.searchParams.set('start_date',timestamp.slice(0,10));url.searchParams.set('end_date',timestamp.slice(0,10));url.searchParams.set('models',config.openMeteoModel);url.searchParams.set('timezone','UTC');url.searchParams.set('cell_selection','nearest');url.searchParams.set(resolution,resolution==='daily'?'precipitation_sum':'precipitation');
 type Payload={latitude?:number;longitude?:number;daily_units?:{precipitation_sum?:string};hourly_units?:{precipitation?:string};daily?:{time:string[];precipitation_sum:(number|null)[]};hourly?:{time:string[];precipitation:(number|null)[]}};
 const payload=await fetchJson(url.toString());const rows=(Array.isArray(payload)?payload:[payload]) as Payload[];
 if(rows.length!==grid.points.length)throw Error('Spatial provider returned an unexpected number of locations.');
 const cells:SpatialRainCell[]=rows.map((row,i)=>{
  const unit=resolution==='daily'?row.daily_units?.precipitation_sum:row.hourly_units?.precipitation;if(unit!=='mm')throw Error('Spatial source must return precipitation depth in mm.');
  if(!Number.isFinite(row.latitude)||!Number.isFinite(row.longitude))throw Error('Provider did not identify returned grid coordinates.');
  const times=resolution==='daily'?row.daily?.time:row.hourly?.time,values=resolution==='daily'?row.daily?.precipitation_sum:row.hourly?.precipitation;
  const index=times?.indexOf(timestamp)??-1,value=index>=0?values?.[index]:null;
  return {latitude:row.latitude!,longitude:row.longitude!,precipitationMm:typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null,weight:grid.points[i].weight,...(source==='era5'?{latitudeSize:.25,longitudeSize:.25}:{})};
 });
 const unique=new Map<string,SpatialRainCell>();
 for(const cell of cells){const key=cell.latitude+','+cell.longitude,previous=unique.get(key);if(previous){if(previous.precipitationMm!==cell.precipitationMm)throw Error('Provider returned inconsistent values for the same grid cell.');previous.weight=(previous.weight??0)+(cell.weight??0);}else unique.set(key,{...cell});}
 const distinct=[...unique.values()];
 if(!distinct.some(c=>c.precipitationMm!==null))throw Error('No valid spatial values were returned for this interval; missing data were not replaced with zero.');
 return {timestamp,cells:distinct,source:config.dataset,retrievedAt:new Date().toISOString(),sourceUrl:url.toString(),note:`Raw source samples re-retrieved for this interval using the extraction sampling mesh (${grid.points.length} sample locations; ${distinct.length} distinct returned locations). This is approximate district sampling, not a complete raster. Returned cell centres may lie outside small polygons. ${source==='ifs'?'IFS markers show returned locations; exact cell footprints are not supplied.':'ERA5 footprints are 0.25° and clipped to the district for display.'} Provider updates can differ from a previously cached series.`};
}
