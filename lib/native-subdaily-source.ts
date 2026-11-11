import { parseNativeThreeHourly } from './native-subdaily.ts';
import { cmip6GeometryBounds } from './cmip6-online.ts';
import type { OnlineGeometry } from './online-precipitation.ts';
const SEARCH='https://esgf-data.dkrz.de/esg-search/search';
const CACHE=new Map<string,unknown>();
type NativeFile={url:string;title:string;firstYear:number;lastYear:number};
const MODEL='ACCESS-CM2',MEMBER='r1i1p1f1';
const scenarios=['historical','ssp126','ssp245','ssp370','ssp585'];
async function get(url:string,timeout=45000){const response=await fetch(url,{signal:AbortSignal.timeout(timeout)});if(!response.ok)throw Error(`Native archive returned HTTP ${response.status}. No daily source was substituted.`);return response;}
export async function nativeArchiveRequest(p:Record<string,unknown>){
  const scenario=String(p.scenario);if(!scenarios.includes(scenario))throw Error('Choose a supported native CMIP6 experiment.');
  if(p.action==='catalogue'){
   const cached=CACHE.get(scenario);if(cached)return cached;
   const url=new URL(SEARCH);Object.entries({project:'CMIP6',type:'File',source_id:MODEL,experiment_id:scenario,table_id:'3hr',variable_id:'pr',member_id:MEMBER,data_node:'esgf.ceda.ac.uk',distrib:'true',latest:'true',limit:'200',format:'application/solr+json'}).forEach(([key,value])=>url.searchParams.set(key,value));
   const data=await(await get(url.toString())).json() as {response?:{docs?:Array<{url?:string[];title?:string}>}};
   const files:NativeFile[]=[];
   for(const doc of data.response?.docs??[]){
    const value=doc.url?.find(value=>value.endsWith('|HTTPServer'))?.split('|')[0];if(!value)continue;
    const parsed=new URL(value);if(parsed.hostname!=='esgf.ceda.ac.uk'||!parsed.pathname.startsWith('/thredds/fileServer/esg_cmip6/CMIP6/'))continue;
    const title=doc.title??parsed.pathname.split('/').at(-1)!;const match=title.match(/_(\d{4})\d{8}-(\d{4})\d{8}\.nc$/);if(!match)continue;
    files.push({url:parsed.toString(),title,firstYear:Number(match[1]),lastYear:Number(match[2])});
   }
   if(!files.length)throw Error(`No verified CEDA native 3-hour pr files were found for ${MODEL}, ${MEMBER}, ${scenario}.`);
   const result={model:MODEL,member:MEMBER,scenario,intervalMinutes:180,nativeGrid:'1.25° latitude × 1.875° longitude; not NEX downscaled data',files:files.sort((a,b)=>a.firstYear-b.firstYear),catalogueUrl:url.toString()};CACHE.set(scenario,result);return result;
  }
  if(p.action!=='year')throw Error('Unsupported native archive action.');
  const year=Number(p.year);if(!Number.isInteger(year)||year<1850||year>2100||(scenario==='historical'?year>2014:year<2015))throw Error('Invalid native experiment year.');
  const source=new URL(String(p.fileUrl));
  const pathPattern=new RegExp(`^/thredds/fileServer/esg_cmip6/CMIP6/(CMIP|ScenarioMIP)/CSIRO-ARCCSS/ACCESS-CM2/${scenario}/r1i1p1f1/3hr/pr/gn/v[0-9]{8}/pr_3hr_ACCESS-CM2_${scenario}_r1i1p1f1_gn_[0-9]{12}-[0-9]{12}\\.nc$`);
  if(source.protocol!=='https:'||source.hostname!=='esgf.ceda.ac.uk'||source.username||source.password||source.port||source.search||source.hash||!pathPattern.test(source.pathname))throw Error('Only the verified native ACCESS-CM2 CEDA files are accepted.');
  const mode=p.mode;if(mode!=='point'&&mode!=='district')throw Error('Choose point or district native extraction.');
  const url=new URL(source.toString().replace('/fileServer/','/ncss/grid/'));
  url.searchParams.set('var','pr');url.searchParams.set('time_start',`${year}-01-01T00:00:00Z`);url.searchParams.set('time_end',`${year}-12-31T23:59:59Z`);url.searchParams.set('accept','netCDF');url.searchParams.set('addLatLon','true');
  let geometry:OnlineGeometry|undefined;
  if(mode==='point'){
   const lat=Number(p.latitude),lon=Number(p.longitude);if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<23||lat>38||lon<60||lon>79)throw Error('Native point extraction requires Pakistan coordinates.');
   url.searchParams.set('latitude',lat.toFixed(5));url.searchParams.set('longitude',lon.toFixed(5));
  }else{
   geometry=p.geometry as OnlineGeometry;if(!geometry||!['Polygon','MultiPolygon'].includes(geometry.type)||!Array.isArray(geometry.coordinates))throw Error('District native extraction requires the selected polygon.');
   const box=cmip6GeometryBounds(geometry);if(box.south<23||box.north>39||box.west<60||box.east>80)throw Error('The selected district must be inside Pakistan.');
   url.searchParams.set('north',String(box.north+2));url.searchParams.set('south',String(box.south-2));url.searchParams.set('east',String(box.east+2));url.searchParams.set('west',String(box.west-2));url.searchParams.set('horizStride','1');
  }
  const response=await get(url.toString(),150000);if(Number(response.headers.get('content-length'))>24000000)throw Error('The native district subset exceeds the interactive limit.');
  const bytes=await response.arrayBuffer();if(bytes.byteLength>24000000)throw Error('The native subset exceeds the interactive limit.');
  return {status:'complete',year,...parseNativeThreeHourly(bytes,geometry),providerUrl:source.toString(),subsetUrl:url.toString()};
}
