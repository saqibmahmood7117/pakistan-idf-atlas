import type {PrecipitationPlotRecord} from './online-precipitation.ts';
export type AnnualRainfallYear={year:number;totalMm:number|null;validIntervals:number;expectedIntervals:number;coverage:number;complete:boolean};
/** Sum rainfall depths, then average complete source-calendar year totals; no gap filling. */
export function annualRainfallSummary(records:PrecipitationPlotRecord[],options:{calendar?:string;hourlyIntervalEnding?:boolean}={}){
 const calendar=(options.calendar??'standard').trim().toLowerCase(),noLeap=calendar==='noleap'||calendar==='365_day';
 const supported=noLeap||['standard','gregorian','proleptic_gregorian',''].includes(calendar);
 const frequency=records.some(row=>row.timestamp.includes('T'))?'hourly':'daily';
 const unique=new Map<string,{time:number;value:number}>();let invalidRecords=0,duplicates=0;
 for(const row of records){
  const key=row.timestamp.replace(/Z$/,'');const pattern=frequency==='daily'?/^\d{4}-\d{2}-\d{2}$/:/^\d{4}-\d{2}-\d{2}T\d{2}:00$/;
  const time=Date.parse(frequency==='daily'?key+'T00:00:00Z':key+':00Z');
  if(!pattern.test(key)||!Number.isFinite(time)||new Date(time).toISOString().slice(0,frequency==='daily'?10:16)!==key||!Number.isFinite(row.precipitationMm)||row.precipitationMm<0||(noLeap&&key.slice(5,10)==='02-29')){invalidRecords++;continue;}
  if(unique.has(key))duplicates++;unique.set(key,{time,value:row.precipitationMm});
 }
 const entries=[...unique.entries()].sort((a,b)=>a[1].time-b[1].time),years=new Map<number,{total:number;count:number}>();
 for(const [,entry] of entries){let time=entry.time;if(frequency==='hourly'&&options.hourlyIntervalEnding){time-=3600000;if(noLeap&&new Date(time).toISOString().slice(5,10)==='02-29')time-=86400000;}
  const year=new Date(time).getUTCFullYear(),sum=years.get(year)??{total:0,count:0};sum.total+=entry.value;sum.count++;years.set(year,sum);
 }
 if(years.size){const keys=[...years.keys()],first=Math.min(...keys),last=Math.max(...keys);for(let year=first;year<=last;year++)if(!years.has(year))years.set(year,{total:0,count:0});}
 const rows:AnnualRainfallYear[]=[...years].sort((a,b)=>a[0]-b[0]).map(([year,value])=>{const days=noLeap?365:(Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/86400000,expected=days*(frequency==='hourly'?24:1);return {year,totalMm:value.count?value.total:null,validIntervals:value.count,expectedIntervals:expected,coverage:value.count/expected,complete:supported&&value.count===expected};});
 const completeYears=rows.filter(row=>row.complete),totalMm=entries.reduce((sum,[,value])=>sum+value.value,0);
 return {years:rows,meanMm:completeYears.length?completeYears.reduce((sum,row)=>sum+(row.totalMm??0),0)/completeYears.length:null,totalMm,completeYears:completeYears.map(row=>row.year),excludedYears:rows.filter(row=>!row.complete).map(row=>row.year),start:entries[0]?.[0]??'',end:entries.at(-1)?.[0]??'',validRecords:unique.size,invalidRecords,duplicates,frequency,calendar:noLeap?'365_day':calendar||'standard',error:supported?null:`Unsupported source calendar (${calendar}); no annual average inferred.`,hourlyIntervalEnding:frequency==='hourly'&&!!options.hourlyIntervalEnding};
}
