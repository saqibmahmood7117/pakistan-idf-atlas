export type DailyRecord = { date: string; precipitationMm: number; qc: string };
export type HourlyRecord = { timestamp: string; precipitationMm: number; qc: string };
export type DistributionMethod = "gev" | "gumbel" | "lp3" | "lognormal" | "gamma" | "weibull";
export type Method = DistributionMethod | "sherman";
export type ResultRow = { method: Method; durationMinutes: number; returnPeriodYears: number; depthMm: number; intensityMmHr: number; ciLower: number; ciUpper: number; derived: boolean };
export type StationarityResult = {n:number;s:number;z:number;pValue:number;senSlopeMmPerYear:number;senSlopePercentPerYear:number;lag1:number;status:"Insufficient record"|"Trend detected"|"No significant monotonic trend"};
export const DISTRIBUTION_METHODS:DistributionMethod[]=["gev","gumbel","lp3","lognormal","gamma","weibull"];
export const ALL_METHODS:Method[]=[...DISTRIBUTION_METHODS,"sherman"];
export const METHOD_LABEL: Record<Method,string> = {
 gev: "GEV · L-moments",
 gumbel: "Gumbel EV1 · moments",
 lp3: "Log-Pearson III",
 lognormal: "Lognormal · 2-parameter",
 gamma: "Gamma · 2-parameter",
 weibull: "Weibull · 2-parameter",
 sherman: "Sherman IDF equation",
};
export const PERIODS = [2,5,10,25,50,100,250,500];
export const DURATIONS = [5,10,15,30,60,120,180,360,720,1440,2880,4320,7200,10080];

const mean=(x:number[])=>x.reduce((a,b)=>a+b,0)/x.length;
const sd=(x:number[])=>Math.sqrt(x.reduce((a,b)=>a+(b-mean(x))**2,0)/Math.max(1,x.length-1));
const median=(x:number[])=>{const a=[...x].sort((p,q)=>p-q),m=Math.floor(a.length/2);return a.length%2?a[m]:(a[m-1]+a[m])/2};
const normalCdf=(z:number)=>{const sign=z<0?-1:1,x=Math.abs(z)/Math.sqrt(2),t=1/(1+.3275911*x),erf=1-(((((1.061405429*t-1.453152027)*t+1.421413741)*t-.284496736)*t+.254829592)*t)*Math.exp(-x*x);return .5*(1+sign*erf)};
function invNorm(p:number){const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924],b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857],c=[-.00778489400243029,-.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878],d=[.00778469570904146,.32246712907004,2.445134137143,3.75440866190742],plow=.02425,phigh=1-plow;if(!(p>0&&p<1))return p===0?-Infinity:p===1?Infinity:NaN;if(p<plow){const q=Math.sqrt(-2*Math.log(p));return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}if(p>phigh){const q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}const q=p-.5,r=q*q;return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}
function logGamma(z:number):number{const p=[.9999999999998099,676.5203681218851,-1259.1392167224028,771.3234287776531,-176.6150291621406,12.5073432786869,-.13857109526572,9.98436957801957e-6,1.50563273514931e-7];if(z<.5)return Math.log(Math.PI)-Math.log(Math.sin(Math.PI*z))-logGamma(1-z);z--;let x=p[0];for(let i=1;i<p.length;i++)x+=p[i]/(z+i);const t=z+7.5;return .5*Math.log(2*Math.PI)+(z+.5)*Math.log(t)-t+Math.log(x);}
function gamma(z:number){return Math.exp(logGamma(z));}
function regularizedGammaP(a:number,x:number){if(!(a>0)||x<=0)return 0;const gln=logGamma(a),tiny=1e-30;if(x<a+1){let ap=a,sum=1/a,delta=sum;for(let n=1;n<=160;n++){ap++;delta*=x/ap;sum+=delta;if(Math.abs(delta)<Math.abs(sum)*1e-13)break;}return Math.max(0,Math.min(1,sum*Math.exp(-x+a*Math.log(x)-gln)));}let b=x+1-a,c=1/tiny,d=1/Math.max(tiny,b),h=d;for(let i=1;i<=160;i++){const an=-i*(i-a);b+=2;d=an*d+b;if(Math.abs(d)<tiny)d=tiny;c=b+an/c;if(Math.abs(c)<tiny)c=tiny;d=1/d;const delta=d*c;h*=delta;if(Math.abs(delta-1)<1e-13)break;}return Math.max(0,Math.min(1,1-Math.exp(-x+a*Math.log(x)-gln)*h));}
function gammaUnitQuantile(p:number,shape:number){const target=Math.max(1e-12,Math.min(1-1e-12,p));let lo=0,hi=Math.max(1,shape);while(regularizedGammaP(shape,hi)<target&&hi<1e8)hi*=2;for(let i=0;i<70;i++){const mid=(lo+hi)/2;if(regularizedGammaP(shape,mid)<target)lo=mid;else hi=mid;}return (lo+hi)/2;}
function weibullParameters(x:number[]){const m=mean(x),s=sd(x),target=1+(s/Math.max(1e-12,m))**2;let lo=.15,hi=50;for(let i=0;i<80;i++){const k=(lo+hi)/2,ratio=Math.exp(logGamma(1+2/k)-2*logGamma(1+1/k));if(ratio>target)lo=k;else hi=k;}const shape=(lo+hi)/2,scale=m/gamma(1+1/shape);return {shape,scale};}
function quantile(sample:number[],T:number,method:Method):number{const x=[...sample].filter(v=>v>0).sort((a,b)=>a-b),F=1-1/T;if(method==="gumbel"){const beta=sd(x)*Math.sqrt(6)/Math.PI,mu=mean(x)-.5772156649*beta;return mu-beta*Math.log(-Math.log(F));}if(method==="lp3"){const y=x.map(Math.log10),m=mean(y),s=sd(y),n=y.length,g=n>2&&s>0?n*y.reduce((a,v)=>a+(v-m)**3,0)/((n-1)*(n-2)*s**3):0;if(s<1e-12)return 10**m;if(Math.abs(g)<1e-6)return 10**(m+s*invNorm(F));const shape=4/(g*g),scale=Math.abs(g)*s/2,origin=m-2*s/g,gammaProbability=g>0?F:1-F,logQuantile=origin+(g>0?1:-1)*scale*gammaUnitQuantile(gammaProbability,shape);return 10**logQuantile;}if(method==="lognormal"){const y=x.map(Math.log),m=mean(y),s=sd(y);return Math.exp(m+s*invNorm(F));}if(method==="gamma"){const m=mean(x),s=sd(x);if(s<1e-12)return m;const shape=(m/s)**2,scale=s*s/m;return gammaUnitQuantile(F,shape)*scale;}if(method==="weibull"){if(sd(x)<1e-12)return mean(x);const {shape,scale}=weibullParameters(x);return scale*(-Math.log(1-F))**(1/shape);}if(method==="sherman"){const gev=PERIODS.map(p=>quantile(x,p,"gev")),lx=PERIODS.map(Math.log),ly=gev.map(v=>Math.log(Math.max(.001,v))),xm=mean(lx),ym=mean(ly),m=lx.reduce((a,v,i)=>a+(v-xm)*(ly[i]-ym),0)/lx.reduce((a,v)=>a+(v-xm)**2,0),a=Math.exp(ym-m*xm);return a*T**m;}const n=x.length,b0=mean(x),b1=x.reduce((a,v,i)=>a+(i/(n-1))*v,0)/n,b2=n>2?x.reduce((a,v,i)=>a+(i*(i-1)/((n-1)*(n-2)))*v,0)/n:0,l2=2*b1-b0,l3=6*b2-6*b1+b0,t3=l3/l2,c=2/(3+t3)-Math.log(2)/Math.log(3),k=7.859*c+2.9554*c*c;if(Math.abs(k)<1e-5){const alpha=l2/Math.log(2),xi=b0-.5772156649*alpha;return xi-alpha*Math.log(-Math.log(F));}const alpha=l2*k/((1-2**(-k))*gamma(1+k)),xi=b0-alpha*(1-gamma(1+k))/k;return xi+alpha/k*(1-(-Math.log(F))**k);}

export function frequencyQuantile(sample:number[],returnPeriodYears:number,method:Method){return quantile(sample,returnPeriodYears,method);}

function bootstrapInterval(sample:number[],T:number,method:Method,repetitions=200){let state=(sample.length*2654435761+T*1013904223+ALL_METHODS.indexOf(method)*2246822519)>>>0;const random=()=>{state|=0;state=state+0x6D2B79F5|0;let t=Math.imul(state^state>>>15,1|state);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296},estimates:number[]=[];for(let b=0;b<repetitions;b++){const resample=Array.from({length:sample.length},()=>sample[Math.floor(random()*sample.length)]),estimate=quantile(resample,T,method);if(Number.isFinite(estimate))estimates.push(Math.max(0,estimate));}estimates.sort((a,b)=>a-b);const at=(p:number)=>{if(!estimates.length)return NaN;const i=(estimates.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return estimates[lo]+(estimates[hi]-estimates[lo])*(i-lo)};return [at(.025),at(.975)] as const;}

function parameterSummary(sample:number[],method:Method){const n=sample.length,m=mean(sample),s=sd(sample);if(method==="gumbel"){const beta=s*Math.sqrt(6)/Math.PI,mu=m-.5772156649*beta;return `μ=${mu.toFixed(2)}, β=${beta.toFixed(2)}`;}if(method==="lp3"){const y=sample.map(Math.log10),lm=mean(y),ls=sd(y),g=n>2&&ls>0?n*y.reduce((a,v)=>a+(v-lm)**3,0)/((n-1)*(n-2)*ls**3):0;return `log₁₀ μ=${lm.toFixed(3)}, σ=${ls.toFixed(3)}, G=${g.toFixed(2)}`;}if(method==="lognormal"){const y=sample.map(Math.log);return `ln μ=${mean(y).toFixed(3)}, ln σ=${sd(y).toFixed(3)}`;}if(method==="gamma"){const shape=(m/Math.max(1e-12,s))**2,scale=s*s/Math.max(1e-12,m);return `shape=${shape.toFixed(3)}, scale=${scale.toFixed(3)} mm`;}if(method==="weibull"){const p=weibullParameters(sample);return `shape=${p.shape.toFixed(3)}, scale=${p.scale.toFixed(3)} mm`;}if(method==="sherman")return "IDF equation calibrated to GEV levels; not a probability distribution";return "Location, scale and shape from L-moments";}
function diagnosticsForSample(sample:number[]){const x=sample.filter(v=>v>0).sort((a,b)=>a-b),n=x.length;if(n<8)return ALL_METHODS.map(method=>({method,n,rmseMm:NaN,nrmsePercent:NaN,status:"Insufficient record",parameters:"Not fitted"}));return ALL_METHODS.map(method=>{const fitted=x.map((_,i)=>{const F=(i+1-.44)/(n+.12),T=1/(1-F);return quantile(x,T,method)}),rmse=Math.sqrt(x.reduce((a,v,i)=>a+(v-fitted[i])**2,0)/n),normalized=100*rmse/mean(x);return {method,n,rmseMm:+rmse.toFixed(2),nrmsePercent:+normalized.toFixed(1),status:n>=30?"Eligible for comparison":"Provisional (<30 years)",parameters:parameterSummary(x,method)};});}
export function fitDiagnostics(records:DailyRecord[]){return diagnosticsForSample(annualMaxima(records,1).map(v=>v.depthMm));}
export function fitDiagnosticsHourly(records:HourlyRecord[]){return diagnosticsForSample(hourlyAnnualMaxima(records,24).map(v=>v.depthMm));}

export function assess(records:DailyRecord[]){const sorted=[...records].sort((a,b)=>a.date.localeCompare(b.date));const unique=new Map(sorted.map(r=>[r.date,r]));const valid=[...unique.values()].filter(r=>Number.isFinite(r.precipitationMm)&&r.precipitationMm>=0);if(!valid.length)return {records:[],start:"",end:"",missing:0,duplicates:records.length,invalid:0,completeness:0,years:0,eligibleYears:0,yearCompletenessThreshold:90};const days=Math.round((Date.parse(valid.at(-1)!.date)-Date.parse(valid[0].date))/86400000)+1;return {records:valid,start:valid[0].date,end:valid.at(-1)!.date,missing:Math.max(0,days-valid.length),duplicates:records.length-unique.size,invalid:unique.size-valid.length,completeness:100*valid.length/days,years:new Set(valid.map(r=>r.date.slice(0,4))).size,eligibleYears:annualMaxima(valid,1).length,yearCompletenessThreshold:90};}
const hourKey=(value:string)=>{const normalized=value.trim().replace(" ","T");if(/^\d{4}-\d{2}-\d{2}T\d{2}(?::\d{2})?/.test(normalized)&&!/[zZ]|[+-]\d{2}:?\d{2}$/.test(normalized))return normalized.slice(0,13)+":00";const d=new Date(value);if(!Number.isFinite(+d))return "";d.setUTCMinutes(0,0,0);return d.toISOString().slice(0,13)+":00"};
type HourlyPrepared={entries:[string,number][];counts:Map<number,number>};
const hourlyPreparedCache=new WeakMap<HourlyRecord[],HourlyPrepared>(),hourlyMaximaCache=new WeakMap<HourlyRecord[],Map<string,{year:number;depthMm:number}[]>>();
function prepareHourly(records:HourlyRecord[]):HourlyPrepared{
 const cached=hourlyPreparedCache.get(records);if(cached)return cached;
 const values=new Map<string,number>();
 for(const record of records){const key=hourKey(record.timestamp);if(key&&Number.isFinite(record.precipitationMm))values.set(key,record.precipitationMm)}
 const entries=[...values.entries()].sort((a,b)=>a[0].localeCompare(b[0])),counts=new Map<number,number>();
 for(const [key] of entries){const year=Number(key.slice(0,4));counts.set(year,(counts.get(year)??0)+1)}
 const prepared={entries,counts};hourlyPreparedCache.set(records,prepared);return prepared;
}
export function assessHourly(records:HourlyRecord[]){const normalized=records.map(r=>({...r,timestamp:hourKey(r.timestamp)})).filter(r=>r.timestamp),sorted=[...normalized].sort((a,b)=>a.timestamp.localeCompare(b.timestamp)),unique=new Map(sorted.map(r=>[r.timestamp,r])),valid=[...unique.values()].filter(r=>Number.isFinite(r.precipitationMm)&&r.precipitationMm>=0);if(!valid.length)return {records:[] as HourlyRecord[],start:"",end:"",missing:0,duplicates:records.length,invalid:0,completeness:0,years:0,eligibleYears:0,yearCompletenessThreshold:90};const hours=Math.round((Date.parse(valid.at(-1)!.timestamp+":00Z")-Date.parse(valid[0].timestamp+":00Z"))/3600000)+1;return {records:valid,start:valid[0].timestamp,end:valid.at(-1)!.timestamp,missing:Math.max(0,hours-valid.length),duplicates:records.length-unique.size,invalid:unique.size-valid.length,completeness:100*valid.length/hours,years:new Set(valid.map(r=>r.timestamp.slice(0,4))).size,eligibleYears:hourlyAnnualMaxima(valid,24).length,yearCompletenessThreshold:90};}
export function hourlyAnnualMaxima(records:HourlyRecord[],durationHours:number,minYearCompleteness=.9){
 const cacheKey=`${durationHours}|${minYearCompleteness}`,cache=hourlyMaximaCache.get(records)??new Map<string,{year:number;depthMm:number}[]>(),cached=cache.get(cacheKey);if(cached)return cached.map(row=>({...row}));
 const {entries,counts}=prepareHourly(records);
 const expected=(year:number)=>(Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/3600000,eligible=new Set([...counts].filter(([year,count])=>count/expected(year)>=minYearCompleteness).map(([year])=>year)),out=new Map<number,number>();
 let runLength=0,rolling=0,previousHour=NaN;
 const window:number[]=[];
 for(const [key,value] of entries){
  const epochHour=Date.parse(key+":00Z")/3600000;
  if(epochHour!==previousHour+1){runLength=0;rolling=0;window.length=0}
  previousHour=epochHour;runLength++;rolling+=value;window.push(value);
  if(window.length>durationHours)rolling-=window.shift()!;
  if(runLength<durationHours)continue;
  const year=Number(key.slice(0,4));if(eligible.has(year))out.set(year,Math.max(out.get(year)??0,rolling));
 }
 const result=[...out].sort((a,b)=>a[0]-b[0]).map(([year,depthMm])=>({year,depthMm}));cache.set(cacheKey,result);hourlyMaximaCache.set(records,cache);return result.map(row=>({...row}));
}
export function hourlyToDailyTotals(records:HourlyRecord[]){const groups=new Map<string,{sum:number,count:number}>();for(const r of records){const key=hourKey(r.timestamp);if(!key)continue;const date=key.slice(0,10),g=groups.get(date)??{sum:0,count:0};g.sum+=r.precipitationMm;g.count++;groups.set(date,g)}return [...groups].filter(([,g])=>g.count===24).map(([date,g])=>({date,precipitationMm:g.sum,qc:"aggregated from 24 hourly values"}));}
export function annualMaxima(records:DailyRecord[],days:number,minYearCompleteness=.9){const values=new Map(records.map(r=>[r.date,r.precipitationMm])),counts=new Map<number,number>();for(const date of values.keys()){const y=Number(date.slice(0,4));counts.set(y,(counts.get(y)??0)+1)}const expected=(year:number)=>(Date.UTC(year+1,0,1)-Date.UTC(year,0,1))/86400000,eligible=new Set([...counts].filter(([year,count])=>count/expected(year)>=minYearCompleteness).map(([year])=>year)),out=new Map<number,number>();for(const r of records){const y=Number(r.date.slice(0,4));if(!eligible.has(y))continue;let sum=0,ok=true;for(let j=0;j<days;j++){const d=new Date(r.date+"T00:00:00Z");d.setUTCDate(d.getUTCDate()-j);const v=values.get(d.toISOString().slice(0,10));if(v==null){ok=false;break;}sum+=v;}if(ok)out.set(y,Math.max(out.get(y)??0,sum));}return [...out].sort((a,b)=>a[0]-b[0]).map(([year,depthMm])=>({year,depthMm}));}
export function stationarityDiagnostics(records:DailyRecord[]):StationarityResult{const series=annualMaxima(records,1).sort((a,b)=>a.year-b.year),n=series.length;if(n<8)return {n,s:0,z:0,pValue:NaN,senSlopeMmPerYear:NaN,senSlopePercentPerYear:NaN,lag1:NaN,status:"Insufficient record"};let s=0;const slopes:number[]=[];for(let i=0;i<n-1;i++)for(let j=i+1;j<n;j++){s+=Math.sign(series[j].depthMm-series[i].depthMm);slopes.push((series[j].depthMm-series[i].depthMm)/(series[j].year-series[i].year));}const ties=new Map<number,number>();series.forEach(v=>ties.set(v.depthMm,(ties.get(v.depthMm)??0)+1));const tieTerm=[...ties.values()].filter(t=>t>1).reduce((a,t)=>a+t*(t-1)*(2*t+5),0),variance=(n*(n-1)*(2*n+5)-tieTerm)/18,z=variance>0?(s>0?(s-1)/Math.sqrt(variance):s<0?(s+1)/Math.sqrt(variance):0):0,pValue=Math.max(0,Math.min(1,2*(1-normalCdf(Math.abs(z))))),senSlope=median(slopes),depths=series.map(v=>v.depthMm),avg=mean(depths),x=depths.slice(0,-1),y=depths.slice(1),xm=mean(x),ym=mean(y),den=x.reduce((a,v)=>a+(v-xm)**2,0),lag1=den?x.reduce((a,v,i)=>a+(v-xm)*(y[i]-ym),0)/Math.sqrt(den*y.reduce((a,v)=>a+(v-ym)**2,0)):0;return {n,s,z:+z.toFixed(3),pValue:+pValue.toFixed(4),senSlopeMmPerYear:+senSlope.toFixed(3),senSlopePercentPerYear:+(100*senSlope/Math.max(.001,avg)).toFixed(3),lag1:+lag1.toFixed(3),status:pValue<.05?"Trend detected":"No significant monotonic trend"};}
export function stationarityDiagnosticsHourly(records:HourlyRecord[]):StationarityResult{const series=hourlyAnnualMaxima(records,24).sort((a,b)=>a.year-b.year),n=series.length;if(n<8)return {n,s:0,z:0,pValue:NaN,senSlopeMmPerYear:NaN,senSlopePercentPerYear:NaN,lag1:NaN,status:"Insufficient record"};let s=0;const slopes:number[]=[];for(let i=0;i<n-1;i++)for(let j=i+1;j<n;j++){s+=Math.sign(series[j].depthMm-series[i].depthMm);slopes.push((series[j].depthMm-series[i].depthMm)/(series[j].year-series[i].year));}const ties=new Map<number,number>();series.forEach(v=>ties.set(v.depthMm,(ties.get(v.depthMm)??0)+1));const tieTerm=[...ties.values()].filter(t=>t>1).reduce((a,t)=>a+t*(t-1)*(2*t+5),0),variance=(n*(n-1)*(2*n+5)-tieTerm)/18,z=variance>0?(s>0?(s-1)/Math.sqrt(variance):s<0?(s+1)/Math.sqrt(variance):0):0,pValue=Math.max(0,Math.min(1,2*(1-normalCdf(Math.abs(z))))),senSlope=median(slopes),depths=series.map(v=>v.depthMm),avg=mean(depths),x=depths.slice(0,-1),y=depths.slice(1),xm=mean(x),ym=mean(y),den=x.reduce((a,v)=>a+(v-xm)**2,0),lag1=den?x.reduce((a,v,i)=>a+(v-xm)*(y[i]-ym),0)/Math.sqrt(den*y.reduce((a,v)=>a+(v-ym)**2,0)):0;return {n,s,z:+z.toFixed(3),pValue:+pValue.toFixed(4),senSlopeMmPerYear:+senSlope.toFixed(3),senSlopePercentPerYear:+(100*senSlope/Math.max(.001,avg)).toFixed(3),lag1:+lag1.toFixed(3),status:pValue<.05?"Trend detected":"No significant monotonic trend"};}

export type NonstationaryFit = {
  status:"Fitted"|"Insufficient record"|"Optimization failed";
  n:number;centerYear:number;yearScale:number;referenceYear:number;
  locationAtCenter:number;locationSlopeMmPerYear:number;scale:number;shape:number;
  stationaryAicc:number;nonstationaryAicc:number;deltaAicc:number;
  preferred:"Nonstationary"|"Stationary"|"Inconclusive";
};

export type AnnualCovariateKind =
  | "enso"
  | "temperature"
  | "moisture"
  | "urbanization"
  | "climate-index"
  | "other";
export type AnnualCovariate = {
  id:string;label:string;kind:AnnualCovariateKind;units:string;
  physicalRationale:string;source:string;physicallyPlausible:boolean;
  values:{year:number;value:number}[];
};
export type CovariateModelRow = {
  modelId:string;label:string;kind:"stationary"|AnnualCovariateKind|"time";units:string;
  n:number;aicc:number;deltaAicc:number;akaikeWeight:number;
  locationSlopePerUnit:number;slopeCiLower:number;slopeCiUpper:number;
  residualMean:number;residualSd:number;residualLag1:number;pitKsD:number;
  residualStatus:"Adequate"|"Review"|"Unavailable";
  holdoutN:number;holdoutMeanNll:number;holdoutDeltaVsStationary:number;
  physicalRationale:string;source:string;selectionEvidence:string;
};
export type CovariateModelExclusion = {modelId:string;label:string;reason:string};
export type CovariateModelComparison = {
  status:"Compared"|"Insufficient record"|"Optimization failed";
  commonYears:number[];rows:CovariateModelRow[];excluded:CovariateModelExclusion[];
  selectedModelId:string|null;decision:string;decisionReason:string;
  holdoutRule:string;uncertaintyRule:string;selectionRule:string;
};
export type CovariateFit = {
  status:"Fitted"|"Insufficient record"|"Optimization failed";
  n:number;covariateId:string;covariateLabel:string;units:string;
  centerValue:number;valueScale:number;evaluationValue:number;
  locationAtCenter:number;locationSlopePerUnit:number;scale:number;shape:number;
  stationaryAicc:number;nonstationaryAicc:number;deltaAicc:number;
  preferred:"Nonstationary"|"Stationary"|"Inconclusive";
};

export type ReferenceYearBasis="record-center"|"latest-eligible"|"custom";
export type ReferenceYearSelection={
 basis:ReferenceYearBasis;referenceYear:number;centerYear:number;firstEligibleYear:number;lastEligibleYear:number;
 eligibleYearCount:number;isExtrapolation:boolean;formula:string;
};

/**
 * Select the evaluation year for a time-varying GEV from the eligible annual-maxima years.
 * Centering time at the arithmetic mean is a regression re-parameterization: it leaves the
 * fitted linear trend unchanged while making the intercept the return level at the centre
 * of the observed time covariate. A latest-year or custom evaluation changes only the point
 * at which the fitted model is reported; it does not add future climate information.
 */
export function calculateReferenceYear(maxima:{year:number}[],basis:ReferenceYearBasis="record-center",customYear=NaN):ReferenceYearSelection{
 const years=[...new Set(maxima.map(v=>v.year).filter(Number.isFinite))].sort((a,b)=>a-b),eligibleYearCount=years.length;
 if(!eligibleYearCount){const fallback=Number.isFinite(customYear)?customYear:new Date().getUTCFullYear();return {basis,referenceYear:fallback,centerYear:NaN,firstEligibleYear:NaN,lastEligibleYear:NaN,eligibleYearCount:0,isExtrapolation:false,formula:"Unavailable until eligible annual maxima are created"};}
 const centerYear=years.reduce((sum,year)=>sum+year,0)/eligibleYearCount,firstEligibleYear=years[0],lastEligibleYear=years.at(-1)!,referenceYear=basis==="record-center"?centerYear:basis==="latest-eligible"?lastEligibleYear:Number.isFinite(customYear)?customYear:centerYear;
 return {basis,referenceYear:+referenceYear.toFixed(2),centerYear:+centerYear.toFixed(2),firstEligibleYear,lastEligibleYear,eligibleYearCount,isExtrapolation:referenceYear<firstEligibleYear||referenceYear>lastEligibleYear,formula:`ȳ = Σ eligible AMS years / n = ${years.reduce((sum,year)=>sum+year,0)} / ${eligibleYearCount} = ${centerYear.toFixed(2)}`};
}

type GevFit={params:number[];nll:number;aicc:number;ok:boolean};
const gevShape=(eta:number)=>.5*Math.tanh(eta);
function gevNll(points:{x:number;y:number}[],p:number[],varyLocation:boolean){
 const mu0=p[0],slope=varyLocation?p[1]:0,logSigma=p[varyLocation?2:1],eta=p[varyLocation?3:2],sigma=Math.exp(logSigma),xi=gevShape(eta);
 if(!Number.isFinite(sigma)||sigma<1e-5||sigma>1e5)return 1e30;
 let out=0;
 for(const point of points){const mu=mu0+slope*point.x,z=(point.y-mu)/sigma;if(Math.abs(xi)<1e-5)out+=logSigma+z+Math.exp(-z);else{const support=1+xi*z;if(support<=1e-10||!Number.isFinite(support))return 1e30;out+=logSigma+(1+1/xi)*Math.log(support)+support**(-1/xi);}if(!Number.isFinite(out)||out>1e29)return 1e30;}
 return out;
}
function nelderMead(start:number[],step:number[],objective:(p:number[])=>number,maxIter=700){
 const n=start.length,simplex=[start,...start.map((_,i)=>start.map((v,j)=>v+(i===j?step[j]:0)))].map(p=>({p,v:objective(p)}));
 const combine=(a:number[],b:number[],wa:number,wb:number)=>a.map((v,i)=>wa*v+wb*b[i]);
 for(let iter=0;iter<maxIter;iter++){
  simplex.sort((a,b)=>a.v-b.v);const best=simplex[0],worst=simplex[n],centroid=Array.from({length:n},(_,j)=>simplex.slice(0,n).reduce((s,q)=>s+q.p[j],0)/n),reflected=combine(centroid,worst.p,2,-1),rv=objective(reflected);
  if(rv<best.v){const expanded=combine(centroid,worst.p,3,-2),ev=objective(expanded);simplex[n]=ev<rv?{p:expanded,v:ev}:{p:reflected,v:rv};}
  else if(rv<simplex[n-1].v)simplex[n]={p:reflected,v:rv};
  else{const contracted=rv<worst.v?combine(centroid,worst.p,1.5,-.5):combine(centroid,worst.p,.5,.5),cv=objective(contracted);if(cv<Math.min(rv,worst.v))simplex[n]={p:contracted,v:cv};else for(let i=1;i<=n;i++){simplex[i].p=combine(best.p,simplex[i].p,.5,.5);simplex[i].v=objective(simplex[i].p);}}
  const spread=Math.max(...simplex.map(q=>Math.abs(q.v-simplex[0].v)));if(spread<1e-8)break;
 }
 simplex.sort((a,b)=>a.v-b.v);return simplex[0];
}
function fitGev(points:{x:number;y:number}[],varyLocation:boolean):GevFit{
 const values=points.map(p=>p.y),sigma0=Math.max(.1,sd(values)*Math.sqrt(6)/Math.PI),mu0=mean(values)-.5772156649*sigma0,k=varyLocation?4:3,start=varyLocation?[mu0,0,Math.log(sigma0),0]:[mu0,Math.log(sigma0),0],steps=varyLocation?[Math.max(.2,sigma0*.15),Math.max(.2,sigma0*.08),.12,.12]:[Math.max(.2,sigma0*.15),.12,.12],best=nelderMead(start,steps,p=>gevNll(points,p,varyLocation)),den=points.length-k-1,aic=2*k+2*best.v,aicc=den>0?aic+2*k*(k+1)/den:Infinity;
 return {params:best.p,nll:best.v,aicc,ok:Number.isFinite(best.v)&&best.v<1e29};
}
function gevReturn(mu:number,sigma:number,xi:number,T:number){const y=-Math.log(1-1/T);return Math.abs(xi)<1e-5?mu-sigma*Math.log(y):mu+sigma/xi*(y**(-xi)-1);}
function deterministicRandom(seed:number){let state=seed>>>0;return()=>{state|=0;state=state+0x6D2B79F5|0;let t=Math.imul(state^state>>>15,1|state);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296};}

type ModelPoint={year:number;y:number;x:number};
type PreparedFit={fit:GevFit;xMean:number;xSd:number;vary:boolean};
const finite=(value:number,digits=4)=>Number.isFinite(value)?+value.toFixed(digits):NaN;
function prepareFit(points:ModelPoint[],vary:boolean):PreparedFit{
 const xMean=vary?mean(points.map(p=>p.x)):0,xSd=vary?Math.max(1e-9,sd(points.map(p=>p.x))):1;
 return {fit:fitGev(points.map(p=>({x:vary?(p.x-xMean)/xSd:0,y:p.y})),vary),xMean,xSd,vary};
}
function gevCdf(y:number,mu:number,sigma:number,xi:number){
 const z=(y-mu)/sigma;
 if(Math.abs(xi)<1e-5)return Math.exp(-Math.exp(-z));
 const support=1+xi*z;if(support<=0)return xi>0?0:1;
 return Math.exp(-(support**(-1/xi)));
}
function residualDiagnostics(points:ModelPoint[],prepared:PreparedFit){
 if(!prepared.fit.ok)return {mean:NaN,sd:NaN,lag1:NaN,ksD:NaN,status:"Unavailable" as const};
 const params=prepared.fit.params,mu0=params[0],slope=prepared.vary?params[1]:0,sigma=Math.exp(params[prepared.vary?2:1]),xi=gevShape(params[prepared.vary?3:2]);
 const probabilities=points.map(point=>{const x=prepared.vary?(point.x-prepared.xMean)/prepared.xSd:0;return Math.max(1e-8,Math.min(1-1e-8,gevCdf(point.y,mu0+slope*x,sigma,xi)))}),ordered=[...probabilities].sort((a,b)=>a-b),n=ordered.length;
 let ksD=0;ordered.forEach((u,i)=>{ksD=Math.max(ksD,Math.abs(u-i/n),Math.abs((i+1)/n-u))});
 const z=probabilities.map(invNorm),zm=mean(z),zs=sd(z),a=z.slice(0,-1),b=z.slice(1),am=mean(a),bm=mean(b),den=Math.sqrt(a.reduce((s,v)=>s+(v-am)**2,0)*b.reduce((s,v)=>s+(v-bm)**2,0)),lag1=den?a.reduce((s,v,i)=>s+(v-am)*(b[i]-bm),0)/den:0;
 const adequate=ksD<=1.36/Math.sqrt(n)&&Math.abs(zm)<=.3&&zs>=.7&&zs<=1.3&&Math.abs(lag1)<=.3;
 return {mean:finite(zm,3),sd:finite(zs,3),lag1:finite(lag1,3),ksD:finite(ksD,3),status:adequate?"Adequate" as const:"Review" as const};
}
function holdoutScore(points:ModelPoint[],vary:boolean){
 const n=points.length,testN=Math.max(5,Math.round(n*.25)),trainN=n-testN;if(trainN<15)return {n:0,meanNll:NaN};
 const prepared=prepareFit(points.slice(0,trainN),vary);if(!prepared.fit.ok)return {n:testN,meanNll:NaN};
 let total=0;
 for(const point of points.slice(trainN)){
  const x=vary?(point.x-prepared.xMean)/prepared.xSd:0,nll=gevNll([{x,y:point.y}],prepared.fit.params,vary);
  if(!Number.isFinite(nll)||nll>=1e29)return {n:testN,meanNll:Infinity};total+=nll;
 }
 return {n:testN,meanNll:total/testN};
}
function slopeInterval(points:ModelPoint[],seed:number){
 const n=points.length,block=Math.max(2,Math.floor(Math.sqrt(n))),random=deterministicRandom(seed),slopes:number[]=[];
 for(let repetition=0;repetition<80;repetition++){
  const sample:ModelPoint[]=[];
  while(sample.length<n){const start=Math.floor(random()*n);for(let offset=0;offset<block&&sample.length<n;offset++)sample.push(points[(start+offset)%n]);}
  const prepared=prepareFit(sample,true);if(prepared.fit.ok&&prepared.xSd>1e-9)slopes.push(prepared.fit.params[1]/prepared.xSd);
 }
 slopes.sort((a,b)=>a-b);const at=(p:number)=>{if(!slopes.length)return NaN;const i=(slopes.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return slopes[lo]+(slopes[hi]-slopes[lo])*(i-lo)};
 return [at(.025),at(.975)] as const;
}

/**
 * Compare stationary, time and physically justified annual-covariate GEV models.
 * Every ranked model uses the same annual maxima and a chronological holdout.
 * Correlation is deliberately not calculated or used as a selection criterion.
 */
export function compareCovariateModels(maxima:{year:number;depthMm:number}[],covariates:AnnualCovariate[]=[]):CovariateModelComparison{
 const base=[...new Map(maxima.filter(v=>Number.isFinite(v.year)&&Number.isFinite(v.depthMm)&&v.depthMm>0).map(v=>[v.year,v])).values()].sort((a,b)=>a.year-b.year),excluded:CovariateModelExclusion[]=[];
 const rules={holdoutRule:"Chronological last 25% (minimum five years) held out; lower mean negative log-likelihood is better.",uncertaintyRule:"95% moving-block bootstrap interval for the GEV location coefficient (80 refits).",selectionRule:"A covariate is selected only when it is physically justified, within ΔAICc ≤ 2 of the best model, improves held-out log score over stationarity, has adequate PIT residual diagnostics, and its 95% coefficient interval excludes zero."};
 if(base.length<20)return {status:"Insufficient record",commonYears:base.map(v=>v.year),rows:[],excluded,selectedModelId:null,decision:"No covariate selected",decisionReason:"At least 20 eligible annual maxima are required for covariate comparison.",...rules};
 type Candidate={id:string;label:string;kind:CovariateModelRow["kind"];units:string;map:Map<number,number>;rationale:string;source:string};
 const available:Candidate[]=[];
 for(const candidate of covariates){
  const map=new Map(candidate.values.filter(v=>Number.isFinite(v.year)&&Number.isFinite(v.value)).map(v=>[v.year,v.value])),overlap=base.filter(v=>map.has(v.year)),unique=new Set(overlap.map(v=>map.get(v.year))).size,coverage=overlap.length/base.length;
  if(!candidate.physicallyPlausible){excluded.push({modelId:candidate.id,label:candidate.label,reason:"Not ranked: no documented physical rationale was supplied."});continue;}
  if(overlap.length<20||coverage<.7){excluded.push({modelId:candidate.id,label:candidate.label,reason:`Not ranked: ${overlap.length}/${base.length} matched years; at least 20 years and 70% coverage are required.`});continue;}
  if(unique<3){excluded.push({modelId:candidate.id,label:candidate.label,reason:"Not ranked: fewer than three distinct annual values."});continue;}
  available.push({id:candidate.id,label:candidate.label,kind:candidate.kind,units:candidate.units,map,rationale:candidate.physicalRationale,source:candidate.source});
 }
 available.sort((a,b)=>base.filter(v=>b.map.has(v.year)).length-base.filter(v=>a.map.has(v.year)).length||a.label.localeCompare(b.label));
 let commonYears=new Set(base.map(v=>v.year));const included:Candidate[]=[];
 for(const candidate of available.slice(0,10)){
  const next=new Set([...commonYears].filter(year=>candidate.map.has(year)));
  if(next.size<20){excluded.push({modelId:candidate.id,label:candidate.label,reason:"Not ranked: including it would reduce the shared comparison period below 20 years."});continue;}
  commonYears=next;included.push(candidate);
  if(included.length===6){for(const extra of available.slice(available.indexOf(candidate)+1))excluded.push({modelId:extra.id,label:extra.label,reason:"Not ranked in this run: maximum of six uploaded candidates; split large screening exercises into documented groups."});break;}
 }
 const common=base.filter(v=>commonYears.has(v.year)),candidateDefs:Candidate[]=[{id:"time",label:"Time",kind:"time",units:"year",map:new Map(common.map(v=>[v.year,v.year])),rationale:"Time is a proxy for unresolved gradual change; it is not itself a physical cause.",source:"Eligible annual-maxima years"},...included],rawRows:Array<Omit<CovariateModelRow,"deltaAicc"|"akaikeWeight"|"holdoutDeltaVsStationary"|"selectionEvidence">>=[];
 const stationaryPoints=common.map(v=>({year:v.year,y:v.depthMm,x:0})),stationaryFit=prepareFit(stationaryPoints,false),stationaryResidual=residualDiagnostics(stationaryPoints,stationaryFit),stationaryHoldout=holdoutScore(stationaryPoints,false);
 if(!stationaryFit.fit.ok)return {status:"Optimization failed",commonYears:common.map(v=>v.year),rows:[],excluded,selectedModelId:null,decision:"No covariate selected",decisionReason:"The stationary reference model could not be fitted on the shared comparison years.",...rules};
 rawRows.push({modelId:"stationary",label:"Stationary GEV",kind:"stationary",units:"not applicable",n:common.length,aicc:stationaryFit.fit.aicc,locationSlopePerUnit:0,slopeCiLower:NaN,slopeCiUpper:NaN,residualMean:stationaryResidual.mean,residualSd:stationaryResidual.sd,residualLag1:stationaryResidual.lag1,pitKsD:stationaryResidual.ksD,residualStatus:stationaryResidual.status,holdoutN:stationaryHoldout.n,holdoutMeanNll:stationaryHoldout.meanNll,physicalRationale:"Reference model with time-invariant GEV parameters.",source:"Eligible annual maxima"});
 for(const candidate of candidateDefs){
  const points=common.map(v=>({year:v.year,y:v.depthMm,x:candidate.map.get(v.year)!})),prepared=prepareFit(points,true);if(!prepared.fit.ok){excluded.push({modelId:candidate.id,label:candidate.label,reason:"Optimization failed on the common comparison years."});continue;}
  const residual=residualDiagnostics(points,prepared),holdout=holdoutScore(points,true),[ciLow,ciHigh]=slopeInterval(points,(common.length*2654435761+candidate.id.length*1013904223)>>>0);
  rawRows.push({modelId:candidate.id,label:candidate.label,kind:candidate.kind,units:candidate.units,n:common.length,aicc:prepared.fit.aicc,locationSlopePerUnit:prepared.fit.params[1]/prepared.xSd,slopeCiLower:ciLow,slopeCiUpper:ciHigh,residualMean:residual.mean,residualSd:residual.sd,residualLag1:residual.lag1,pitKsD:residual.ksD,residualStatus:residual.status,holdoutN:holdout.n,holdoutMeanNll:holdout.meanNll,physicalRationale:candidate.rationale,source:candidate.source});
 }
 const bestAicc=Math.min(...rawRows.map(r=>r.aicc)),weightDenominator=rawRows.reduce((sum,row)=>sum+Math.exp(-.5*(row.aicc-bestAicc)),0),stationaryNll=rawRows[0].holdoutMeanNll;
 const rows:CovariateModelRow[]=rawRows.map(row=>{const delta=row.aicc-bestAicc,holdoutDelta=row.holdoutMeanNll-stationaryNll,ciExcludesZero=row.modelId!=="stationary"&&Number.isFinite(row.slopeCiLower)&&Number.isFinite(row.slopeCiUpper)&&(row.slopeCiLower>0||row.slopeCiUpper<0),aiccSupported=delta<=2,oosBetter=row.modelId!=="stationary"&&Number.isFinite(holdoutDelta)&&holdoutDelta<0,evidence=row.modelId==="stationary"?"Reference model":aiccSupported&&oosBetter&&row.residualStatus==="Adequate"&&ciExcludesZero?"All selection checks passed":[!aiccSupported?"ΔAICc > 2":"",!oosBetter?"no held-out improvement":"",row.residualStatus!=="Adequate"?"residual diagnostics require review":"",!ciExcludesZero?"coefficient interval includes zero":""].filter(Boolean).join("; ");return {...row,aicc:finite(row.aicc,2),deltaAicc:finite(delta,2),akaikeWeight:finite(Math.exp(-.5*delta)/weightDenominator,3),locationSlopePerUnit:finite(row.locationSlopePerUnit,5),slopeCiLower:finite(row.slopeCiLower,5),slopeCiUpper:finite(row.slopeCiUpper,5),holdoutMeanNll:finite(row.holdoutMeanNll,4),holdoutDeltaVsStationary:finite(holdoutDelta,4),selectionEvidence:evidence};});
 const supported=rows.filter(row=>row.modelId!=="stationary"&&row.selectionEvidence==="All selection checks passed").sort((a,b)=>a.holdoutMeanNll-b.holdoutMeanNll),stationary=rows.find(row=>row.modelId==="stationary")!;
 let selectedModelId:string|null=null,decision="Inconclusive — no covariate selected",decisionReason="AICc, residual diagnostics, coefficient uncertainty and held-out performance do not jointly identify one covariate.";
 if(supported.length===1){selectedModelId=supported[0].modelId;decision=`Supported covariate: ${supported[0].label}`;decisionReason="This candidate passed all predeclared checks on the shared comparison years.";}
 else if(supported.length>1){const margin=supported[1].holdoutMeanNll-supported[0].holdoutMeanNll;if(margin>.05){selectedModelId=supported[0].modelId;decision=`Supported covariate: ${supported[0].label}`;decisionReason=`Multiple candidates passed, and ${supported[0].label} had the lower held-out mean negative log-likelihood by ${margin.toFixed(3)}.`;}else decisionReason="Multiple covariates pass the checks with practically similar held-out performance; physical evidence or an independent validation record is required.";}
 else if(stationary.deltaAicc<=2&&rows.every(row=>row.modelId==="stationary"||row.holdoutDeltaVsStationary>=0||row.residualStatus!=="Adequate")){selectedModelId="stationary";decision="Stationary GEV retained";decisionReason="No nonstationary candidate improved the complete evidence set over the stationary reference.";}
 return {status:"Compared",commonYears:common.map(v=>v.year),rows,excluded,selectedModelId,decision,decisionReason,...rules};
}

export function calculateNonstationaryCovariate(records:DailyRecord[],candidate:AnnualCovariate,evaluationValue:number,exponent=.33){
 const map=new Map(candidate.values.map(v=>[v.year,v.value])),maxima=annualMaxima(records,1).filter(v=>map.has(v.year)),n=maxima.length,empty:CovariateFit={status:"Insufficient record",n,covariateId:candidate.id,covariateLabel:candidate.label,units:candidate.units,centerValue:NaN,valueScale:NaN,evaluationValue,locationAtCenter:NaN,locationSlopePerUnit:NaN,scale:NaN,shape:NaN,stationaryAicc:NaN,nonstationaryAicc:NaN,deltaAicc:NaN,preferred:"Inconclusive"};
 if(n<20)return {rows:[] as ResultRow[],fit:empty};
 const points=maxima.map(v=>({year:v.year,y:v.depthMm,x:map.get(v.year)!})),prepared=prepareFit(points,true),stationary=prepareFit(points,false);if(!prepared.fit.ok||!stationary.fit.ok)return {rows:[] as ResultRow[],fit:{...empty,status:"Optimization failed" as const}};
 const [mu0,slopeStd,logSigma,eta]=prepared.fit.params,sigma=Math.exp(logSigma),shape=gevShape(eta),xRef=(evaluationValue-prepared.xMean)/prepared.xSd,delta=stationary.fit.aicc-prepared.fit.aicc,preferred=delta>2?"Nonstationary" as const:delta<-2?"Stationary" as const:"Inconclusive" as const,random=deterministicRandom((n*2654435761+candidate.id.length*1013904223)>>>0),bootstrap=new Map(PERIODS.map(T=>[T,[] as number[]]));
 for(let b=0;b<80;b++){const sample=Array.from({length:n},()=>points[Math.floor(random()*n)]),fit=prepareFit(sample,true);if(!fit.fit.ok)continue;const [bm,bs,bl,be]=fit.fit.params,bx=(evaluationValue-fit.xMean)/fit.xSd,bSigma=Math.exp(bl),bShape=gevShape(be);for(const T of PERIODS){const value=gevReturn(bm+bs*bx,bSigma,bShape,T);if(Number.isFinite(value)&&value>=0)bootstrap.get(T)!.push(value);}}
 const at=(values:number[],p:number)=>{const a=[...values].sort((x,y)=>x-y);if(!a.length)return NaN;const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]+(a[hi]-a[lo])*(i-lo)},rows:ResultRow[]=[];
 for(const T of PERIODS){const daily=Math.max(0,gevReturn(mu0+slopeStd*xRef,sigma,shape,T)),boot=bootstrap.get(T)!;for(const duration of DURATIONS){if(duration>1440)continue;const derived=duration<1440,scaleDuration=derived?(duration/1440)**exponent:1,depth=daily*scaleDuration,intensity=depth/(duration/60);rows.push({method:"gev",durationMinutes:duration,returnPeriodYears:T,depthMm:finite(depth,2),intensityMmHr:finite(intensity,2),ciLower:finite(at(boot,.025)*scaleDuration/(duration/60),2),ciUpper:finite(at(boot,.975)*scaleDuration/(duration/60),2),derived});}}
 return {rows,fit:{status:"Fitted" as const,n,covariateId:candidate.id,covariateLabel:candidate.label,units:candidate.units,centerValue:finite(prepared.xMean,4),valueScale:finite(prepared.xSd,4),evaluationValue,locationAtCenter:finite(mu0,3),locationSlopePerUnit:finite(slopeStd/prepared.xSd,5),scale:finite(sigma,3),shape:finite(shape,4),stationaryAicc:finite(stationary.fit.aicc,2),nonstationaryAicc:finite(prepared.fit.aicc,2),deltaAicc:finite(delta,2),preferred}};
}
export function calculateNonstationaryTime(records:DailyRecord[],referenceYear:number,exponent=.33){
 const maxima=annualMaxima(records,1),n=maxima.length,empty:NonstationaryFit={status:"Insufficient record",n,centerYear:NaN,yearScale:NaN,referenceYear,locationAtCenter:NaN,locationSlopeMmPerYear:NaN,scale:NaN,shape:NaN,stationaryAicc:NaN,nonstationaryAicc:NaN,deltaAicc:NaN,preferred:"Inconclusive"};
 if(n<20)return {rows:[] as ResultRow[],fit:empty};
 const centerYear=mean(maxima.map(v=>v.year)),yearScale=Math.max(1,sd(maxima.map(v=>v.year))),points=maxima.map(v=>({x:(v.year-centerYear)/yearScale,y:v.depthMm})),stationary=fitGev(points,false),ns=fitGev(points,true);
 if(!stationary.ok||!ns.ok)return {rows:[] as ResultRow[],fit:{...empty,status:"Optimization failed",centerYear,yearScale}};
 const [mu0,slopeStd,logSigma,eta]=ns.params,sigma=Math.exp(logSigma),shape=gevShape(eta),delta=stationary.aicc-ns.aicc,preferred=delta>2?"Nonstationary":delta<-2?"Stationary":"Inconclusive",xRef=(referenceYear-centerYear)/yearScale,rows:ResultRow[]=[],random=deterministicRandom((n*2654435761+Math.round(referenceYear)*1013904223)>>>0),bootstrap=new Map<number,number[]>();
 PERIODS.forEach(T=>bootstrap.set(T,[]));
 for(let b=0;b<80;b++){const sample=Array.from({length:n},()=>points[Math.floor(random()*n)]),fit=fitGev(sample,true);if(!fit.ok)continue;const [bm,bs,bl,be]=fit.params,bqSigma=Math.exp(bl),bqShape=gevShape(be);for(const T of PERIODS){const q=gevReturn(bm+bs*xRef,bqSigma,bqShape,T);if(Number.isFinite(q)&&q>=0)bootstrap.get(T)!.push(q);}}
 const qAt=(values:number[],p:number)=>{const a=[...values].sort((x,y)=>x-y);if(!a.length)return NaN;const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]+(a[hi]-a[lo])*(i-lo)};
 for(const T of PERIODS){const daily=Math.max(0,gevReturn(mu0+slopeStd*xRef,sigma,shape,T)),boot=bootstrap.get(T)!;for(const duration of DURATIONS){if(duration>1440)continue;const derived=duration<1440,scaleDuration=derived?(duration/1440)**exponent:1,depth=daily*scaleDuration,intensity=depth/(duration/60),lo=qAt(boot,.025)*scaleDuration/(duration/60),hi=qAt(boot,.975)*scaleDuration/(duration/60);rows.push({method:"gev",durationMinutes:duration,returnPeriodYears:T,depthMm:+depth.toFixed(2),intensityMmHr:+intensity.toFixed(2),ciLower:+lo.toFixed(2),ciUpper:+hi.toFixed(2),derived});}}
 const fit:NonstationaryFit={status:"Fitted",n,centerYear:+centerYear.toFixed(2),yearScale:+yearScale.toFixed(2),referenceYear,locationAtCenter:+mu0.toFixed(3),locationSlopeMmPerYear:+(slopeStd/yearScale).toFixed(4),scale:+sigma.toFixed(3),shape:+shape.toFixed(4),stationaryAicc:+stationary.aicc.toFixed(2),nonstationaryAicc:+ns.aicc.toFixed(2),deltaAicc:+delta.toFixed(2),preferred};
 return {rows,fit};
}
export function calculate(records:DailyRecord[], exponent=.33){const result:ResultRow[]=[],am=annualMaxima(records,1).map(v=>v.depthMm);if(am.length<8)return result;for(const method of ALL_METHODS)for(const T of PERIODS){const dailyDepth=Math.max(0,quantile(am,T,method)),[bootLow,bootHigh]=bootstrapInterval(am,T,method);for(const duration of DURATIONS){if(duration>1440)continue;const derived=duration<1440,scale=derived?(duration/1440)**exponent:1,depth=dailyDepth*scale,intensity=depth/(duration/60),ciLow=Math.max(0,bootLow)*scale/(duration/60),ciHigh=Math.max(0,bootHigh)*scale/(duration/60);result.push({method,durationMinutes:duration,returnPeriodYears:T,depthMm:+depth.toFixed(2),intensityMmHr:+intensity.toFixed(2),ciLower:+ciLow.toFixed(2),ciUpper:+ciHigh.toFixed(2),derived});}}return result;}
export function calculateHourly(records:HourlyRecord[],exponent=.33){const result:ResultRow[]=[],samples=new Map<number,number[]>();for(const minutes of DURATIONS.filter(d=>d>=60&&d<=1440))samples.set(minutes,hourlyAnnualMaxima(records,minutes/60).map(v=>v.depthMm));const oneHour=samples.get(60)??[];if(oneHour.length<8)return result;for(const method of ALL_METHODS)for(const T of PERIODS)for(const duration of DURATIONS){if(duration>1440)continue;const derived=duration<60,sample=derived?oneHour:samples.get(duration)??[];if(sample.length<8)continue;const base=Math.max(0,quantile(sample,T,method)),[bootLow,bootHigh]=bootstrapInterval(sample,T,method),scale=derived?(duration/60)**exponent:1,depth=base*scale,intensity=depth/(duration/60),ciLow=Math.max(0,bootLow)*scale/(duration/60),ciHigh=Math.max(0,bootHigh)*scale/(duration/60);result.push({method,durationMinutes:duration,returnPeriodYears:T,depthMm:+depth.toFixed(2),intensityMmHr:+intensity.toFixed(2),ciLower:+ciLow.toFixed(2),ciUpper:+ciHigh.toFixed(2),derived});}return result;}
