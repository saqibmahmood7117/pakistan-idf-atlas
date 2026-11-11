"use client";
import { useRef, useState, type ReactNode } from 'react';
import { CMIP6_PERIODS, CMIP6_SCENARIOS, type Cmip6Period, type Cmip6Scenario } from '../../lib/idf-data';
import { independentlyCorrectNativeDurations, type NativeRainRecord, type NativeCorrectionResult } from '../../lib/native-subdaily';
import { fitShermanEquation } from '../../lib/idf-design';
import { escapeReportText, reportFileStem } from '../../lib/report-export';
import type { OnlineGeometry, OnlineExtractionResponse } from '../../lib/online-precipitation';
import type { ResultRow } from '../../lib/observed-idf';
import PowerIntensityCalculator from './power-intensity-calculator';
type Catalogue={model:string;member:string;nativeGrid:string;catalogueUrl:string;files:{url:string;title:string;firstYear:number;lastYear:number}[]};
type Annual={records:NativeRainRecord[];gridCells:number;calendar:string;intervalConvention:string;providerUrl:string;returnedLatitude?:number;returnedLongitude?:number};
const cache=new Map<string,Annual>();
function save(blob:Blob,name:string){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}
export default function NativeSubdailyWorkflow({mode,district,geometry,spatialKey,latitude,longitude,pointReady,boundaryCode,fetchReference,renderChart}:{
 mode:'point'|'district';district:string;geometry?:OnlineGeometry;spatialKey:string;latitude:number;longitude:number;pointReady:boolean;boundaryCode?:string;
 fetchReference:(progress:(n:number)=>void)=>Promise<OnlineExtractionResponse>;
 renderChart:(rows:ResultRow[],svgId:string)=>ReactNode;
}){
 const [scenario,setScenario]=useState<Cmip6Scenario>('ssp245'),[period,setPeriod]=useState<Cmip6Period>('2041-2070');
 const [busy,setBusy]=useState(false),[message,setMessage]=useState('Retrieve native 3-hour historical/future model precipitation and an hourly ERA5 reference. No scaling or daily-to-hourly conversion is used.');
 const [result,setResult]=useState<(NativeCorrectionResult&{key:string;referenceMethod:string;nativeGrid:string;cells:number;files:string[];retrievedAt:string;calendar:string;rawCounts:number[]})|null>(null);
 const node=useRef<HTMLDivElement>(null);
 const key=[spatialKey,scenario,period].join('|'),active=result?.key===key?result:null;
 const location=mode==='district'?`${district} district (${boundaryCode??'boundary code unavailable'})`:`point ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
 async function run(){
  if(mode==='district'&&!geometry){setMessage('Load the selected verified district polygon first.');return;}
  if(mode==='point'&&!pointReady){setMessage('Enter point coordinates inside Pakistan first.');return;}
  setBusy(true);setResult(null);
  const post=async(p:Record<string,unknown>)=>{
   try {
    const response=await fetch('/api/native-subdaily',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p),signal:AbortSignal.timeout(p.action==='year'?180000:60000)});
    const value=await response.json();if(!response.ok||value.status==='error')throw Error(value.error??'Native source retrieval failed.');return value;
   } catch(serverError) {
    // Same verified source and validation, direct CORS transport when server egress fails.
    try {const {nativeArchiveRequest}=await import('../../lib/native-subdaily-source');return await nativeArchiveRequest(p);}
    catch(directError){throw Error(`${serverError instanceof Error?serverError.message:'Server retrieval failed'} Direct native archive: ${directError instanceof Error?directError.message:'unavailable'}`);}
   }
  };
  try{
   setMessage('Checking native 3-hour ACCESS-CM2 r1i1p1f1 historical and SSP file catalogues…');
   const historical=await post({action:'catalogue',scenario:'historical'}) as Catalogue;
   const future=await post({action:'catalogue',scenario}) as Catalogue;
   const [first,last]=period.split('-').map(Number),usedFiles=new Set<string>();let cells=0,calendar='';
   async function series(catalogue:Catalogue,experiment:string,start:number,end:number){
    const groups:NativeRainRecord[][]=[];
    for(let year=start;year<=end;year++){
     const file=catalogue.files.find(file=>file.firstYear<=year&&file.lastYear>=year);if(!file)throw Error(`Native ${experiment} files do not cover ${year}. No replacement dataset was used.`);
     const payload={action:'year',scenario:experiment,year,fileUrl:file.url,mode,geometry:mode==='district'?geometry:undefined,latitude:mode==='point'?latitude:undefined,longitude:mode==='point'?longitude:undefined};
     const cacheKey=JSON.stringify(payload);let value=cache.get(cacheKey);
     if(!value){value=await post(payload) as Annual;cache.set(cacheKey,value);}
     groups.push(value.records);cells=Math.max(cells,value.gridCells);calendar=value.calendar;usedFiles.add(file.url);
     setMessage(`Native ${experiment}: ${year-start+1}/${end-start+1} years retrieved. Completed subsets are cached in this tab; retry resumes them.`);
    }
    return groups.flat();
   }
   const historicalRecords=await series(historical,'historical',1985,2014);
   const futureRecords=await series(future,scenario,first,last);
   const reference=await fetchReference(n=>setMessage(`Retrieving hourly ERA5 reference for the same spatial selection… ${n}%`));
   if(reference.status!=='complete'||reference.metadata.temporalResolution!=='hourly'||!reference.hourlyRecords)throw Error('No matching hourly ERA5 reference was returned.');
   // Open-Meteo rainfall is the preceding hour; native model records use interval start.
   const referenceRecords=reference.hourlyRecords.map(row=>({timestamp:new Date(Date.parse(row.timestamp+'Z')-3600000).toISOString().slice(0,16),precipitationMm:row.precipitationMm})).filter(row=>row.timestamp>='1985-01-01T00:00'&&row.timestamp<'2015-01-01T00:00');
   setMessage('Building independent rolling 3-, 6-, 12- and 24-hour annual maxima; fitting and correcting each duration separately…');
   await new Promise(resolve=>setTimeout(resolve,25));
   const corrected=independentlyCorrectNativeDurations(historicalRecords,futureRecords,referenceRecords);
   setResult({...corrected,key,referenceMethod:reference.metadata.spatialMethod,nativeGrid:future.nativeGrid,cells,files:[...usedFiles],retrievedAt:new Date().toISOString(),calendar,rawCounts:[historicalRecords.length,futureRecords.length,referenceRecords.length]});
   setMessage('Independent duration-specific return levels are ready. No sub-daily value was derived from a 24-hour curve.');
  }catch(error){setMessage(error instanceof Error?error.message:'Native sub-daily correction failed.');}finally{setBusy(false);}
 }
 async function excel(){if(!active)return;const XLSX=await import('xlsx'),book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet([{model:'ACCESS-CM2',member:'r1i1p1f1',scenario,period,location,spatialKey,calendar:active.calendar,nativeIntervalMinutes:180,grid:active.nativeGrid,gridCells:active.cells,reference:'ERA5 hourly reanalysis; not gauge observations',referenceSpatialMethod:active.referenceMethod,method:active.method,equation:'Q_corrected(T,d)=Q_reference_historical(T,d)*Q_model_future(T,d)/Q_model_historical(T,d)',baseline:'1985–2014',durationScaling:'None',confidenceInterval:'100 bootstrap refits; baseline model/reference resampled by common year and future years resampled separately',retrievedAt:active.retrievedAt}]),'Metadata');
  XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(active.rows),'Corrected Return Levels');
  XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(active.audit.map(row=>({...row,baselineYears:row.baselineYears.join(', '),futureYears:row.futureYears.join(', ')}))),'Duration Audit');
  XLSX.utils.book_append_sheet(book,XLSX.utils.json_to_sheet(active.files.map(url=>({url}))),'Native Source Files');
  XLSX.writeFile(book,`${reportFileStem(location)}-independent-native-subdaily.xlsx`);
 }
 function html(print=false){if(!node.current)return;const clone=node.current.cloneNode(true) as HTMLElement;clone.querySelectorAll('button').forEach(button=>button.remove());
  const body=`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeReportText(location)} native sub-daily report</title><style>body{font:11pt/1.6 Arial,sans-serif;color:#18384c;max-width:1000px;margin:auto;padding:30px}h1,h2,h3{color:#173b5c}table{border-collapse:collapse;width:100%;font-size:9pt}th,td{padding:8px;border:1px solid #ccdadd;text-align:left}svg{width:100%;height:auto}.chart-title{font-weight:bold}code{overflow-wrap:anywhere}.tc-caution,.report-note{padding:12px;border-left:4px solid #b87416;background:#fff9ed}@page{size:A4;margin:16mm}@media print{body{padding:0}tr,svg{break-inside:avoid}h2,h3{break-after:avoid}}</style></head><body>${clone.outerHTML}</body></html>`;
  if(print){const win=window.open('','_blank');if(win){win.document.write(body);win.document.close();win.focus();win.print();}return;}
  save(new Blob([body],{type:'text/html'}),`${reportFileStem(location)}-native-subdaily-report.html`);
 }
 return <article className="panel online-workspace native-subdaily-workspace">
  <p className="eyebrow">Native climate projections · independent durations</p><h2>Native 3-hourly ACCESS-CM2 bias-corrected curves</h2>
  <p>Source: CMIP6 <strong>3hr pr</strong>, ACCESS-CM2 r1i1p1f1 via ESGF/CEDA. This is a separate coarse-grid archive, not the daily NEX-GDDP product. It supports 3-, 6-, 12- and 24-hour durations. No 1-hour or shorter projections are inferred.</p>
  <div className="formgrid"><label>Native SSP scenario<select aria-label="Native SSP scenario" value={scenario} onChange={e=>setScenario(e.target.value as Cmip6Scenario)} disabled={busy}>{Object.entries(CMIP6_SCENARIOS).map(([value,data])=><option key={value} value={value}>{data.label}</option>)}</select></label><label>Native projection period<select aria-label="Native projection period" value={period} onChange={e=>setPeriod(e.target.value as Cmip6Period)} disabled={busy}>{Object.keys(CMIP6_PERIODS).map(value=><option key={value}>{value}</option>)}</select></label></div>
  <p><strong>Spatial selection:</strong> {location}. Change the shared point/district controls below to choose another location.</p>
  <div className="report-actions"><button onClick={run} disabled={busy||(mode==='district'?!geometry:!pointReady)}>{busy?'Retrieving native sub-daily data…':'Retrieve & independently correct native sub-daily curves'}</button></div>
  <p role="status" className="tc-caution">{message}</p>
  <p className="report-note">Model grid: approximately 1.25° × 1.875°. District aggregation uses polygon overlap with native cells; ERA5 reference sampling is approximate. These are reanalysis-referenced model return levels, not gauge-validated local rainfall. Retrieval can take several minutes. Independent corrections do not guarantee consistent continuous storm sequences.</p>
  <div id="native-subdaily-results">{active&&<PowerIntensityCalculator rows={active.rows} globalFit={fitShermanEquation(active.rows)} defaultDurationMinutes={180} defaultEquationMode="power" />}</div>
  <div id="native-subdaily-report" ref={node}>
  {active?<><h2>Independent native sub-daily results and report</h2><p>ACCESS-CM2 · r1i1p1f1 · {CMIP6_SCENARIOS[scenario].label} · {period} · {location}. Retrieved {active.retrievedAt}.</p>
   <h3>Executive summary</h3><p>This assessment estimates future rainfall intensities for four independently supported durations, using native ACCESS-CM2 precipitation and an ERA5 historical reference for the selected location. It applies no daily-to-sub-daily scaling. Results describe a coarse-grid climate projection; they require local validation before drainage design. Each duration has separate data coverage, fitted quantiles and uncertainty.</p><p>{active.method}. Each duration is constructed from consecutive native intervals and fitted separately by stationary GEV L-moments.</p>
   <p><code>Qcorr(T,d)=Qref,h(T,d)×Qmodel,f(T,d)/Qmodel,h(T,d); i=Qcorr/(d/60)</code></p>
   <p>At each duration d and return period T, the historical reference/model quantile ratio adjusts the future model quantile. This corrects duration-specific return levels. It is not monthly daily QDM, temporal scaling, or a corrected continuous rainfall time series. Historical fits use at least 20 common eligible years in 1985–2014; future fits require at least eight. Coverage threshold: 90%. Intervals use 100 bootstrap refits and exclude structural, scenario and reference bias uncertainty.</p>
   {renderChart(active.rows,'native-idf-svg')}
   <div className="report-table-wrap"><table><caption>Duration-specific data support</caption><thead><tr><th>Duration</th><th>Common baseline years</th><th>Eligible future years</th></tr></thead><tbody>{active.audit.map(row=><tr key={row.durationMinutes}><th>{row.durationMinutes/60} hours</th><td>{row.baselineYears.join(', ')}</td><td>{row.futureYears.join(', ')}</td></tr>)}</tbody></table></div>
   <div className="report-table-wrap"><table><caption>Corrected native return levels</caption><thead><tr><th>Duration (hours)</th><th>T (years)</th><th>Depth (mm)</th><th>Intensity (mm/hour)</th><th>95% interval (mm/hour)</th></tr></thead><tbody>{active.rows.map(row=><tr key={`${row.durationMinutes}-${row.returnPeriodYears}`}><td>{row.durationMinutes/60}</td><td>{row.returnPeriodYears}</td><td>{row.depthMm.toFixed(2)}</td><td>{row.intensityMmHr.toFixed(3)}</td><td>{row.ciLower.toFixed(3)}–{row.ciUpper.toFixed(3)}</td></tr>)}</tbody></table></div>
   <h3>Calculation steps and constants</h3><ol><li>Retrieve historical and future native 3-hour precipitation flux. Convert kg m⁻² s⁻¹ to mm per native interval by multiplying by 10800 seconds; 1 kg/m² of water equals 1 mm.</li><li>Aggregate matching point or district rainfall before correction. Build consecutive rolling totals at 180, 360, 720 and 1440 minutes, retaining years with at least 90% coverage.</li><li>Fit a separate GEV distribution by L-moments to each duration and dataset. T is return period in years; its annual non-exceedance probability is 1−1/T. Q is the resulting rainfall depth in mm.</li><li>Multiply each future model depth by its duration-specific historical reference/model quantile ratio. Divide corrected depth by d/60 hours to obtain i in mm/hour.</li><li>Fit chart equations to these corrected duration points only. Their coefficients depend on the active data and return period; they are not universal constants. R² describes curve fit, not rainfall prediction accuracy.</li></ol><p>The Excel-style chart equation is i=c tᵖ. Here c is exp(intercept) and p is the slope from least-squares regression of ln(i) on ln(t), separately for each T. These are fitted summaries of the corrected duration values. No fixed exponent such as −0.670 is prescribed. Use minutes for t and mm/hour for i; changing units changes c. R² measures log-space fit only.</p><h3>List of acronyms</h3><p>IDF: intensity–duration–frequency; CMIP6: Coupled Model Intercomparison Project Phase 6; SSP: Shared Socioeconomic Pathway; GEV: generalized extreme value; ERA5: ECMWF fifth-generation reanalysis; ECMWF: European Centre for Medium-Range Weather Forecasts; ESGF: Earth System Grid Federation; CEDA: Centre for Environmental Data Analysis; QDM: quantile delta mapping; CF: Climate and Forecast metadata conventions.</p><h3>Provenance and limitations</h3><p>Native model: {active.nativeGrid}; {active.cells} cells. Reference spatial method: {active.referenceMethod}. Calendar: {active.calendar}; no calendar conversion. Interval means converted to native 3-hour depth using 10800 seconds. ERA5 preceding-hour values are aligned to interval starts before rolling aggregation.</p><p>Accepted model historical/future/reference intervals: {active.rawCounts.join(' / ')}. Baseline and duration windows are audited separately. The 250- and 500-year values are strong extrapolations beyond the record. Regional model resolution, reanalysis errors and independent-fit duration inconsistencies require expert review.</p>
   {active.warnings.length>0&&<ul>{active.warnings.map(warning=><li key={warning}>{warning}</li>)}</ul>}
   <details><summary>Verified native source file URLs</summary><ul>{active.files.map(url=><li key={url}><a href={url}>{url}</a></li>)}</ul></details>
  </>:<p>No native sub-daily result has been generated for this selection. A daily curve is never relabelled as an independently corrected sub-daily curve.</p>}
  </div>
  {active&&<div className="report-actions"><button onClick={excel}>Download native corrected Excel</button><button onClick={()=>html(false)}>Download native report HTML</button><button onClick={()=>html(true)}>Print native report / Save PDF</button></div>}
 </article>;
}
