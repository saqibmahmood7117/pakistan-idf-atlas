import { annualMaxima, type DailyRecord } from "./observed-idf.ts";
import type { OnlineGeometry } from "./online-precipitation.ts";

/** Includes polygon content, not just the displayed district name. */
export function cmipBiasSpatialKey(input: {
  mode: "point" | "district"; latitude: number; longitude: number;
  district: string; geometry?: OnlineGeometry | null;
  boundaryCode?: string; boundaryVersion?: string;
}) {
  if (input.mode === "point") return `point|${input.latitude.toFixed(5)}|${input.longitude.toFixed(5)}`;
  if (!input.geometry) return `district|${input.district}|boundary-unavailable`;
  const serialized=JSON.stringify(input.geometry);
  let hash=2166136261;
  for(let index=0;index<serialized.length;index++) hash=Math.imul(hash^serialized.charCodeAt(index),16777619)>>>0;
  return `district|${input.district}|${input.boundaryCode??""}|${input.boundaryVersion??""}|${serialized.length}:${hash.toString(16)}`;
}

/** Only common, complete baseline years may calibrate a reference/model pair. */
export function matchCmipHistoricalBaseline(model: DailyRecord[], reference: DailyRecord[]) {
  const baseline=(records:DailyRecord[])=>records.filter(row=>row.date>="1985-01-01"&&row.date<="2014-12-31");
  const modelBaseline=baseline(model),referenceBaseline=baseline(reference);
  const referenceYears=new Set(annualMaxima(referenceBaseline,1).map(row=>row.year));
  const years=annualMaxima(modelBaseline,1).map(row=>row.year).filter(year=>referenceYears.has(year)).sort((a,b)=>a-b);
  const common=new Set(years);
  return {years,model:modelBaseline.filter(row=>common.has(Number(row.date.slice(0,4)))),reference:referenceBaseline.filter(row=>common.has(Number(row.date.slice(0,4))))};
}

export function districtBiasReference(mode: "point" | "district", requested: "auto" | "gauge" | "era5", eligibleGaugeYears: number) {
  if (mode === "district") {
    if (requested === "gauge") throw new Error("A single uploaded point gauge is not a district spatial reference. Choose Automatic or ERA5 for district bias correction.");
    return "era5" as const;
  }
  return requested === "era5" || (requested === "auto" && eligibleGaugeYears < 20) ? "era5" as const : "gauge" as const;
}

export type CmipBiasSpatialAudit = {
  mode: "point" | "district";
  spatialKey: string;
  districtName?: string;
  boundaryCode?: string;
  boundarySource?: string;
  boundaryVersion?: string;
  member: string;
  historicalGridCells: number;
  historicalSpatialMethod: string;
  referenceSpatialMethod: string;
  referenceGridCells?: number;
  baseline: "1985–2014";
  commonEligibleYears: number[];
  correctionOrder: string;
};
