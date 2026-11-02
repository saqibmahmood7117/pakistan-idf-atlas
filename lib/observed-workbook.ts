import type * as Xlsx from "xlsx";
import type {DailyRecord,HourlyRecord} from "./observed-idf";

type DateOrder="dmy"|"mdy";
type DateParts={year:number;month:number;day:number;hour:number;minute:number;second:number;hasTime:boolean};
type Columns={precipitation:number;combinedTime:number;date:number;time:number;year:number;month:number;day:number;dayOfYear:number;hour:number;minute:number;headerText:string};
type DailySource=DailyRecord&{sheet:string};
type HourlySource={timestamp:string;hourTimestamp:string;precipitationMm:number;sheet:string;subhourly:boolean};

export type ObservedWorkbookResult={
 resolution:"daily"|"hourly";
 dailyRecords:DailyRecord[];
 hourlyRecords:HourlyRecord[];
 sheets:string[];
 candidateRows:number;
 parsedRows:number;
 invalidRows:number;
 duplicateRows:number;
 aggregatedSubhourlyRows:number;
 otherResolutionRows:number;
 recoveredCounterRows:number;
};

export type ObservedWorkbookOptions={preferredResolution?:"daily"|"hourly"};

const normalizeHeader=(value:unknown)=>String(value??"").trim().toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
const asNumber=(value:unknown)=>{if(typeof value==="number")return value;if(typeof value!=="string")return NaN;const text=value.trim().replace(/,/g,"");if(/^t(?:race)?$/i.test(text))return 0;return Number(text)};
const integer=(value:unknown)=>{const n=asNumber(value);return Number.isFinite(n)?Math.trunc(n):NaN};
const pad=(value:number)=>String(value).padStart(2,"0");
const validParts=(p:DateParts)=>Number.isInteger(p.year)&&p.year>=1800&&p.year<=2200&&p.month>=1&&p.month<=12&&p.day>=1&&p.day<=new Date(Date.UTC(p.year,p.month,0)).getUTCDate()&&p.hour>=0&&p.hour<=24&&p.minute>=0&&p.minute<60&&p.second>=0&&p.second<60;
const normalizeParts=(p:DateParts)=>{if(!validParts(p))return null;const d=new Date(Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second));return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate(),hour:d.getUTCHours(),minute:d.getUTCMinutes(),second:d.getUTCSeconds(),hasTime:p.hasTime} as DateParts};
const dateKey=(p:DateParts)=>`${p.year}-${pad(p.month)}-${pad(p.day)}`;
const minuteKey=(p:DateParts)=>`${dateKey(p)}T${pad(p.hour)}:${pad(p.minute)}`;
const hourKey=(p:DateParts)=>`${dateKey(p)}T${pad(p.hour)}:00`;

function precipitationScore(header:string){
 if(!header||/probability|forecast/.test(header))return 0;
 if(/^(prectotcorr|prectot|prcp|ppt|rr|p)$/.test(header))return 120;
 if(/precipitation|rainfall|\bprecip\b|\brain\b/.test(header))return 110;
 return 0;
}

function detectColumns(row:unknown[]):Columns{
 const headers=row.map(normalizeHeader);
 let precipitation=-1,bestPrecipitation=0;
 headers.forEach((header,index)=>{const score=precipitationScore(header);if(score>bestPrecipitation){bestPrecipitation=score;precipitation=index}});
 const find=(pattern:RegExp)=>headers.findIndex(value=>pattern.test(value));
 const combinedTime=find(/^(timestamp|datetime|date time|date and time|valid time|local standard time|observation date time|record date time)(?: |$)/);
 const date=find(/^(date|observation date|record date|calendar date)(?: |$)/);
 const time=find(/^(time|clock time|observation time|record time)(?: |$)/);
 const year=find(/^(year|yr|yyyy|y)(?: |$)/);
 const month=find(/^(month|mon|mo|mm|m)(?: |$)/);
 const day=find(/^(day|dy|dd|day of month|d)(?: |$)/);
 const dayOfYear=find(/^(day of year|julian day|doy|jday|julian)(?: |$)/);
 const hour=find(/^(hour|hr|hh|hour ending|hour beginning|h)(?: |$)/);
 const minute=find(/^(minute|min|mi)(?: |$)/);
 return {precipitation,combinedTime,date,time,year,month,day,dayOfYear,hour,minute,headerText:headers.join(" ")};
}

const hasDateColumns=(c:Columns)=>c.combinedTime>=0||c.date>=0||(c.year>=0&&((c.month>=0&&c.day>=0)||c.dayOfYear>=0));
const schemaScore=(c:Columns)=>(c.precipitation>=0?100:0)+(c.combinedTime>=0?45:0)+(c.date>=0?40:0)+([c.year,c.month,c.day].filter(i=>i>=0).length*16)+(c.dayOfYear>=0?28:0)+(c.time>=0?14:0)+(c.hour>=0?12:0)+(c.minute>=0?8:0);

function inferDateOrder(rows:unknown[][],column:number):DateOrder{
 let dmy=0,mdy=0;
 for(const row of rows.slice(0,2000)){
  const match=String(row[column]??"").trim().match(/^(\d{1,2})[./-](\d{1,2})[./-]\d{2,4}/);
  if(!match)continue;
  const first=Number(match[1]),second=Number(match[2]);
  if(first>12&&second<=12)dmy++;else if(second>12&&first<=12)mdy++;
 }
 return mdy>dmy?"mdy":"dmy";
}

function clockFrom(value:unknown,kind:"time"|"hour"|"minute"){
 if(value instanceof Date)return {hour:value.getUTCHours(),minute:value.getUTCMinutes(),second:value.getUTCSeconds()};
 if(typeof value==="number"){
  if(kind==="minute")return {hour:0,minute:Math.trunc(value),second:0};
  if(value>=0&&value<1){const total=Math.round(value*86400);return {hour:Math.floor(total/3600),minute:Math.floor(total%3600/60),second:total%60}}
  if(kind==="hour"&&value>=0&&value<=24)return {hour:Math.trunc(value),minute:0,second:0};
  if(kind==="time"&&Number.isInteger(value)&&value>=0&&value<=2359){const text=String(value).padStart(4,"0");return {hour:Number(text.slice(0,2)),minute:Number(text.slice(2,4)),second:0}}
 }
 const text=String(value??"").trim();
 if(!text)return null;
 const ampm=text.match(/^(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*([ap]m)$/i);
 if(ampm){let hour=Number(ampm[1])%12;if(ampm[4].toLowerCase()==="pm")hour+=12;return {hour,minute:Number(ampm[2]??0),second:Number(ampm[3]??0)}}
 const colon=text.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
 if(colon)return {hour:Number(colon[1]),minute:Number(colon[2]),second:Number(colon[3]??0)};
 if(/^\d{1,4}$/.test(text)&&kind==="time"){const value=text.padStart(4,"0");return {hour:Number(value.slice(0,2)),minute:Number(value.slice(2,4)),second:0}}
 if(/^\d{5,6}$/.test(text)&&kind==="time"){const value=text.padStart(6,"0");return {hour:Number(value.slice(0,2)),minute:Number(value.slice(2,4)),second:Number(value.slice(4,6))}}
 const numeric=Number(text);
 if(Number.isFinite(numeric)){
  if(kind==="minute")return {hour:0,minute:Math.trunc(numeric),second:0};
  if(numeric>=0&&numeric<=24)return {hour:Math.trunc(numeric),minute:0,second:0};
 }
 return null;
}

function partsFrom(value:unknown,order:DateOrder,XLSX:typeof Xlsx):DateParts|null{
 if(value instanceof Date)return normalizeParts({year:value.getUTCFullYear(),month:value.getUTCMonth()+1,day:value.getUTCDate(),hour:value.getUTCHours(),minute:value.getUTCMinutes(),second:value.getUTCSeconds(),hasTime:value.getUTCHours()!==0||value.getUTCMinutes()!==0||value.getUTCSeconds()!==0});
 if(typeof value==="number"&&value>31){const xlsxModule=XLSX as typeof Xlsx&{default?:typeof Xlsx},parsed=(xlsxModule.SSF??xlsxModule.default?.SSF)?.parse_date_code(value);if(parsed)return normalizeParts({year:parsed.y,month:parsed.m,day:parsed.d,hour:parsed.H,minute:parsed.M,second:Math.floor(parsed.S),hasTime:parsed.H!==0||parsed.M!==0||parsed.S!==0})}
 const text=String(value??"").trim();
 if(!text)return null;
 const iso=text.match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})(?:[T\s]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*([ap]m)?)?/i);
 if(iso){let hour=Number(iso[4]??0);if(iso[7]){hour%=12;if(iso[7].toLowerCase()==="pm")hour+=12}return normalizeParts({year:Number(iso[1]),month:Number(iso[2]),day:Number(iso[3]),hour,minute:Number(iso[5]??0),second:Number(iso[6]??0),hasTime:iso[4]!=null})}
 const compact=text.match(/^(\d{4})(\d{2})(\d{2})(?:(\d{2})(\d{2})?(\d{2})?)?$/);
 if(compact)return normalizeParts({year:Number(compact[1]),month:Number(compact[2]),day:Number(compact[3]),hour:Number(compact[4]??0),minute:Number(compact[5]??0),second:Number(compact[6]??0),hasTime:compact[4]!=null});
 const ordinal=text.match(/^(\d{4})(\d{3})$/);
 if(ordinal){const year=Number(ordinal[1]),dayOfYear=Number(ordinal[2]),date=new Date(Date.UTC(year,0,dayOfYear));if(dayOfYear>=1&&date.getUTCFullYear()===year)return {year,month:date.getUTCMonth()+1,day:date.getUTCDate(),hour:0,minute:0,second:0,hasTime:false}}
 const local=text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:[T\s]+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?\s*([ap]m)?)?/i);
 if(local){const first=Number(local[1]),second=Number(local[2]),year=Number(local[3])+(local[3].length===2?(Number(local[3])>=70?1900:2000):0);let hour=Number(local[4]??0);if(local[7]){hour%=12;if(local[7].toLowerCase()==="pm")hour+=12}const useDmy=first>12||(second<=12&&order==="dmy");return normalizeParts({year,month:useDmy?second:first,day:useDmy?first:second,hour,minute:Number(local[5]??0),second:Number(local[6]??0),hasTime:local[4]!=null})}
 const parsed=new Date(text);
 if(!Number.isFinite(+parsed))return null;
 return normalizeParts({year:parsed.getFullYear(),month:parsed.getMonth()+1,day:parsed.getDate(),hour:parsed.getHours(),minute:parsed.getMinutes(),second:parsed.getSeconds(),hasTime:/(?:T|\s)\d{1,2}:?\d{0,2}/.test(text)});
}

function partsFromRow(row:unknown[],c:Columns,order:DateOrder,XLSX:typeof Xlsx,fallbackDate:DateParts|null){
 let parts:DateParts|null=null;
 if(c.year>=0&&c.month>=0&&c.day>=0)parts=normalizeParts({year:integer(row[c.year]),month:integer(row[c.month]),day:integer(row[c.day]),hour:0,minute:0,second:0,hasTime:false});
 else if(c.year>=0&&c.dayOfYear>=0){const year=integer(row[c.year]),dayOfYear=integer(row[c.dayOfYear]),date=new Date(Date.UTC(year,0,dayOfYear));if(dayOfYear>=1&&date.getUTCFullYear()===year)parts={year,month:date.getUTCMonth()+1,day:date.getUTCDate(),hour:0,minute:0,second:0,hasTime:false}}
 else if(c.combinedTime>=0)parts=partsFrom(row[c.combinedTime],order,XLSX);
 else if(c.date>=0)parts=partsFrom(row[c.date],order,XLSX);
 if(!parts&&fallbackDate)parts={...fallbackDate,hour:0,minute:0,second:0,hasTime:false};
 if(!parts)return null;
 const clockIndex=c.time>=0?c.time:c.hour,clockKind=c.time>=0?"time":"hour";
 if(clockIndex>=0&&String(row[clockIndex]??"").trim()!==""){
  const clock=clockFrom(row[clockIndex],clockKind);
  if(!clock)return null;
  parts={...parts,...clock,hasTime:true};
 }
 if(c.minute>=0&&String(row[c.minute]??"").trim()!==""){
  const minute=clockFrom(row[c.minute],"minute");
  if(!minute)return null;
  parts={...parts,minute:minute.minute,second:minute.second,hasTime:true};
 }
 return normalizeParts(parts);
}

function findHeader(rows:unknown[][],XLSX:typeof Xlsx){
 let best:{index:number;columns:Columns;order:DateOrder;score:number}|null=null;
 for(let index=0;index<Math.min(rows.length,200);index++){
  const columns=detectColumns(rows[index]);
  if(columns.precipitation<0||!hasDateColumns(columns))continue;
  const dateColumn=columns.combinedTime>=0?columns.combinedTime:columns.date,order=dateColumn>=0?inferDateOrder(rows.slice(index+1),dateColumn):"dmy";
  let valid=0,fallbackDate:DateParts|null=null;
  const distinctTimestamps=new Set<string>();
  for(const row of rows.slice(index+1,index+501)){
   const precipitation=asNumber(row[columns.precipitation]),explicitDate=columns.combinedTime>=0?row[columns.combinedTime]:columns.date>=0?row[columns.date]:columns.year>=0?row[columns.year]:"",parts=partsFromRow(row,columns,order,XLSX,String(explicitDate??"").trim()===""?fallbackDate:null);
   if(Number.isFinite(precipitation)&&precipitation>=0&&parts){valid++;if(String(explicitDate??"").trim()!=="")fallbackDate={...parts,hour:0,minute:0,second:0,hasTime:false};const hourly=columns.combinedTime>=0||columns.time>=0||columns.hour>=0||columns.minute>=0||parts.hasTime;distinctTimestamps.add(hourly?minuteKey(parts):dateKey(parts))}
  }
  const score=distinctTimestamps.size*1_000_000+valid*1000+schemaScore(columns);
  if(!best||score>best.score)best={index,columns,order,score};
 }
 return best;
}

function recoverHourlyCounter(rows:unknown[][],startIndex:number,columns:Columns,sheet:string){
 if(columns.date<0||columns.combinedTime>=0||columns.time>=0||columns.hour>=0||columns.minute>=0)return null;
 const recovered:HourlySource[]=[],pattern=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d+)$/,prefix={value:""};
 let expected=0,candidateRows=0,invalidRows=0;
 for(const row of rows.slice(startIndex+1)){
  if(!row.some(value=>String(value??"").trim()!==""))continue;
  candidateRows++;
  const text=String(row[columns.date]??"").trim(),match=text.match(pattern);
  if(!match)return null;
  const currentPrefix=`${match[1]}-${match[2]}-${match[3]}T${match[4]}`,counter=Number(match[5]);
  if(!prefix.value)prefix.value=currentPrefix;
  if(currentPrefix!==prefix.value||counter!==expected||!Number.isSafeInteger(counter))return null;
  const precipitationMm=asNumber(row[columns.precipitation]);
  if(Number.isFinite(precipitationMm)&&precipitationMm>=0){const base=Date.UTC(Number(match[1]),Number(match[2])-1,Number(match[3]),Number(match[4])),timestamp=new Date(base+counter*3600000).toISOString().slice(0,13)+":00";recovered.push({timestamp,hourTimestamp:timestamp,precipitationMm,sheet,subhourly:false})}else invalidRows++;
  expected++;
 }
 if(candidateRows<61||expected!==candidateRows||expected<=60)return null;
 return {records:recovered,candidateRows,invalidRows};
}

export function parseObservedWorkbook(XLSX:typeof Xlsx,workbook:Xlsx.WorkBook,options:ObservedWorkbookOptions={}):ObservedWorkbookResult{
 const daily:DailySource[]=[],hourly:HourlySource[]=[];
 let candidateRows=0,parsedRows=0,recoveredCounterRows=0;
 for(const sheetName of workbook.SheetNames){
  const sheet=workbook.Sheets[sheetName];
  if(!sheet)continue;
  const rows=XLSX.utils.sheet_to_json<unknown[]>(sheet,{header:1,raw:true,defval:""});
  const header=findHeader(rows,XLSX);
  if(!header)continue;
  const {index,columns,order}=header,sheetDaily:DailySource[]=[],sheetHourly:Array<Omit<HourlySource,"subhourly">&{minute:number;second:number}>=[];
  const counterRecovery=options.preferredResolution==="hourly"?recoverHourlyCounter(rows,index,columns,sheetName):null;
  if(counterRecovery){candidateRows+=counterRecovery.candidateRows;parsedRows+=counterRecovery.records.length;recoveredCounterRows+=counterRecovery.candidateRows;for(const row of counterRecovery.records)hourly.push(row);continue}
  let fallbackDate:DateParts|null=null;
  for(const row of rows.slice(index+1)){
   if(!row.some(value=>String(value??"").trim()!==""))continue;
   candidateRows++;
   const precipitationMm=asNumber(row[columns.precipitation]);
   if(!Number.isFinite(precipitationMm)||precipitationMm<0)continue;
   const explicitDate=columns.combinedTime>=0?row[columns.combinedTime]:columns.date>=0?row[columns.date]:columns.year>=0?row[columns.year]:"";
   const parts=partsFromRow(row,columns,order,XLSX,String(explicitDate??"").trim()===""?fallbackDate:null);
   if(!parts)continue;
   if(String(explicitDate??"").trim()!=="")fallbackDate={...parts,hour:0,minute:0,second:0,hasTime:false};
   parsedRows++;
   const isHourly=columns.combinedTime>=0||columns.time>=0||columns.hour>=0||columns.minute>=0||parts.hasTime||/hourly|hour ending|hour beginning/.test(columns.headerText);
   if(isHourly)sheetHourly.push({timestamp:minuteKey(parts),hourTimestamp:hourKey(parts),precipitationMm,sheet:sheetName,minute:parts.minute,second:parts.second});
   else sheetDaily.push({date:dateKey(parts),precipitationMm,qc:`accepted · ${sheetName}`,sheet:sheetName});
  }
  const sheetHasSubhourly=columns.minute>=0||sheetHourly.some(row=>row.minute!==0||row.second!==0);
  for(const row of sheetHourly)hourly.push({timestamp:row.timestamp,hourTimestamp:row.hourTimestamp,precipitationMm:row.precipitationMm,sheet:row.sheet,subhourly:sheetHasSubhourly});
  for(const row of sheetDaily)daily.push(row);
 }
 if(!daily.length&&!hourly.length)throw new Error("No valid precipitation table was found. Supported layouts include Date/Timestamp, Date + Time, and Year + Month + Day + Hour columns.");
 const resolution:"daily"|"hourly"=hourly.length>daily.length?"hourly":"daily";
 let duplicateRows=0,aggregatedSubhourlyRows=0;
 const dailyRecords:DailyRecord[]=[],hourlyRecords:HourlyRecord[]=[];
 let sheets:string[]=[];
 if(resolution==="daily"){
  const unique=new Map(daily.map(row=>[row.date,row]));
  duplicateRows=daily.length-unique.size;
  const records=[...unique.values()].sort((a,b)=>a.date.localeCompare(b.date));
  for(const row of records)dailyRecords.push({date:row.date,precipitationMm:row.precipitationMm,qc:row.qc});
  sheets=[...new Set(records.map(row=>row.sheet))];
 }else{
  let records:Array<{timestamp:string;precipitationMm:number;qc:string;sheets:string[]}>;
  if(!hourly.some(row=>row.subhourly)){
   const uniqueHours=new Map(hourly.map(row=>[row.hourTimestamp,row]));
   if(hourly.length>=1000&&uniqueHours.size/hourly.length<.001)throw new Error(`The detected date/time columns collapsed ${hourly.length.toLocaleString()} source rows to only ${uniqueHours.size.toLocaleString()} hourly timestamps. The workbook uses an unsupported or ambiguous time layout; no IDF curve was calculated from the collapsed data.`);
   duplicateRows=hourly.length-uniqueHours.size;
   records=[...uniqueHours].sort((a,b)=>a[0].localeCompare(b[0])).map(([timestamp,row])=>({timestamp,precipitationMm:row.precipitationMm,qc:`accepted · ${row.sheet}`,sheets:[row.sheet]}));
  }else{
   const uniqueMinutes=new Map(hourly.map(row=>[row.timestamp,row]));
   if(hourly.length>=1000&&uniqueMinutes.size/hourly.length<.001)throw new Error(`The detected date/time columns collapsed ${hourly.length.toLocaleString()} source rows to only ${uniqueMinutes.size.toLocaleString()} timestamps. The workbook uses an unsupported or ambiguous time layout; no IDF curve was calculated from the collapsed data.`);
   duplicateRows=hourly.length-uniqueMinutes.size;
   const groups=new Map<string,HourlySource[]>();
   for(const row of uniqueMinutes.values()){const group=groups.get(row.hourTimestamp)??[];group.push(row);groups.set(row.hourTimestamp,group)}
   records=[...groups].sort((a,b)=>a[0].localeCompare(b[0])).map(([timestamp,group])=>{
    const subhourly=group.filter(row=>row.subhourly),used=subhourly.length?subhourly:[group.at(-1)!];
    if(subhourly.length)aggregatedSubhourlyRows+=Math.max(0,subhourly.length-1);
    const rowSheets=[...new Set(used.map(row=>row.sheet))];
    return {timestamp,precipitationMm:used.reduce((sum,row)=>sum+row.precipitationMm,0),qc:subhourly.length?`accepted · summed ${subhourly.length} sub-hourly rows · ${rowSheets.join(", ")}`:`accepted · ${rowSheets.join(", ")}`,sheets:rowSheets};
   });
  }
  const sheetNames=new Set<string>();
  for(const row of records){hourlyRecords.push({timestamp:row.timestamp,precipitationMm:row.precipitationMm,qc:row.qc});for(const sheet of row.sheets)sheetNames.add(sheet)}
  sheets=[...sheetNames];
 }
 return {resolution,dailyRecords,hourlyRecords,sheets,candidateRows,parsedRows:resolution==="hourly"?hourly.length:daily.length,invalidRows:Math.max(0,candidateRows-parsedRows),duplicateRows,aggregatedSubhourlyRows,otherResolutionRows:resolution==="hourly"?daily.length:hourly.length,recoveredCounterRows};
}
