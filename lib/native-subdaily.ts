import { NetCDFReader } from "netcdfjs";
import { frequencyQuantile, PERIODS, type ResultRow } from "./observed-idf.ts";
import type { OnlineGeometry } from "./online-precipitation.ts";

export type NativeRainRecord={timestamp:string;precipitationMm:number};
export type NativeDurationAudit={durationMinutes:number;baselineYears:number[];futureYears:number[];referenceYears:number;minimumCoverage:number};
export type NativeCorrectionResult={rows:ResultRow[];audit:NativeDurationAudit[];warnings:string[];method:string};
const STEP=180*60000;
const flat=(input:unknown):number[]=>typeof input==='number'?[input]:Array.isArray(input)||ArrayBuffer.isView(input)?Array.from(input as ArrayLike<unknown>).flatMap(flat):[];

function clipArea(ring:number[][],west:number,east:number,south:number,north:number){
 let points=ring;
 const boundaries:[number,number,boolean][]=[[0,west,true],[0,east,false],[1,south,true],[1,north,false]];
 for(const [axis,edge,greater] of boundaries){
  const out:number[][]=[];
  for(let i=0;i<points.length;i++){
   const a=points[i],b=points[(i+1)%points.length];
   const ina=greater?a[axis]>=edge:a[axis]<=edge,inb=greater?b[axis]>=edge:b[axis]<=edge;
   if(ina)out.push(a);
   if(ina!==inb){const t=(edge-a[axis])/(b[axis]-a[axis]);out.push([a[0]+t*(b[0]-a[0]),a[1]+t*(b[1]-a[1])]);}
  }
  points=out;if(!points.length)return 0;
 }
 return Math.abs(points.reduce((sum,a,i)=>{const b=points[(i+1)%points.length];return sum+a[0]*b[1]-b[0]*a[1];},0))/2;
}
export function nativeCellOverlap(geometry:OnlineGeometry,lat:number,lon:number){
 const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
 return polygons.reduce((sum,polygon)=>sum+Math.max(0,polygon.reduce((area,ring,index)=>area+(index===0?1:-1)*clipArea(ring,lon-.9375,lon+.9375,lat-.625,lat+.625),0)),0)*Math.cos(lat*Math.PI/180);
}

/** ACCESS-CM2 native 3hr mean flux. NCSS times are verified interval midpoints. */
export function parseNativeThreeHourly(data:ArrayBuffer|Uint8Array,geometry?:OnlineGeometry){
 const reader=new NetCDFReader(data);
 const find=(names:string[])=>reader.variables.find(v=>names.includes(v.name));
 const time=find(['time']),pr=find(['pr']),latitude=find(['lat','latitude']),longitude=find(['lon','longitude']);
 if(!time||!pr||!latitude||!longitude)throw Error('Native NetCDF subset is missing time, precipitation or grid coordinates.');
 const attr=(variable:typeof time,key:string)=>(variable?.attributes as {name:string;value:unknown}[]|undefined)?.find(a=>a.name===key)?.value;
 const units=String(attr(time,'units')??'');const match=units.match(/^(days?|hours?|seconds?)\s+since\s+(.+)$/i);
 if(!match)throw Error('Unsupported native time units.');
 const calendar=String(attr(time,'calendar')??'standard');
 if(!['standard','gregorian','proleptic_gregorian'].includes(calendar))throw Error(`Native calendar ${calendar} requires a calendar-aware workflow; no conversion was assumed.`);
 const unit=String(attr(pr,'units')??'').replace(/\s+/g,' ').trim();
 if(!['kg m-2 s-1','kg m^-2 s^-1','kg/m2/s'].includes(unit))throw Error(`Unsupported native precipitation units: ${unit}.`);
 const epoch=Date.parse(match[2].trim().replace(' ','T'));if(!Number.isFinite(epoch))throw Error('Invalid native time epoch.');
 const multiplier=/^day/i.test(match[1])?86400000:/^hour/i.test(match[1])?3600000:1000;
 const times=flat(reader.getDataVariable(time)),lats=flat(reader.getDataVariable(latitude)),lons=flat(reader.getDataVariable(longitude)).map(v=>v>180?v-360:v),values=flat(reader.getDataVariable(pr));
 const point=pr.dimensions.length===1;
 const sizes=pr.dimensions.map(id=>reader.dimensions[id].size||reader.recordDimension.length);
 const dims=pr.dimensions.map(id=>reader.dimensions[id].name);
 const ti=dims.findIndex(d=>/time|obs/i.test(d)),yi=dims.findIndex(d=>/lat/i.test(d)),xi=dims.findIndex(d=>/lon/i.test(d));
 if(!point&&(ti<0||yi<0||xi<0))throw Error('Unsupported native grid dimensions.');
 const cells=lats.flatMap((lat,y)=>lons.map((lon,x)=>({lat,lon,y,x,weight:geometry?nativeCellOverlap(geometry,lat,lon):1}))).filter(c=>c.weight>0);
 if(!cells.length)throw Error('No model-cell overlap with the selected district. No nearest-point replacement was made.');
 const totalWeight=cells.reduce((sum,cell)=>sum+cell.weight,0);
 const records:NativeRainRecord[]=[];
 for(let t=0;t<times.length;t++){
  const center=epoch+times[t]*multiplier,start=center-STEP/2;
  if(Math.abs(start/STEP-Math.round(start/STEP))>1e-7)throw Error('Native times do not match the verified 3-hour interval midpoint convention.');
  let sum=0,weight=0;
  for(const cell of cells){
   const indices=Array(sizes.length).fill(0);indices[ti]=t;if(!point){indices[yi]=cell.y;indices[xi]=cell.x;}
   const index=point?t:indices.reduce((value,coordinate,i)=>value*sizes[i]+coordinate,0);
   const value=values[index];if(!Number.isFinite(value)||value<0||value>1)continue;
   sum+=value*10800*cell.weight;weight+=cell.weight;
  }
  if(weight>=totalWeight*(1-1e-9))records.push({timestamp:new Date(start).toISOString().slice(0,16),precipitationMm:sum/weight});
 }
 if(!records.length)throw Error('No valid native 3-hour precipitation was returned.');
 return {records,gridCells:cells.length,calendar,units:unit,returnedLatitude:point?lats[0]:undefined,returnedLongitude:point?lons[0]:undefined,intervalConvention:'Native CF interval midpoint converted to start; flux multiplied by 10800 seconds, no temporal disaggregation'};
}

/** Rolling sums only use consecutive native intervals. Year coverage is duration-specific. */
export function nativeDurationMaxima(records:NativeRainRecord[],stepMinutes:number,durationMinutes:number){
 if(durationMinutes<stepMinutes||durationMinutes%stepMinutes)throw Error('Duration is unsupported by the native interval.');
 const entries=[...new Map(records.filter(r=>Number.isFinite(r.precipitationMm)&&r.precipitationMm>=0).map(r=>[Date.parse(r.timestamp+'Z'),r.precipitationMm])).entries()].filter(([t])=>Number.isFinite(t)).sort((a,b)=>a[0]-b[0]);
 const counts=new Map<number,number>();for(const [t] of entries){const year=new Date(t).getUTCFullYear();counts.set(year,(counts.get(year)??0)+1);}
 const eligible=new Set([...counts].filter(([year,count])=>count/((Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/(stepMinutes*60000))>=.9).map(([year])=>year));
 const width=durationMinutes/stepMinutes,window:number[]=[];let sum=0,previous=NaN;const maxima=new Map<number,number>(),windowCounts=new Map<number,number>();
 for(const [t,value] of entries){if(t-previous!==stepMinutes*60000){window.length=0;sum=0;}previous=t;window.push(value);sum+=value;if(window.length>width)sum-=window.shift()!;if(window.length!==width)continue;
  const year=new Date(t+stepMinutes*60000-1).getUTCFullYear();windowCounts.set(year,(windowCounts.get(year)??0)+1);if(eligible.has(year))maxima.set(year,Math.max(maxima.get(year)??0,sum));}
 return [...maxima].filter(([year])=>(windowCounts.get(year)??0)/((Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/(stepMinutes*60000))>=.9).map(([year,depthMm])=>({year,depthMm})).sort((a,b)=>a.year-b.year);
}

/** Independently adjusted duration-specific return levels, not a corrected continuous time series. */
export function independentlyCorrectNativeDurations(historical:NativeRainRecord[],future:NativeRainRecord[],reference:NativeRainRecord[]):NativeCorrectionResult{
 const rows:ResultRow[]=[],audit:NativeDurationAudit[]=[],warnings:string[]=[];
 for(const duration of [180,360,720,1440]){
  const hm=nativeDurationMaxima(historical,180,duration),hr=nativeDurationMaxima(reference,60,duration),fm=nativeDurationMaxima(future,180,duration);
  const referenceMap=new Map(hr.map(row=>[row.year,row.depthMm]));
  const common=hm.filter(row=>referenceMap.has(row.year)&&row.year>=1985&&row.year<=2014);
  if(common.length<20)throw Error(`${duration/60}-hour correction has ${common.length} common eligible baseline years; at least 20 are required.`);
  if(fm.length<8)throw Error(`${duration/60}-hour future fit has fewer than eight eligible years.`);
  const model=common.map(r=>r.depthMm),ref=common.map(r=>referenceMap.get(r.year)!),fut=fm.map(r=>r.depthMm);
  const quantile=(values:number[],period:number)=>frequencyQuantile(values,period,'gev');
  let seed=duration+common.length*7919;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const boot=new Map(PERIODS.map(T=>[T,[] as number[]]));
  for(let repetition=0;repetition<100;repetition++){
   const indices=Array.from({length:model.length},()=>Math.floor(random()*model.length));const bm=indices.map(i=>model[i]),br=indices.map(i=>ref[i]),bf=Array.from({length:fut.length},()=>fut[Math.floor(random()*fut.length)]);
   for(const T of PERIODS){const denominator=quantile(bm,T),estimate=quantile(br,T)*quantile(bf,T)/denominator;if(denominator>0&&estimate>=0&&Number.isFinite(estimate))boot.get(T)!.push(estimate);}
  }
  for(const T of PERIODS){
   const mh=quantile(model,T),rh=quantile(ref,T),ff=quantile(fut,T);const depth=rh*ff/mh;
   if(!(mh>0&&depth>=0&&Number.isFinite(depth)))throw Error(`${duration/60}-hour return-level correction is not estimable at T=${T}.`);
   const values=boot.get(T)!.sort((a,b)=>a-b);if(values.length<80)throw Error('Too few valid bootstrap refits; native correction is unstable.');
   const at=(p:number)=>values[Math.round((values.length-1)*p)];
   rows.push({method:'gev',durationMinutes:duration,returnPeriodYears:T,depthMm:depth,intensityMmHr:depth/(duration/60),ciLower:at(.025)/(duration/60),ciUpper:at(.975)/(duration/60),derived:false});
  }
  audit.push({durationMinutes:duration,baselineYears:common.map(r=>r.year),futureYears:fm.map(r=>r.year),referenceYears:hr.length,minimumCoverage:.9});
 }
 for(const T of PERIODS){const curve=rows.filter(r=>r.returnPeriodYears===T);for(let i=1;i<curve.length;i++)if(curve[i].depthMm<curve[i-1].depthMm||curve[i].intensityMmHr>curve[i-1].intensityMmHr)warnings.push(`T=${T}: duration ordering needs review. Independent fits were not forced into a scaling law.`);}
 return {rows,audit,warnings:[...new Set(warnings)],method:'Independent duration-specific multiplicative quantile-change correction of GEV return levels'};
}
