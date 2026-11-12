"use client";
import {PAKISTAN_DISTRICT_GROUPS} from '../../lib/district-catalogue';
export default function DistrictSelector({district,onChange,disabled=false}:{district:string;onChange:(district:string)=>void;disabled?:boolean}){
 const province=Object.keys(PAKISTAN_DISTRICT_GROUPS).find(region=>PAKISTAN_DISTRICT_GROUPS[region].includes(district))??'';
 return <div className="province-district-selector" style={{display:'grid',gap:10}}>
  <label>Province / territory<select aria-label="Province / territory" value={province} disabled={disabled} onChange={event=>{const first=PAKISTAN_DISTRICT_GROUPS[event.target.value]?.[0];if(first)onChange(first);}}>{!province&&<option value="">Choose province / territory</option>}{Object.keys(PAKISTAN_DISTRICT_GROUPS).map(region=><option key={region}>{region}</option>)}</select></label>
  <label>District<select aria-label="District selection" value={district} disabled={disabled} onChange={event=>onChange(event.target.value)}>{(PAKISTAN_DISTRICT_GROUPS[province]??[]).map(name=><option key={name}>{name}</option>)}</select></label>
  <small className="field-note">{disabled?'Selection is disabled for the active data or point mode.':`${PAKISTAN_DISTRICT_GROUPS[province]?.length??0} districts in this province/territory · versioned project boundary catalogue.`}</small>
 </div>;
}
