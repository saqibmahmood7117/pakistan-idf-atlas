"use client";
import PowerIntensityCalculator from "./components/power-intensity-calculator";
import { escapeReportText, reportFileStem, REPORT_LAYOUT_CSS } from "../lib/report-export";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DISTRICTS_BY_REGION,
  CMIP6_MODELS,
  CMIP6_PERIODS,
  CMIP6_SCENARIOS,
  PAKISTAN_IDF_ENSEMBLE_MODELS,
  SOURCE_META,
  type Cmip6Period,
  type Cmip6Scenario,
} from "../lib/idf-data";
import {
  assess,
  assessHourly,
  calculate,
  calculateHourly,
  calculateNonstationaryCovariate,
  calculateNonstationaryTime,
  calculateReferenceYear,
  compareCovariateModels,
  annualMaxima,
  fitDiagnostics,
  fitDiagnosticsHourly,
  hourlyAnnualMaxima,
  hourlyToDailyTotals,
  stationarityDiagnostics,
  stationarityDiagnosticsHourly,
  ALL_METHODS,
  DISTRIBUTION_METHODS,
  METHOD_LABEL,
  PERIODS,
  type DailyRecord,
  type AnnualCovariate,
  type HourlyRecord,
  type Method,
  type ReferenceYearBasis,
  type ResultRow,
} from "../lib/observed-idf";
import { parseObservedWorkbook } from "../lib/observed-workbook";
import { parseCovariateWorkbook } from "../lib/covariate-workbook";
import {
  ONLINE_COVARIATE_CONFIG,
  annualMeanFromDatedValues,
  onlineCovariateSourceText,
  type OnlineCovariateMetadata,
  type OnlineCovariateResponse,
  type OnlineCovariateSource,
} from "../lib/online-covariates";
import {
  ERA5_DISTRICT_CELL_LIMIT,
  ERA5_LAND_PRECIPITATION_NOTICE,
  ERA5_MULTI_LOCATION_BATCH_SIZE,
  ERA5_REQUEST_PACING_MS,
  LIVE_SOURCE_CONFIG,
  climateServDate,
  climateServRecords,
  aggregatePrecipitationForPlot,
  era5DistrictGrid,
  mergeDailyRecords,
  mergeHourlyRecords,
  nasaPowerRecords,
  peakPreservingPrecipitationPlot,
  pointBufferGeometry,
  powerDistrictGrid,
  reanalysisDistrictGrid,
  splitDateRange,
  type LiveOnlineSource,
  type OnlineExtractionMetadata,
  type OnlineExtractionResponse,
  type OnlineGeometry,
  type OnlineJob,
  type PrecipitationPlotInterval,
  type PrecipitationPlotRecord,
  type OnlineTemporalResolution,
  type WeightedGridPoint,
} from "../lib/online-precipitation";
import {
  OCHA_ADM2_CATALOGUE_COUNT,
  boundaryFeatureName,
  normalizeBoundaryName,
} from "../lib/district-boundaries";
import {
  type Cmip6Catalogue,
  type Cmip6ExtractionMetadata,
} from "../lib/cmip6-online";
import {
  applyObservedDurationRatios,
  monthlyMultiplicativeQdm,
  multiModelEnvelope,
  observedDurationRatios,
  projectionEvidenceStatus,
  type ModelReturnLevels,
} from "../lib/cmip6-extremes";
import {
  parseBiasCorrectedCmipWorkbook,
  type ImportedCmipWorkbook,
} from "../lib/cmip6-workbook";
import {
  fitPowerEquation,
  fitShermanEquation,
  formatPowerEquation,
  formatShermanEquation,
  kirpichTimeOfConcentrationMinutes,
  shermanIntensity,
  type ShermanEquationFit,
} from "../lib/idf-design";
import {
  extractLineStrings,
  flowPathLengthMetres as calculateFlowPathLengthMetres,
  type Position,
  type WatershedGeometryResult,
} from "../lib/watershed-geometry";

type GeoGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };
type GeoFeature = {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: GeoGeometry;
};
type GeoCollection = { type: "FeatureCollection"; features: GeoFeature[] };
type SourceTab = "observed" | "online" | "cmip6";
type Cmip6SelectionMode = "ensemble" | "individual";
type Cmip6BiasReference = "auto" | "gauge" | "era5";
type NonstationaryCovariate = "time" | "matched";
type WatershedGeometryResponse = {
  status: "complete" | "error";
  result?: WatershedGeometryResult;
  error?: string;
};
type Cmip6AnnualResponse = {
  records: DailyRecord[];
  extractedGridCells: number;
  returnedLatitude?: number;
  returnedLongitude?: number;
  nearestCellFallback?: boolean;
  sourceTimeUnits?: string;
  sourceCalendar?: string;
  calendarConversion?: string;
};
type StoredCmipModel = ModelReturnLevels & {
  selectionKey: string;
  correctionReference: string;
};
const cmipEnsembleSelectionKey = ({
  scenario,
  period,
  latitude,
  longitude,
  reference,
  model,
  method,
  durationBasis,
}: {
  scenario: Cmip6Scenario;
  period: Cmip6Period;
  latitude: number;
  longitude: number;
  reference: string;
  model: "stationary" | "nonstationary";
  method: Method;
  durationBasis: "observed-duration-ratios" | "24-hour-only";
}) =>
  [
    scenario,
    period,
    latitude.toFixed(5),
    longitude.toFixed(5),
    reference,
    model,
    method,
    durationBasis,
  ].join("|");
const cmip6AnnualResponseCache = new Map<string, Cmip6AnnualResponse>();
const CMIP6_ANNUAL_CACHE_LIMIT = 80;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isGeoCollection = (value: unknown): value is GeoCollection => {
  if (
    !isRecord(value) ||
    value.type !== "FeatureCollection" ||
    !Array.isArray(value.features) ||
    !value.features.length
  )
    return false;
  return value.features.every(
    (feature) =>
      isRecord(feature) &&
      feature.type === "Feature" &&
      isRecord(feature.properties) &&
      isRecord(feature.geometry) &&
      (feature.geometry.type === "Polygon" ||
        feature.geometry.type === "MultiPolygon") &&
      Array.isArray(feature.geometry.coordinates),
  );
};
const boundaryName = (f: GeoFeature) => boundaryFeatureName(f.properties);
async function fetchGeoCollection(url: string) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Boundary service returned ${response.status}.`);
  const data: unknown = await response.json();
  if (!isGeoCollection(data))
    throw new Error("Online layer is not valid polygon GeoJSON.");
  return data;
}

type DirectEra5Request = {
  source: "era5" | "era5land";
  resolution: OnlineTemporalResolution;
  mode: "point" | "district";
  start: string;
  end: string;
  latitude?: number;
  longitude?: number;
  geometry?: OnlineGeometry;
  districtName?: string;
  districtCode?: string;
  boundarySource?: string;
  boundaryVersion?: string;
  boundaryValidOn?: string;
  bypassCache?: boolean;
};
type DirectOpenMeteoPayload = {
  latitude?: number;
  longitude?: number;
  daily?: {
    time?: string[];
    precipitation_sum?: Array<number | null>;
    temperature_2m_max?: Array<number | null>;
    temperature_2m_min?: Array<number | null>;
  };
  hourly?: { time?: string[]; precipitation?: Array<number | null> };
};
async function fetchOpenMeteoInBrowser(url: string, bypassCache = false) {
  const retryable = new Set([429, 502, 503, 504]);
  let responseCache: Cache | null = null;
  try {
    if ("caches" in globalThis) {
      responseCache = await globalThis.caches.open(
        "pakistan-idf-open-meteo-v1",
      );
      const cached = bypassCache ? null : await responseCache.match(url);
      if (cached?.ok)
        return (await cached.json()) as
          | DirectOpenMeteoPayload
          | DirectOpenMeteoPayload[];
    }
  } catch {
    responseCache = null;
  }
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url);
    if (response.ok) {
      const cacheCopy = response.clone();
      const payload = (await response.json()) as
        | DirectOpenMeteoPayload
        | DirectOpenMeteoPayload[];
      try {
        await responseCache?.put(url, cacheCopy);
      } catch {
        // Retrieval remains valid when browser cache storage is unavailable.
      }
      return payload;
    }
    if (!retryable.has(response.status) || attempt === 5)
      throw new Error(
        response.status === 429
          ? "Open-Meteo returned HTTP 429 because its free request quota is exhausted for this connection. The atlas did not substitute another dataset. Try again later, or select CHIRPS, IMERG or NASA POWER."
          : `Open-Meteo returned HTTP ${response.status}.`,
      );
    const retryAfter = Number(response.headers.get("retry-after"));
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(15_000, retryAfter * 1000)
          : Math.min(12_000, 1000 * 2 ** attempt),
      ),
    );
  }
  throw new Error("Open-Meteo did not return a usable response.");
}
async function extractEra5InBrowser(
  request: DirectEra5Request,
  onProgress: (value: number) => void,
): Promise<OnlineExtractionResponse> {
  if (request.source === "era5land")
    throw new Error(ERA5_LAND_PRECIPITATION_NOTICE);
  if (request.mode === "district" && !request.geometry)
    throw new Error("The selected district polygon is not available.");
  const districtGrid =
    request.mode === "district"
      ? reanalysisDistrictGrid(
          request.source,
          request.geometry!,
          ERA5_DISTRICT_CELL_LIMIT[request.resolution],
        )
      : null;
  const points: WeightedGridPoint[] = districtGrid?.points ?? [
    {
      latitude: Number(request.latitude),
      longitude: Number(request.longitude),
      weight: 1,
    },
  ];
  const chunks = splitDateRange(
      request.start,
      request.end,
      request.resolution === "hourly" ? 5 : 20,
    ),
    batchSize = ERA5_MULTI_LOCATION_BATCH_SIZE[request.resolution],
    totalBatches = chunks.length * Math.ceil(points.length / batchSize);
  const dailyGroups: DailyRecord[][] = [],
    hourlyGroups: HourlyRecord[][] = [];
  let completed = 0,
    returnedLatitude: number | undefined,
    returnedLongitude: number | undefined;
  for (const chunk of chunks) {
    let times: string[] | null = null,
      weightedSum: number[] = [],
      validWeight: number[] = [];
    for (let offset = 0; offset < points.length; offset += batchSize) {
      const batch = points.slice(offset, offset + batchSize),
        url = new URL("https://archive-api.open-meteo.com/v1/archive");
      url.searchParams.set(
        "latitude",
        batch.map((point) => point.latitude.toFixed(4)).join(","),
      );
      url.searchParams.set(
        "longitude",
        batch.map((point) => point.longitude.toFixed(4)).join(","),
      );
      url.searchParams.set("start_date", chunk.start);
      url.searchParams.set("end_date", chunk.end);
      url.searchParams.set(
        request.resolution === "hourly" ? "hourly" : "daily",
        request.resolution === "hourly" ? "precipitation" : "precipitation_sum",
      );
      url.searchParams.set(
        "models",
        LIVE_SOURCE_CONFIG[request.source].openMeteoModel,
      );
      url.searchParams.set("timezone", "UTC");
      url.searchParams.set("cell_selection", "nearest");
      const payload = await fetchOpenMeteoInBrowser(
          url.toString(),
          request.bypassCache === true,
        ),
        locations = (
          Array.isArray(payload) ? payload : [payload]
        ) as DirectOpenMeteoPayload[];
      if (locations.length !== batch.length)
        throw new Error(
          "The reanalysis provider returned an unexpected number of grid-cell series.",
        );
      for (let index = 0; index < locations.length; index += 1) {
        const location = locations[index],
          locationTimes =
            request.resolution === "hourly"
              ? (location.hourly?.time ?? [])
              : (location.daily?.time ?? []),
          values =
            request.resolution === "hourly"
              ? (location.hourly?.precipitation ?? [])
              : (location.daily?.precipitation_sum ?? []);
        if (!times) {
          times = locationTimes;
          weightedSum = Array(locationTimes.length).fill(0);
          validWeight = Array(locationTimes.length).fill(0);
        }
        if (
          locationTimes.length !== times.length ||
          locationTimes.some((time, item) => time !== times![item])
        )
          throw new Error(
            "The reanalysis provider returned inconsistent timestamps across grid cells.",
          );
        const weight = batch[index].weight;
        for (let item = 0; item < values.length; item += 1) {
          const value = values[item];
          if (
            Number.isFinite(value) &&
            Number(value) >= 0 &&
            Number(value) < 5000
          ) {
            weightedSum[item] += Number(value) * weight;
            validWeight[item] += weight;
          }
        }
        if (request.mode === "point") {
          returnedLatitude = location.latitude;
          returnedLongitude = location.longitude;
        }
      }
      completed += 1;
      onProgress(Math.round((100 * completed) / totalBatches));
      if (completed < totalBatches)
        await new Promise((resolve) =>
          setTimeout(resolve, ERA5_REQUEST_PACING_MS[request.resolution]),
        );
    }
    if (request.resolution === "hourly")
      hourlyGroups.push(
        (times ?? []).flatMap((timestamp, index) =>
          validWeight[index] > 0 &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(timestamp)
            ? [
                {
                  timestamp,
                  precipitationMm: weightedSum[index] / validWeight[index],
                  qc: "online provider hourly value",
                },
              ]
            : [],
        ),
      );
    else
      dailyGroups.push(
        (times ?? []).flatMap((date, index) =>
          validWeight[index] > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)
            ? [
                {
                  date,
                  precipitationMm: weightedSum[index] / validWeight[index],
                  qc: "online provider daily value",
                },
              ]
            : [],
        ),
      );
  }
  const config = LIVE_SOURCE_CONFIG[request.source],
    sourceLabel = request.source === "era5" ? "ERA5" : "ERA5-Land",
    spatialMethod =
      request.mode === "point"
        ? `Nearest native ${sourceLabel} grid cell returned directly to the browser; ${request.resolution} precipitation retained in UTC`
        : `Overlap-weighted district ${request.resolution} series approximated from ${points.length} spatially representative ${sourceLabel} cells; polygon overlap fractions estimated on a 5×5 sub-grid per candidate cell`,
    metadataBase = {
      source: request.source,
      dataset:
        request.resolution === "hourly"
          ? `${sourceLabel} hourly precipitation`
          : `${sourceLabel} daily precipitation`,
      provider: config.provider,
      providerUrl: config.providerUrl,
      retrievalService: `${config.retrievalService} · direct browser fallback after shared-server throttle`,
      extractionMode: request.mode,
      spatialMethod,
      nativeResolution:
        request.resolution === "hourly"
          ? `${config.nativeResolution}; hourly precipitation totals`
          : `${config.nativeResolution}; hourly precipitation aggregated by the provider to daily totals`,
      requestedStart: request.start,
      requestedEnd: request.end,
      requestedLatitude:
        request.mode === "point" ? request.latitude : undefined,
      requestedLongitude:
        request.mode === "point" ? request.longitude : undefined,
      districtName:
        request.mode === "district" ? request.districtName : undefined,
      districtCode:
        request.mode === "district" ? request.districtCode : undefined,
      boundarySource:
        request.mode === "district" ? request.boundarySource : undefined,
      boundaryVersion:
        request.mode === "district" ? request.boundaryVersion : undefined,
      boundaryValidOn:
        request.mode === "district" ? request.boundaryValidOn : undefined,
      returnedLatitude,
      returnedLongitude,
      candidateGridCells: districtGrid?.candidateCount,
      extractedGridCells: points.length,
      gridSamplingLimited: districtGrid?.limited,
      retrievedAt: new Date().toISOString(),
    };
  if (request.resolution === "hourly") {
    const hourlyRecords = mergeHourlyRecords(hourlyGroups);
    if (!hourlyRecords.length)
      throw new Error(
        `${sourceLabel} returned no usable hourly precipitation values.`,
      );
    const metadata: OnlineExtractionMetadata & {
      temporalResolution: "hourly";
    } = {
      ...metadataBase,
      temporalResolution: "hourly",
      returnedStart: hourlyRecords[0].timestamp,
      returnedEnd: hourlyRecords.at(-1)!.timestamp,
      acceptedRecords: hourlyRecords.length,
    };
    return { status: "complete", progress: 100, hourlyRecords, metadata };
  }
  const records = mergeDailyRecords(dailyGroups);
  if (!records.length)
    throw new Error(
      `${sourceLabel} returned no usable daily precipitation values.`,
    );
  const metadata: OnlineExtractionMetadata & { temporalResolution: "daily" } = {
    ...metadataBase,
    temporalResolution: "daily",
    returnedStart: records[0].date,
    returnedEnd: records.at(-1)!.date,
    acceptedRecords: records.length,
  };
  return { status: "complete", progress: 100, records, metadata };
}

type DirectNasaPowerRequest = Omit<DirectEra5Request, "source">;
type DirectNasaPowerPayload = {
  geometry?: { coordinates?: unknown[] };
  properties?: { parameter?: Record<string, unknown> };
};
async function fetchNasaPowerInBrowser(url: string) {
  const retryable = new Set([429, 502, 503, 504]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url);
    if (response.ok)
      return (await response.json()) as DirectNasaPowerPayload;
    if (!retryable.has(response.status) || attempt === 4)
      throw new Error(`NASA POWER returned HTTP ${response.status}.`);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(10_000, 1000 * 2 ** attempt)),
    );
  }
  throw new Error("NASA POWER did not return a usable response.");
}
async function extractNasaPowerInBrowser(
  request: DirectNasaPowerRequest,
  onProgress: (value: number) => void,
): Promise<OnlineExtractionResponse> {
  if (request.mode === "district" && !request.geometry)
    throw new Error("The selected district polygon is not available.");
  const districtGrid =
    request.mode === "district"
      ? powerDistrictGrid(request.geometry!, 6)
      : null;
  const points: WeightedGridPoint[] = districtGrid?.points ?? [
    {
      latitude: Number(request.latitude),
      longitude: Number(request.longitude),
      weight: 1,
    },
  ];
  const chunks = splitDateRange(request.start, request.end, 10);
  const weightedDates = new Map<
    string,
    { weightedSum: number; validWeight: number }
  >();
  const totalRequests = points.length * chunks.length;
  let completed = 0,
    returnedLatitude: number | undefined,
    returnedLongitude: number | undefined;

  for (const point of points) {
    for (const chunk of chunks) {
      const url = new URL(
        "https://power.larc.nasa.gov/api/temporal/daily/point",
      );
      url.searchParams.set("parameters", "PRECTOTCORR");
      url.searchParams.set("community", "AG");
      url.searchParams.set("longitude", point.longitude.toFixed(4));
      url.searchParams.set("latitude", point.latitude.toFixed(4));
      url.searchParams.set("start", chunk.start.replaceAll("-", ""));
      url.searchParams.set("end", chunk.end.replaceAll("-", ""));
      url.searchParams.set("format", "JSON");
      url.searchParams.set("time-standard", "UTC");
      const payload = await fetchNasaPowerInBrowser(url.toString());
      for (const record of nasaPowerRecords(payload)) {
        const current = weightedDates.get(record.date) ?? {
          weightedSum: 0,
          validWeight: 0,
        };
        current.weightedSum += record.precipitationMm * point.weight;
        current.validWeight += point.weight;
        weightedDates.set(record.date, current);
      }
      if (request.mode === "point") {
        const coordinates = payload.geometry?.coordinates;
        if (Array.isArray(coordinates)) {
          returnedLongitude = Number(coordinates[0]);
          returnedLatitude = Number(coordinates[1]);
        }
      }
      completed += 1;
      onProgress(Math.round((100 * completed) / totalRequests));
      if (completed < totalRequests)
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const records = [...weightedDates.entries()]
    .filter(([, value]) => value.validWeight > 0)
    .map(([date, value]) => ({
      date,
      precipitationMm: value.weightedSum / value.validWeight,
      qc: "NASA POWER provider daily value",
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!records.length)
    throw new Error(
      "NASA POWER returned no usable corrected daily precipitation values.",
    );
  const config = LIVE_SOURCE_CONFIG.power;
  const metadata: OnlineExtractionMetadata & {
    temporalResolution: "daily";
  } = {
    source: "power",
    dataset: config.dataset,
    provider: config.provider,
    providerUrl: config.providerUrl,
    retrievalService: `${config.retrievalService} · direct browser fallback after shared-route failure`,
    temporalResolution: "daily",
    extractionMode: request.mode,
    spatialMethod:
      request.mode === "point"
        ? "NASA POWER point series from the returned MERRA-2 meteorological grid cell; PRECTOTCORR retained in UTC"
        : `Approximate overlap-weighted district mean from ${points.length} representative NASA POWER MERRA-2 grid cells; polygon overlap fractions estimated on a 5×5 sub-grid per candidate cell`,
    nativeResolution: config.nativeResolution,
    requestedStart: request.start,
    requestedEnd: request.end,
    returnedStart: records[0].date,
    returnedEnd: records.at(-1)!.date,
    acceptedRecords: records.length,
    requestedLatitude: request.mode === "point" ? request.latitude : undefined,
    requestedLongitude:
      request.mode === "point" ? request.longitude : undefined,
    districtName:
      request.mode === "district" ? request.districtName : undefined,
    districtCode:
      request.mode === "district" ? request.districtCode : undefined,
    boundarySource:
      request.mode === "district" ? request.boundarySource : undefined,
    boundaryVersion:
      request.mode === "district" ? request.boundaryVersion : undefined,
    boundaryValidOn:
      request.mode === "district" ? request.boundaryValidOn : undefined,
    returnedLatitude,
    returnedLongitude,
    candidateGridCells: districtGrid?.candidateCount,
    extractedGridCells: points.length,
    gridSamplingLimited: districtGrid?.limited,
    retrievedAt: new Date().toISOString(),
  };
  return { status: "complete", progress: 100, records, metadata };
}

type DirectClimateServSource = "chirps" | "imerg" | "imergEarly";
type DirectClimateServRequest = {
  action: "start" | "poll";
  source: DirectClimateServSource;
  mode: "point" | "district";
  start: string;
  end: string;
  latitude?: number;
  longitude?: number;
  geometry?: OnlineGeometry;
  jobs?: OnlineJob[];
  districtName?: string;
  districtCode?: string;
  boundarySource?: string;
  boundaryVersion?: string;
  boundaryValidOn?: string;
};
const DIRECT_CLIMATE_SERV_BASE =
  "https://climateserv.servirglobal.net/api";

async function fetchClimateServInBrowser(
  url: string,
  init?: RequestInit,
  timeoutMs = 45_000,
) {
  const retryable = new Set([429, 502, 503, 504]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      if (response.ok) return response;
      if (!retryable.has(response.status) || attempt === 4)
        throw new Error(`ClimateSERV returned HTTP ${response.status}.`);
    } catch (error) {
      if (attempt === 4) throw error;
    } finally {
      window.clearTimeout(timeout);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(10_000, 1000 * 2 ** attempt)),
    );
  }
  throw new Error("ClimateSERV did not return a usable response.");
}

async function submitClimateServJobInBrowser(
  datatype: number,
  geometry: OnlineGeometry,
  start: string,
  end: string,
) {
  const form = new URLSearchParams({
    datatype: String(datatype),
    begintime: climateServDate(start),
    endtime: climateServDate(end),
    intervaltype: "0",
    operationtype: "5",
    dateType_Category: "default",
    isZip_CurrentDataType: "false",
    geometry: JSON.stringify(geometry),
  });
  const response = await fetchClimateServInBrowser(
    `${DIRECT_CLIMATE_SERV_BASE}/submitDataRequest/`,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: form.toString(),
    },
  );
  const payload: unknown = await response.json();
  const id = Array.isArray(payload) ? String(payload[0] ?? "") : "";
  if (!/^[0-9a-f-]{36}$/i.test(id))
    throw new Error("ClimateSERV did not return a valid processing job.");
  return id;
}

async function climateServInBrowser(
  request: DirectClimateServRequest,
  onProgress: (value: number) => void,
): Promise<OnlineExtractionResponse> {
  const config = LIVE_SOURCE_CONFIG[request.source];
  if (!("climateServDatatype" in config))
    throw new Error("This source is not available through ClimateSERV.");
  if (request.action === "start") {
    if (request.mode === "district" && !request.geometry)
      throw new Error("The selected district polygon is not available.");
    const geometry =
      request.mode === "point"
        ? pointBufferGeometry(
            Number(request.longitude),
            Number(request.latitude),
          )
        : request.geometry!;
    const chunks = splitDateRange(
      request.start,
      request.end,
      request.source === "chirps" ? 10 : 5,
    );
    const jobs: OnlineJob[] = [];
    for (const chunk of chunks) {
      const id = await submitClimateServJobInBrowser(
        config.climateServDatatype,
        geometry,
        chunk.start,
        chunk.end,
      );
      jobs.push({ id, ...chunk });
      onProgress(Math.round((10 * jobs.length) / chunks.length));
      if (jobs.length < chunks.length)
        await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return {
      status: "processing",
      progress: 10,
      jobs,
      message: `${jobs.length} provider job${jobs.length === 1 ? "" : "s"} submitted directly from this browser. Daily statistics are processing.`,
    };
  }

  const jobs = request.jobs ?? [];
  if (
    !jobs.length ||
    jobs.length > 16 ||
    jobs.some((job) => !/^[0-9a-f-]{36}$/i.test(job.id))
  )
    throw new Error("The provider job list is missing or invalid.");
  const progressValues: number[] = [];
  for (const job of jobs) {
    const url = new URL(
      `${DIRECT_CLIMATE_SERV_BASE}/getDataRequestProgress/`,
    );
    url.searchParams.set("id", job.id);
    const response = await fetchClimateServInBrowser(
      url.toString(),
      undefined,
      25_000,
    );
    const payload: unknown = await response.json();
    const value = Number(Array.isArray(payload) ? payload[0] : payload);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(
        "ClimateSERV reported a failed processing job. Retry once, shorten the record, or use IMERG Early, CHIRPS, ERA5-Land or NASA POWER.",
      );
    progressValues.push(Math.min(100, value));
  }
  const progress = Math.round(
    progressValues.reduce((sum, value) => sum + value, 0) /
      progressValues.length,
  );
  onProgress(progress);
  if (progressValues.some((value) => value < 100))
    return {
      status: "processing",
      progress,
      jobs,
      message: `Provider processing is ${progress}% complete through the direct-browser route.`,
    };

  const recordGroups: DailyRecord[][] = [];
  for (const job of jobs) {
    const url = new URL(`${DIRECT_CLIMATE_SERV_BASE}/getDataFromRequest/`);
    url.searchParams.set("id", job.id);
    const response = await fetchClimateServInBrowser(
      url.toString(),
      undefined,
      60_000,
    );
    recordGroups.push(climateServRecords(await response.json()));
  }
  const records = mergeDailyRecords(recordGroups);
  if (!records.length)
    throw new Error(
      "ClimateSERV completed the jobs but returned no usable non-negative precipitation values.",
    );
  const metadata: OnlineExtractionMetadata & {
    temporalResolution: "daily";
  } = {
    source: request.source,
    dataset: config.dataset,
    provider: config.provider,
    providerUrl: config.providerUrl,
    retrievalService: `${config.retrievalService} · direct browser fallback after shared-route failure`,
    temporalResolution: "daily",
    extractionMode: request.mode,
    spatialMethod:
      request.mode === "district"
        ? "Daily polygon mean calculated by ClimateSERV for the submitted district geometry"
        : "Daily ClimateSERV polygon statistic from a 0.002° square centred on the requested coordinate",
    nativeResolution: config.nativeResolution,
    requestedStart: request.start,
    requestedEnd: request.end,
    returnedStart: records[0].date,
    returnedEnd: records.at(-1)!.date,
    acceptedRecords: records.length,
    requestedLatitude:
      request.mode === "point" ? request.latitude : undefined,
    requestedLongitude:
      request.mode === "point" ? request.longitude : undefined,
    districtName:
      request.mode === "district" ? request.districtName : undefined,
    districtCode:
      request.mode === "district" ? request.districtCode : undefined,
    boundarySource:
      request.mode === "district" ? request.boundarySource : undefined,
    boundaryVersion:
      request.mode === "district" ? request.boundaryVersion : undefined,
    boundaryValidOn:
      request.mode === "district" ? request.boundaryValidOn : undefined,
    providerJobs: jobs.length,
    retrievedAt: new Date().toISOString(),
  };
  return { status: "complete", progress: 100, records, metadata };
}

type DirectEra5TemperatureRequest = {
  mode: "point" | "district";
  startYear: number;
  endYear: number;
  latitude?: number;
  longitude?: number;
  geometry?: OnlineGeometry;
};
async function extractEra5TemperatureInBrowser(
  request: DirectEra5TemperatureRequest,
  onProgress: (value: number) => void,
): Promise<Extract<OnlineCovariateResponse, { status: "complete" }>> {
  if (request.mode === "district" && !request.geometry)
    throw new Error("The selected district polygon is not available.");
  const districtGrid =
      request.mode === "district"
        ? era5DistrictGrid(request.geometry!, 48)
        : null,
    points: WeightedGridPoint[] = districtGrid?.points ?? [
      {
        latitude: Number(request.latitude),
        longitude: Number(request.longitude),
        weight: 1,
      },
    ],
    chunks = splitDateRange(
      `${request.startYear}-01-01`,
      `${request.endYear}-12-31`,
      20,
    ),
    batchSize = 8,
    totalBatches = chunks.length * Math.ceil(points.length / batchSize),
    datedValues: Array<{ date: string; value: number }> = [];
  let completed = 0,
    sourceRecords = 0;
  for (const chunk of chunks) {
    let times: string[] | null = null,
      weightedSum: number[] = [],
      validWeight: number[] = [];
    for (let offset = 0; offset < points.length; offset += batchSize) {
      const batch = points.slice(offset, offset + batchSize),
        url = new URL("https://archive-api.open-meteo.com/v1/archive");
      url.searchParams.set(
        "latitude",
        batch.map((point) => point.latitude.toFixed(4)).join(","),
      );
      url.searchParams.set(
        "longitude",
        batch.map((point) => point.longitude.toFixed(4)).join(","),
      );
      url.searchParams.set("start_date", chunk.start);
      url.searchParams.set("end_date", chunk.end);
      url.searchParams.set(
        "daily",
        "temperature_2m_max,temperature_2m_min",
      );
      url.searchParams.set("models", "era5");
      url.searchParams.set("timezone", "UTC");
      url.searchParams.set("cell_selection", "nearest");
      const payload = await fetchOpenMeteoInBrowser(url.toString()),
        locations = (
          Array.isArray(payload) ? payload : [payload]
        ) as DirectOpenMeteoPayload[];
      if (locations.length !== batch.length)
        throw new Error(
          "ERA5 temperature retrieval returned an unexpected number of grid-cell series.",
        );
      for (let index = 0; index < locations.length; index += 1) {
        const location = locations[index],
          locationTimes = location.daily?.time ?? [],
          maxima = location.daily?.temperature_2m_max ?? [],
          minima = location.daily?.temperature_2m_min ?? [];
        if (!times) {
          times = locationTimes;
          weightedSum = Array(locationTimes.length).fill(0);
          validWeight = Array(locationTimes.length).fill(0);
        }
        if (
          locationTimes.length !== times.length ||
          locationTimes.some((time, item) => time !== times![item])
        )
          throw new Error(
            "ERA5 temperature retrieval returned inconsistent dates across grid cells.",
          );
        const weight = batch[index].weight;
        for (let item = 0; item < locationTimes.length; item += 1) {
          const maximum = Number(maxima[item]),
            minimum = Number(minima[item]);
          if (
            Number.isFinite(maximum) &&
            Number.isFinite(minimum) &&
            maximum >= minimum &&
            minimum > -100 &&
            maximum < 80
          ) {
            weightedSum[item] += ((maximum + minimum) / 2) * weight;
            validWeight[item] += weight;
            sourceRecords += 1;
          }
        }
      }
      completed += 1;
      onProgress(Math.round((100 * completed) / totalBatches));
      if (completed < totalBatches)
        await new Promise((resolve) => setTimeout(resolve, 300));
    }
    for (let item = 0; item < (times?.length ?? 0); item += 1)
      if (
        validWeight[item] > 0 &&
        /^\d{4}-\d{2}-\d{2}$/.test(times![item])
      )
        datedValues.push({
          date: times![item],
          value: weightedSum[item] / validWeight[item],
        });
  }
  const values = annualMeanFromDatedValues(datedValues);
  if (!values.length)
    throw new Error(
      "ERA5 returned no complete annual temperature values for the requested period.",
    );
  const config = ONLINE_COVARIATE_CONFIG.temperature,
    metadata: OnlineCovariateMetadata = {
      source: "temperature",
      dataset: config.dataset,
      provider: config.provider,
      providerUrl: config.providerUrl,
      retrievalService: `${config.retrievalService} · direct browser fallback after shared-server throttle`,
      spatialScope:
        request.mode === "district"
          ? "Selected district"
          : `Requested point ${Number(request.latitude).toFixed(5)}, ${Number(request.longitude).toFixed(5)}`,
      spatialMethod:
        request.mode === "district"
          ? `Approximate overlap-weighted mean of ${points.length} representative ERA5 cells; overlap fractions estimated on a 5×5 sub-grid`
          : "Nearest ERA5 grid cell returned by the retrieval service",
      nativeResolution:
        "0.25° ERA5; daily midrange calculated from daily Tmax and Tmin",
      requestedStartYear: request.startYear,
      requestedEndYear: request.endYear,
      returnedStartYear: values[0].year,
      returnedEndYear: values.at(-1)!.year,
      sourceRecords,
      acceptedAnnualValues: values.length,
      completenessRule:
        "Calendar-year mean retained when at least 90% of daily midrange values are available",
      limitations:
        "Annual temperature is the mean daily midrange, (Tmax + Tmin)/2, not an hourly arithmetic mean. District weights approximate polygon overlap.",
      retrievedAt: new Date().toISOString(),
    },
    covariate: AnnualCovariate = {
      id: "online-era5-temperature",
      label: `ERA5 annual 2 m temperature · ${request.mode === "district" ? "district" : "point"}`,
      kind: "temperature",
      units: "°C",
      physicalRationale:
        "Air temperature is physically related to atmospheric moisture-holding capacity, but support for an extreme-rainfall model must be demonstrated by the full comparison diagnostics.",
      source: "",
      physicallyPlausible: true,
      values,
    };
  covariate.source = onlineCovariateSourceText(metadata);
  return { status: "complete", progress: 100, covariate, metadata };
}

const refs = [
  [
    "World Meteorological Organization. (n.d.). Climate data: quality control, management and homogenization guidance.",
    "https://community.wmo.int/site/knowledge-hub/programmes-and-initiatives/climate-services/climate-data",
  ],
  [
    "Hosking, J. R. M. (1990). L-moments: Analysis and estimation of distributions using linear combinations of order statistics. Journal of the Royal Statistical Society: Series B, 52(1), 105–124.",
    "https://doi.org/10.1111/j.2517-6161.1990.tb01775.x",
  ],
  [
    "Koutsoyiannis, D., Kozonis, D., & Manetas, A. (1998). A mathematical framework for studying rainfall intensity-duration-frequency relationships. Journal of Hydrology, 206(1–2), 118–135.",
    "https://doi.org/10.1016/S0022-1694(98)00097-3",
  ],
  [
    "Katz, R. W., Parlange, M. B., & Naveau, P. (2002). Statistics of extremes in hydrology. Advances in Water Resources, 25(8–12), 1287–1304.",
    "https://doi.org/10.1016/S0309-1708(02)00056-8",
  ],
  [
    "Mann, H. B. (1945). Nonparametric tests against trend. Econometrica, 13(3), 245–259.",
    "https://doi.org/10.2307/1907187",
  ],
  [
    "Cheng, L., & AghaKouchak, A. (2014). Nonstationary precipitation intensity-duration-frequency curves for infrastructure design in a changing climate. Scientific Reports, 4, 7093.",
    "https://doi.org/10.1038/srep07093",
  ],
  [
    "Vinnarasi, R., & Dhanya, C. T. (2021). Time-varying intensity-duration-frequency relationship through climate-informed covariates. Journal of Hydrology.",
    "https://consensus.app/papers/timevarying-intensitydurationfrequency-relationship-vinnarasi-dhanya/28c8c8cb9d6d5eb9bc7ca457c596f36c/",
  ],
  [
    "Aksu, H., Aksoy, H., Çetin, M., Yaldiz, S. G., Yildirim, I., & Alsenjar, O. (2024). Development of rainfall intensity-duration-frequency curves under nonstationary conditions. Sustainable Water Resources Management, 11.",
    "https://consensus.app/papers/development-of-rainfall-intensitydurationfrequency-aksu-aksoy/13eb671d58b25e0a99b6fb12daedd111/",
  ],
  [
    "Cannon, A. J., Sobie, S. R., & Murdock, T. Q. (2015). Bias correction of GCM precipitation by quantile mapping: How well do methods preserve changes in quantiles and extremes? Journal of Climate, 28(17), 6938–6959.",
    "https://consensus.app/papers/bias-correction-of-gcm-precipitation-by-quantile-mapping-cannon-sobie/4b9f7f4f329a5bca88b8b44219106a7b/?utm_source=chatgpt",
  ],
  [
    "Sarhadi, A., & Soulis, E. D. (2017). Time-varying extreme rainfall intensity-duration-frequency curves in a changing climate. Geophysical Research Letters, 44, 2454–2463.",
    "https://doi.org/10.1002/2016GL072201",
  ],
  [
    "Agilan, V., & Umamahesh, N. V. (2017). What are the best covariates for developing non-stationary rainfall intensity-duration-frequency relationships? Advances in Water Resources, 101, 11–22.",
    "https://doi.org/10.1016/j.advwatres.2016.12.016",
  ],
  [
    "Kim, H., Kim, S., Shin, H., & Heo, J. (2017). Appropriate model selection methods for nonstationary generalized extreme value models. Journal of Hydrology, 547, 557–574.",
    "https://doi.org/10.1016/j.jhydrol.2017.02.005",
  ],
  [
    "Agilan, V., & Umamahesh, N. V. (2018). Covariate and parameter uncertainty in non-stationary rainfall IDF curve. International Journal of Climatology, 38(1), 365–383.",
    "https://doi.org/10.1002/joc.5181",
  ],
  [
    "Wehner, M. F., Duffy, M. L., Risser, M., Paciorek, C. J., Stone, D., & Pall, P. (2024). On the uncertainty of long-period return values of extreme daily precipitation. Frontiers in Climate.",
    "https://consensus.app/papers/on-the-uncertainty-of-longperiod-return-values-of-extreme-wehner-duffy/8bc9300de4185837a428ab89b955c32b/?utm_source=chatgpt",
  ],
  [
    "Patel, R. N., & Schneider, T. (2026). How short climate records affect GEV-based estimates of rare event probabilities. Environmental Research: Climate, 5.",
    "https://consensus.app/papers/how-short-climate-records-affect-gevbased-estimates-of-patel-schneider/a4ee9bde69385e70bf808afd6d42026d/?utm_source=chatgpt",
  ],
  [
    "Hussain, A., et al. (2023). Assessment of precipitation extremes and their association with NDVI, monsoon and oceanic indices over Pakistan. Atmospheric Research.",
    "https://consensus.app/papers/assessment-of-precipitation-extremes-and-their-hussain-hussain/62a22a091b2a5a0dae0febf6bdbf664e/?utm_source=chatgpt",
  ],
  [
    "Masood, M. U., et al. (2023). The effect of the El Niño Southern Oscillation on precipitation extremes in the Hindu Kush Mountains Range. Water, 15(24), 4311.",
    "https://doi.org/10.3390/w15244311",
  ],
  [
    "U.S. Geological Survey. (2018). Guidelines for determining flood flow frequency—Bulletin 17C. Techniques and Methods 4-B5.",
    "https://pubs.usgs.gov/publication/tm4B5",
  ],
  [
    "United Nations Office for the Coordination of Humanitarian Affairs. Pakistan administrative boundaries (COD-AB). Humanitarian Data Exchange.",
    "https://data.humdata.org/dataset/cod-ab-pak",
  ],
  [
    "geoBoundaries. Pakistan ADM2/ADM3 open administrative boundary API.",
    "https://www.geoboundaries.org/api.html",
  ],
  [
    "Pakistan Bureau of Statistics. Geographic Information System resources.",
    "https://www.pbs.gov.pk/gis/",
  ],
  [
    "Pakistan Meteorological Department. Climate-data request services.",
    "https://rmcpunjab.pmd.gov.pk/Services-Climate-Requests.php",
  ],
  [
    "NASA Center for Climate Simulation. NASA Earth Exchange Global Daily Downscaled Projections (NEX-GDDP-CMIP6).",
    "https://www.nccs.nasa.gov/data-collections/nex-gddp-cmip6/",
  ],
  [
    "Copernicus Climate Change Service. ERA5 hourly data on single levels from 1940 to present.",
    "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels",
  ],
  [
    "Open-Meteo. Historical Weather API: ERA5 and ERA5-Land reanalysis access.",
    "https://open-meteo.com/en/docs/historical-weather-api",
  ],
  [
    "UCSB Climate Hazards Center. CHIRPS precipitation data.",
    "https://www.chc.ucsb.edu/data/chirps",
  ],
  [
    "Shahid, M., et al. (2021). Assessing the potential and hydrological usefulness of CHIRPS precipitation dataset over a complex topography in Pakistan. Hydrological Sciences Journal.",
    "https://consensus.app/papers/assessing-the-potential-and-hydrological-usefulness-of-shahid-rahman/d652cfab06965d018402a440f9624ecd/?utm_source=chatgpt",
  ],
  [
    "Ansari, S., & Grossi, G. (2022). Performance evaluation of raw and bias-corrected ERA5 precipitation for extreme-event analysis in the Upper Jhelum Basin. Theoretical and Applied Climatology.",
    "https://consensus.app/papers/performance-evaluation-of-raw-and-biascorrected-era5-ansari-grossi/e592c4bf49125f86bc5ecb3ecdddd69d/?utm_source=chatgpt",
  ],
  [
    "SERVIR. ClimateSERV developer API for point and polygon climate-data statistics.",
    "https://climateserv.servirglobal.net/develop-api",
  ],
  [
    "NASA Global Precipitation Measurement Mission. Integrated Multi-satellitE Retrievals for GPM (IMERG).",
    "https://gpm.nasa.gov/data/imerg",
  ],
  [
    "NASA Global Precipitation Measurement Mission. Precipitation data directory and archive-access requirements.",
    "https://gpm.nasa.gov/data/directory",
  ],
  [
    "Copernicus Climate Change Service. CMIP6 climate projections catalogue.",
    "https://cds.climate.copernicus.eu/datasets/projections-cmip6?tab=overview",
  ],
  [
    "Intergovernmental Panel on Climate Change. (2021). Climate Change 2021: The Physical Science Basis, Chapter 4—Future Global Climate.",
    "https://www.ipcc.ch/report/ar6/wg1/chapter/chapter-4/",
  ],
  [
    "Asian Infrastructure Investment Bank. (2025). Climate Change Assessment Report: Rawalpindi–Hassanabdal project, Pakistan.",
    "https://www.aiib.org/en/projects/details/2025/_download/Pakistan/Climate-Change-Assessment-Report-Rawalpindi-Hassanabdal.pdf",
  ],
  [
    "Research for Community Access Partnership. (2019). Low Volume Rural Road Manual, Part C: Hydrology, Drainage and Roadside Stabilisation.",
    "https://www.research4cap.org/wp-content/uploads/ral/SLRA-2019-ManualforLVR-PartC-200416-compressed.pdf",
  ],
  [
    "International Commission on Large Dams. (2012). Integrated Flood Risk Management, Bulletin 156.",
    "https://www.icoldchile.cl/boletines/156.pdf",
  ],
  [
    "World Bank. (2021). Good Practice Note on Dam Safety.",
    "https://documents1.worldbank.org/curated/en/099600009232224065/pdf/P1562430405c5606b0bca307068cf45dcc9.pdf",
  ],
  [
    "U.S. Department of Agriculture, Forest Service. Tools for Analysis: Rational peak flow and metric Kirpich time-of-concentration equation.",
    "https://research.fs.usda.gov/download/treesearch/32878.pdf",
  ],
  [
    "Heberger, M. (2022). Global Watersheds web application and watershed/river API documentation.",
    "https://mghydro.com/watersheds/help.html",
  ],
  [
    "U.S. Army Corps of Engineers, Hydrologic Engineering Center. HEC-HMS basin characteristics: longest flow path and 10–85% slope.",
    "https://www.hec.usace.army.mil/confluence/hmsdocs/hmstrm/geographic-information-system-gis/basin-characteristics",
  ],
  [
    "Open-Meteo. Elevation API using Copernicus DEM GLO-90 terrain elevations.",
    "https://open-meteo.com/en/docs/elevation-api",
  ],
];
const infrastructureGuidance = [
  {
    period: "2–5 years",
    aep: "50%–20%",
    infrastructure:
      "Minor local drainage, small roadside drains and nuisance-flood conveyance",
    use: "Frequent-service screening; verify municipal criteria and allowable surface flooding",
    basis: "International road-drainage practice; project authority governs",
  },
  {
    period: "10 years",
    aep: "10%",
    infrastructure: "Rural road drains and minor culverts",
    use: "Common minimum for minor rural crossings",
    basis: "Low Volume Rural Road Manual, Part C (2019)",
  },
  {
    period: "25 years",
    aep: "4%",
    infrastructure: "Urban road drainage and culvert hydraulic design",
    use: "Pakistan project example uses 25-year design for culverts",
    basis: "AIIB Rawalpindi–Hassanabdal assessment (2025)",
  },
  {
    period: "50 years",
    aep: "2%",
    infrastructure: "Culvert capacity and resilience check",
    use: "Check that the structure passes the larger event without unacceptable damage",
    basis: "AIIB Rawalpindi–Hassanabdal assessment (2025)",
  },
  {
    period: "100 years",
    aep: "1%",
    infrastructure:
      "Bridges, major crossings, floodplain development and low-hazard dam screening",
    use: "Pakistan project example uses 100 years for bridges; consequence assessment remains essential",
    basis: "AIIB (2025); ICOLD Bulletin 156",
  },
  {
    period: "250–500 years",
    aep: "0.4%–0.2%",
    infrastructure:
      "High-consequence urban or industrial flood protection and critical-infrastructure sensitivity checks",
    use: "Use as an upper-tail stress test only where the owner adopts a risk-based criterion; not a universal design requirement",
    basis: "ICOLD Bulletin 156",
  },
  {
    period: "Beyond 500 years / PMF",
    aep: "<0.2% / not assigned",
    infrastructure: "High- and extreme-hazard dams",
    use: "The atlas stops at 500 years and is not sufficient for high-hazard dam design",
    basis: "World Bank Good Practice Note on Dam Safety (2021)",
  },
];
const glossary = [
  [
    "IDF",
    "Intensity–Duration–Frequency: rainfall intensity for a stated storm duration and annual chance of exceedance.",
  ],
  [
    "Return period and AEP",
    "A T-year return period means a 1/T annual exceedance probability (AEP). It is an annual chance, not a promise that the event occurs once every T years.",
  ],
  [
    "Annual-maxima series",
    "The largest qualifying rainfall accumulation retained from each eligible year and used for frequency fitting.",
  ],
  [
    "Stationary model",
    "The fitted rainfall distribution is assumed not to change with year or another explanatory variable.",
  ],
  [
    "Nonstationary model",
    "At least one fitted distribution parameter changes with a stated explanatory variable. This report uses a time-varying GEV location when that option is selected.",
  ],
  [
    "Reference year",
    "The year at which a time-varying model is evaluated. The automatic value is the mean year of the eligible annual maxima; it is neither an extra observation nor a forecast.",
  ],
  [
    "Derived duration",
    "A duration calculated from a coarser observed interval by a stated scaling equation. It was not measured directly at that duration.",
  ],
  [
    "95% bootstrap interval",
    "A range from repeated resampling of eligible annual maxima. It represents sampling variation under the fitted workflow, not every source of uncertainty.",
  ],
] as const;
const REPORT_EXPORT_CSS = `
@page{size:A4;margin:18mm 15mm 18mm;@bottom-right{content:"Page " counter(page) " of " counter(pages);color:#6a7d86;font:7.5pt Arial,sans-serif}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#fff;color:#18384c;font:10.5pt/1.55 Arial,Helvetica,sans-serif}.report{max-width:190mm;margin:0 auto;padding:12mm}.report h1,.report h2,.report h3{font-family:Georgia,"Times New Roman",serif;color:#173b5c}.report h1{font-size:27pt;line-height:1.08}.report h2{margin:8mm 0 4mm;padding-bottom:2mm;border-bottom:1px solid #c9d9dc;font-size:17pt}.report h2 span{display:inline-block;min-width:12mm;color:#0f766e}.report h3{margin:5mm 0 2mm;font-size:12.5pt}.report p,.report li{color:#405966}.eyebrow{text-transform:uppercase;letter-spacing:.12em;color:#0f766e;font-size:8pt;font-weight:800}.print-header,.print-footer{display:none}.report-cover{min-height:245mm;display:flex;flex-direction:column;justify-content:space-between;padding:18mm;background:linear-gradient(145deg,#f5fbfb,#e9f7f5);border-top:8mm solid #0f766e}.report-brand{display:flex;align-items:center;gap:4mm;color:#173b5c;font:700 15pt Georgia,serif}.report-brand-mark{display:grid;place-items:center;width:12mm;height:12mm;border-radius:50%;background:#0f766e;color:#fff}.report-cover-title{max-width:150mm}.report-cover-title h1{margin:3mm 0}.report-cover-subtitle{font-size:13pt;color:#54707d}.report-classification{display:inline-block;margin-top:6mm;padding:3mm 4mm;border-left:1.5mm solid #0f766e;background:#fff;color:#173b5c;font-weight:700}.document-control{margin-top:10mm}.document-control dl{display:grid;grid-template-columns:1fr 1fr;margin:0;border-top:1px solid #bdd2d5}.document-control div{padding:3mm 0;border-bottom:1px solid #cfdddf}.document-control dt{font-size:7.5pt;text-transform:uppercase;letter-spacing:.07em;color:#647b86}.document-control dd{margin:1mm 0 0;font-weight:700}.report-contents{padding:7mm 0 11mm}.report-contents ol{display:grid;grid-template-columns:1fr 1fr;gap:2mm 10mm;padding:0;list-style:none;counter-reset:item}.report-contents li{counter-increment:item;border-bottom:1px solid #dbe5e7;padding:2.5mm 0}.report-contents li::before{content:counter(item) ".0";display:inline-block;width:12mm;color:#0f766e;font-weight:800}.report-contents a{color:#294958;text-decoration:none}.report-status,.report-summary{padding:4mm;border-radius:2mm;background:#edf8f7;border-left:1.2mm solid #0f766e}.report-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm;margin:5mm 0}.report-kpis>div{padding:4mm;border:1px solid #d4e2e4;border-radius:2mm;background:#f7fbfb}.report-kpis span{display:block;font-size:7.5pt;text-transform:uppercase;color:#657a84}.report-kpis strong{display:block;color:#0f766e;font-size:15pt}.report-kpis small{color:#657a84}.report-objectives,.method-flow{display:grid;grid-template-columns:repeat(2,1fr);gap:3mm}.report-objectives>div,.method-flow>div{padding:4mm;border:1px solid #d5e3e5;border-radius:2mm;background:#fbfdfd}.method-flow{grid-template-columns:repeat(4,1fr);margin:4mm 0}.method-flow span{display:block;color:#0f766e;font-weight:800}.report-table-wrap{overflow:visible;margin:5mm 0}table{width:100%;border-collapse:collapse;font-size:8.5pt}caption{text-align:left;padding:3mm;background:#eaf7f6;color:#0f766e;font-weight:800}th,td{padding:2.2mm;border:1px solid #d9e3e5;text-align:left;vertical-align:top}th{color:#0f766e;text-transform:uppercase;font-size:7.5pt}td{text-align:center}tbody th{text-align:left;color:#173b5c}.report-source-table th{width:20%}.report-chart{margin:5mm 0;border:1px solid #d3e0e2;border-radius:2mm;overflow:hidden}.report-chart .chartbox{padding:2mm}.report-chart .chart-title{display:flex;justify-content:space-between;padding:3mm;background:#eef8f8}.report-chart svg{width:100%;height:auto}.report-chart figcaption{padding:3mm;background:#f7fbfb;color:#526c78;text-align:center;font-size:8pt}.methodology-steps li{margin-bottom:2.5mm}.equation-grid{display:grid;grid-template-columns:1fr 1fr;gap:3mm}.equation-grid p{margin:0;padding:3mm;border:1px solid #d5e3e5;border-radius:2mm;background:#f7fbfb}.equation-grid strong,.equation-grid code,.equation-grid small{display:block}.equation-grid code{margin:1.5mm 0;font:10pt Georgia,serif;color:#173b5c}.equation-grid small{color:#607681}.report-note,.limitations{padding:4mm;background:#fff9ed;border-left:1.2mm solid #b87416}.report-reference-list{padding-left:8mm}.report-reference-list li{margin-bottom:3mm;padding-left:2mm}.report-reference-list a{color:#0f766e;overflow-wrap:anywhere}.report-actions{display:none}
@media(max-width:700px){.report{padding:5mm}.report-cover{min-height:auto;padding:8mm}.document-control dl,.report-contents ol,.report-kpis,.report-objectives,.method-flow,.equation-grid{grid-template-columns:1fr}.report-table-wrap{overflow:auto}.report-idf-table{min-width:175mm}}
@media print{body{background:#fff}.report{max-width:none;margin:0;padding:0}.report-cover{break-after:page}.report-contents{break-after:page}.section-break{break-before:page}.report-section h2,.report-section h3,caption{break-after:avoid}.report-chart,.report-kpis,.equation-grid p{break-inside:avoid}.report-table-wrap{overflow:visible}table{break-inside:auto}tr{break-inside:avoid}.print-header,.print-footer{display:block;position:fixed;left:0;right:0;color:#6a7d86;font-size:7.5pt}.print-header{top:-11mm;border-bottom:.2mm solid #cbdadd;padding-bottom:2mm}.print-footer{bottom:-11mm;border-top:.2mm solid #cbdadd;padding-top:2mm}.report-chart svg{max-height:125mm}.report-idf-table{font-size:7.5pt}.report-cover h1{font-size:25pt}a{color:inherit;text-decoration:none}}
.evidence-classes{display:grid;grid-template-columns:repeat(3,1fr);gap:3mm;margin:4mm 0}.evidence-classes>div{padding:4mm;border:1px solid #d5e3e5;border-top:1.5mm solid #0f766e;border-radius:2mm;background:#fbfdfd}.evidence-classes>div:nth-child(2){border-top-color:#b87416}.evidence-classes>div:nth-child(3){border-top-color:#647b86}.evidence-classes strong,.evidence-classes span{display:block}.evidence-classes span{margin-top:1mm;color:#607681;font-size:8pt}
@media(max-width:700px){.evidence-classes{grid-template-columns:1fr}}
@media print{.evidence-classes>div{break-inside:avoid}}
`;
const allDistricts = Object.values(DISTRICTS_BY_REGION).flat();
function save(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}
function chartPng() {
  const svg = document.querySelector("#idf-svg") as SVGElement | null;
  if (!svg) return;
  const img = new Image(),
    url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(svg)], {
        type: "image/svg+xml",
      }),
    );
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = 1400;
    c.height = 800;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);
    c.toBlob((b) => b && save(b, "idf-curves.png"), "image/png");
    URL.revokeObjectURL(url);
  };
  img.src = url;
}
function precipitationPlotPng() {
  const svg = document.querySelector(
    "#precipitation-series-svg",
  ) as SVGElement | null;
  if (!svg) return;
  const img = new Image(),
    url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(svg)], {
        type: "image/svg+xml",
      }),
    );
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1600;
    canvas.height = 760;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => blob && save(blob, "retrieved-precipitation-series.png"),
      "image/png",
    );
    URL.revokeObjectURL(url);
  };
  img.src = url;
}
function precipitationTimestampLabel(
  timestamp: string,
  interval: PrecipitationPlotInterval,
  resolution: OnlineTemporalResolution,
) {
  const months = [
      "Jan",
      "Feb",
      "Mar",
      "Apr",
      "May",
      "Jun",
      "Jul",
      "Aug",
      "Sep",
      "Oct",
      "Nov",
      "Dec",
    ],
    year = timestamp.slice(0, 4),
    month = months[Math.max(0, Number(timestamp.slice(5, 7)) - 1)] ?? "",
    day = timestamp.slice(8, 10),
    time = timestamp.slice(11, 16);
  if (interval === "annual") return year;
  if (interval === "annual-maxima") return `${day} ${month} ${year}`;
  if (interval === "monthly") return `${month} ${year}`;
  if (interval === "daily" || resolution === "daily")
    return `${day} ${month} ${year}`;
  return `${day} ${month} ${year} ${time} UTC`;
}
function PrecipitationSeriesChart({
  records,
  resolution,
  interval,
  dataset,
  location,
}: {
  records: PrecipitationPlotRecord[];
  resolution: OnlineTemporalResolution;
  interval: PrecipitationPlotInterval;
  dataset: string;
  location: string;
}) {
  const aggregated = aggregatePrecipitationForPlot(records, interval),
    plotted = peakPreservingPrecipitationPlot(aggregated),
    reduced = plotted.length < aggregated.length,
    width = 980,
    height = 430,
    margin = { left: 78, right: 30, top: 30, bottom: 72 },
    plotWidth = width - margin.left - margin.right,
    plotHeight = height - margin.top - margin.bottom,
    rawMaximum = aggregated.reduce(
      (maximumValue, point) =>
        Math.max(maximumValue, point.precipitationMm),
      0.1,
    ),
    magnitude = 10 ** Math.floor(Math.log10(rawMaximum)),
    normalizedMaximum = rawMaximum / magnitude,
    step =
      normalizedMaximum <= 1
        ? 1
        : normalizedMaximum <= 2
          ? 2
          : normalizedMaximum <= 5
            ? 5
            : 10,
    maximum = step * magnitude,
    yTicks = [0, 0.2, 0.4, 0.6, 0.8, 1].map(
      (fraction) => fraction * maximum,
    ),
    x = (index: number) =>
      margin.left +
      (plotted.length <= 1 ? plotWidth / 2 : (index / (plotted.length - 1)) * plotWidth),
    y = (value: number) =>
      margin.top + (1 - value / maximum) * plotHeight,
    barWidth = Math.max(
      0.8,
      Math.min(14, (plotWidth / Math.max(1, plotted.length)) * 0.76),
    ),
    xTickIndexes = [
      ...new Set(
        [0, 0.2, 0.4, 0.6, 0.8, 1].map((fraction) =>
          Math.round(fraction * Math.max(0, plotted.length - 1)),
        ),
      ),
    ],
    intervalLabel =
      interval === "native"
        ? resolution === "hourly"
          ? "Hourly precipitation"
          : "Daily precipitation"
        : interval === "daily"
          ? "Daily totals"
          : interval === "monthly"
            ? "Monthly totals"
            : interval === "annual"
              ? "Annual totals"
              : "Annual maximum daily precipitation",
    total = records.reduce((sum, record) => sum + record.precipitationMm, 0),
    wetIntervals = records.reduce(
      (count, record) => count + (record.precipitationMm > 0 ? 1 : 0),
      0,
    ),
    peak = aggregated.reduce(
      (current, point) =>
        !current || point.precipitationMm > current.precipitationMm
          ? point
          : current,
      null as (typeof aggregated)[number] | null,
    ),
    formatAmount = (value: number) =>
      value >= 1000
        ? value.toLocaleString(undefined, { maximumFractionDigits: 0 })
        : value.toLocaleString(undefined, {
            minimumFractionDigits: value < 10 ? 1 : 0,
            maximumFractionDigits: value < 10 ? 2 : 1,
          });
  return (
    <div className="precipitation-chart">
      <div className="precipitation-chart-title">
        <div>
          <strong>{dataset}</strong>
          <span>{location}</span>
        </div>
        <span>{intervalLabel} · millimetres per interval</span>
      </div>
      <svg
        id="precipitation-series-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${intervalLabel} time series for ${dataset} at ${location}`}
        style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
      >
        <defs>
          <linearGradient id="precipitation-bars" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#0891b2" />
            <stop offset="1" stopColor="#0f766e" />
          </linearGradient>
          <linearGradient id="precipitation-background" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fbfefe" />
            <stop offset="1" stopColor="#eef8f8" />
          </linearGradient>
        </defs>
        <rect width={width} height={height} rx="10" fill="#ffffff" />
        <rect
          x={margin.left}
          y={margin.top}
          width={plotWidth}
          height={plotHeight}
          rx="5"
          fill="url(#precipitation-background)"
          stroke="#b9cdd2"
        />
        {yTicks.map((tick) => (
          <g key={`precipitation-y-${tick}`}>
            <line
              x1={margin.left}
              x2={width - margin.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? "#9bb3ba" : "#cbdde1"}
              strokeDasharray={tick === 0 ? undefined : "4 4"}
            />
            <text
              x={margin.left - 11}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize="10"
              fontWeight="600"
              fill="#536b77"
            >
              {formatAmount(tick)}
            </text>
          </g>
        ))}
        {plotted.map((point, index) => {
          const top = y(point.precipitationMm),
            label = precipitationTimestampLabel(
              point.timestamp,
              interval,
              resolution,
            );
          return (
            <rect
              key={`${point.timestamp}-${index}`}
              x={x(index) - barWidth / 2}
              y={top}
              width={barWidth}
              height={Math.max(0.5, margin.top + plotHeight - top)}
              rx={barWidth > 3 ? 1.5 : 0}
              fill="url(#precipitation-bars)"
              opacity=".9"
            >
              <title>
                {label}: {formatAmount(point.precipitationMm)} mm
              </title>
            </rect>
          );
        })}
        {xTickIndexes.map((index) => {
          const point = plotted[index];
          if (!point) return null;
          return (
            <g key={`precipitation-x-${index}`}>
              <line
                x1={x(index)}
                x2={x(index)}
                y1={height - margin.bottom}
                y2={height - margin.bottom + 5}
                stroke="#607b86"
              />
              <text
                x={x(index)}
                y={height - margin.bottom + 23}
                textAnchor="middle"
                fontSize="9.5"
                fontWeight="600"
                fill="#536b77"
              >
                {precipitationTimestampLabel(
                  point.timestamp,
                  interval,
                  resolution,
                )}
              </text>
            </g>
          );
        })}
        <text
          x={margin.left + plotWidth / 2}
          y={height - 16}
          textAnchor="middle"
          fontSize="12"
          fontWeight="700"
          fill="#314957"
        >
          Time
        </text>
        <text
          x="19"
          y={margin.top + plotHeight / 2}
          textAnchor="middle"
          transform={`rotate(-90 19 ${margin.top + plotHeight / 2})`}
          fontSize="12"
          fontWeight="700"
          fill="#314957"
        >
          Precipitation (mm per interval)
        </text>
      </svg>
      <div className="precipitation-plot-kpis">
        <div>
          <span>Total precipitation</span>
          <strong>{formatAmount(total)} mm</strong>
          <small>Sum of all accepted source intervals</small>
        </div>
        <div>
          <span>Wet source intervals</span>
          <strong>{wetIntervals.toLocaleString()}</strong>
          <small>{resolution} values above 0 mm</small>
        </div>
        <div>
          <span>Maximum {intervalLabel.toLowerCase()}</span>
          <strong>{peak ? `${formatAmount(peak.precipitationMm)} mm` : "—"}</strong>
          <small>
            {peak
              ? precipitationTimestampLabel(
                  peak.timestamp,
                  interval,
                  resolution,
                )
              : "No accepted value"}
          </small>
        </div>
        <div>
          <span>Plotted periods</span>
          <strong>{aggregated.length.toLocaleString()}</strong>
          <small>{records.length.toLocaleString()} accepted source values</small>
        </div>
      </div>
      <p className="precipitation-plot-note">
        {reduced
          ? `For responsive display, ${aggregated.length.toLocaleString()} intervals are summarized into ${plotted.length.toLocaleString()} peak-preserving bars. The complete retrieved series remains unchanged in the Excel download.`
          : `All ${aggregated.length.toLocaleString()} plotted intervals are shown. The complete retrieved series remains unchanged in the Excel download.`}
      </p>
    </div>
  );
}
function IdfChart({
  rows,
  axis,
  svgId = "idf-svg",
  equationFit = null,
  timeOfConcentrationMinutes = null,
  designReturnPeriod = 10,
  designIntensity = null,
}: {
  rows: ResultRow[];
  axis: "linear" | "log";
  svgId?: string;
  equationFit?: ShermanEquationFit | null;
  timeOfConcentrationMinutes?: number | null;
  designReturnPeriod?: number;
  designIntensity?: number | null;
}) {
  const w = 800,
    h = 668,
    m = { l: 82, r: 118, t: 234, b: 70 },
    plotW = w - m.l - m.r,
    plotH = h - m.t - m.b,
    durations = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440],
    colors = [
      "#2db2cc",
      "#16a39d",
      "#007f88",
      "#2d75d3",
      "#1559ad",
      "#6353b5",
      "#8b3fa1",
      "#7a1f5c",
    ];
  const series = PERIODS.map((T) => {
      const unique = new Map<number, ResultRow>();
      rows
        .filter((r) => r.returnPeriodYears === T && r.durationMinutes <= 1440)
        .forEach((r) => {
          if (!unique.has(r.durationMinutes)) unique.set(r.durationMinutes, r);
        });
      return {
        T,
        rows: [...unique.values()].sort(
          (a, b) => a.durationMinutes - b.durationMinutes,
        ),
      };
    }),
    powerEquationFits = series.map((item) => fitPowerEquation(item.rows, item.T)),
    values = series.flatMap((s) => s.rows.map((r) => r.intensityMmHr)),
    max = Math.max(1, ...values) * 1.08,
    min = Math.max(0.001, Math.min(...values) * 0.84),
    x = (d: number) => m.l + (Math.log10(d / 5) / Math.log10(1440 / 5)) * plotW,
    y = (v: number) =>
      axis === "log"
        ? m.t +
          (1 -
            (Math.log10(Math.max(min, v)) - Math.log10(min)) /
              (Math.log10(max) - Math.log10(min) || 1)) *
            plotH
        : m.t + (1 - v / max) * plotH,
    ticks = [0, 0.2, 0.4, 0.6, 0.8, 1].map((q) =>
      axis === "log"
        ? 10 ** (Math.log10(min) + q * (Math.log10(max) - Math.log10(min)))
        : q * max,
    ),
    formatTick = (t: number) =>
      t < 1 ? t.toFixed(2) : t < 10 ? t.toFixed(1) : t.toFixed(0),
    clipId = `${svgId}-plot`,
    concentrationVisible = Boolean(
      equationFit &&
        timeOfConcentrationMinutes != null &&
        timeOfConcentrationMinutes >= 5 &&
        timeOfConcentrationMinutes <= 1440 &&
        designIntensity != null &&
        designIntensity >= min &&
        designIntensity <= max,
    ),
    concentrationX = timeOfConcentrationMinutes
      ? x(timeOfConcentrationMinutes)
      : m.l,
    concentrationAnchor =
      concentrationX > m.l + plotW * 0.72 ? "end" : "start",
    concentrationLabelX =
      concentrationAnchor === "end" ? concentrationX - 7 : concentrationX + 7;
  return (
    <div className="chartbox">
      <div className="chart-title">
        <strong>Intensity–Duration–Frequency curves</strong>
        <span>5 minutes to 24 hours · 2- to 500-year return periods</span>
      </div>
      <svg
        id={svgId}
        viewBox={`0 0 ${w} ${h}`}
        role="img"
        aria-label="IDF curves with duration on the x axis and rainfall intensity in millimetres per hour on the y axis"
        style={{ fontFamily: "Arial, Helvetica, sans-serif" }}
      >
        <defs>
          <linearGradient id={`${svgId}-bg`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#fbfefe" />
            <stop offset="1" stopColor="#f1f8f9" />
          </linearGradient>
          <clipPath id={clipId}>
            <rect x={m.l} y={m.t} width={plotW} height={plotH} rx="5" />
          </clipPath>
        </defs>
        <rect width={w} height={h} rx="10" fill="#ffffff" />
        <g aria-label="Power trendline equations for all return periods">
          <text x={m.l} y="35" fontSize="9" fontWeight="700" fill="#173b5c">
            Excel-style power trendlines · i = c × tᵖ · t in minutes · i in mm/hour
          </text>
          {series.map((item, index) => {
            const fit = powerEquationFits[index],
              left = m.l + (index % 2) * (plotW / 2 + 4),
              top = 45 + Math.floor(index / 2) * 43;
            return (
              <g key={`equation-${item.T}`} data-return-period={item.T}>
                <rect x={left} y={top} width={plotW / 2 - 4} height="38" rx="5" fill="#f7fbfc" stroke="#c4d7db" />
                <rect x={left} y={top + 5} width="3" height="28" rx="1.5" fill={colors[index]} />
                <text x={left + 10} y={top + 14} fontSize="9" fontWeight="700" fill={colors[index]}>
                  {item.T}-year
                </text>
                {fit ? (
                  <>
                    <text x={left + 64} y={top + 15} fontSize="12" fontWeight="700" fill="#173b5c">
                      {`i = ${fit.coefficient.toFixed(3)}t`}<tspan baselineShift="super" fontSize="9">{fit.exponent.toFixed(3)}</tspan>
                    </text>
                    <text x={left + 64} y={top + 30} fontSize="9.5" fill="#405966">
                      {`R² = ${fit.rSquared.toFixed(4)}`}
                    </text>
                    <title>{`${item.T}-year: ${formatPowerEquation(fit)}; log-space R² = ${fit.rSquared.toFixed(6)}; ${fit.sampleSize} durations`}</title>
                  </>
                ) : (
                  <text x={left + 64} y={top + 24} fontSize="9" fill="#607b86">Requires at least two durations</text>
                )}
              </g>
            );
          })}
          <text x={m.l} y="226" fontSize="8" fill="#607b86">
            R² measures the log–log trendline fit, not the reliability of the rainfall estimate.
          </text>
        </g>
        <rect
          x={m.l}
          y={m.t}
          width={plotW}
          height={plotH}
          rx="5"
          fill={`url(#${svgId}-bg)`}
          stroke="#b9cdd2"
          strokeWidth="1.2"
        />
        {ticks.map((t, i) => (
          <g key={`y-${i}`}>
            <line
              x1={m.l}
              x2={w - m.r}
              y1={y(t)}
              y2={y(t)}
              stroke={i === 0 || i === ticks.length - 1 ? "#b8ccd1" : "#cbdde1"}
              strokeWidth={i === 0 || i === ticks.length - 1 ? 1.15 : 1}
              strokeDasharray={
                i === 0 || i === ticks.length - 1 ? undefined : "4 4"
              }
            />
            <line x1={m.l - 5} x2={m.l} y1={y(t)} y2={y(t)} stroke="#607b86" />
            <text
              x={m.l - 11}
              y={y(t) + 4}
              textAnchor="end"
              fontSize="10"
              fontWeight="600"
              fill="#536b77"
            >
              {formatTick(t)}
            </text>
          </g>
        ))}
        {durations.map((d) => (
          <g key={`x-${d}`}>
            <line
              x1={x(d)}
              x2={x(d)}
              y1={m.t}
              y2={h - m.b}
              stroke="#d6e4e7"
              strokeWidth="1"
              strokeDasharray="3 5"
            />
            <line
              x1={x(d)}
              x2={x(d)}
              y1={h - m.b}
              y2={h - m.b + 5}
              stroke="#607b86"
            />
            <text
              x={x(d)}
              y={h - m.b + 22}
              textAnchor="middle"
              fontSize="9.5"
              fontWeight="600"
              fill="#536b77"
            >
              {d}
            </text>
          </g>
        ))}
        <g clipPath={`url(#${clipId})`}>
          {series.map((s, i) => (
            <g key={s.T}>
              <polyline
                points={s.rows
                  .map((r) => `${x(r.durationMinutes)},${y(r.intensityMmHr)}`)
                  .join(" ")}
                fill="none"
                stroke="#ffffff"
                strokeOpacity=".9"
                strokeWidth={s.T === 500 ? 7 : 6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polyline
                points={s.rows
                  .map((r) => `${x(r.durationMinutes)},${y(r.intensityMmHr)}`)
                  .join(" ")}
                fill="none"
                stroke={colors[i]}
                strokeWidth={s.T === 500 ? 3.8 : 3}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {s.rows.map((r) => (
                <circle
                  key={r.durationMinutes}
                  cx={x(r.durationMinutes)}
                  cy={y(r.intensityMmHr)}
                  r={s.T === 500 ? 4.5 : 4}
                  fill="#ffffff"
                  stroke={colors[i]}
                  strokeWidth="2.2"
                >
                  <title>{`${s.T}-year return period · ${r.durationMinutes} minutes · ${r.intensityMmHr} mm/hour`}</title>
                </circle>
              ))}
            </g>
          ))}
          {concentrationVisible && (
            <>
              <line
                x1={concentrationX}
                x2={concentrationX}
                y1={m.t}
                y2={h - m.b}
                stroke="#b87416"
                strokeWidth="2.5"
                strokeDasharray="7 5"
              />
              <circle
                cx={concentrationX}
                cy={y(designIntensity!)}
                r="6"
                fill="#fff"
                stroke="#b87416"
                strokeWidth="3"
              >
                <title>{`Time of concentration ${timeOfConcentrationMinutes!.toFixed(2)} minutes · ${designReturnPeriod}-year design intensity ${designIntensity!.toFixed(2)} mm/hour`}</title>
              </circle>
            </>
          )}
        </g>
        {concentrationVisible && (
          <g>
            <rect
              x={
                concentrationAnchor === "end"
                  ? concentrationLabelX - 145
                  : concentrationLabelX
              }
              y={m.t + 8}
              width="145"
              height="34"
              rx="6"
              fill="#fff9eb"
              stroke="#d9a45e"
            />
            <text
              x={
                concentrationAnchor === "end"
                  ? concentrationLabelX - 137
                  : concentrationLabelX + 8
              }
              y={m.t + 22}
              fontSize="9"
              fontWeight="800"
              fill="#8a5714"
            >
              {`t₍c₎=${timeOfConcentrationMinutes!.toFixed(2)} min`}
            </text>
            <text
              x={
                concentrationAnchor === "end"
                  ? concentrationLabelX - 137
                  : concentrationLabelX + 8
              }
              y={m.t + 35}
              fontSize="8.5"
              fontWeight="700"
              fill="#6f531f"
            >
              {`${designReturnPeriod}-yr i=${designIntensity!.toFixed(2)} mm/h`}
            </text>
          </g>
        )}
        <line
          x1={m.l}
          x2={w - m.r}
          y1={h - m.b}
          y2={h - m.b}
          stroke="#536b77"
          strokeWidth="1.5"
        />
        <line
          x1={m.l}
          x2={m.l}
          y1={m.t}
          y2={h - m.b}
          stroke="#536b77"
          strokeWidth="1.5"
        />
        <g>
          <rect
            x={w - m.r + 7}
            y={m.t}
            width={106}
            height="194"
            rx="8"
            fill="#f7fbfc"
            stroke="#c4d7db"
          />
          <text
            x={w - m.r + 17}
            y={m.t + 18}
            fontSize="8.5"
            fontWeight="800"
            letterSpacing=".8"
            fill="#607b86"
          >
            RETURN PERIOD
          </text>
          {series.map((s, i) => (
            <g key={`legend-${s.T}`}>
              <line
                x1={w - m.r + 17}
                x2={w - m.r + 43}
                y1={m.t + 38 + i * 20}
                y2={m.t + 38 + i * 20}
                stroke={colors[i]}
                strokeWidth={s.T === 500 ? 3.8 : 3}
                strokeLinecap="round"
              />
              <circle
                cx={w - m.r + 30}
                cy={m.t + 38 + i * 20}
                r="2.8"
                fill="#fff"
                stroke={colors[i]}
                strokeWidth="1.5"
              />
              <text
                x={w - m.r + 50}
                y={m.t + 42 + i * 20}
                fontSize="10"
                fontWeight="700"
                fill={colors[i]}
              >
                {s.T}-year
              </text>
            </g>
          ))}
        </g>
        <text
          x={(m.l + w - m.r) / 2}
          y={h - 15}
          textAnchor="middle"
          fontSize="12.5"
          fontWeight="700"
          fill="#294958"
        >
          Duration (minutes)
        </text>
        <text
          transform={`rotate(-90 21 ${h / 2})`}
          x="21"
          y={h / 2}
          textAnchor="middle"
          fontSize="12.5"
          fontWeight="700"
          fill="#294958"
        >
          Rainfall intensity (mm/hour)
        </text>
        <text x={m.l} y="18" fontSize="9" fontWeight="700" fill="#0f766e">
          IDF · intensity, not rainfall depth
        </text>
      </svg>
    </div>
  );
}

function WatershedGeometryPreview({
  result,
}: {
  result: WatershedGeometryResult;
}) {
  const rings: Position[][] = [];
  const collectRings = (value: unknown): void => {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      Array.isArray(value[0]) &&
      typeof value[0][0] === "number" &&
      typeof value[0][1] === "number"
    ) {
      const ring = value
        .filter(
          (point) =>
            Array.isArray(point) &&
            Number.isFinite(Number(point[0])) &&
            Number.isFinite(Number(point[1])),
        )
        .map(
          (point) => [Number(point[0]), Number(point[1])] as Position,
        );
      if (ring.length >= 3) rings.push(ring);
      return;
    }
    if (Array.isArray(value)) value.forEach(collectRings);
  };
  result.watershed?.features.forEach((feature) => {
    if (
      feature.geometry?.type === "Polygon" ||
      feature.geometry?.type === "MultiPolygon"
    )
      collectRings(feature.geometry.coordinates);
  });
  const points = [...rings.flat(), ...result.coordinates];
  if (!points.length) return null;
  const width = 620,
    height = 300,
    padding = 22,
    longitudes = points.map((point) => point[0]),
    latitudes = points.map((point) => point[1]),
    west = Math.min(...longitudes),
    east = Math.max(...longitudes),
    south = Math.min(...latitudes),
    north = Math.max(...latitudes),
    spanLongitude = Math.max(1e-6, east - west),
    spanLatitude = Math.max(1e-6, north - south),
    scale = Math.min(
      (width - padding * 2) / spanLongitude,
      (height - padding * 2) / spanLatitude,
    ),
    project = (point: Position) => [
      padding + (point[0] - west) * scale,
      height - padding - (point[1] - south) * scale,
    ],
    pathPoints = result.coordinates
      .map((point) => project(point).map((value) => value.toFixed(1)).join(","))
      .join(" "),
    outlet = project(result.coordinates[0]),
    upstream = project(result.coordinates.at(-1)!);
  return (
    <figure className="watershed-preview">
      <div className="watershed-preview-head">
        <strong>Calculated watershed geometry</strong>
        <span>
          {result.source === "mghydro"
            ? `MGHydro · ${result.precision} precision`
            : "Uploaded flow path"}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Watershed boundary and calculated longest flow path"
      >
        <rect width={width} height={height} rx="10" fill="#f5fbfb" />
        {rings.map((ring, index) => (
          <path
            key={index}
            d={`${ring
              .map((point, pointIndex) => {
                const [x, y] = project(point);
                return `${pointIndex ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
              })
              .join(" ")} Z`}
            fill="#cce8e4"
            fillRule="evenodd"
            stroke="#6daea8"
            strokeWidth="1"
          />
        ))}
        <polyline
          points={pathPoints}
          fill="none"
          stroke="#b87416"
          strokeWidth="4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx={outlet[0]} cy={outlet[1]} r="6" fill="#d33f49" stroke="#fff" strokeWidth="2" />
        <circle cx={upstream[0]} cy={upstream[1]} r="6" fill="#0f766e" stroke="#fff" strokeWidth="2" />
      </svg>
      <figcaption>
        <span><i className="outlet-dot" /> Outlet</span>
        <span><i className="upstream-dot" /> Hydraulically farthest point</span>
        <span><i className="path-line" /> Longest connected flow path</span>
      </figcaption>
    </figure>
  );
}

function pointInRing(lon: number, lat: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j],
      cross =
        yi > lat !== yj > lat &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (cross) inside = !inside;
  }
  return inside;
}
function pointInGeometry(lon: number, lat: number, geometry: GeoGeometry) {
  const inPolygon = (polygon: number[][][]) =>
    Boolean(
      polygon[0] &&
        pointInRing(lon, lat, polygon[0]) &&
        !polygon.slice(1).some((ring) => pointInRing(lon, lat, ring)),
    );
  return geometry.type === "Polygon"
    ? inPolygon(geometry.coordinates)
    : geometry.coordinates.some(inPolygon);
}

function representativePointForGeometry(geometry: GeoGeometry) {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const largest = [...polygons].sort((a, b) => {
    const extentArea = (polygon: number[][][]) => {
      const ring = polygon[0] ?? [];
      const longitudes = ring.map((point) => point[0]);
      const latitudes = ring.map((point) => point[1]);
      return longitudes.length
        ? (Math.max(...longitudes) - Math.min(...longitudes)) *
            (Math.max(...latitudes) - Math.min(...latitudes))
        : 0;
    };
    return extentArea(b) - extentArea(a);
  })[0];
  const ring = largest?.[0] ?? [];
  if (ring.length < 3) return null;
  let twiceArea = 0,
    longitudeNumerator = 0,
    latitudeNumerator = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index],
      [x2, y2] = ring[index + 1],
      cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    longitudeNumerator += (x1 + x2) * cross;
    latitudeNumerator += (y1 + y2) * cross;
  }
  const centroid =
    Math.abs(twiceArea) > 1e-12
      ? {
          lon: longitudeNumerator / (3 * twiceArea),
          lat: latitudeNumerator / (3 * twiceArea),
        }
      : null;
  if (
    centroid &&
    pointInGeometry(centroid.lon, centroid.lat, geometry)
  )
    return centroid;
  const average = {
    lon: ring.reduce((sum, point) => sum + point[0], 0) / ring.length,
    lat: ring.reduce((sum, point) => sum + point[1], 0) / ring.length,
  };
  if (pointInGeometry(average.lon, average.lat, geometry)) return average;
  const first = ring[0];
  return first ? { lon: first[0], lat: first[1] } : null;
}

const insidePakistanExtent = (latitude: number, longitude: number) =>
  latitude >= 23.3 &&
  latitude <= 37.2 &&
  longitude >= 60.7 &&
  longitude <= 77.3;

type MapView = { x: number; y: number; width: number; height: number };

function OutletSelectionMap({
  geo,
  latitude,
  longitude,
  onSelect,
}: {
  geo: GeoCollection | null;
  latitude: number | null;
  longitude: number | null;
  onSelect: (latitude: number, longitude: number) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null),
    dragRef = useRef<{
      clientX: number;
      clientY: number;
      view: MapView;
    } | null>(null),
    didDragRef = useRef(false),
    fullView: MapView = { x: 0, y: 0, width: 660, height: 420 };
  const [view, setView] = useState<MapView>(fullView),
    [dragging, setDragging] = useState(false);
  const west = 60.7,
    east = 77.3,
    south = 23.3,
    north = 37.2,
    mapLeft = 28,
    mapRight = 642,
    mapTop = 24,
    mapBottom = 382;
  const project = useCallback(
    (point: number[]) => [
      mapLeft + ((point[0] - west) / (east - west)) * (mapRight - mapLeft),
      mapBottom -
        ((point[1] - south) / (north - south)) * (mapBottom - mapTop),
    ],
    [],
  );
  const mapData = useMemo(() => {
    if (!geo) return { paths: [] as string[] };
    const ring = (coordinates: number[][]) =>
        `${coordinates
          .map((point, index) => {
            const [x, y] = project(point);
            return `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
          })
          .join(" ")} Z`,
      polygonPath = (polygon: number[][][]) => polygon.map(ring).join(" "),
      paths = geo.features.map((feature) =>
        feature.geometry.type === "Polygon"
          ? polygonPath(feature.geometry.coordinates)
          : feature.geometry.coordinates.map(polygonPath).join(" "),
      );
    return { paths };
  }, [geo, project]);
  const marker =
    latitude !== null && longitude !== null
      ? project([longitude, latitude])
      : null;
  const zoom = (factor: number) =>
    setView((current) => {
      const width = Math.min(
          fullView.width,
          Math.max(80, current.width * factor),
        ),
        height = Math.min(
          fullView.height,
          Math.max(51, current.height * factor),
        ),
        centerX = current.x + current.width / 2,
        centerY = current.y + current.height / 2;
      return {
        x: centerX - width / 2,
        y: centerY - height / 2,
        width,
        height,
      };
    });
  const selectAtPointer = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = view.x + ((event.clientX - rect.left) / rect.width) * view.width,
      y = view.y + ((event.clientY - rect.top) / rect.height) * view.height,
      selectedLongitude = Math.min(
        east,
        Math.max(
          west,
          west + ((x - mapLeft) / (mapRight - mapLeft)) * (east - west),
        ),
      ),
      selectedLatitude = Math.min(
        north,
        Math.max(
          south,
          south +
            ((mapBottom - y) / (mapBottom - mapTop)) * (north - south),
        ),
      );
    onSelect(selectedLatitude, selectedLongitude);
  };
  const pointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current,
      rect = svgRef.current?.getBoundingClientRect();
    if (!drag || !rect) return;
    if (
      Math.abs(event.clientX - drag.clientX) +
        Math.abs(event.clientY - drag.clientY) >
      3
    ) {
      didDragRef.current = true;
      if (!event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.setPointerCapture(event.pointerId);
    }
    setView({
      ...drag.view,
      x:
        drag.view.x -
        ((event.clientX - drag.clientX) * drag.view.width) / rect.width,
      y:
        drag.view.y -
        ((event.clientY - drag.clientY) * drag.view.height) / rect.height,
    });
  };
  const pointerEnd = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!didDragRef.current) selectAtPointer(event);
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const nudge = (event: React.KeyboardEvent<SVGSVGElement>) => {
    if (latitude === null || longitude === null) return;
    const stepLatitude = ((north - south) * view.height) / fullView.height / 100,
      stepLongitude = ((east - west) * view.width) / fullView.width / 100;
    let nextLatitude = latitude,
      nextLongitude = longitude;
    if (event.key === "ArrowUp") nextLatitude += stepLatitude;
    else if (event.key === "ArrowDown") nextLatitude -= stepLatitude;
    else if (event.key === "ArrowRight") nextLongitude += stepLongitude;
    else if (event.key === "ArrowLeft") nextLongitude -= stepLongitude;
    else return;
    event.preventDefault();
    onSelect(
      Math.min(north, Math.max(south, nextLatitude)),
      Math.min(east, Math.max(west, nextLongitude)),
    );
  };
  return (
    <section className="outlet-selection-map" aria-labelledby="outlet-map-title">
      <div className="outlet-map-head">
        <div>
          <span>MGHydro outlet picker</span>
          <strong id="outlet-map-title">
            Click the map to select coordinates
          </strong>
        </div>
        <output aria-live="polite">
          {latitude !== null && longitude !== null
            ? `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`
            : "No outlet selected"}
        </output>
      </div>
      <div className="outlet-map-canvas">
        <div className="outlet-map-controls" aria-label="Outlet map controls">
          <button type="button" onClick={() => zoom(0.72)} aria-label="Zoom in">
            ＋
          </button>
          <button type="button" onClick={() => zoom(1.38)} aria-label="Zoom out">
            −
          </button>
          <button
            type="button"
            onClick={() => setView(fullView)}
            aria-label="Reset Pakistan map"
          >
            Reset
          </button>
        </div>
        <svg
          ref={svgRef}
          className={dragging ? "dragging" : ""}
          viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
          role="application"
          tabIndex={0}
          aria-label="Pakistan outlet map. Click to select an outlet, drag to pan, use the mouse wheel or controls to zoom, or use arrow keys to move the selected point."
          onKeyDown={nudge}
          onWheel={(event) => {
            event.preventDefault();
            zoom(event.deltaY > 0 ? 1.12 : 0.89);
          }}
          onPointerDown={(event) => {
            didDragRef.current = false;
            dragRef.current = {
              clientX: event.clientX,
              clientY: event.clientY,
              view,
            };
            setDragging(true);
          }}
          onPointerMove={pointerMove}
          onPointerUp={pointerEnd}
          onPointerCancel={(event) => {
            didDragRef.current = true;
            pointerEnd(event);
          }}
        >
          <rect width="660" height="420" fill="#eef8f7" />
          {[62, 65, 68, 71, 74, 77].map((value) => {
            const [x] = project([value, south]);
            return (
              <g key={`longitude-${value}`}>
                <line x1={x} y1={mapTop} x2={x} y2={mapBottom} />
                <text x={x + 3} y={mapBottom - 5}>
                  {value}°E
                </text>
              </g>
            );
          })}
          {[24, 27, 30, 33, 36].map((value) => {
            const [, y] = project([west, value]);
            return (
              <g key={`latitude-${value}`}>
                <line x1={mapLeft} y1={y} x2={mapRight} y2={y} />
                <text x={mapLeft + 4} y={y - 4}>
                  {value}°N
                </text>
              </g>
            );
          })}
          <g className="outlet-districts">
            {mapData.paths.map((path, index) => (
              <path key={index} d={path} />
            ))}
          </g>
          {marker && (
            <g
              className="outlet-marker"
              transform={`translate(${marker[0]} ${marker[1]})`}
            >
              <circle r="11" />
              <circle r="3.5" />
              <path d="M0 -20V-11M0 11V20M-20 0H-11M11 0H20" />
            </g>
          )}
        </svg>
        <div className="outlet-map-help">
          Click near the intended river · drag to pan · scroll to zoom
        </div>
      </div>
      <p>
        MGHydro snaps the selected outlet to its mapped river network. If the
        returned watershed is incorrect, move the marker closer to the intended
        stream and calculate again.
      </p>
    </section>
  );
}

function GoogleMapsOutlet({
  geo,
  latitude,
  longitude,
  onSelect,
}: {
  geo: GeoCollection | null;
  latitude: number | null;
  longitude: number | null;
  onSelect: (latitude: number, longitude: number) => void;
}) {
  const resolvedLatitude = latitude ?? 34.64737,
    resolvedLongitude = longitude ?? 72.03598;
  const [embedFailed, setEmbedFailed] = useState(false),
    [mapZoom, setMapZoom] = useState(13),
    mapCenter = {
      latitude: resolvedLatitude,
      longitude: resolvedLongitude,
    };
  const coordinate = `${mapCenter.latitude.toFixed(6)},${mapCenter.longitude.toFixed(6)}`,
    embedUrl = `https://maps.google.com/maps?q=${encodeURIComponent(coordinate)}&z=${mapZoom}&output=embed`;
  const selectCoordinate = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect(),
      scale = 256 * 2 ** mapZoom,
      clippedLatitude = Math.max(
        -85.05112878,
        Math.min(85.05112878, mapCenter.latitude),
      ),
      sine = Math.sin((clippedLatitude * Math.PI) / 180),
      centerX = ((mapCenter.longitude + 180) / 360) * scale,
      centerY =
        (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) *
        scale,
      selectedX = centerX + event.clientX - rect.left - rect.width / 2,
      selectedY = centerY + event.clientY - rect.top - rect.height / 2,
      selectedLongitude = (selectedX / scale) * 360 - 180,
      mercatorY = Math.PI - (2 * Math.PI * selectedY) / scale,
      selectedLatitude =
        (Math.atan(Math.sinh(mercatorY)) * 180) / Math.PI,
      next = {
        latitude: Math.max(23.3, Math.min(37.2, selectedLatitude)),
        longitude: Math.max(60.7, Math.min(77.3, selectedLongitude)),
      };
    onSelect(next.latitude, next.longitude);
  };
  if (embedFailed)
    return (
      <OutletSelectionMap
        geo={geo}
        latitude={latitude}
        longitude={longitude}
        onSelect={onSelect}
      />
    );
  return (
    <section className="google-outlet-map" aria-labelledby="google-outlet-title">
      <div className="outlet-map-head">
        <div>
          <span>Google Maps outlet picker</span>
          <strong id="google-outlet-title">Click the map to select coordinates</strong>
        </div>
        <output aria-live="polite">
          {resolvedLatitude.toFixed(5)}, {resolvedLongitude.toFixed(5)}
        </output>
      </div>
      <div className="google-map-picker">
        <iframe
          key={`${coordinate}-${mapZoom}`}
          src={embedUrl}
          title={`Google Maps outlet at ${resolvedLatitude.toFixed(5)}, ${resolvedLongitude.toFixed(5)}`}
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          onError={() => setEmbedFailed(true)}
        />
        <button
          type="button"
          className="google-map-click-layer"
          onClick={selectCoordinate}
          aria-label="Select the MGHydro outlet at this Google Maps position"
        >
          <span>Click the intended river outlet</span>
        </button>
        <div className="google-map-controls" aria-label="Google map controls">
          <button
            type="button"
            onClick={() => setMapZoom((value) => Math.min(18, value + 1))}
            aria-label="Zoom in"
          >
            ＋
          </button>
          <button
            type="button"
            onClick={() => setMapZoom((value) => Math.max(6, value - 1))}
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            type="button"
            onClick={() => setMapZoom(13)}
          >
            Reset zoom
          </button>
        </div>
      </div>
      <p>
        Select the outlet directly in this window. Each click updates latitude
        and longitude and recentres Google Maps; use the controls to zoom before
        calculating the longest flow path and slope with MGHydro.
      </p>
    </section>
  );
}

function BoundaryMap({
  geo,
  selected,
  onSelect,
  onHover,
  hoverAvailable,
  locked = false,
  selectionDisabled = false,
  point,
}: {
  geo: GeoCollection | null;
  selected: string;
  onSelect: (v: string) => void;
  onHover: (v: string) => void;
  hoverAvailable: boolean;
  locked?: boolean;
  selectionDisabled?: boolean;
  point: { lat: number; lon: number } | null;
}) {
  const svgRef = useRef<SVGSVGElement>(null),
    dragRef = useRef<{
      clientX: number;
      clientY: number;
      view: MapView;
    } | null>(null),
    didDragRef = useRef(false);
  const [view, setView] = useState<MapView>({
      x: 0,
      y: 0,
      width: 660,
      height: 470,
    }),
    [hovered, setHovered] = useState(""),
    [hoverEnabled, setHoverEnabled] = useState(true),
    [dragging, setDragging] = useState(false);
  const mapData = useMemo(() => {
    if (!geo) return null;
    const points: number[][] = [];
    const visit = (value: unknown, target: number[][] = points): void => {
      if (!Array.isArray(value)) return;
      if (typeof value[0] === "number" && typeof value[1] === "number") {
        target.push(value as number[]);
        return;
      }
      value.forEach((part) => visit(part, target));
    };
    geo.features.forEach((f) => visit(f.geometry.coordinates));
    const xs = points.map((p) => p[0]),
      ys = points.map((p) => p[1]),
      minX = Math.min(...xs),
      maxX = Math.max(...xs),
      minY = Math.min(...ys),
      maxY = Math.max(...ys),
      project = (p: number[]) => [
        ((p[0] - minX) / (maxX - minX)) * 620 + 20,
        430 - ((p[1] - minY) / (maxY - minY)) * 400 + 20,
      ],
      ring = (r: number[][]) =>
        r
          .map(
            (p, i) =>
              `${i ? "L" : "M"}${project(p)[0].toFixed(1)},${project(p)[1].toFixed(1)}`,
          )
          .join(" ") + " Z",
      polygonPath = (polygon: number[][][]) => polygon.map(ring).join(" "),
      path = (geometry: GeoGeometry) =>
        geometry.type === "Polygon"
          ? polygonPath(geometry.coordinates)
          : geometry.coordinates.map(polygonPath).join(" "),
      marker = point ? project([point.lon, point.lat]) : null,
      selectedKey = normalizeBoundaryName(selected),
      selectedFeature = geo.features.find(
        (f) => normalizeBoundaryName(boundaryName(f)) === selectedKey,
      );
    let focus: MapView = { x: 0, y: 0, width: 660, height: 470 };
    if (selectedFeature) {
      const selectedPoints: number[][] = [];
      visit(selectedFeature.geometry.coordinates, selectedPoints);
      const projected = selectedPoints.map(project),
        sx = projected.map((p) => p[0]),
        sy = projected.map((p) => p[1]);
      if (marker) {
        sx.push(marker[0]);
        sy.push(marker[1]);
      }
      const left = Math.min(...sx),
        right = Math.max(...sx),
        top = Math.min(...sy),
        bottom = Math.max(...sy),
        width = Math.max(105, (right - left) * 2.4),
        height = Math.max(105, (bottom - top) * 2.4),
        cx = (left + right) / 2,
        cy = (top + bottom) / 2;
      focus = { x: cx - width / 2, y: cy - height / 2, width, height };
    }
    return { path, marker, selectedKey, focus };
  }, [geo, selected, point]);
  if (!geo || !mapData)
    return (
      <div className="boundary-empty">
        <strong>Load the official district shapefile ZIP or GeoJSON</strong>
        <p>
          The map is deliberately withheld until a versioned administrative
          layer is supplied.
        </p>
      </div>
    );
  const zoom = (factor: number) =>
    setView((v) => {
      const width = Math.min(660, Math.max(45, v.width * factor)),
        height = Math.min(470, Math.max(32, v.height * factor)),
        cx = v.x + v.width / 2,
        cy = v.y + v.height / 2;
      return { x: cx - width / 2, y: cy - height / 2, width, height };
    });
  const pointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current,
      rect = svgRef.current?.getBoundingClientRect();
    if (!drag || !rect) return;
    if (
      Math.abs(event.clientX - drag.clientX) +
        Math.abs(event.clientY - drag.clientY) >
      3
    ) {
      didDragRef.current = true;
      if (!event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.setPointerCapture(event.pointerId);
    }
    setView({
      ...drag.view,
      x:
        drag.view.x -
        ((event.clientX - drag.clientX) * drag.view.width) / rect.width,
      y:
        drag.view.y -
        ((event.clientY - drag.clientY) * drag.view.height) / rect.height,
    });
  };
  const pointerEnd = (event: React.PointerEvent<SVGSVGElement>) => {
    if (dragRef.current) {
      dragRef.current = null;
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(event.pointerId))
        event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const activeHover = hoverAvailable && hoverEnabled && !locked;
  return (
    <div className="interactive-map-shell">
      <div className="map-controls" aria-label="Map navigation controls">
        <button onClick={() => zoom(0.72)} aria-label="Zoom in">
          ＋
        </button>
        <button onClick={() => zoom(1.38)} aria-label="Zoom out">
          −
        </button>
        <button
          onClick={() => setView(mapData.focus)}
          aria-label="Focus selected district"
        >
          ⌖
        </button>
        <button
          onClick={() => setView({ x: 0, y: 0, width: 660, height: 470 })}
          aria-label="Reset Pakistan view"
        >
          ⌂
        </button>
        <button
          className={activeHover ? "hover-active" : ""}
          onClick={() => setHoverEnabled((v) => !v)}
          aria-pressed={activeHover}
          disabled={!hoverAvailable || locked}
        >
          {selectionDisabled
            ? "District selection disabled"
            : locked
              ? "District locked"
              : hoverAvailable
                ? activeHover
                  ? "Hover preview on"
                  : "Hover preview off"
                : "Hover: online only"}
        </button>
      </div>
      {hovered && (
        <div className="map-hover-label">
          {hovered}
          <small>
            {selectionDisabled
              ? "Reference boundary only"
              : locked
                ? "Selection locked"
                : activeHover
                  ? "Preview only · click to lock"
                  : "Click to select and lock"}
          </small>
        </div>
      )}
      <svg
        ref={svgRef}
        className={`boundary-map ${dragging ? "dragging" : ""}`}
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        role="img"
        aria-label={`Interactive Pakistan boundaries; selected ${selected}${locked ? " and locked" : ""}${point ? ` with coordinate marker at ${point.lat}, ${point.lon}` : ""}`}
        onWheel={(event) => {
          event.preventDefault();
          zoom(event.deltaY < 0 ? 0.82 : 1.22);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          didDragRef.current = false;
          dragRef.current = {
            clientX: event.clientX,
            clientY: event.clientY,
            view,
          };
          setDragging(true);
        }}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        onPointerLeave={() => {
          if (!dragRef.current) setHovered("");
        }}
      >
        {geo.features.map((f, i) => {
          const n = boundaryName(f),
            matched = normalizeBoundaryName(n) === mapData.selectedKey;
          return (
            <path
              key={i}
              d={mapData.path(f.geometry)}
              className={matched ? "selected" : ""}
              aria-label={matched ? `Selected district: ${selected}` : n}
              onPointerEnter={() => {
                if (dragRef.current) return;
                setHovered(n);
                if (activeHover) onHover(n);
              }}
              onClick={(event) => {
                event.stopPropagation();
                if (didDragRef.current || selectionDisabled) return;
                setHoverEnabled(false);
                onSelect(n);
              }}
            >
              <title>{`${n}${matched ? " · selected" : ""} · ${selectionDisabled ? "reference only; district selection disabled" : locked ? "district selection locked" : hoverAvailable ? "hover to preview IDF; click to select and lock" : "click to select and lock"}`}</title>
            </path>
          );
        })}
        {mapData.marker && (
          <g
            className="coordinate-marker"
            aria-label={`Entered coordinates ${point?.lat}, ${point?.lon}`}
          >
            <circle cx={mapData.marker[0]} cy={mapData.marker[1]} r="7" />
            <circle cx={mapData.marker[0]} cy={mapData.marker[1]} r="2.5" />
            <title>{`Entered point · ${point?.lat.toFixed(5)}, ${point?.lon.toFixed(5)}`}</title>
          </g>
        )}
      </svg>
      <div className="map-help">
        Wheel or ＋/− to zoom · drag to move ·{" "}
        {selectionDisabled
          ? "district selection is disabled for uploaded observations"
          : locked
            ? `${selected} is locked; use Unlock district to change it`
            : hoverAvailable
              ? "hover to preview · click a district to select and lock"
              : "click a district to select and lock"}
      </div>
    </div>
  );
}

export default function App() {
  const [district, setDistrict] = useState("Peshawar"),
    [name, setName] = useState("Observed gauge"),
    [observedResolution, setObservedResolution] = useState<"daily" | "hourly">(
      "daily",
    ),
    [raw, setRaw] = useState<DailyRecord[]>([]),
    [hourlyRaw, setHourlyRaw] = useState<HourlyRecord[]>([]),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [method, setMethod] = useState<Method>("gev"),
    [axis, setAxis] = useState<"linear" | "log">("log"),
    [exponent, setExponent] = useState(0.33),
    [timeOfConcentrationMode, setTimeOfConcentrationMode] =
      useState<"manual" | "kirpich">("manual"),
    [manualTimeOfConcentration, setManualTimeOfConcentration] = useState(""),
    [flowPathLengthMetres, setFlowPathLengthMetres] = useState(""),
    [catchmentSlopePercent, setCatchmentSlopePercent] = useState(""),
    [flowGeometryMode, setFlowGeometryMode] =
      useState<"manual" | "mghydro" | "upload">("manual"),
    [watershedOutletLatitude, setWatershedOutletLatitude] =
      useState("34.647370"),
    [watershedOutletLongitude, setWatershedOutletLongitude] =
      useState("72.035980"),
    [watershedPrecision, setWatershedPrecision] =
      useState<"low" | "high">("high"),
    [watershedSlopeMethod, setWatershedSlopeMethod] =
      useState<"10-85" | "endpoint">("10-85"),
    [watershedGeometryBusy, setWatershedGeometryBusy] = useState(false),
    [watershedGeometryMessage, setWatershedGeometryMessage] = useState(
      "Choose MGHydro or upload a flow path to calculate length and slope automatically.",
    ),
    [watershedGeometryResult, setWatershedGeometryResult] =
      useState<WatershedGeometryResult | null>(null),
    [flowPathFileName, setFlowPathFileName] = useState(""),
    [designReturnPeriod, setDesignReturnPeriod] = useState(10),
    [message, setMessage] = useState("Upload an Excel or CSV file to begin."),
    [boundary, setBoundary] = useState("OCHA COD-AB v01"),
    [geo, setGeo] = useState<GeoCollection | null>(null),
    [pakistanDistrictGeo, setPakistanDistrictGeo] =
      useState<GeoCollection | null>(null),
    [geoMessage, setGeoMessage] = useState(
      "No boundary loaded; results retain the manually selected district.",
    ),
    [spatialMode, setSpatialMode] = useState<"district" | "point">("district"),
    [stationLat, setStationLat] = useState(""),
    [stationLon, setStationLon] = useState(""),
    [sourceTab, setSourceTab] = useState<SourceTab>("observed"),
    [modelTab, setModelTab] = useState<"stationary" | "nonstationary">(
      "stationary",
    ),
    [nonstationaryCovariate, setNonstationaryCovariate] =
      useState<NonstationaryCovariate>("time"),
    [annualCovariates, setAnnualCovariates] = useState<AnnualCovariate[]>([]),
    [selectedCovariateId, setSelectedCovariateId] = useState(""),
    [covariateEvaluationBasis, setCovariateEvaluationBasis] =
      useState<"record-mean" | "latest-matched" | "custom">("record-mean"),
    [customCovariateValue, setCustomCovariateValue] = useState(0),
    [covariateMessage, setCovariateMessage] = useState(
      "Retrieve documented annual ENSO, temperature, moisture and urbanization series online, or upload another physically justified series. Models are compared only on matched annual-maxima years.",
    ),
    [onlineCovariateSource, setOnlineCovariateSource] =
      useState<OnlineCovariateSource>("enso"),
    [onlineCovariateBusy, setOnlineCovariateBusy] = useState(false),
    [onlineCovariateProgress, setOnlineCovariateProgress] = useState(0),
    [covariateWorkflowStatus, setCovariateWorkflowStatus] = useState(
      "After retrieval, the atlas will automatically match shared years, compare the candidate models and generate the evidence-supported IDF curve.",
    ),
    [onlineCovariateMetadata, setOnlineCovariateMetadata] = useState<
      OnlineCovariateMetadata[]
    >([]),
    [onlineSource, setOnlineSource] =
      useState<LiveOnlineSource>("era5"),
    [onlineStart, setOnlineStart] = useState(""),
    [onlineEnd, setOnlineEnd] = useState(""),
    [onlineResolution, setOnlineResolution] =
      useState<OnlineTemporalResolution>("daily"),
    [onlineRaw, setOnlineRaw] = useState<DailyRecord[]>([]),
    [onlineHourlyRaw, setOnlineHourlyRaw] = useState<HourlyRecord[]>([]),
    [onlineMetadata, setOnlineMetadata] =
      useState<OnlineExtractionMetadata | null>(null),
    [onlineBusy, setOnlineBusy] = useState(false),
    [onlineProgress, setOnlineProgress] = useState(0),
    [onlineMessage, setOnlineMessage] = useState(
      "Choose a source, temporal resolution and spatial mode, then retrieve the provider series.",
    ),
    [onlineQuotaBlocked, setOnlineQuotaBlocked] = useState(false),
    [showOnlinePrecipitationPlot, setShowOnlinePrecipitationPlot] =
      useState(false),
    [onlinePlotInterval, setOnlinePlotInterval] =
      useState<PrecipitationPlotInterval>("monthly"),
    [onlineExtractionKey, setOnlineExtractionKey] = useState(""),
    [referenceYearBasis, setReferenceYearBasis] =
      useState<ReferenceYearBasis>("record-center"),
    [customReferenceYear, setCustomReferenceYear] = useState(2030),
    [cmipScenario, setCmipScenario] = useState<Cmip6Scenario>("ssp245"),
    [cmipPeriod, setCmipPeriod] = useState<Cmip6Period>("2041-2070"),
    [cmipSelectionMode, setCmipSelectionMode] =
      useState<Cmip6SelectionMode>("individual"),
    [selectedCmipModel, setCmipModel] =
      useState<(typeof CMIP6_MODELS)[number]>("ACCESS-CM2"),
    [cmipMember, setCmipMember] = useState("auto"),
    [cmipRaw, setCmipRaw] = useState<DailyRecord[]>([]),
    [cmipHistoricalRaw, setCmipHistoricalRaw] = useState<DailyRecord[]>([]),
    [cmipEra5ReferenceRaw, setCmipEra5ReferenceRaw] = useState<DailyRecord[]>([]),
    [cmipBiasReference, setCmipBiasReference] =
      useState<Cmip6BiasReference>("auto"),
    [cmipHistoricalMessage, setCmipHistoricalMessage] = useState(
      "Retrieve the matching 1985–2014 historical GCM grid cell. The atlas uses gauge observations when available, or can retrieve ERA5 as a clearly labelled fallback reference.",
    ),
    [cmipHistoricalLoadedKey, setCmipHistoricalLoadedKey] = useState(""),
    [cmipEnsembleModels, setCmipEnsembleModels] =
      useState<StoredCmipModel[]>([]),
    [cmipImportedWorkbook, setCmipImportedWorkbook] =
      useState<ImportedCmipWorkbook | null>(null),
    [cmipLoadedKey, setCmipLoadedKey] = useState(""),
    [cmipMetadata, setCmipMetadata] =
      useState<Cmip6ExtractionMetadata | null>(null),
    [cmipBusy, setCmipBusy] = useState(false),
    [cmipProgress, setCmipProgress] = useState(0),
    [cmipDataMessage, setCmipDataMessage] = useState(
      "Choose an individual GCM, SSP, period and spatial extraction, then retrieve the actual daily pr series from NASA NCCS THREDDS. The retrieved values—not a screening multiplier—will be plotted and fitted.",
    ),
    [showCmipPrecipitationPlot, setShowCmipPrecipitationPlot] =
      useState(false),
    [cmipPlotInterval, setCmipPlotInterval] =
      useState<PrecipitationPlotInterval>("monthly"),
    [boundaryLevel, setBoundaryLevel] = useState<"district" | "tehsil">(
      "district",
    ),
    [mapSelection, setMapSelection] = useState("Peshawar"),
    [districtLocked, setDistrictLocked] = useState(false);
  const input = useRef<HTMLInputElement>(null),
    hourlyInput = useRef<HTMLInputElement>(null),
    covariateInput = useRef<HTMLInputElement>(null),
    cmipInput = useRef<HTMLInputElement>(null),
    cmipResultsInput = useRef<HTMLInputElement>(null),
    boundaryInput = useRef<HTMLInputElement>(null);
  const filtered = useMemo(
    () =>
      raw.filter((r) => (!start || r.date >= start) && (!end || r.date <= end)),
    [raw, start, end],
  );
  const hourlyFiltered = useMemo(
    () =>
      hourlyRaw.filter(
        (r) =>
          (!start || r.timestamp.slice(0, 10) >= start) &&
          (!end || r.timestamp.slice(0, 10) <= end),
      ),
    [hourlyRaw, start, end],
  );
  const dailyQc = useMemo(() => assess(filtered), [filtered]),
    hourlyQc = useMemo(() => assessHourly(hourlyFiltered), [hourlyFiltered]);
  const activeObservedQc = observedResolution === "daily" ? dailyQc : hourlyQc;
  const manualObservedLoaded =
    sourceTab === "observed" &&
    (observedResolution === "daily" ? raw.length > 0 : hourlyRaw.length > 0);
  const hourlyDaily = useMemo(
    () => hourlyToDailyTotals(hourlyQc.records),
    [hourlyQc.records],
  );
  const qc = useMemo(
    () => assess(observedResolution === "hourly" ? hourlyDaily : filtered),
    [observedResolution, hourlyDaily, filtered],
  );
  const stationarity = useMemo(
    () =>
      observedResolution === "hourly"
        ? stationarityDiagnosticsHourly(hourlyQc.records)
        : stationarityDiagnostics(qc.records),
    [observedResolution, hourlyQc.records, qc.records],
  );
  const stationaryObserved = useMemo(
    () =>
      observedResolution === "hourly"
        ? calculateHourly(hourlyQc.records, exponent)
        : calculate(qc.records, exponent),
    [observedResolution, hourlyQc.records, qc.records, exponent],
  );
  const diagnostics = useMemo(
    () =>
      observedResolution === "hourly"
        ? fitDiagnosticsHourly(hourlyQc.records)
        : fitDiagnostics(qc.records),
    [observedResolution, hourlyQc.records, qc.records],
  );
  const observedAms = useMemo(
    () =>
      observedResolution === "hourly"
        ? hourlyAnnualMaxima(hourlyQc.records, 24)
        : annualMaxima(qc.records, 1),
    [observedResolution, hourlyQc.records, qc.records],
  );
  const coordinateLat = Number(stationLat),
    coordinateLon = Number(stationLon),
    coordinateValid =
      stationLat.trim() !== "" &&
      stationLon.trim() !== "" &&
      Number.isFinite(coordinateLat) &&
      Number.isFinite(coordinateLon) &&
      coordinateLat >= -90 &&
      coordinateLat <= 90 &&
      coordinateLon >= -180 &&
      coordinateLon <= 180,
    watershedOutletLatitudeNumber = Number(watershedOutletLatitude),
    watershedOutletLongitudeNumber = Number(watershedOutletLongitude),
    watershedOutletPointValid =
      watershedOutletLatitude.trim() !== "" &&
      watershedOutletLongitude.trim() !== "" &&
      Number.isFinite(watershedOutletLatitudeNumber) &&
      Number.isFinite(watershedOutletLongitudeNumber) &&
      insidePakistanExtent(
        watershedOutletLatitudeNumber,
        watershedOutletLongitudeNumber,
      ),
    coordinateInsidePakistan =
      coordinateValid &&
      insidePakistanExtent(coordinateLat, coordinateLon) &&
      (pakistanDistrictGeo
        ? pakistanDistrictGeo.features.some((feature) =>
            pointInGeometry(
              coordinateLon,
              coordinateLat,
              feature.geometry,
            ),
          )
        : true),
    cmipCoordinateReady = coordinateValid && coordinateInsidePakistan;
  const latestCompleteYear = new Date().getUTCFullYear() - 1,
    onlineRequestedStart =
      onlineStart ||
      LIVE_SOURCE_CONFIG[onlineSource].firstDate,
    onlineRequestedEnd = onlineEnd || `${latestCompleteYear}-12-31`;
  const currentOnlineSelectionKey = [
    onlineSource,
    onlineResolution,
    spatialMode,
    district,
    spatialMode === "point" ? stationLat : "district",
    spatialMode === "point" ? stationLon : "district",
    onlineRequestedStart,
    onlineRequestedEnd,
  ].join("|");
  const onlineReady =
    (onlineResolution === "daily" ? onlineRaw.length : onlineHourlyRaw.length) >
      0 && onlineExtractionKey === currentOnlineSelectionKey;
  const onlineFiltered = useMemo(
    () =>
      onlineReady
        ? onlineRaw.filter(
            (r) =>
              r.date >= onlineRequestedStart && r.date <= onlineRequestedEnd,
          )
        : [],
    [onlineReady, onlineRaw, onlineRequestedStart, onlineRequestedEnd],
  );
  const onlineHourlyFiltered = useMemo(
    () =>
      onlineReady
        ? onlineHourlyRaw.filter(
            (r) =>
              r.timestamp.slice(0, 10) >= onlineRequestedStart &&
              r.timestamp.slice(0, 10) <= onlineRequestedEnd,
          )
        : [],
    [onlineReady, onlineHourlyRaw, onlineRequestedStart, onlineRequestedEnd],
  );
  const onlineDailyQc = useMemo(() => assess(onlineFiltered), [onlineFiltered]),
    onlineHourlyQc = useMemo(
      () => assessHourly(onlineHourlyFiltered),
      [onlineHourlyFiltered],
    ),
    onlineQc = onlineResolution === "hourly" ? onlineHourlyQc : onlineDailyQc;
  const onlinePlotRecords = useMemo<PrecipitationPlotRecord[]>(
      () =>
        onlineResolution === "hourly"
          ? onlineHourlyQc.records.map((record) => ({
              timestamp: record.timestamp,
              precipitationMm: record.precipitationMm,
            }))
          : onlineDailyQc.records.map((record) => ({
              timestamp: record.date,
              precipitationMm: record.precipitationMm,
            })),
      [onlineResolution, onlineHourlyQc.records, onlineDailyQc.records],
    ),
    onlinePlotLocation =
      spatialMode === "district"
        ? `${onlineMetadata?.districtName ?? district} district area series`
        : coordinateValid
          ? `Point/grid-cell at ${coordinateLat.toFixed(5)}, ${coordinateLon.toFixed(5)}`
          : "Point/grid-cell coordinates";
  const onlineHourlyDaily = useMemo(
    () => hourlyToDailyTotals(onlineHourlyQc.records),
    [onlineHourlyQc.records],
  );
  const onlineStationarity = useMemo(
    () =>
      onlineResolution === "hourly"
        ? stationarityDiagnosticsHourly(onlineHourlyQc.records)
        : stationarityDiagnostics(onlineDailyQc.records),
    [onlineResolution, onlineHourlyQc.records, onlineDailyQc.records],
  );
  const stationaryOnline = useMemo(
    () =>
      onlineResolution === "hourly"
        ? calculateHourly(onlineHourlyQc.records, exponent)
        : calculate(onlineDailyQc.records, exponent),
    [onlineResolution, onlineHourlyQc.records, onlineDailyQc.records, exponent],
  );
  const onlineDiagnostics = useMemo(
    () =>
      onlineResolution === "hourly"
        ? fitDiagnosticsHourly(onlineHourlyQc.records)
        : fitDiagnostics(onlineDailyQc.records),
    [onlineResolution, onlineHourlyQc.records, onlineDailyQc.records],
  );
  const onlineAms = useMemo(
    () =>
      onlineResolution === "hourly"
        ? hourlyAnnualMaxima(onlineHourlyQc.records, 24)
        : annualMaxima(onlineDailyQc.records, 1),
    [onlineResolution, onlineHourlyQc.records, onlineDailyQc.records],
  );
  const cmipMidpoint = CMIP6_PERIODS[cmipPeriod].midpoint,
    cmipModel =
      cmipSelectionMode === "ensemble"
        ? "Multi-model median"
        : selectedCmipModel,
    cmipModelLabel = cmipModel,
    currentCmipDataKey = [
      cmipSelectionMode,
      cmipModelLabel,
      cmipScenario,
      cmipPeriod,
      spatialMode,
      district,
      spatialMode === "point" ? stationLat : "district",
      spatialMode === "point" ? stationLon : "district",
    ].join("|"),
    cmipDataReady =
      cmipRaw.length > 0 &&
      cmipLoadedKey === currentCmipDataKey,
    cmipQc = assess(cmipDataReady ? cmipRaw : []);
  const cmipStationarity = useMemo(
      () => stationarityDiagnostics(cmipQc.records),
      [cmipQc.records],
    ),
    stationaryCmip = useMemo(
      () => calculate(cmipQc.records, exponent),
      [cmipQc.records, exponent],
    ),
    nonstationaryCmip = useMemo(
      () => calculateNonstationaryTime(cmipQc.records, cmipMidpoint, exponent),
      [cmipQc.records, cmipMidpoint, exponent],
    ),
    cmipDiagnostics = useMemo(
      () => fitDiagnostics(cmipQc.records),
      [cmipQc.records],
    ),
    cmipAms = useMemo(
      () => annualMaxima(cmipQc.records, 1),
      [cmipQc.records],
    ),
    currentCmipHistoricalKey = [
      selectedCmipModel,
      cmipBiasReference,
      stationLat,
      stationLon,
      raw.length,
      hourlyRaw.length,
    ].join("|"),
    cmipHistoricalQc = assess(
      cmipHistoricalLoadedKey === currentCmipHistoricalKey
        ? cmipHistoricalRaw
        : [],
    ),
    cmipEra5ReferenceQc = assess(
      cmipHistoricalLoadedKey === currentCmipHistoricalKey
        ? cmipEra5ReferenceRaw
        : [],
    ),
    gaugeHistoricalDaily = (
      observedResolution === "hourly" ? hourlyDaily : qc.records
    ).filter((record) => {
      const year = Number(record.date.slice(0, 4));
      return year >= 1985 && year <= 2014;
    }),
    gaugeHistoricalQc = assess(gaugeHistoricalDaily),
    useEra5BiasReference =
      cmipBiasReference === "era5" ||
      (cmipBiasReference === "auto" && gaugeHistoricalQc.eligibleYears < 20),
    cmipReferenceDaily = useEra5BiasReference
      ? cmipEra5ReferenceQc.records
      : gaugeHistoricalQc.records,
    cmipReferenceQc = assess(cmipReferenceDaily),
    cmipReferenceRows = calculate(cmipReferenceDaily, exponent),
    cmipReferenceAms = annualMaxima(cmipReferenceDaily, 1),
    cmipReferenceLabel = useEra5BiasReference
      ? "ERA5 reanalysis"
      : "observed gauge",
    stationaryCmipHistorical = calculate(cmipHistoricalQc.records, exponent),
    cmipQdm = monthlyMultiplicativeQdm(
      cmipQc.records,
      cmipHistoricalQc.records,
      cmipReferenceDaily,
    ),
    cmipCorrectedQc = assess(cmipQdm.records),
    stationaryCmipCorrected = calculate(cmipCorrectedQc.records, exponent),
    nonstationaryCmipCorrected = calculateNonstationaryTime(
      cmipCorrectedQc.records,
      cmipMidpoint,
      exponent,
    ),
    cmipQdmReady =
      cmipQdm.summaries.length === 12 &&
      cmipHistoricalQc.eligibleYears >= 20 &&
      cmipReferenceQc.eligibleYears >= 20 &&
      cmipCorrectedQc.eligibleYears >= 8,
    cmipFutureUncorrectedRows = modelTab === "nonstationary"
      ? nonstationaryCmip.rows
      : stationaryCmip,
    cmipFutureCorrectedRows = modelTab === "nonstationary"
      ? nonstationaryCmipCorrected.rows
      : stationaryCmipCorrected,
    cmipCorrected24h = cmipQdmReady
      ? cmipFutureCorrectedRows.filter(
          (row) => row.durationMinutes === 1440,
        )
      : [],
    cmipDurationRatios = observedResolution === "hourly"
      ? observedDurationRatios(stationaryObserved, method)
      : new Map<string, number>(),
    cmipValidatedRows = cmipCorrected24h.length
      ? observedResolution === "hourly"
        ? applyObservedDurationRatios(cmipCorrected24h, cmipDurationRatios)
        : cmipCorrected24h
      : [],
    cmipBiasComparison = cmipCorrected24h.map(corrected => {
      const uncorrected = cmipFutureUncorrectedRows.find(row =>
        row.method === corrected.method &&
        row.durationMinutes === 1440 &&
        row.returnPeriodYears === corrected.returnPeriodYears,
      );
      return {
        returnPeriodYears: corrected.returnPeriodYears,
        historicalGcmMm: stationaryCmipHistorical.find(row =>
          row.method === corrected.method && row.durationMinutes === 1440 && row.returnPeriodYears === corrected.returnPeriodYears,
        )?.depthMm ?? Number.NaN,
        referenceMm: cmipReferenceRows.find(row =>
          row.method === corrected.method && row.durationMinutes === 1440 && row.returnPeriodYears === corrected.returnPeriodYears,
        )?.depthMm ?? Number.NaN,
        factor:
          uncorrected?.depthMm && uncorrected.depthMm > 0
            ? corrected.depthMm / uncorrected.depthMm
            : Number.NaN,
        futureRawMm: uncorrected?.depthMm ?? Number.NaN,
        futureCorrectedMm: corrected.depthMm,
      };
    }),
    currentCmipEnsembleKey = cmipEnsembleSelectionKey({
      scenario: cmipScenario,
      period: cmipPeriod,
      latitude: coordinateLat,
      longitude: coordinateLon,
      reference: cmipReferenceLabel,
      model: modelTab,
      method,
      durationBasis:
        observedResolution === "hourly" && hourlyRaw.length
          ? "observed-duration-ratios"
          : "24-hour-only",
    }),
    cmipActiveEnsembleModels = cmipEnsembleModels.filter(
      (item) => item.selectionKey === currentCmipEnsembleKey,
    ),
    cmipImportedModels = cmipActiveEnsembleModels.filter((item) =>
      item.correctionReference.startsWith("Imported workbook"),
    ),
    cmipImportedProfile = cmipImportedWorkbook?.profiles.find(
      (profile) =>
        profile.scenario === cmipScenario && profile.period === cmipPeriod,
    ),
    cmipImportedReady =
      cmipSelectionMode === "ensemble" &&
      modelTab === "stationary" &&
      method === "gev" &&
      cmipImportedModels.length >= 3 &&
      Boolean(cmipImportedProfile),
    cmipResultsReady = cmipDataReady || cmipImportedReady,
    cmipRecommendedStored = PAKISTAN_IDF_ENSEMBLE_MODELS.filter((model) =>
      cmipActiveEnsembleModels.some((item) => item.model === model),
    ).length,
    cmipEnsembleRows = multiModelEnvelope(cmipActiveEnsembleModels),
    cmipPlotRecords: PrecipitationPlotRecord[] = (cmipQdmReady
      ? cmipCorrectedQc.records
      : cmipQc.records
    ).map(
      (record) => ({
        timestamp: record.date,
        precipitationMm: record.precipitationMm,
      }),
    ),
    cmipPlotLocation =
      spatialMode === "district"
        ? `${district} district · NASA grid-cell mean`
        : coordinateValid
          ? `Point/grid-cell at ${coordinateLat.toFixed(5)}, ${coordinateLon.toFixed(5)} · ${cmipQdmReady ? "monthly QDM corrected" : "raw GCM"}`
          : "Point/grid-cell coordinates";
  const activeStationarity =
      sourceTab === "online"
        ? onlineStationarity
        : sourceTab === "cmip6"
          ? cmipStationarity
          : stationarity,
    activeDiagnostics =
      sourceTab === "online"
        ? onlineDiagnostics
        : sourceTab === "cmip6"
          ? cmipDiagnostics
          : diagnostics,
    ams =
      sourceTab === "online"
        ? onlineAms
        : sourceTab === "cmip6"
          ? cmipAms
          : observedAms;
  const recommendation = useMemo(
    () =>
      activeStationarity.n >= 8
        ? [...activeDiagnostics]
            .filter((d) => d.method !== "sherman" && Number.isFinite(d.rmseMm))
            .sort((a, b) => a.rmseMm - b.rmseMm)[0]?.method
        : null,
    [activeStationarity.n, activeDiagnostics],
  );
  const referenceYearSelection = useMemo(
      () =>
        calculateReferenceYear(ams, referenceYearBasis, customReferenceYear),
      [ams, referenceYearBasis, customReferenceYear],
    ),
    recordCenterYear = Number.isFinite(referenceYearSelection.centerYear)
      ? referenceYearSelection.centerYear
      : customReferenceYear,
    referenceYear =
      sourceTab === "cmip6"
        ? cmipMidpoint
        : referenceYearSelection.referenceYear,
    referenceYearStatus = !referenceYearSelection.eligibleYearCount
      ? "Load or retrieve daily data to calculate the reference year"
      : referenceYearSelection.isExtrapolation
        ? "Outside eligible AMS years: extrapolation"
        : "Within eligible AMS years: interpolation";
  const covariateComparison = useMemo(
    () => compareCovariateModels(ams, annualCovariates),
    [ams, annualCovariates],
  );
  const selectedAnnualCovariate = useMemo(
    () =>
      annualCovariates.find(
        (candidate) => candidate.id === selectedCovariateId,
      ),
    [annualCovariates, selectedCovariateId],
  );
  const selectedMatchedValues = useMemo(() => {
    if (!selectedAnnualCovariate) return [];
    const years = new Set(ams.map((row) => row.year));
    return selectedAnnualCovariate.values
      .filter((row) => years.has(row.year))
      .sort((a, b) => a.year - b.year);
  }, [ams, selectedAnnualCovariate]);
  const covariateMean = selectedMatchedValues.length
      ? selectedMatchedValues.reduce((sum, row) => sum + row.value, 0) /
        selectedMatchedValues.length
      : NaN,
    covariateLatest = selectedMatchedValues.at(-1)?.value ?? NaN,
    covariateEvaluationValue =
      covariateEvaluationBasis === "record-mean"
        ? covariateMean
        : covariateEvaluationBasis === "latest-matched"
          ? covariateLatest
          : customCovariateValue,
    covariateRange = selectedMatchedValues.length
      ? {
          min: Math.min(...selectedMatchedValues.map((row) => row.value)),
          max: Math.max(...selectedMatchedValues.map((row) => row.value)),
        }
      : { min: NaN, max: NaN },
    covariateEvaluationStatus = !selectedAnnualCovariate
      ? "No matched annual covariate selected"
      : covariateEvaluationValue < covariateRange.min ||
          covariateEvaluationValue > covariateRange.max
        ? "Outside matched covariate range: extrapolation"
        : "Within matched covariate range: interpolation",
    covariateLabel =
      nonstationaryCovariate === "time"
        ? `Fitted time-varying GEV · ${referenceYear}`
        : selectedAnnualCovariate
          ? `${selectedAnnualCovariate.label} · ${Number.isFinite(covariateEvaluationValue) ? covariateEvaluationValue.toFixed(3) : "not available"} ${selectedAnnualCovariate.units}`
          : "Matched covariate not available";
  const activeDailyRecords =
    sourceTab === "online"
      ? onlineResolution === "hourly"
        ? onlineHourlyDaily
        : onlineDailyQc.records
      : sourceTab === "cmip6"
        ? cmipQc.records
        : qc.records;
  const nonstationaryTime = useMemo(
    () =>
      calculateNonstationaryTime(activeDailyRecords, referenceYear, exponent),
    [activeDailyRecords, referenceYear, exponent],
  );
  const nonstationaryMatched = useMemo(
    () => {
      const candidate = annualCovariates.find(
        (row) => row.id === selectedCovariateId,
      );
      return candidate && Number.isFinite(covariateEvaluationValue)
        ? calculateNonstationaryCovariate(
            activeDailyRecords,
            candidate,
            covariateEvaluationValue,
            exponent,
          )
        : null;
    },
    [
      activeDailyRecords,
      annualCovariates,
      selectedCovariateId,
      covariateEvaluationValue,
      exponent,
    ],
  );
  const activeNonstationaryRows = useMemo(
      () =>
        nonstationaryCovariate === "time"
          ? nonstationaryTime.rows
          : (nonstationaryMatched?.rows ?? []),
      [nonstationaryCovariate, nonstationaryTime.rows, nonstationaryMatched],
    ),
    activeNonstationaryStatus =
      nonstationaryCovariate === "time"
        ? nonstationaryTime.fit.status
        : (nonstationaryMatched?.fit.status ?? "Insufficient record");
  const observedResults = useMemo(
    () =>
      observedResolution === "daily" &&
      modelTab === "nonstationary"
        ? activeNonstationaryRows
        : stationaryObserved,
    [
      observedResolution,
      modelTab,
      activeNonstationaryRows,
      stationaryObserved,
    ],
  );
  const fittedOnlineResults = useMemo(
    () =>
      !onlineReady
        ? []
        : modelTab === "nonstationary"
          ? activeNonstationaryRows
          : stationaryOnline,
    [
      onlineReady,
      modelTab,
      activeNonstationaryRows,
      stationaryOnline,
    ],
  );
  const activeNativeHourly =
    (sourceTab === "observed" && observedResolution === "hourly") ||
    (sourceTab === "online" && onlineResolution === "hourly");
  const results =
      sourceTab === "observed"
        ? observedResults
        : sourceTab === "online"
          ? fittedOnlineResults
          : cmipSelectionMode === "ensemble"
            ? cmipEnsembleRows
            : !cmipDataReady
            ? []
            : cmipValidatedRows.length
                ? cmipValidatedRows
            : modelTab === "nonstationary"
              ? nonstationaryCmip.rows
              : stationaryCmip,
    shown = results.filter((r) => r.method === method),
    reportDurations = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440],
    sourceLabel =
      sourceTab === "observed"
        ? `${name} · observed ${observedResolution}`
        : sourceTab === "cmip6"
          ? cmipImportedReady && cmipImportedWorkbook
            ? `Imported bias-corrected CMIP6 ensemble · ${cmipImportedWorkbook.locationName} · ${CMIP6_SCENARIOS[cmipScenario].label} · ${cmipPeriod} · ${cmipImportedModels.length} models · ${cmipReferenceLabel} · 24-hour only`
          : cmipDataReady
            ? cmipMetadata
              ? `NASA NEX-GDDP-CMIP6 · ${cmipMetadata.model} · ${CMIP6_SCENARIOS[cmipScenario].label} · ${cmipMetadata.member} · ${cmipPeriod} · ${cmipQdmReady ? `${cmipQdm.method} · ${cmipReferenceLabel}` : "raw GCM"} · ${spatialMode === "district" ? `district grid-cell mean · ${district}` : `point · ${coordinateValid ? `${coordinateLat.toFixed(5)}, ${coordinateLon.toFixed(5)}` : "coordinates required"}`}`
              : `Uploaded GCM precipitation · ${cmipModel} · ${CMIP6_SCENARIOS[cmipScenario].label} · ${cmipPeriod}`
            : `NASA NEX-GDDP-CMIP6 · ${cmipModel} · ${CMIP6_SCENARIOS[cmipScenario].label} · not retrieved`
          : onlineReady && onlineMetadata
            ? `${onlineMetadata.dataset} · ${onlineMetadata.temporalResolution} · ${spatialMode === "district" ? `district polygon · ${district}` : `point · ${coordinateValid ? `${coordinateLat.toFixed(5)}, ${coordinateLon.toFixed(5)}` : "coordinates required"}`}`
            : `${SOURCE_META[onlineSource].label} · ${onlineResolution} series not retrieved`,
    selected24h = shown.filter((r) => r.durationMinutes === 1440),
    selected10 = selected24h.find((r) => r.returnPeriodYears === 10),
    selected50 = selected24h.find((r) => r.returnPeriodYears === 50),
    selected100 = selected24h.find((r) => r.returnPeriodYears === 100),
    selected250 = selected24h.find((r) => r.returnPeriodYears === 250),
    selected500 = selected24h.find((r) => r.returnPeriodYears === 500);
  const selectedWatershedSlopeMPerM = watershedGeometryResult
      ? watershedSlopeMethod === "10-85"
        ? watershedGeometryResult.slope10To85MPerM
        : watershedGeometryResult.endpointSlopeMPerM
      : null,
    effectiveFlowPathLengthMetres =
      flowGeometryMode === "manual"
        ? Number(flowPathLengthMetres)
        : (watershedGeometryResult?.lengthMetres ?? Number.NaN),
    effectiveCatchmentSlopeMPerM =
      flowGeometryMode === "manual"
        ? Number(catchmentSlopePercent) / 100
        : (selectedWatershedSlopeMPerM ?? Number.NaN),
    idfEquation = fitShermanEquation(shown),
    idfPowerEquations = PERIODS.flatMap((returnPeriodYears) => {
      const fit = fitPowerEquation(shown, returnPeriodYears);
      return fit ? [fit] : [];
    }),
    manualConcentrationValue = Number(manualTimeOfConcentration),
    kirpichConcentrationValue = kirpichTimeOfConcentrationMinutes(
      effectiveFlowPathLengthMetres,
      effectiveCatchmentSlopeMPerM,
    ),
    timeOfConcentrationMinutes =
      timeOfConcentrationMode === "manual"
        ? manualTimeOfConcentration.trim() && manualConcentrationValue > 0
          ? manualConcentrationValue
          : null
        : kirpichConcentrationValue,
    concentrationWithinIdfRange = Boolean(
      timeOfConcentrationMinutes != null &&
        timeOfConcentrationMinutes >= 5 &&
        timeOfConcentrationMinutes <= 1440,
    ),
    designIntensity = concentrationWithinIdfRange
      ? shermanIntensity(
          idfEquation,
          timeOfConcentrationMinutes!,
          designReturnPeriod,
        )
      : null,
    designRainfallDepth =
      designIntensity != null && timeOfConcentrationMinutes != null
        ? (designIntensity * timeOfConcentrationMinutes) / 60
        : null;
  const activeFrequencyMethodLabel =
    modelTab === "nonstationary"
      ? "GEV · maximum likelihood"
      : METHOD_LABEL[method];
  const analysisClassification =
    sourceTab === "cmip6"
      ? cmipImportedReady && cmipImportedWorkbook
        ? `Imported bias-corrected CMIP6 ensemble · model median with P10–P90 spread · ${cmipImportedWorkbook.validationStatus} · 24-hour only`
      : !cmipDataReady
        ? "CMIP6 precipitation not yet retrieved for the active selection"
        : activeStationarity.n < 8
          ? "Not estimable — fewer than 8 eligible GCM annual maxima"
          : cmipQdmReady
            ? `QDM-corrected GCM ${modelTab} IDF · ${cmipReferenceLabel} reference · ${cmipMetadata?.member ?? "member not reported"}`
            : `Raw GCM-derived ${modelTab} IDF · bias correction pending · ${cmipMetadata?.member ?? "member not reported"}`
      : sourceTab === "online" && !onlineReady
        ? "Online precipitation not yet retrieved for the active selection"
        : modelTab === "nonstationary"
          ? activeNonstationaryStatus !== "Fitted"
            ? "Nonstationary model not estimable — at least 20 eligible maxima required"
            : `${covariateComparison.decision}; ${covariateLabel}`
          : activeStationarity.n < 8
            ? "Not estimable — fewer than 8 eligible annual maxima"
            : activeStationarity.n < 30
              ? "Provisional — fewer than 30 eligible annual maxima"
              : activeStationarity.pValue < 0.05
                ? "Trend detected — stationary assumption challenged"
                : "Stationarity not rejected at α = 0.05";
  const reportDate = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    }).format(new Date()),
    reportId =
      sourceTab === "observed"
        ? `PK-IDF-OBS-${
            name
              .toUpperCase()
              .replace(/[^A-Z0-9]+/g, "-")
              .replace(/^-|-$/g, "") || "GAUGE"
          }-${modelTab === "stationary" ? "STA" : "NSTA"}`
        : `PK-IDF-${district.toUpperCase().replaceAll(" ", "-")}-${sourceTab === "cmip6" ? "CMIP6" : "ONLINE"}-${modelTab === "stationary" ? "STA" : "NSTA"}`;
  const matchedBoundaryName = useMemo(
    () =>
      boundaryLevel === "district"
        ? (geo?.features
            .map(boundaryName)
            .find(
              (n) =>
                normalizeBoundaryName(n) === normalizeBoundaryName(district),
            ) ?? null)
        : mapSelection,
    [geo, district, boundaryLevel, mapSelection],
  );
  const matchedBoundaryFeature = useMemo(
    () =>
      boundaryLevel === "district"
        ? (geo?.features.find(
            (f) =>
              normalizeBoundaryName(boundaryName(f)) ===
              normalizeBoundaryName(district),
          ) ?? null)
        : null,
    [geo, district, boundaryLevel],
  );
  const districtRepresentativePoint = useMemo(
    () =>
      matchedBoundaryFeature
        ? representativePointForGeometry(matchedBoundaryFeature.geometry)
        : null,
    [matchedBoundaryFeature],
  );
  const matchedBoundaryIdentity = useMemo(() => {
    if (!matchedBoundaryFeature) return null;
    const properties = matchedBoundaryFeature.properties;
    return {
      name: boundaryName(matchedBoundaryFeature),
      code: String(properties.adm2_pcode ?? properties.ADM2_PCODE ?? "not reported"),
      source: "OCHA COD-AB Pakistan ADM2",
      version: String(properties.cod_version ?? "V_01"),
      validOn: String(properties.valid_on ?? "2022-09-09"),
    };
  }, [matchedBoundaryFeature]);
  const selectedBoundaryExtent = useMemo(() => {
    if (!matchedBoundaryFeature) return null;
    const points: number[][] = [];
    const collect = (value: unknown) => {
      if (
        Array.isArray(value) &&
        value.length >= 2 &&
        typeof value[0] === "number" &&
        typeof value[1] === "number"
      )
        points.push(value as number[]);
      else if (Array.isArray(value)) value.forEach(collect);
    };
    collect(matchedBoundaryFeature.geometry.coordinates);
    if (!points.length) return null;
    const lon = points.map((p) => p[0]),
      lat = points.map((p) => p[1]);
    return {
      north: Math.max(...lat),
      west: Math.min(...lon),
      south: Math.min(...lat),
      east: Math.max(...lon),
    };
  }, [matchedBoundaryFeature]);
  const coordinatePoint =
      spatialMode === "point" && coordinateValid
        ? { lat: coordinateLat, lon: coordinateLon }
        : null,
    coordinateInsideDistrict =
      coordinateValid && matchedBoundaryFeature
        ? pointInGeometry(
            coordinateLon,
            coordinateLat,
            matchedBoundaryFeature.geometry,
          )
        : null,
    spatialLabel = manualObservedLoaded
      ? coordinateValid
        ? `Uploaded gauge series · ${coordinateLat.toFixed(5)}, ${coordinateLon.toFixed(5)}`
        : "Uploaded gauge series · district independent"
      : spatialMode === "district"
        ? `District boundary average · ${district}`
        : coordinateValid
          ? `Pakistan point coordinates · ${coordinateLat.toFixed(5)}, ${coordinateLon.toFixed(5)}`
          : "Point coordinates · incomplete or invalid";
  const coordinateStatus = manualObservedLoaded
    ? coordinateValid
      ? "Coordinates are stored as optional gauge metadata; no district boundary enters the analysis."
      : "District selection is disabled. Optional gauge coordinates do not change the uploaded rainfall or fitted IDF curves."
    : spatialMode === "district"
      ? `The verified ${district} polygon is used as the requested extraction boundary.`
      : !coordinateValid
        ? "Enter valid latitude (−90 to 90) and longitude (−180 to 180)."
        : sourceTab === "cmip6" && !coordinateInsidePakistan
          ? "The point is outside Pakistan's verified district boundaries. Choose a Pakistan district representative point or enter coordinates inside Pakistan."
        : coordinateInsideDistrict === null
          ? "Coordinates are valid; load an exact district polygon to test district membership."
          : coordinateInsideDistrict
            ? `Coordinates fall inside the selected ${district} polygon.`
            : `Warning: coordinates fall outside the selected ${district} polygon.`;
  function useActiveAtlasOutlet() {
    const outlet = coordinateValid
      ? { lat: coordinateLat, lon: coordinateLon }
      : districtRepresentativePoint;
    if (!outlet) {
      setWatershedGeometryMessage(
        "Enter point coordinates or load a verified district boundary first.",
      );
      return;
    }
    setWatershedOutletLatitude(outlet.lat.toFixed(6));
    setWatershedOutletLongitude(outlet.lon.toFixed(6));
    setWatershedGeometryMessage(
      coordinateValid
        ? "Active atlas point copied as the watershed outlet."
        : `Representative point for ${district} copied. Move it onto the intended river before delineation.`,
    );
  }
  async function calculateMghydroGeometry() {
    const latitude = Number(watershedOutletLatitude),
      longitude = Number(watershedOutletLongitude);
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      latitude < -60 ||
      latitude > 85 ||
      longitude < -180 ||
      longitude > 180
    ) {
      setWatershedGeometryMessage(
        "Enter a valid MGHydro outlet: latitude −60 to 85 and longitude −180 to 180.",
      );
      return;
    }
    setWatershedGeometryBusy(true);
    setWatershedGeometryResult(null);
    setWatershedGeometryMessage(
      "Delineating the watershed, retrieving the river network and profiling the longest connected flow path…",
    );
    try {
      const response = await fetch("/api/watershed-geometry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "mghydro",
            latitude,
            longitude,
            precision: watershedPrecision,
          }),
        }),
        payload = (await response.json()) as WatershedGeometryResponse;
      if (!response.ok || payload.status !== "complete" || !payload.result)
        throw new Error(payload.error ?? "MGHydro calculation failed.");
      setWatershedGeometryResult(payload.result);
      setFlowPathFileName("");
      setWatershedGeometryMessage(
        `Automatic geometry complete: ${(payload.result.lengthMetres / 1000).toFixed(2)} km longest connected flow path. Review the watershed and outlet before design use.`,
      );
    } catch (error) {
      setWatershedGeometryMessage(
        error instanceof Error
          ? error.message
          : "The MGHydro calculation failed.",
      );
    } finally {
      setWatershedGeometryBusy(false);
    }
  }
  async function uploadFlowPathGeometry(file?: File) {
    if (!file) return;
    setWatershedGeometryBusy(true);
    setWatershedGeometryResult(null);
    setFlowPathFileName(file.name);
    setWatershedGeometryMessage(
      "Reading the flow path and retrieving elevations for the endpoint and 10–85% slopes…",
    );
    try {
      let data: unknown;
      if (file.name.toLowerCase().endsWith(".zip")) {
        const shp = (await import("shpjs")).default;
        data = await shp(await file.arrayBuffer());
      } else data = JSON.parse(await file.text()) as unknown;
      const lines = extractLineStrings(data);
      if (!lines.length)
        throw new Error(
          "No LineString flow path was found. Upload one selected longest path as GeoJSON or a zipped line shapefile.",
        );
      const coordinates = [...lines].sort(
        (a, b) =>
          calculateFlowPathLengthMetres(b) - calculateFlowPathLengthMetres(a),
      )[0];
      const response = await fetch("/api/watershed-geometry", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "profile", coordinates }),
        }),
        payload = (await response.json()) as WatershedGeometryResponse;
      if (!response.ok || payload.status !== "complete" || !payload.result)
        throw new Error(payload.error ?? "Flow-path profiling failed.");
      setWatershedGeometryResult(payload.result);
      setWatershedGeometryMessage(
        `Uploaded flow path profiled: ${(payload.result.lengthMetres / 1000).toFixed(2)} km. Confirm that the selected line is the hydraulically longest path.`,
      );
    } catch (error) {
      setWatershedGeometryMessage(
        error instanceof Error
          ? error.message
          : "The flow-path file could not be processed.",
      );
    } finally {
      setWatershedGeometryBusy(false);
    }
  }
  function downloadWatershedGeometry() {
    if (!watershedGeometryResult) return;
    const features = [
      ...(watershedGeometryResult.watershed?.features ?? []),
      {
        type: "Feature" as const,
        properties: {
          layer: "longest_connected_flow_path",
          length_m: watershedGeometryResult.lengthMetres,
          endpoint_slope: watershedGeometryResult.endpointSlopeMPerM,
          slope_10_85: watershedGeometryResult.slope10To85MPerM,
          elevation_source: watershedGeometryResult.elevationSource,
        },
        geometry: {
          type: "LineString",
          coordinates: watershedGeometryResult.coordinates,
        },
      },
    ];
    save(
      new Blob(
        [JSON.stringify({ type: "FeatureCollection", features }, null, 2)],
        { type: "application/geo+json" },
      ),
      `watershed-flow-path-${watershedGeometryResult.outletLatitude.toFixed(4)}-${watershedGeometryResult.outletLongitude.toFixed(4)}.geojson`,
    );
  }
  const loadOnlineBoundary = useCallback(
    async (level: "district" | "tehsil", selectedDistrict = "Peshawar") => {
      const config =
        level === "district"
          ? {
              url: "/data/pakistan-districts-ocha-2024.geojson",
              period: "09 Sep 2022–27 Sep 2024",
              license: "CC BY-IGO",
              label: "District",
              identity: "OCHA COD-AB PAK ADM2 · v01",
            }
          : {
              url: "/data/pakistan-tehsils-2017.geojson",
              period: "represented year 2017",
              license: "ODbL 1.0",
              label: "Tehsil",
              identity: "geoBoundaries PAK ADM3 · 2017",
            };
      setDistrictLocked(false);
      setBoundaryLevel(level);
      setGeoMessage(`Loading ${config.label.toLowerCase()} boundaries online…`);
      try {
        const data = await fetchGeoCollection(config.url);
        setGeo(data);
        if (level === "district") setPakistanDistrictGeo(data);
        setBoundary(config.identity);
        setGeoMessage(
          `${data.features.length} ${config.label.toLowerCase()} features loaded online · ${config.period} · ${config.license}. District names are reconciled to the analysis dropdown without substituting historic parent districts.`,
        );
        if (level === "district") setMapSelection(selectedDistrict);
        else setMapSelection("Select a tehsil on the map");
      } catch (e) {
        setGeo(null);
        setGeoMessage(
          `${e instanceof Error ? e.message : "Online boundary failed."} Use the official OCHA shapefile upload as the fallback.`,
        );
      }
    },
    [],
  );
  useEffect(() => {
    let active = true;
    void fetchGeoCollection("/data/pakistan-districts-ocha-2024.geojson")
      .then((data) => {
        if (!active) return;
        setGeo(data);
        setPakistanDistrictGeo(data);
        setBoundary("OCHA COD-AB PAK ADM2 · v01");
        setGeoMessage(
          `${data.features.length} district features loaded online · 09 Sep 2022–27 Sep 2024 · CC BY-IGO. District names are reconciled to the analysis dropdown without substituting historic parent districts.`,
        );
        setMapSelection("Peshawar");
      })
      .catch((e) => {
        if (active)
          setGeoMessage(
            `${e instanceof Error ? e.message : "Online boundary failed."} Use the official OCHA shapefile upload as the fallback.`,
          );
      });
    return () => {
      active = false;
    };
  }, []);
  function developIdfFromRetrievedCovariates(
    candidates: AnnualCovariate[],
  ) {
    const comparison = compareCovariateModels(ams, candidates),
      selectedModelId = comparison.selectedModelId;
    setMethod("gev");
    setCovariateEvaluationBasis("record-mean");

    if (comparison.status !== "Compared") {
      setModelTab("stationary");
      setCovariateWorkflowStatus(
        `IDF development stopped: ${comparison.decisionReason}`,
      );
    } else if (selectedModelId === "time") {
      setModelTab("nonstationary");
      setNonstationaryCovariate("time");
      setReferenceYearBasis("record-center");
      setCovariateWorkflowStatus(
        `IDF complete. Time passed the full comparison and the nonstationary GEV curve was generated at the automatic record-centre year. ${comparison.decisionReason}`,
      );
    } else if (
      selectedModelId &&
      selectedModelId !== "stationary" &&
      candidates.some((candidate) => candidate.id === selectedModelId)
    ) {
      const selected = candidates.find(
        (candidate) => candidate.id === selectedModelId,
      )!;
      setSelectedCovariateId(selectedModelId);
      setNonstationaryCovariate("matched");
      setModelTab("nonstationary");
      setCovariateWorkflowStatus(
        `IDF complete. ${selected.label} passed the AICc, residual, coefficient-uncertainty and held-out checks. Its nonstationary GEV curve was generated at the mean matched covariate value.`,
      );
    } else {
      setModelTab("stationary");
      setCovariateWorkflowStatus(
        selectedModelId === "stationary"
          ? `IDF complete. The stationary GEV was retained because no nonstationary candidate improved the complete evidence set. ${comparison.decisionReason}`
          : `IDF complete with the stationary GEV reference curve. The covariate comparison was inconclusive, so the retrieved covariate was not forced into the design curve. ${comparison.decisionReason}`,
      );
    }

    setTimeout(() =>
      document
        .getElementById("idf-results")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0,
    );
  }
  async function extractOnlinePrecipitation() {
    if (
      !Object.hasOwn(LIVE_SOURCE_CONFIG, onlineSource)
    ) {
      setOnlineMessage("Choose a supported live precipitation source.");
      return;
    }
    if (onlineSource === "era5land") {
      setOnlineMessage(ERA5_LAND_PRECIPITATION_NOTICE);
      return;
    }
    if (spatialMode === "point" && !coordinateValid) {
      setOnlineMessage(
        "Enter valid latitude and longitude before point extraction.",
      );
      return;
    }
    if (spatialMode === "district" && !matchedBoundaryFeature) {
      setOnlineMessage(
        "The exact selected district polygon is not loaded. Load the online district layer and try again.",
      );
      return;
    }
    if (
      onlineResolution === "hourly" &&
      onlineSource !== "era5"
    ) {
      setOnlineMessage(
        onlineSource === "chirps"
          ? "CHIRPS has no hourly product. Choose daily resolution."
          : onlineSource === "power"
            ? "The connected NASA POWER option uses corrected daily precipitation. Choose daily resolution."
            : "Native 30-minute IMERG requires authenticated NASA archive access; the connected public service supplies daily values only.",
      );
      return;
    }
    const requestStart = onlineRequestedStart,
      requestEnd = onlineRequestedEnd,
      selectionKey = [
        onlineSource,
        onlineResolution,
        spatialMode,
        district,
        spatialMode === "point" ? stationLat : "district",
        spatialMode === "point" ? stationLon : "district",
        requestStart,
        requestEnd,
      ].join("|");
    setOnlineStart(requestStart);
    setOnlineEnd(requestEnd);
    setOnlineBusy(true);
    setOnlineProgress(0);
    setOnlineQuotaBlocked(false);
    setShowOnlinePrecipitationPlot(false);
    setOnlineMessage(
      "Submitting the extraction request to the online provider…",
    );
    const post = async (payload: Record<string, unknown>) => {
      const response = await fetch("/api/online-precipitation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      let data: OnlineExtractionResponse;
      try {
        data = (await response.json()) as OnlineExtractionResponse;
      } catch {
        data = {
          status: "error",
          error: `The shared retrieval route returned HTTP ${response.status}.`,
        };
      }
      if (
        data.status === "error" &&
        payload.action === "start" &&
        payload.source === "power"
      ) {
        setOnlineMessage(
          "The shared retrieval route could not complete NASA POWER. Retrying the official POWER API directly from this browser…",
        );
        return await extractNasaPowerInBrowser(
          {
            resolution: "daily",
            mode: payload.mode as "point" | "district",
            start: String(payload.start),
            end: String(payload.end),
            latitude: payload.latitude as number | undefined,
            longitude: payload.longitude as number | undefined,
            geometry: payload.geometry as OnlineGeometry | undefined,
            districtName: payload.districtName as string | undefined,
            districtCode: payload.districtCode as string | undefined,
            boundarySource: payload.boundarySource as string | undefined,
            boundaryVersion: payload.boundaryVersion as string | undefined,
            boundaryValidOn: payload.boundaryValidOn as string | undefined,
          },
          setOnlineProgress,
        );
      }
      if (
        data.status === "error" &&
        (payload.source === "chirps" ||
          payload.source === "imerg" ||
          payload.source === "imergEarly")
      ) {
        setOnlineMessage(
          `The shared retrieval route could not complete ${payload.source === "chirps" ? "CHIRPS" : payload.source === "imergEarly" ? "IMERG Early" : "IMERG Late"}. Retrying ClimateSERV directly from this browser…`,
        );
        return await climateServInBrowser(
          {
            action: payload.action as "start" | "poll",
            source: payload.source,
            mode: payload.mode as "point" | "district",
            start: String(payload.start),
            end: String(payload.end),
            latitude: payload.latitude as number | undefined,
            longitude: payload.longitude as number | undefined,
            geometry: payload.geometry as OnlineGeometry | undefined,
            jobs: payload.jobs as OnlineJob[] | undefined,
            districtName: payload.districtName as string | undefined,
            districtCode: payload.districtCode as string | undefined,
            boundarySource: payload.boundarySource as string | undefined,
            boundaryVersion: payload.boundaryVersion as string | undefined,
            boundaryValidOn: payload.boundaryValidOn as string | undefined,
          },
          setOnlineProgress,
        );
      }
      if (
        data.status === "error" &&
        payload.action === "start" &&
        (payload.source === "era5" || payload.source === "era5land") &&
        /HTTP (429|502|503|504)|temporarily throttled|try again later/i.test(
          data.error,
        )
      ) {
        setOnlineMessage(
          `The shared retrieval service is temporarily throttled. Retrying ${payload.source === "era5land" ? "ERA5-Land" : "ERA5"} directly from this browser…`,
        );
        return await extractEra5InBrowser(
          {
            source: payload.source as "era5" | "era5land",
            resolution: payload.resolution as OnlineTemporalResolution,
            mode: payload.mode as "point" | "district",
            start: String(payload.start),
            end: String(payload.end),
            latitude: payload.latitude as number | undefined,
            longitude: payload.longitude as number | undefined,
            geometry: payload.geometry as OnlineGeometry | undefined,
            districtName: payload.districtName as string | undefined,
            districtCode: payload.districtCode as string | undefined,
            boundarySource: payload.boundarySource as string | undefined,
            boundaryVersion: payload.boundaryVersion as string | undefined,
            boundaryValidOn: payload.boundaryValidOn as string | undefined,
          },
          setOnlineProgress,
        );
      }
      if (data.status === "error") throw new Error(data.error);
      if (!response.ok)
        throw new Error("The online extraction service rejected the request.");
      return data;
    };
    try {
      const startPayload = {
        action: "start",
        source: onlineSource,
        resolution: onlineResolution,
        mode: spatialMode,
        start: requestStart,
        end: requestEnd,
        latitude: spatialMode === "point" ? coordinateLat : undefined,
        longitude: spatialMode === "point" ? coordinateLon : undefined,
        geometry:
          spatialMode === "district"
            ? matchedBoundaryFeature?.geometry
            : undefined,
        districtName:
          spatialMode === "district" ? matchedBoundaryIdentity?.name : undefined,
        districtCode:
          spatialMode === "district" ? matchedBoundaryIdentity?.code : undefined,
        boundarySource:
          spatialMode === "district" ? matchedBoundaryIdentity?.source : undefined,
        boundaryVersion:
          spatialMode === "district" ? matchedBoundaryIdentity?.version : undefined,
        boundaryValidOn:
          spatialMode === "district" ? matchedBoundaryIdentity?.validOn : undefined,
      };
      let response: OnlineExtractionResponse;
      if (onlineSource === "era5") {
        setOnlineMessage(
          `Retrieving ERA5 directly from Open-Meteo with a quota-bounded ${spatialMode === "district" ? `${ERA5_DISTRICT_CELL_LIMIT[onlineResolution]}-cell district sample` : "point request"}…`,
        );
        try {
          response = await extractEra5InBrowser(
            {
              source: onlineSource,
              resolution: onlineResolution,
              mode: spatialMode,
              start: requestStart,
              end: requestEnd,
              latitude: spatialMode === "point" ? coordinateLat : undefined,
              longitude: spatialMode === "point" ? coordinateLon : undefined,
              geometry:
                spatialMode === "district"
                  ? matchedBoundaryFeature?.geometry
                  : undefined,
              districtName:
                spatialMode === "district"
                  ? matchedBoundaryIdentity?.name
                  : undefined,
              districtCode:
                spatialMode === "district"
                  ? matchedBoundaryIdentity?.code
                  : undefined,
              boundarySource:
                spatialMode === "district"
                  ? matchedBoundaryIdentity?.source
                  : undefined,
              boundaryVersion:
                spatialMode === "district"
                  ? matchedBoundaryIdentity?.version
                  : undefined,
              boundaryValidOn:
                spatialMode === "district"
                  ? matchedBoundaryIdentity?.validOn
                  : undefined,
            },
            setOnlineProgress,
          );
        } catch (error) {
          if (
            error instanceof TypeError ||
            (error instanceof Error &&
              /failed to fetch|network|cors/i.test(error.message))
          ) {
            setOnlineMessage(
              "Direct browser access is unavailable. Retrying the same quota-bounded ERA5 request through the shared route…",
            );
            response = await post(startPayload);
          } else {
            throw error;
          }
        }
      } else {
        response = await post(startPayload);
      }
      let attempts = 0;
      while (response.status === "processing") {
        setOnlineProgress(response.progress);
        setOnlineMessage(response.message);
        if (attempts++ >= 180)
          throw new Error(
            "The provider is still processing after nine minutes. Please try a shorter record or try again later.",
          );
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const jobs: OnlineJob[] = response.jobs;
        response = await post({
          action: "poll",
          source: onlineSource,
          resolution: "daily",
          mode: spatialMode,
          start: requestStart,
          end: requestEnd,
          jobs,
          latitude: spatialMode === "point" ? coordinateLat : undefined,
          longitude: spatialMode === "point" ? coordinateLon : undefined,
          districtName:
            spatialMode === "district" ? matchedBoundaryIdentity?.name : undefined,
          districtCode:
            spatialMode === "district" ? matchedBoundaryIdentity?.code : undefined,
          boundarySource:
            spatialMode === "district" ? matchedBoundaryIdentity?.source : undefined,
          boundaryVersion:
            spatialMode === "district" ? matchedBoundaryIdentity?.version : undefined,
          boundaryValidOn:
            spatialMode === "district" ? matchedBoundaryIdentity?.validOn : undefined,
        });
      }
      if (response.status !== "complete")
        throw new Error(
          "The provider did not return a completed precipitation series.",
        );
      if (response.metadata.temporalResolution === "hourly") {
        setOnlineHourlyRaw(response.hourlyRecords ?? []);
        setOnlineRaw([]);
      } else {
        setOnlineRaw(response.records ?? []);
        setOnlineHourlyRaw([]);
      }
      setOnlineMetadata(response.metadata);
      setOnlineExtractionKey(selectionKey);
      setOnlineProgress(100);
      setOnlineQuotaBlocked(false);
      setOnlinePlotInterval(
        response.metadata.temporalResolution === "hourly"
          ? "daily"
          : response.metadata.acceptedRecords > 1500
            ? "monthly"
            : "native",
      );
      setShowOnlinePrecipitationPlot(true);
      setOnlineMessage(
        `Retrieved ${response.metadata.acceptedRecords.toLocaleString()} ${response.metadata.temporalResolution} values from ${response.metadata.returnedStart} to ${response.metadata.returnedEnd}. Quality control, duration-specific annual maxima and distribution fitting now use this provider series. The precipitation time-series plot is ready below.`,
      );
    } catch (error) {
      setOnlineRaw([]);
      setOnlineHourlyRaw([]);
      setOnlineMetadata(null);
      setOnlineExtractionKey("");
      setOnlineProgress(0);
      setShowOnlinePrecipitationPlot(false);
      setOnlineQuotaBlocked(
        onlineSource === "era5" &&
          error instanceof Error &&
          /HTTP 429|quota is exhausted/i.test(error.message),
      );
      setOnlineMessage(
        error instanceof Error
          ? error.message
          : "Online precipitation extraction failed.",
      );
    } finally {
      setOnlineBusy(false);
    }
  }
  async function uploadObservedWorkbook(
    file?: File,
    preferredResolution?: "daily" | "hourly",
  ) {
    if (!file) return;
    try {
      const XLSX = await import("xlsx"),
        wb = XLSX.read(await file.arrayBuffer(), {
          type: "array",
          cellDates: true,
        });
      const parsed = parseObservedWorkbook(XLSX, wb, { preferredResolution }),
        records =
          parsed.resolution === "hourly"
            ? parsed.hourlyRecords
            : parsed.dailyRecords,
        keyOf = (row: DailyRecord | HourlyRecord) =>
          "timestamp" in row ? row.timestamp : row.date;
      const { resolution, sheets } = parsed;
      setObservedResolution(resolution);
      setSpatialMode("point");
      if (resolution === "hourly") setModelTab("stationary");
      if (resolution === "hourly") {
        setHourlyRaw(parsed.hourlyRecords);
        setRaw([]);
      } else {
        setRaw(parsed.dailyRecords);
        setHourlyRaw([]);
      }
      const dates = records.map((row) => keyOf(row).slice(0, 10));
      setStart(dates[0]);
      setEnd(dates.at(-1)!);
      const aggregation = parsed.aggregatedSubhourlyRows
        ? ` ${parsed.parsedRows.toLocaleString()} sub-hourly source rows were summed within each clock hour; ${parsed.aggregatedSubhourlyRows.toLocaleString()} rows were consolidated by that aggregation.`
        : "";
      const counterRecovery = parsed.recoveredCounterRows
        ? ` Recovered ${parsed.recoveredCounterRows.toLocaleString()} consecutive hourly timestamps from the file's cumulative counter and verified the complete sequence before analysis.`
        : "";
      const otherResolution = parsed.otherResolutionRows
        ? ` ${parsed.otherResolutionRows.toLocaleString()} valid rows at the other time resolution were not mixed into this analysis.`
        : "";
      setMessage(
        `Auto-read ${records.length.toLocaleString()} ${resolution} records from ${parsed.parsedRows.toLocaleString()} valid source rows in ${sheets.length} compatible worksheet${sheets.length === 1 ? "" : "s"} (${sheets.join(", ")}).${counterRecovery}${aggregation} ${parsed.duplicateRows.toLocaleString()} exact duplicate timestamps were merged; ${parsed.invalidRows.toLocaleString()} rows without a valid date/time or precipitation value were ignored.${otherResolution} Timestamps were preserved as local clock time with no timezone shift. District-boundary averaging is disabled and the file remained local.`,
      );
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Could not auto-read the workbook.",
      );
    }
  }
  async function upload(file?: File) {
    return uploadObservedWorkbook(file, "daily");
  }
  async function uploadHourly(file?: File) {
    return uploadObservedWorkbook(file, "hourly");
  }
  async function retrieveCmipPrecipitation() {
    if (cmipSelectionMode !== "individual") {
      setCmipDataMessage(
        "Direct retrieval fits one GCM at a time. Choose Individual GCM model, retrieve and fit each model, then calculate the multi-model median from model-specific return levels.",
      );
      return;
    }
    if (spatialMode === "point" && !cmipCoordinateReady) {
      setCmipDataMessage(
        "Enter latitude and longitude inside Pakistan before point GCM extraction.",
      );
      return;
    }
    if (spatialMode === "district" && !matchedBoundaryFeature) {
      setCmipDataMessage(
        "The exact selected district polygon is not loaded. Load the verified district layer and try again.",
      );
      return;
    }
    const [startYear, endYear] = cmipPeriod.split("-").map(Number);
    setCmipBusy(true);
    setCmipProgress(1);
    setCmipRaw([]);
    setCmipLoadedKey("");
    setCmipMetadata(null);
    setShowCmipPrecipitationPlot(false);
    setCmipDataMessage(
      `Checking the NASA catalogue for ${selectedCmipModel}, ${CMIP6_SCENARIOS[cmipScenario].label}…`,
    );
    const post = async (payload: Record<string, unknown>) => {
      const cacheKey =
        payload.action === "year" ? JSON.stringify(payload) : "";
      const cached = cacheKey
        ? cmip6AnnualResponseCache.get(cacheKey)
        : undefined;
      if (cached) return cached as unknown as Record<string, unknown>;
      const timeoutMs = payload.action === "year" ? 125_000 : 45_000;
      let response: Response;
      try {
        response = await fetch("/api/cmip6-precipitation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new Error(
          `The NASA request did not finish within ${Math.round(timeoutMs / 1000)} seconds. Retry the same selection; completed annual subsets remain cached in this browser tab. ${error instanceof Error ? error.message : ""}`.trim(),
        );
      }
      const data = (await response.json().catch(() => ({
        error: `The CMIP6 retrieval route returned HTTP ${response.status}.`,
      }))) as Record<string, unknown>;
      if (!response.ok || typeof data.error === "string")
        throw new Error(
          typeof data.error === "string"
            ? data.error
            : `The CMIP6 retrieval route returned HTTP ${response.status}.`,
        );
      if (cacheKey) {
        if (cmip6AnnualResponseCache.size >= CMIP6_ANNUAL_CACHE_LIMIT) {
          const oldest = cmip6AnnualResponseCache.keys().next().value;
          if (oldest) cmip6AnnualResponseCache.delete(oldest);
        }
        cmip6AnnualResponseCache.set(
          cacheKey,
          data as unknown as Cmip6AnnualResponse,
        );
      }
      return data;
    };
    try {
      const catalogue = (await post({
        action: "catalogue",
        model: selectedCmipModel,
        scenario: cmipScenario,
        member: cmipMember,
        startYear,
        endYear,
      })) as unknown as Cmip6Catalogue;
      setCmipMember(catalogue.selectedMember);
      setCmipProgress(5);
      setCmipDataMessage(
        `Retrieving ${catalogue.files.length} annual NASA subsets for ${catalogue.model}, ${catalogue.selectedMember}. District requests use NASA's supported NetCDF-3 subset format; completed years are cached in this browser tab.`,
      );
      const groups: DailyRecord[][] = [];
      let maximumGridCells = 0;
      let returnedLatitude: number | undefined;
      let returnedLongitude: number | undefined;
      let usedNearestCellFallback = false;
      const sourceCalendars = new Set<string>();
      const sourceTimeUnits = new Set<string>();
      const calendarConversions = new Set<string>();
      const batchSize = spatialMode === "district" ? 2 : 4;
      for (let offset = 0; offset < catalogue.files.length; offset += batchSize) {
        const batch = catalogue.files.slice(offset, offset + batchSize);
        const annual = await Promise.all(
          batch.map(async (file) => {
            const response = await post({
              action: "year",
              model: selectedCmipModel,
              scenario: cmipScenario,
              member: catalogue.selectedMember,
              year: file.year,
              fileName: file.fileName,
              mode: spatialMode,
              latitude:
                spatialMode === "point" ? coordinateLat : undefined,
              longitude:
                spatialMode === "point" ? coordinateLon : undefined,
              geometry:
                spatialMode === "district"
                  ? matchedBoundaryFeature?.geometry
                  : undefined,
            });
            return response as Cmip6AnnualResponse;
          }),
        );
        for (const response of annual) {
          groups.push(response.records);
          maximumGridCells = Math.max(
            maximumGridCells,
            Number(response.extractedGridCells) || 0,
          );
          returnedLatitude ??= response.returnedLatitude;
          returnedLongitude ??= response.returnedLongitude;
          usedNearestCellFallback ||= Boolean(
            response.nearestCellFallback,
          );
          if (response.sourceCalendar)
            sourceCalendars.add(response.sourceCalendar);
          if (response.sourceTimeUnits)
            sourceTimeUnits.add(response.sourceTimeUnits);
          if (response.calendarConversion)
            calendarConversions.add(response.calendarConversion);
        }
        const completed = Math.min(
          catalogue.files.length,
          offset + batch.length,
        );
        setCmipProgress(
          Math.round(5 + (completed / catalogue.files.length) * 90),
        );
        setCmipDataMessage(
          `Retrieved ${completed} of ${catalogue.files.length} annual NASA subsets for ${catalogue.model}, ${catalogue.selectedMember}…`,
        );
      }
      const records = mergeDailyRecords(groups);
      if (!records.length)
        throw new Error(
          "NASA completed the subsets but returned no usable daily precipitation values.",
        );
      const metadata: Cmip6ExtractionMetadata = {
        dataset: "NASA NEX-GDDP-CMIP6 v2",
        provider: "NASA Center for Climate Simulation",
        providerUrl:
          "https://www.nccs.nasa.gov/data-collections/nex-gddp-cmip6/",
        retrievalService: "NCCS THREDDS NetCDF Subset Service",
        model: selectedCmipModel,
        modelFolder: catalogue.modelFolder,
        scenario: cmipScenario,
        member: catalogue.selectedMember,
        variable: "pr",
        sourceUnits: "kg m-2 s-1",
        sourceTimeUnits:
          [...sourceTimeUnits].join(", ") || "not reported by provider",
        outputUnits: "mm/day",
        nativeResolution: "Daily · 0.25°",
        sourceCalendar:
          [...sourceCalendars].join(", ") || "not reported by provider",
        calendarConversion:
          [...calendarConversions].join(" ") ||
          "No calendar conversion was reported by the provider response.",
        extractionMode: spatialMode,
        spatialMethod:
          spatialMode === "district"
            ? usedNearestCellFallback
              ? "The district was smaller than a native 0.25° cell; the nearest NASA grid cell to the polygon centre was used and explicitly flagged."
              : "Daily mean of NASA 0.25° grid-cell centres inside the verified district polygon, weighted by cell-area latitude."
            : "NASA NCSS grid-as-point extraction at the requested coordinate; the returned containing grid cell is recorded.",
        requestedStart: `${startYear}-01-01`,
        requestedEnd: `${endYear}-12-31`,
        returnedStart: records[0].date,
        returnedEnd: records.at(-1)!.date,
        acceptedRecords: records.length,
        extractedGridCells: maximumGridCells,
        requestedLatitude:
          spatialMode === "point" ? coordinateLat : undefined,
        requestedLongitude:
          spatialMode === "point" ? coordinateLon : undefined,
        returnedLatitude,
        returnedLongitude,
        districtName:
          spatialMode === "district"
            ? (matchedBoundaryIdentity?.name ?? district)
            : undefined,
        districtCode:
          spatialMode === "district"
            ? matchedBoundaryIdentity?.code
            : undefined,
        boundarySource:
          spatialMode === "district"
            ? matchedBoundaryIdentity?.source
            : undefined,
        boundaryVersion:
          spatialMode === "district"
            ? matchedBoundaryIdentity?.version
            : undefined,
        boundaryValidOn:
          spatialMode === "district"
            ? matchedBoundaryIdentity?.validOn
            : undefined,
        retrievedAt: new Date().toISOString(),
      };
      setCmipRaw(records);
      setCmipMetadata(metadata);
      setCmipLoadedKey(currentCmipDataKey);
      setCmipPlotInterval(records.length > 365 ? "annual-maxima" : "native");
      setShowCmipPrecipitationPlot(true);
      setCmipProgress(100);
      setCmipDataMessage(
        `Retrieved ${records.length.toLocaleString()} actual daily pr values from NASA for ${selectedCmipModel}, ${catalogue.selectedMember}, ${CMIP6_SCENARIOS[cmipScenario].label}, ${cmipPeriod}. The atlas converted kg m⁻² s⁻¹ to mm/day, applied the reported ${metadata.sourceCalendar} calendar rule without adding synthetic rainfall, ran QC and annual-maxima extraction, fitted the selected distributions, generated the 24-hour IDF and opened the precipitation plot.`,
      );
      setTimeout(
        () =>
          document
            .getElementById("idf-results")
            ?.scrollIntoView({ behavior: "smooth", block: "start" }),
        0,
      );
    } catch (error) {
      setCmipRaw([]);
      setCmipLoadedKey("");
      setCmipMetadata(null);
      setCmipProgress(0);
      setShowCmipPrecipitationPlot(false);
      setCmipDataMessage(
        error instanceof Error
          ? error.message
          : "Direct NASA CMIP6 precipitation retrieval failed.",
      );
    } finally {
      setCmipBusy(false);
    }
  }
  async function retrieveHistoricalCmipForBiasCorrection() {
    if (spatialMode !== "point" || !cmipCoordinateReady) {
      setCmipHistoricalMessage("Historical validation requires Point/grid-cell extraction at coordinates inside Pakistan.");
      return;
    }
    const gaugeAvailable = gaugeHistoricalQc.eligibleYears >= 20;
    const shouldUseEra5 = cmipBiasReference === "era5" || (cmipBiasReference === "auto" && !gaugeAvailable);
    if (cmipBiasReference === "gauge" && !gaugeAvailable) {
      setCmipHistoricalMessage("Observed gauge only is selected, but fewer than 20 complete gauge years overlap 1985–2014. Upload an adequate gauge series or choose Automatic / ERA5 reanalysis.");
      return;
    }
    setCmipBusy(true);
    setCmipHistoricalRaw([]);
    if (shouldUseEra5) setCmipEra5ReferenceRaw([]);
    setCmipHistoricalLoadedKey("");
    setCmipHistoricalMessage(`Retrieving ${shouldUseEra5 ? "ERA5 reference and " : ""}${selectedCmipModel} historical 1985–2014 at the project grid cell…`);
    const post = async (payload: Record<string, unknown>) => {
      const response = await fetch("/api/cmip6-precipitation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(payload.action === "year" ? 125_000 : 45_000),
      });
      const data = await response.json() as Record<string, unknown>;
      if (!response.ok || typeof data.error === "string") throw new Error(String(data.error ?? `Historical CMIP6 request returned HTTP ${response.status}.`));
      return data;
    };
    try {
      let referenceCount = observedAms.length;
      if (shouldUseEra5) {
        const era5Request: DirectEra5Request = {
          source: "era5",
          resolution: "daily",
          mode: "point",
          start: "1985-01-01",
          end: "2014-12-31",
          latitude: coordinateLat,
          longitude: coordinateLon,
        };
        let era5 = await extractEra5InBrowser(
          era5Request,
          value => setCmipHistoricalMessage(`Retrieving ERA5 bias-correction reference… ${value}%`),
        );
        let era5Records = era5.status === "complete" && era5.metadata.temporalResolution === "daily"
          ? (era5.records ?? [])
          : [];
        let era5Qc = assess(era5Records);
        if (era5Qc.eligibleYears < 20) {
          setCmipHistoricalMessage(
            `ERA5 reference was incomplete (${era5Qc.eligibleYears} eligible years). Refreshing the provider record and retrying missing coverage…`,
          );
          era5 = await extractEra5InBrowser(
            { ...era5Request, bypassCache: true },
            value => setCmipHistoricalMessage(`Refreshing ERA5 bias-correction reference… ${value}%`),
          );
          era5Records = era5.status === "complete" && era5.metadata.temporalResolution === "daily"
            ? (era5.records ?? [])
            : [];
          era5Qc = assess(era5Records);
        }
        if (era5Qc.eligibleYears < 20) {
          const counts = new Map<number, number>();
          for (const row of era5Qc.records) {
            const year = Number(row.date.slice(0, 4));
            counts.set(year, (counts.get(year) ?? 0) + 1);
          }
          const excluded = Array.from({ length: 30 }, (_, index) => 1985 + index)
            .filter((year) => {
              const expected = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
              return (counts.get(year) ?? 0) / expected < 0.9;
            });
          throw new Error(
            `ERA5 supplied ${era5Qc.records.length.toLocaleString()} valid daily values and ${era5Qc.eligibleYears} eligible annual maxima for 1985–2014. Bias correction requires at least 20. Excluded years (<90% complete): ${excluded.length ? excluded.join(", ") : "none identified"}.`,
          );
        }
        setCmipEra5ReferenceRaw(era5Records);
        referenceCount = era5Qc.eligibleYears;
      }
      const catalogue = await post({ action: "catalogue", model: selectedCmipModel, scenario: "historical", member: cmipMember, startYear: 1985, endYear: 2014 }) as unknown as Cmip6Catalogue;
      const groups: DailyRecord[][] = [];
      for (let offset = 0; offset < catalogue.files.length; offset += 5) {
        const batch = catalogue.files.slice(offset, offset + 5);
        const responses = await Promise.all(batch.map(file => post({
          action: "year", model: selectedCmipModel, scenario: "historical", member: catalogue.selectedMember,
          year: file.year, fileName: file.fileName, mode: "point", latitude: coordinateLat, longitude: coordinateLon,
        }) as Promise<Record<string, unknown>>));
        for (const response of responses as unknown as Cmip6AnnualResponse[]) groups.push(response.records);
        setCmipHistoricalMessage(`Historical validation: retrieved ${Math.min(offset + batch.length, 30)} of 30 years…`);
      }
      const records = mergeDailyRecords(groups);
      setCmipHistoricalRaw(records);
      setCmipHistoricalLoadedKey(currentCmipHistoricalKey);
      setCmipHistoricalMessage(`Historical comparison ready: ${annualMaxima(records, 1).length} GCM annual maxima versus ${referenceCount} ${shouldUseEra5 ? "ERA5 reanalysis" : "nearby-gauge"} annual maxima. Monthly multiplicative QDM is now applied to every future daily value before annual maxima and the 24-hour GEV are fitted. ${shouldUseEra5 ? "This is reanalysis-corrected, not gauge-corrected." : ""}`);
    } catch (error) {
      setCmipHistoricalMessage(error instanceof Error ? error.message : "Historical GCM retrieval failed.");
    } finally {
      setCmipBusy(false);
    }
  }
  async function uploadCmipPrecipitation(file?: File) {
    if (!file) return;
    try {
      const XLSX = await import("xlsx"),
        workbook = XLSX.read(await file.arrayBuffer(), {
          type: "array",
          cellDates: true,
        }),
        parsed = parseObservedWorkbook(XLSX, workbook, {
          preferredResolution: "daily",
        });
      if (parsed.resolution !== "daily")
        throw new Error(
          "The selected GCM file was detected as hourly/sub-daily. NASA NEX-GDDP-CMIP6 precipitation is a daily product; upload a daily Date + precipitation/rainfall table.",
        );
      const [firstYear, lastYear] = cmipPeriod.split("-").map(Number),
        periodRecords = parsed.dailyRecords.filter((record) => {
          const year = Number(record.date.slice(0, 4));
          return year >= firstYear && year <= lastYear;
        });
      if (!periodRecords.length)
        throw new Error(
          `No valid daily precipitation values fall inside the selected ${cmipPeriod} period. Change the time slice or upload the matching GCM export.`,
        );
      setCmipRaw(periodRecords);
      setCmipMetadata(null);
      setCmipLoadedKey(currentCmipDataKey);
      setCmipPlotInterval(
        periodRecords.length > 1500 ? "monthly" : "native",
      );
      setShowCmipPrecipitationPlot(true);
      setCmipDataMessage(
        `Loaded ${periodRecords.length.toLocaleString()} daily GCM precipitation values for ${cmipModelLabel}, ${CMIP6_SCENARIOS[cmipScenario].label}, ${cmipPeriod}. The chart and IDF now use these uploaded values in millimetres; no screening multiplier is used. ${parsed.duplicateRows.toLocaleString()} duplicate dates were merged and ${parsed.invalidRows.toLocaleString()} invalid rows were ignored.`,
      );
    } catch (error) {
      setCmipRaw([]);
      setCmipLoadedKey("");
      setCmipMetadata(null);
      setShowCmipPrecipitationPlot(false);
      setCmipDataMessage(
        error instanceof Error
          ? error.message
          : "Could not read the GCM precipitation file.",
      );
    } finally {
      if (cmipInput.current) cmipInput.current.value = "";
    }
  }
  async function uploadBiasCorrectedCmipWorkbook(file?: File) {
    if (!file) return;
    try {
      const XLSX = await import("xlsx"),
        workbook = XLSX.read(await file.arrayBuffer(), {
          type: "array",
          cellDates: true,
        }),
        parsed = parseBiasCorrectedCmipWorkbook(XLSX, workbook),
        profile =
          parsed.profiles.find(
            (item) =>
              item.scenario === cmipScenario && item.period === cmipPeriod,
          ) ?? parsed.profiles[0],
        importedModels: StoredCmipModel[] = parsed.models.map((item) => ({
          model: item.model,
          rows: item.rows,
          selectionKey: cmipEnsembleSelectionKey({
            scenario: item.scenario,
            period: item.period,
            latitude: parsed.latitude,
            longitude: parsed.longitude,
            reference: parsed.referenceLabel,
            model: "stationary",
            method: "gev",
            durationBasis: "24-hour-only",
          }),
          correctionReference: `Imported workbook · ${parsed.referenceLabel} · ${parsed.historicalPeriod}`,
        })),
        importedKeys = new Set(
          importedModels.map((item) => item.selectionKey),
        );
      setCmipEnsembleModels((previous) => [
        ...previous.filter((item) => !importedKeys.has(item.selectionKey)),
        ...importedModels,
      ]);
      setCmipImportedWorkbook(parsed);
      setSourceTab("cmip6");
      setSpatialMode("point");
      setStationLat(String(parsed.latitude));
      setStationLon(String(parsed.longitude));
      setCmipScenario(profile.scenario);
      setCmipPeriod(profile.period);
      setCustomReferenceYear(CMIP6_PERIODS[profile.period].midpoint);
      setCmipSelectionMode("ensemble");
      setModelTab("stationary");
      setMethod("gev");
      setObservedResolution("daily");
      setCmipBiasReference(
        /era5/i.test(parsed.referenceLabel) ? "era5" : "gauge",
      );
      setCmipRaw([]);
      setCmipLoadedKey("");
      setCmipMetadata(null);
      setShowCmipPrecipitationPlot(false);
      setCmipDataMessage(
        `Imported ${parsed.modelRows.toLocaleString()} model-specific corrected 24-hour return levels for ${parsed.locationName} from ${parsed.models.length} model/scenario profiles. The active ${CMIP6_SCENARIOS[profile.scenario].label} ${profile.period} ensemble contains ${profile.modelCount} models and reports the median with P10–P90 model spread. Validation status: ${parsed.validationStatus}. Daily precipitation and sub-daily curves were not inferred from summary return levels.`,
      );
      setCmipHistoricalMessage(
        `Imported precomputed bias-corrected return levels use ${parsed.referenceLabel} over ${parsed.historicalPeriod}. The Atlas revalidated coordinates, scenario/period labels, depth-to-intensity conversion, curve monotonicity, common return periods and the supplied ensemble summary.`,
      );
    } catch (error) {
      setCmipDataMessage(
        error instanceof Error
          ? error.message
          : "Could not validate the bias-corrected CMIP6 workbook.",
      );
    } finally {
      if (cmipResultsInput.current) cmipResultsInput.current.value = "";
    }
  }
  async function uploadCovariates(file?: File) {
    if (!file) return;
    try {
      const XLSX = await import("xlsx"),
        workbook = XLSX.read(await file.arrayBuffer(), {
          type: "array",
          cellDates: true,
        }),
        parsed = parseCovariateWorkbook(XLSX, workbook);
      setAnnualCovariates(parsed.covariates);
      const firstRankable = parsed.covariates.find(
        (candidate) => candidate.physicallyPlausible,
      );
      if (firstRankable) {
        setSelectedCovariateId(firstRankable.id);
        setNonstationaryCovariate("matched");
      }
      setCovariateMessage(
        `Read ${parsed.covariates.length} annual covariate series from ${parsed.sheets.length} worksheet${parsed.sheets.length === 1 ? "" : "s"}. ${parsed.acceptedValues.toLocaleString()} numeric year-values were accepted; ${parsed.duplicateYears.toLocaleString()} duplicate year-values were replaced by the last stated value.${parsed.ignoredColumns.length ? ` Ignored short/non-numeric columns: ${parsed.ignoredColumns.join(", ")}.` : ""} Models are compared only on shared eligible years; correlation is not a selection criterion.`,
      );
    } catch (error) {
      setAnnualCovariates([]);
      setSelectedCovariateId("");
      setNonstationaryCovariate("time");
      setCovariateMessage(
        error instanceof Error
          ? error.message
          : "Could not read the annual covariate workbook.",
      );
    } finally {
      if (covariateInput.current) covariateInput.current.value = "";
    }
  }
  async function retrieveOnlineCovariates(
    sources: OnlineCovariateSource[] = [onlineCovariateSource],
  ) {
    const eligibleYears = ams.map((row) => row.year).sort((a, b) => a - b);
    if (eligibleYears.length < 20) {
      setCovariateMessage(
        "Load or retrieve precipitation with at least 20 eligible annual maxima before retrieving matched annual covariates.",
      );
      return;
    }
    const spatialSources = sources.filter(
      (source) => source === "temperature" || source === "moisture",
    );
    if (spatialSources.length && spatialMode === "point" && !coordinateValid) {
      if (sources.length === 1) {
        setCovariateMessage(
          "Temperature and moisture retrieval need valid gauge or point coordinates. ENSO and Pakistan urbanization can be retrieved without coordinates.",
        );
        return;
      }
      sources = sources.filter(
        (source) => source !== "temperature" && source !== "moisture",
      );
    }
    if (
      spatialSources.length &&
      spatialMode === "district" &&
      !matchedBoundaryFeature
    ) {
      if (sources.length === 1) {
        setCovariateMessage(
          "Temperature and moisture district retrieval need the exact selected district polygon. Reload the district layer and try again.",
        );
        return;
      }
      sources = sources.filter(
        (source) => source !== "temperature" && source !== "moisture",
      );
    }
    if (!sources.length) return;
    const startYear = eligibleYears[0],
      endYear = eligibleYears.at(-1)!,
      retrieved: AnnualCovariate[] = [],
      metadataRows: OnlineCovariateMetadata[] = [],
      failures: string[] = [];
    setOnlineCovariateBusy(true);
    setOnlineCovariateProgress(0);
    setCovariateWorkflowStatus(
      "Step 1 of 4 · Retrieving and aggregating the selected annual covariate…",
    );
    setCovariateMessage(
      `Retrieving ${sources.length} annual covariate source${sources.length === 1 ? "" : "s"} for the eligible ${startYear}–${endYear} annual-maxima period…`,
    );
    const post = async (
      payload: Record<string, unknown>,
      onDirectProgress?: (value: number) => void,
    ) => {
      const response = await fetch("/api/online-covariates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as OnlineCovariateResponse;
      if (
        data.status === "error" &&
        payload.action === "start" &&
        payload.source === "temperature" &&
        /HTTP 429/.test(data.error)
      ) {
        setCovariateMessage(
          "The shared ERA5 route is temporarily throttled. Continuing the same temperature extraction directly through this browser…",
        );
        return await extractEra5TemperatureInBrowser(
          {
            mode: payload.mode as "point" | "district",
            startYear: Number(payload.startYear),
            endYear: Number(payload.endYear),
            latitude: payload.latitude as number | undefined,
            longitude: payload.longitude as number | undefined,
            geometry: payload.geometry as OnlineGeometry | undefined,
          },
          onDirectProgress ?? setOnlineCovariateProgress,
        );
      }
      if (data.status === "error") throw new Error(data.error);
      if (!response.ok)
        throw new Error("The online covariate service rejected the request.");
      return data;
    };
    try {
      for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
        const source = sources[sourceIndex];
        try {
          let response = await post(
            {
              action: "start",
              source,
              mode: spatialMode,
              startYear,
              endYear,
              latitude: spatialMode === "point" ? coordinateLat : undefined,
              longitude: spatialMode === "point" ? coordinateLon : undefined,
              geometry:
                spatialMode === "district"
                  ? matchedBoundaryFeature?.geometry
                  : undefined,
            },
            (value) =>
              setOnlineCovariateProgress(
                Math.round(
                  ((sourceIndex + value / 100) / sources.length) * 100,
                ),
              ),
          );
          let attempts = 0;
          while (response.status === "processing") {
            setOnlineCovariateProgress(
              Math.round(
                ((sourceIndex + response.progress / 100) / sources.length) *
                  100,
              ),
            );
            setCovariateMessage(
              `${ONLINE_COVARIATE_CONFIG[source].label}: ${response.message}`,
            );
            if (attempts++ >= 180)
              throw new Error(
                "The provider is still processing after nine minutes. Try a shorter period or retrieve this covariate later.",
              );
            await new Promise((resolve) => setTimeout(resolve, 3000));
            response = await post({
              action: "poll",
              source,
              mode: spatialMode,
              startYear,
              endYear,
              jobs: response.jobs,
              latitude: spatialMode === "point" ? coordinateLat : undefined,
              longitude: spatialMode === "point" ? coordinateLon : undefined,
            });
          }
          if (response.status !== "complete")
            throw new Error(
              "The provider did not return a completed annual covariate series.",
            );
          retrieved.push(response.covariate);
          metadataRows.push(response.metadata);
          setOnlineCovariateProgress(
            Math.round(((sourceIndex + 1) / sources.length) * 100),
          );
        } catch (error) {
          failures.push(
            `${ONLINE_COVARIATE_CONFIG[source].label}: ${error instanceof Error ? error.message : "retrieval failed"}`,
          );
        }
      }
      if (retrieved.length) {
        const replacements = new Set(retrieved.map((row) => row.id)),
          updatedCovariates = [
            ...annualCovariates.filter(
              (row) => !replacements.has(row.id),
            ),
            ...retrieved,
          ];
        setAnnualCovariates(updatedCovariates);
        setOnlineCovariateMetadata((current) => {
          const replacements = new Set(
            metadataRows.map((row) => row.source),
          );
          return [
            ...current.filter((row) => !replacements.has(row.source)),
            ...metadataRows,
          ];
        });
        setCovariateWorkflowStatus(
          "Steps 2–4 · Matching eligible years, fitting stationary/time/covariate GEV models, checking AICc, residuals, uncertainty and held-out performance, then generating the supported IDF curve…",
        );
        developIdfFromRetrievedCovariates(updatedCovariates);
      }
      const skippedSpatial =
        spatialSources.length &&
        !sources.some(
          (source) => source === "temperature" || source === "moisture",
        )
          ? " Temperature and moisture were skipped because valid point coordinates or a district polygon were unavailable."
          : "";
      setCovariateMessage(
        retrieved.length
          ? `Retrieved ${retrieved.length} documented annual covariate series for ${startYear}–${endYear}: ${retrieved.map((row) => `${row.label} (${row.values.length} years)`).join("; ")}.${skippedSpatial}${failures.length ? ` Provider warnings: ${failures.join(" | ")}.` : ""} The automatic next process now matches years, compares the models and develops the evidence-supported IDF; correlation is not a selection criterion.`
          : failures.join(" | ") ||
              "No online annual covariate series was returned.",
      );
      if (!retrieved.length)
        setCovariateWorkflowStatus(
          "IDF development did not start because no usable online covariate series was returned.",
        );
    } finally {
      setOnlineCovariateBusy(false);
    }
  }
  function downloadCovariateTemplate() {
    const csv = [
      "Year,ENSO_Nino3.4_C,Annual_Temperature_C,Precipitable_Water_mm,Urban_Fraction",
      "1985,,,,",
      "1986,,,,",
      "1987,,,,",
    ].join("\n");
    save(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
      "annual-idf-covariates-template.csv",
    );
  }
  function downloadHourlyTemplate() {
    save(
      new Blob(
        [
          "Timestamp,Precipitation (mm)\n2020-01-01T00:00,0.0\n2020-01-01T01:00,1.2\n2020-01-01T02:00,0.4\n",
        ],
        { type: "text/csv;charset=utf-8" },
      ),
      "hourly-precipitation-template.csv",
    );
  }
  async function loadBoundary(file?: File) {
    if (!file) return;
    try {
      let data: unknown;
      if (file.name.toLowerCase().endsWith(".zip")) {
        const shp = (await import("shpjs")).default;
        data = await shp(await file.arrayBuffer());
      } else data = JSON.parse(await file.text()) as unknown;
      const collection = Array.isArray(data)
        ? data.find(isGeoCollection)
        : data;
      if (!isGeoCollection(collection))
        throw new Error("No polygon FeatureCollection found.");
      setGeo(collection);
      setBoundary(`${file.name} · ${collection.features.length} features`);
      setGeoMessage(
        `${collection.features.length} administrative features loaded locally. Verify the layer date and name field before publication.`,
      );
    } catch (e) {
      setGeoMessage(
        e instanceof Error ? e.message : "Boundary file could not be read.",
      );
    }
  }
  function chooseDistrict(value: string, lock = true) {
    if (manualObservedLoaded) return;
    setDistrict(value);
    setMapSelection(value);
    setDistrictLocked(lock);
    if (boundaryLevel !== "district")
      void loadOnlineBoundary("district", value);
  }
  function useDistrictRepresentativePoint() {
    if (!districtRepresentativePoint) return;
    setSpatialMode("point");
    setStationLat(districtRepresentativePoint.lat.toFixed(5));
    setStationLon(districtRepresentativePoint.lon.toFixed(5));
    setCmipHistoricalLoadedKey("");
    setCmipHistoricalMessage(
      `${district} representative point selected. Retrieve the future and matching 1985–2014 historical model records for this location.`,
    );
  }
  function storeCorrectedCmipModel() {
    if (
      cmipSelectionMode !== "individual" ||
      !cmipValidatedRows.length ||
      !cmipQdmReady
    )
      return;
    setCmipEnsembleModels((previous) => [
      ...previous.filter(
        (item) =>
          !(
            item.selectionKey === currentCmipEnsembleKey &&
            item.model === selectedCmipModel
          ),
      ),
      {
        model: selectedCmipModel,
        rows: cmipValidatedRows,
        selectionKey: currentCmipEnsembleKey,
        correctionReference: cmipReferenceLabel,
      },
    ]);
  }
  function selectNextPakistanEnsembleModel() {
    const next = PAKISTAN_IDF_ENSEMBLE_MODELS.find(
      (model) =>
        !cmipActiveEnsembleModels.some((item) => item.model === model),
    );
    if (!next) return;
    setCmipSelectionMode("individual");
    setCmipModel(next);
    setCmipMember("auto");
    setCmipHistoricalLoadedKey("");
    setCmipDataMessage(
      `${next} selected from the recommended Pakistan 10-model set. Retrieve its future record, then retrieve historical GCM and the bias-correction reference.`,
    );
  }
  function previewBoundaryFeature(value: string) {
    if (manualObservedLoaded || districtLocked) return;
    if (boundaryLevel === "district") {
      const matched = allDistricts.find(
        (d) => normalizeBoundaryName(d) === normalizeBoundaryName(value),
      );
      if (matched) chooseDistrict(matched, false);
    }
  }
  function chooseBoundaryFeature(value: string) {
    if (manualObservedLoaded) return;
    setDistrictLocked(true);
    setMapSelection(value);
    if (boundaryLevel === "district") {
      const matched = allDistricts.find(
        (d) => normalizeBoundaryName(d) === normalizeBoundaryName(value),
      );
      if (matched) {
        setDistrict(matched);
        setMapSelection(matched);
      }
    }
  }
  function updateRow(
    i: number,
    key: "date" | "precipitationMm",
    value: string,
  ) {
    setRaw((v) =>
      v.map((r, j) =>
        j === i
          ? {
              ...r,
              [key]: key === "precipitationMm" ? Number(value) : value,
              qc: "edited",
            }
          : r,
      ),
    );
  }
  async function downloadObservedPrecipitation() {
    if (
      observedResolution === "daily"
        ? !dailyQc.records.length
        : !hourlyQc.records.length
    )
      return;
    const XLSX = await import("xlsx"),
      wb = XLSX.utils.book_new();
    const active = observedResolution === "daily" ? dailyQc : hourlyQc;
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        {
          district: "not used for uploaded gauge analysis",
          source: name,
          temporal_resolution: observedResolution,
          date_start: active.start,
          date_end: active.end,
          units:
            observedResolution === "daily"
              ? "mm/day"
              : "mm accumulated per hourly interval",
          accepted_rows: active.records.length,
          completeness_percent: +active.completeness.toFixed(2),
          spatial_mode: "Uploaded station / gauge series",
          latitude: coordinateValid ? coordinateLat : "not provided",
          longitude: coordinateValid ? coordinateLon : "not provided",
          coordinate_inside_selected_district:
            "not evaluated — district selection disabled",
          boundary: "not used in fitting",
        },
      ]),
      "Metadata",
    );
    if (observedResolution === "daily")
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          dailyQc.records.map((r) => ({
            date: r.date,
            precipitation_mm: r.precipitationMm,
            qc_state: r.qc,
          })),
        ),
        "Daily Precipitation",
      );
    else
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          hourlyQc.records.map((r) => ({
            timestamp: r.timestamp,
            precipitation_mm: r.precipitationMm,
            qc_state: r.qc,
          })),
        ),
        "Hourly Precipitation",
      );
    XLSX.writeFile(
      wb,
      `${name.replaceAll(" ", "-") || "observed-gauge"}-${observedResolution}-precipitation.xlsx`,
    );
  }
  async function downloadOnlinePrecipitation() {
    if (!onlineReady || !onlineMetadata || !onlineQc.records.length) return;
    const XLSX = await import("xlsx"),
      wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        {
          district:
            spatialMode === "district"
              ? (onlineMetadata.districtName ?? district)
              : "not applicable — point extraction",
          district_boundary_code:
            onlineMetadata.districtCode ?? "not applicable",
          boundary_source:
            onlineMetadata.boundarySource ?? "not applicable",
          boundary_version:
            onlineMetadata.boundaryVersion ?? "not applicable",
          boundary_valid_on:
            onlineMetadata.boundaryValidOn ?? "not applicable",
          dataset: onlineMetadata.dataset,
          provider: onlineMetadata.provider,
          retrieval_service: onlineMetadata.retrievalService,
          retrieved_at_utc: onlineMetadata.retrievedAt,
          temporal_resolution: onlineMetadata.temporalResolution,
          units:
            onlineMetadata.temporalResolution === "hourly"
              ? "mm accumulated in each UTC hour"
              : "mm/day",
          extraction_mode: onlineMetadata.extractionMode,
          spatial_method: onlineMetadata.spatialMethod,
          native_resolution: onlineMetadata.nativeResolution,
          requested_start: onlineMetadata.requestedStart,
          requested_end: onlineMetadata.requestedEnd,
          returned_start: onlineMetadata.returnedStart,
          returned_end: onlineMetadata.returnedEnd,
          accepted_records: onlineMetadata.acceptedRecords,
          completeness_percent: +onlineQc.completeness.toFixed(2),
          eligible_annual_maxima: onlineStationarity.n,
          requested_latitude:
            onlineMetadata.requestedLatitude ?? "not applicable",
          requested_longitude:
            onlineMetadata.requestedLongitude ?? "not applicable",
          returned_grid_latitude:
            onlineMetadata.returnedLatitude ?? "not reported",
          returned_grid_longitude:
            onlineMetadata.returnedLongitude ?? "not reported",
          candidate_grid_cells:
            onlineMetadata.candidateGridCells ?? "provider polygon service",
          extracted_grid_cells:
            onlineMetadata.extractedGridCells ?? "provider polygon service",
          grid_sampling_limited:
            onlineMetadata.gridSamplingLimited ?? "not applicable",
          provider_url: onlineMetadata.providerUrl,
        },
      ]),
      "Metadata",
    );
    if (onlineMetadata.temporalResolution === "hourly")
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          onlineHourlyQc.records.map((record) => ({
            timestamp_utc: record.timestamp,
            precipitation_mm: record.precipitationMm,
            qc_state: record.qc,
          })),
        ),
        "Hourly Precipitation",
      );
    else
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          onlineDailyQc.records.map((record) => ({
            date: record.date,
            precipitation_mm: record.precipitationMm,
            qc_state: record.qc,
          })),
        ),
        "Daily Precipitation",
      );
    XLSX.writeFile(
      wb,
      `${(spatialMode === "district" ? district : `${coordinateLat.toFixed(4)}-${coordinateLon.toFixed(4)}`).replaceAll(" ", "-")}-${onlineSource}-${onlineMetadata.temporalResolution}-precipitation.xlsx`,
    );
  }
  async function downloadCmipPrecipitation() {
    if (!cmipDataReady || !cmipQc.records.length) return;
    const XLSX = await import("xlsx"),
      wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        {
          dataset: cmipMetadata?.dataset ?? "User-uploaded GCM precipitation",
          provider:
            cmipMetadata?.provider ?? "Source stated in the uploaded file",
          retrieval_service:
            cmipMetadata?.retrievalService ?? "Uploaded processed table",
          model: cmipModelLabel,
          scenario: CMIP6_SCENARIOS[cmipScenario].label,
          member: cmipMetadata?.member ?? "not reported",
          variable: "pr",
          source_units: cmipMetadata?.sourceUnits ?? "not reported",
          source_time_units:
            cmipMetadata?.sourceTimeUnits ?? "not reported",
          output_units: "mm/day",
          source_calendar: cmipMetadata?.sourceCalendar ?? "not reported",
          calendar_conversion:
            cmipMetadata?.calendarConversion ?? "not reported",
          period: cmipPeriod,
          extraction_mode: spatialMode,
          spatial_method:
            cmipMetadata?.spatialMethod ?? "Uploaded spatial series",
          district:
            spatialMode === "district"
              ? (cmipMetadata?.districtName ?? district)
              : "not applicable",
          district_code:
            cmipMetadata?.districtCode ?? "not applicable",
          boundary_source:
            cmipMetadata?.boundarySource ?? "not applicable",
          requested_latitude:
            cmipMetadata?.requestedLatitude ?? "not applicable",
          requested_longitude:
            cmipMetadata?.requestedLongitude ?? "not applicable",
          returned_grid_latitude:
            cmipMetadata?.returnedLatitude ?? "not reported",
          returned_grid_longitude:
            cmipMetadata?.returnedLongitude ?? "not reported",
          returned_start:
            cmipMetadata?.returnedStart ?? cmipQc.records[0].date,
          returned_end:
            cmipMetadata?.returnedEnd ?? cmipQc.records.at(-1)!.date,
          accepted_records: cmipQc.records.length,
          completeness_percent: +cmipQc.completeness.toFixed(2),
          eligible_annual_maxima: cmipStationarity.n,
          bias_correction_method: cmipQdmReady
            ? cmipQdm.method
            : "not yet applied",
          bias_correction_reference: cmipQdmReady
            ? cmipReferenceLabel
            : "not yet applied",
          qdm_wet_day_threshold_mm: cmipQdmReady
            ? cmipQdm.wetDayThresholdMm
            : "not applicable",
          retrieved_at_utc: cmipMetadata?.retrievedAt ?? "uploaded locally",
          provider_url:
            cmipMetadata?.providerUrl ?? SOURCE_META.cmip6.accessUrl,
        },
      ]),
      "Metadata",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        cmipQc.records.map((record) => ({
          date: record.date,
          precipitation_mm: record.precipitationMm,
          qc_state: record.qc,
        })),
      ),
      "Daily GCM Precipitation",
    );
    if (cmipQdmReady) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          cmipCorrectedQc.records.map((record) => ({
            date: record.date,
            qdm_corrected_precipitation_mm: record.precipitationMm,
            qc_state: record.qc,
          })),
        ),
        "Daily QDM Corrected",
      );
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          cmipQdm.summaries.map((summary) => ({
            month: summary.month,
            future_days: summary.futureRecords,
            historical_gcm_days: summary.historicalGcmRecords,
            reference_days: summary.referenceRecords,
            median_factor: summary.medianFactor,
            p10_factor: summary.p10Factor,
            p90_factor: summary.p90Factor,
            reference: cmipReferenceLabel,
            method: cmipQdm.method,
          })),
        ),
        "Monthly QDM Audit",
      );
    }
    XLSX.writeFile(
      wb,
      `${selectedCmipModel.replaceAll(" ", "-")}-${cmipScenario}-${cmipPeriod}-${spatialMode === "district" ? district.replaceAll(" ", "-") : "point"}-precipitation.xlsx`,
    );
  }
  async function downloadSourceRequest() {
    const XLSX = await import("xlsx"),
      wb = XLSX.utils.book_new(),
      selectedOnlineSource =
        sourceTab === "cmip6" ? ("cmip6" as const) : onlineSource,
      meta = SOURCE_META[selectedOnlineSource],
      extent = selectedBoundaryExtent;
    const selection = {
      request_type:
        "Official precipitation acquisition request — contains metadata and instructions, not product values",
      spatial_extraction_mode:
        spatialMode === "district"
          ? "District boundary average"
          : "Point coordinates",
      district,
      boundary,
      boundary_match: matchedBoundaryName ?? "not matched",
      district_boundary_code:
        matchedBoundaryIdentity?.code ?? "not matched",
      boundary_source:
        matchedBoundaryIdentity?.source ?? "not matched",
      boundary_version:
        matchedBoundaryIdentity?.version ?? "not matched",
      boundary_valid_on:
        matchedBoundaryIdentity?.validOn ?? "not matched",
      latitude:
        spatialMode === "point" && coordinateValid
          ? coordinateLat
          : "not applicable",
      longitude:
        spatialMode === "point" && coordinateValid
          ? coordinateLon
          : "not applicable",
      coordinate_inside_selected_district:
        spatialMode === "point"
          ? (coordinateInsideDistrict ?? "not evaluated")
          : "not applicable",
      north_extent:
        spatialMode === "district" && extent
          ? +extent.north.toFixed(5)
          : "not applicable",
      west_extent:
        spatialMode === "district" && extent
          ? +extent.west.toFixed(5)
          : "not applicable",
      south_extent:
        spatialMode === "district" && extent
          ? +extent.south.toFixed(5)
          : "not applicable",
      east_extent:
        spatialMode === "district" && extent
          ? +extent.east.toFixed(5)
          : "not applicable",
      requested_start: start || "select in provider portal",
      requested_end: end || "select in provider portal",
      dataset: meta.label,
      variable:
        selectedOnlineSource === "cmip6"
          ? "pr · daily precipitation flux"
          : "precipitation",
      native_temporal_support: meta.temporal,
      native_spatial_support: meta.coverage,
      official_provider: meta.accessLabel,
      official_download_url: meta.accessUrl,
      provider_access: meta.accessMode,
      aggregation_required:
        spatialMode === "district"
          ? `Clip all intersecting grid cells to the verified district polygon and calculate an overlap-area-weighted ${selectedOnlineSource === "era5" && onlineResolution === "hourly" ? "hourly" : "daily"} mean; do not relabel a single grid point as a district average.`
          : "Extract the provider's containing or nearest grid cell at the entered coordinates and record the returned grid-cell coordinates and distance; do not describe the point series as a district average.",
      status:
        "Precipitation values are not included until downloaded from the official provider and processed.",
    };
    if (selectedOnlineSource === "cmip6")
      Object.assign(selection, {
        gcm_selection_mode: cmipSelectionMode,
        gcm_or_ensemble: cmipModelLabel,
        ssp_scenario: CMIP6_SCENARIOS[cmipScenario].label,
        analysis_period: cmipPeriod,
        period_midpoint: cmipMidpoint,
        production_rule:
          "Download and fit every selected GCM separately; calculate an ensemble median from model-specific return levels.",
      });
    const steps = [
      ["Step", "Required action"],
      [1, `Open ${meta.accessLabel}: ${meta.accessUrl}`],
      [2, meta.accessMode],
      [
        3,
        spatialMode === "district"
          ? "Select precipitation, the requested dates and the recorded district boundary extent."
          : `Select precipitation, the requested dates and point ${coordinateValid ? `${coordinateLat.toFixed(5)}, ${coordinateLon.toFixed(5)}` : "coordinates after completing them in the atlas"}.`,
      ],
      [
        4,
        "Download native CSV, NetCDF or GeoTIFF files and preserve filenames, product version and retrieval date.",
      ],
      [
        5,
        spatialMode === "district"
          ? "Apply unit conversion, missing-value checks and overlap-area-weighted district aggregation."
          : "Apply unit conversion and missing-value checks; record whether the provider used the containing or nearest grid cell.",
      ],
      [
        6,
        selectedOnlineSource === "era5" && onlineResolution === "hourly"
          ? "Create Timestamp and hourly Precipitation (mm) columns, then load the processed workbook in Observed Excel Data for empirical duration-specific IDF fitting."
          : "Create daily Date and Precipitation (mm) columns, then load the processed workbook in Observed Excel Data for empirical IDF fitting.",
      ],
      [
        7,
        "Compare the gridded series against quality-controlled gauges and document bias before design use.",
      ],
    ];
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([selection]),
      "Source Request",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet(steps),
      "Processing Steps",
    );
    XLSX.writeFile(
      wb,
      `${district.replaceAll(" ", "-")}-${meta.short.replaceAll(" ", "-")}-source-download-request.xlsx`,
    );
  }
  async function excel() {
    const XLSX = await import("xlsx"),
      wb = XLSX.utils.book_new();
    const activeQc =
      sourceTab === "online"
        ? onlineQc
        : sourceTab === "cmip6"
          ? cmipQc
          : activeObservedQc;
    const sourceClass =
      sourceTab === "observed"
        ? `User-supplied observed ${observedResolution} precipitation`
        : sourceTab === "online"
          ? onlineReady
            ? `Live online ${onlineResolution} precipitation extraction`
            : "Online precipitation not retrieved"
          : cmipDataReady
            ? "Retrieved NASA NEX-GDDP-CMIP6 daily precipitation"
            : cmipImportedReady
              ? "Imported model-specific bias-corrected CMIP6 return levels"
            : "CMIP6 precipitation not retrieved";
    const summary = [
      {
        District:
          sourceTab === "observed"
            ? "not used for uploaded gauge analysis"
            : district,
        Source: sourceLabel,
        Source_class: sourceClass,
        Analysis_classification: analysisClassification,
        Model: modelTab,
        Nonstationary_covariate:
          modelTab === "nonstationary" && sourceTab !== "cmip6"
            ? nonstationaryCovariate === "time"
              ? "Time"
              : (selectedAnnualCovariate?.label ?? "not available")
            : "not applicable",
        Covariate_evaluation:
          modelTab === "nonstationary" && sourceTab !== "cmip6"
            ? covariateLabel
            : "not applicable",
        Reference_year:
          modelTab === "nonstationary" && nonstationaryCovariate === "time"
            ? referenceYear
            : "not applicable",
        Record_center_year: Number.isFinite(recordCenterYear)
          ? +recordCenterYear.toFixed(2)
          : "not available",
        Time_GEV_status:
          modelTab === "nonstationary" && nonstationaryCovariate === "time"
            ? nonstationaryTime.fit.status
            : "not applicable",
        Time_GEV_location_slope_mm_per_year:
          modelTab === "nonstationary" &&
          nonstationaryCovariate === "time" &&
          nonstationaryTime.fit.status === "Fitted"
            ? +nonstationaryTime.fit.locationSlopeMmPerYear.toFixed(6)
            : "not applicable",
        Matched_covariate_slope_mm_per_unit:
          modelTab === "nonstationary" &&
          nonstationaryCovariate === "matched" &&
          nonstationaryMatched?.fit.status === "Fitted"
            ? nonstationaryMatched.fit.locationSlopePerUnit
            : "not applicable",
        Stationary_AICc:
          modelTab === "nonstationary" &&
          activeNonstationaryStatus === "Fitted"
            ? nonstationaryCovariate === "time"
              ? +nonstationaryTime.fit.stationaryAicc.toFixed(3)
              : nonstationaryMatched?.fit.stationaryAicc
            : "not applicable",
        Nonstationary_AICc:
          modelTab === "nonstationary" &&
          activeNonstationaryStatus === "Fitted"
            ? nonstationaryCovariate === "time"
              ? +nonstationaryTime.fit.nonstationaryAicc.toFixed(3)
              : nonstationaryMatched?.fit.nonstationaryAicc
            : "not applicable",
        AICc_preference:
          modelTab === "nonstationary" && activeNonstationaryStatus === "Fitted"
            ? nonstationaryCovariate === "time"
              ? nonstationaryTime.fit.preferred
              : nonstationaryMatched?.fit.preferred
            : "not applicable",
        Covariate_model_decision:
          sourceTab === "cmip6"
            ? "not applicable"
            : covariateComparison.decision,
        Covariate_selection_rule:
          sourceTab === "cmip6"
            ? "not applicable"
            : covariateComparison.selectionRule,
        Maximum_return_period_years: 500,
        Maximum_duration_hours: 24,
        IDF_unit: "mm/hour",
        Spatial_extraction_mode:
          sourceTab === "observed"
            ? "Uploaded station / gauge series"
            : spatialMode === "district"
              ? "District spatial series"
              : "Point/grid-cell series",
        Spatial_selection: spatialLabel,
        Start:
          sourceTab === "cmip6"
            ? cmipPeriod
            : activeQc.start || "not available",
        End:
          sourceTab === "cmip6" ? cmipPeriod : activeQc.end || "not available",
        Accepted_records:
          cmipImportedReady && cmipImportedWorkbook
            ? cmipImportedWorkbook.modelRows
            : activeQc.records.length,
        Completeness_percent:
          cmipImportedReady ? "not applicable — summary return levels" : +activeQc.completeness.toFixed(2),
        Eligible_AMS_years:
          cmipImportedReady ? "reported in source workbook, not re-fitted" : activeStationarity.n,
        Annual_year_rule: `At least 90% ${sourceTab === "observed" ? observedResolution : sourceTab === "online" ? onlineResolution : "daily"} coverage`,
        Stationarity_status:
          cmipImportedReady ? "not re-evaluated from summary return levels" : activeStationarity.status,
        Mann_Kendall_p:
          Number.isFinite(activeStationarity.pValue)
            ? activeStationarity.pValue
            : "not evaluated",
        Selected_frequency_method: activeFrequencyMethodLabel,
        Stationary_suite_lowest_RMSE_method: recommendation
          ? METHOD_LABEL[recommendation]
          : "Not issued",
        Uncertainty:
          cmipImportedReady
              ? "P10–P90 spread across model-specific bias-corrected GEV return levels"
            : activeNativeHourly
              ? "200-resample bootstrap fitted independently at each 1- to 24-hour duration"
              : "Stationary: 200-resample bootstrap; time-varying GEV: 80 paired bootstrap refits",
        Rare_return_note:
          "250- and 500-year values are high-uncertainty extrapolations governed strongly by tail-model choice.",
        Subdaily_note: activeNativeHourly
          ? "Rolling 1- to 24-hour durations are native-interval supported; 5- to 30-minute durations are derived from the 1-hour fit."
          : "Daily precipitation directly supports 24 hours; shorter durations are power-law disaggregation estimates.",
      },
    ];
    if (sourceTab === "online" && onlineMetadata)
      Object.assign(summary[0], {
        Online_dataset: onlineMetadata.dataset,
        Online_provider: onlineMetadata.provider,
        Retrieval_service: onlineMetadata.retrievalService,
        Retrieval_timestamp_UTC: onlineMetadata.retrievedAt,
        Native_resolution: onlineMetadata.nativeResolution,
        Spatial_method: onlineMetadata.spatialMethod,
        District_boundary_name:
          onlineMetadata.districtName ?? "not applicable",
        District_boundary_code:
          onlineMetadata.districtCode ?? "not applicable",
        Boundary_source:
          onlineMetadata.boundarySource ?? "not applicable",
        Boundary_version:
          onlineMetadata.boundaryVersion ?? "not applicable",
        Boundary_valid_on:
          onlineMetadata.boundaryValidOn ?? "not applicable",
        Provider_url: onlineMetadata.providerUrl,
        Returned_grid_latitude:
          onlineMetadata.returnedLatitude ?? "not reported",
        Returned_grid_longitude:
          onlineMetadata.returnedLongitude ?? "not reported",
        Candidate_grid_cells:
          onlineMetadata.candidateGridCells ?? "provider polygon service",
        Extracted_grid_cells:
          onlineMetadata.extractedGridCells ?? "provider polygon service",
        Grid_sampling_limited:
          onlineMetadata.gridSamplingLimited ?? "not applicable",
      });
    if (sourceTab === "cmip6")
      Object.assign(summary[0], {
        Reference_year: cmipMidpoint,
        CMIP6_dataset: "NASA NEX-GDDP-CMIP6 v2",
        CMIP6_catalogue_entries: CMIP6_MODELS.length,
        CMIP6_selection_mode: cmipSelectionMode,
        CMIP6_model_or_ensemble: cmipModelLabel,
        CMIP6_scenario: CMIP6_SCENARIOS[cmipScenario].label,
        CMIP6_period: cmipPeriod,
        Projection_status:
          cmipImportedReady && cmipImportedWorkbook
            ? `Imported ${cmipImportedModels.length}-model bias-corrected 24-hour GEV ensemble; ${cmipImportedWorkbook.validationStatus}`
            : cmipDataReady
            ? "Actual retrieved daily pr values used for QC, annual maxima and IDF fitting"
            : "No GCM precipitation retrieved; IDF output is blank",
        CMIP6_member: cmipMetadata?.member ?? "not reported for uploaded data",
        CMIP6_retrieval_service:
          cmipMetadata?.retrievalService ?? "uploaded by user",
        CMIP6_source_units:
          cmipMetadata?.sourceUnits ?? "not reported",
        CMIP6_source_time_units:
          cmipMetadata?.sourceTimeUnits ?? "not reported",
        CMIP6_source_calendar:
          cmipMetadata?.sourceCalendar ?? "not reported",
        CMIP6_calendar_conversion:
          cmipMetadata?.calendarConversion ?? "not reported",
        CMIP6_spatial_method:
          cmipMetadata?.spatialMethod ?? "uploaded processed series",
      });
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(summary),
      "Summary",
    );
    if (sourceTab === "observed") {
      if (observedResolution === "daily")
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet(dailyQc.records),
          "Daily Observed",
        );
      else
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet(hourlyQc.records),
          "Hourly Observed",
        );
    }
    if (sourceTab === "online" && onlineReady) {
      if (onlineResolution === "hourly")
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet(
            onlineHourlyQc.records.map((record) => ({
              timestamp_utc: record.timestamp,
              precipitation_mm: record.precipitationMm,
              qc_state: record.qc,
            })),
          ),
          "Online Hourly Data",
        );
      else
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet(
            onlineDailyQc.records.map((record) => ({
              date: record.date,
              precipitation_mm: record.precipitationMm,
              qc_state: record.qc,
            })),
          ),
          "Online Daily Data",
        );
    }
    if (sourceTab === "cmip6" && cmipDataReady)
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          cmipQc.records.map((record) => ({
            date: record.date,
            precipitation_mm: record.precipitationMm,
            qc_state: record.qc,
          })),
        ),
        "Daily GCM Precipitation",
      );
    if (sourceTab !== "cmip6") {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(ams),
        "Annual Maxima 24h",
      );
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet([
          {
            ...activeStationarity,
            temporal_resolution:
              sourceTab === "observed" ? observedResolution : onlineResolution,
            alpha: 0.05,
            serial_correlation_adjustment: "not applied",
            interpretation: activeStationarity.status,
          },
        ]),
        "Stationarity",
      );
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          activeDiagnostics.map((d) => ({
            ...d,
            method: METHOD_LABEL[d.method],
            lowest_rmse: d.method === recommendation,
          })),
        ),
        "Fit Diagnostics",
      );
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          covariateComparison.rows.map((row) => ({
            model: row.label,
            model_id: row.modelId,
            physical_family: row.kind,
            units: row.units,
            shared_year_count: row.n,
            aicc: row.aicc,
            delta_aicc: row.deltaAicc,
            akaike_weight: row.akaikeWeight,
            location_coefficient_mm_per_unit: row.locationSlopePerUnit,
            coefficient_ci_lower: row.slopeCiLower,
            coefficient_ci_upper: row.slopeCiUpper,
            pit_residual_mean: row.residualMean,
            pit_residual_sd: row.residualSd,
            pit_ks_d: row.pitKsD,
            residual_lag1: row.residualLag1,
            residual_status: row.residualStatus,
            chronological_holdout_years: row.holdoutN,
            holdout_mean_negative_log_likelihood: row.holdoutMeanNll,
            holdout_difference_vs_stationary: row.holdoutDeltaVsStationary,
            selection_evidence: row.selectionEvidence,
            physical_rationale: row.physicalRationale,
            source: row.source,
            selected_model:
              row.modelId === covariateComparison.selectedModelId,
          })),
        ),
        "Covariate Comparison",
      );
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet([
          {
            decision: covariateComparison.decision,
            reason: covariateComparison.decisionReason,
            common_years: covariateComparison.commonYears.join(", "),
            selection_rule: covariateComparison.selectionRule,
            holdout_rule: covariateComparison.holdoutRule,
            uncertainty_rule: covariateComparison.uncertaintyRule,
            correlation_rule:
              "Correlation is descriptive only and is not calculated or used for model selection.",
          },
          ...covariateComparison.excluded.map((row) => ({
            decision: `Excluded: ${row.label}`,
            reason: row.reason,
            common_years: "not ranked",
            selection_rule: "not applicable",
            holdout_rule: "not applicable",
            uncertainty_rule: "not applicable",
            correlation_rule: "not used",
          })),
        ]),
        "Covariate Decision",
      );
      if (annualCovariates.length) {
        const years = [
          ...new Set(
            annualCovariates.flatMap((candidate) =>
              candidate.values.map((row) => row.year),
            ),
          ),
        ].sort((a, b) => a - b);
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet(
            years.map((year) =>
              Object.fromEntries([
                ["Year", year],
                ...annualCovariates.map((candidate) => [
                  candidate.label,
                  candidate.values.find((row) => row.year === year)?.value ??
                    "",
                ]),
              ]),
            ),
          ),
          "Annual Covariates",
        );
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet(
            annualCovariates.map((candidate) => ({
              variable: candidate.label,
              units: candidate.units,
              physical_family: candidate.kind,
              physically_plausible: candidate.physicallyPlausible,
              physical_rationale: candidate.physicalRationale,
              source: candidate.source,
            })),
          ),
          "Covariate Metadata",
        );
      }
      if (onlineCovariateMetadata.length) {
        XLSX.utils.book_append_sheet(
          wb,
          XLSX.utils.json_to_sheet(
            onlineCovariateMetadata.map((row) => ({
              source_family: row.source,
              dataset: row.dataset,
              provider: row.provider,
              provider_url: row.providerUrl,
              retrieval_service: row.retrievalService,
              spatial_scope: row.spatialScope,
              spatial_method: row.spatialMethod,
              native_resolution: row.nativeResolution,
              requested_start_year: row.requestedStartYear,
              requested_end_year: row.requestedEndYear,
              returned_start_year: row.returnedStartYear,
              returned_end_year: row.returnedEndYear,
              source_records: row.sourceRecords,
              accepted_annual_values: row.acceptedAnnualValues,
              completeness_rule: row.completenessRule,
              limitations: row.limitations,
              retrieved_at_utc: row.retrievedAt,
            })),
          ),
          "Online Covariate Sources",
        );
      }
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet([
          {
            selected_basis: referenceYearBasis,
            calculated_reference_year: referenceYear,
            record_center_year: referenceYearSelection.centerYear,
            first_eligible_year: referenceYearSelection.firstEligibleYear,
            last_eligible_year: referenceYearSelection.lastEligibleYear,
            eligible_year_count: referenceYearSelection.eligibleYearCount,
            is_extrapolation: referenceYearSelection.isExtrapolation,
            calculation: referenceYearSelection.formula,
            literature_basis:
              "Time-varying GEV: Cheng and AghaKouchak (2014); Sarhadi and Soulis (2017). Covariate selection and uncertainty: Agilan and Umamahesh (2017, 2018).",
          },
        ]),
        "Reference Year",
      );
    }
    if (sourceTab === "cmip6")
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet([
          {
            dataset: "NASA NEX-GDDP-CMIP6 v2",
            variable: "pr",
            catalogue_model_grid_entries: CMIP6_MODELS.length,
            selection_mode: cmipSelectionMode,
            model_or_ensemble: cmipModelLabel,
            scenario: CMIP6_SCENARIOS[cmipScenario].label,
            scenario_description: CMIP6_SCENARIOS[cmipScenario].description,
            period: cmipPeriod,
            period_midpoint: cmipMidpoint,
            coverage: "0.25° global; daily",
            projection_end_year: 2100,
            status:
              cmipImportedReady && cmipImportedWorkbook
                ? `Imported bias-corrected model-specific return levels; ${cmipImportedWorkbook.validationStatus}`
                : cmipDataReady
                ? "Retrieved model-specific daily precipitation fitted; independent gauge evaluation and multi-model ensemble synthesis remain required for design"
                : "No model-specific precipitation retrieved",
            member: cmipMetadata?.member ?? "not reported",
            retrieval_service:
              cmipMetadata?.retrievalService ?? "not retrieved",
            source_calendar:
              cmipMetadata?.sourceCalendar ?? "not reported",
            source_time_units:
              cmipMetadata?.sourceTimeUnits ?? "not reported",
            calendar_conversion:
              cmipMetadata?.calendarConversion ?? "not reported",
            spatial_method:
              cmipMetadata?.spatialMethod ?? "not retrieved",
          },
        ]),
        "CMIP6 Scenario",
      );
    if (sourceTab === "cmip6" && cmipImportedReady && cmipImportedWorkbook) {
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(
          cmipImportedModels.flatMap((model) =>
            model.rows.map((row) => ({
              model: model.model,
              scenario: CMIP6_SCENARIOS[cmipScenario].label,
              period: cmipPeriod,
              return_period_years: row.returnPeriodYears,
              corrected_24h_depth_mm: row.depthMm,
              corrected_intensity_mm_hr: row.intensityMmHr,
              bias_reference: cmipReferenceLabel,
            })),
          ),
        ),
        "Imported Model IDF",
      );
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet([
          ...cmipImportedWorkbook.validationCaveats.map((caveat) => ({
            validation_status: cmipImportedWorkbook.validationStatus,
            caveat,
          })),
          ...cmipImportedWorkbook.warnings.map((warning) => ({
            validation_status: cmipImportedWorkbook.validationStatus,
            caveat: warning,
          })),
        ]),
        "Imported Validation",
      );
    }
    if (sourceTab === "cmip6" && cmipBiasComparison.length)
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.json_to_sheet(cmipBiasComparison.map(row => ({
          return_period_years: row.returnPeriodYears,
          historical_gcm_24h_depth_mm: row.historicalGcmMm,
          bias_reference: cmipReferenceLabel,
          reference_24h_depth_mm: row.referenceMm,
          correction_factor: row.factor,
          future_uncorrected_24h_depth_mm: row.futureRawMm,
          future_corrected_24h_depth_mm: row.futureCorrectedMm,
          future_fit: `${modelTab} GEV`,
          correction_method: cmipQdm.method,
          correction_equation: "For each calendar month and future daily value: corrected = reference historical quantile × (future GCM value / historical GCM quantile) at the future empirical probability; annual maxima and GEV are fitted afterward",
        }))),
        "GCM Bias Correction",
      );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        results
          .filter((r) => r.durationMinutes <= 1440)
          .map((r) => ({
            district:
              sourceTab === "observed"
                ? "not used — uploaded gauge analysis"
                : district,
            source: sourceLabel,
            model: modelTab,
            reference_year:
              modelTab === "nonstationary" &&
              nonstationaryCovariate === "time"
                ? referenceYear
                : "not applicable",
            covariate:
              modelTab === "nonstationary"
                ? nonstationaryCovariate === "time"
                  ? "Time"
                  : (selectedAnnualCovariate?.label ?? "not available")
                : "not applicable",
            covariate_evaluation_value:
              modelTab === "nonstationary" &&
              nonstationaryCovariate === "matched"
                ? covariateEvaluationValue
                : "not applicable",
            method:
              modelTab === "nonstationary"
                ? activeFrequencyMethodLabel
                : METHOD_LABEL[r.method],
            duration_minutes: r.durationMinutes,
            return_period_years: r.returnPeriodYears,
            intensity_mm_per_hour: r.intensityMmHr,
            uncertainty_lower_mm_per_hour: r.ciLower,
            uncertainty_upper_mm_per_hour: r.ciUpper,
            uncertainty_type:
              cmipImportedReady
                ? "P10–P90 across model-specific return levels"
                : "95% bootstrap",
            derived_from_native_interval: r.derived,
            native_temporal_resolution:
              sourceTab === "observed"
                ? observedResolution
                : sourceTab === "online"
                  ? onlineResolution
                  : "daily",
          })),
      ),
      "IDF Curves",
    );
    const equationSheet = XLSX.utils.aoa_to_sheet([
      ["IDF power equations displayed on the chart"],
      [
        "Return period (years)",
        "Coefficient, c",
        "Exponent, p",
        "Log-space R²",
        "Excel equation (i=c×t^p)",
        "Sample size",
      ],
      ...idfPowerEquations.map((fit) => [
        fit.returnPeriodYears,
        fit.coefficient,
        fit.exponent,
        fit.rSquared,
        formatPowerEquation(fit),
        fit.sampleSize,
      ]),
    ]);
    idfPowerEquations.forEach((fit, index) => {
      const row = index + 3;
      equationSheet[`E${row}`] = {
        t: "s",
        f: `"i="&TEXT(B${row},"0.000")&"*t^"&TEXT(C${row},"0.000")`,
        v: formatPowerEquation(fit),
      };
    });
    const formulaMatrixHeaderRow = idfPowerEquations.length + 5,
      formulaMatrixDataRow = formulaMatrixHeaderRow + 1;
    XLSX.utils.sheet_add_aoa(
      equationSheet,
      [
        [
          "Duration (minutes)",
          ...idfPowerEquations.map(
            (fit) => `${fit.returnPeriodYears}-year intensity (mm/hour)`,
          ),
        ],
        ...reportDurations.map((duration) => [
          duration,
          ...idfPowerEquations.map(
            (fit) => fit.coefficient * duration ** fit.exponent,
          ),
        ]),
        [
          "Note",
          "These formula-driven values reproduce the power equations printed on the chart. The IDF Curves sheet retains the authoritative fitted curve values and uncertainty bounds.",
        ],
      ],
      { origin: `A${formulaMatrixHeaderRow}` },
    );
    reportDurations.forEach((duration, durationIndex) => {
      const row = formulaMatrixDataRow + durationIndex;
      idfPowerEquations.forEach((fit, equationIndex) => {
        const column = equationIndex + 1,
          equationRow = equationIndex + 3,
          address = XLSX.utils.encode_cell({ r: row - 1, c: column });
        equationSheet[address] = {
          t: "n",
          f: `$B$${equationRow}*POWER($A${row},$C$${equationRow})`,
          v: fit.coefficient * duration ** fit.exponent,
        };
      });
    });
    equationSheet["!cols"] = [
      { wch: 22 },
      ...idfPowerEquations.map(() => ({ wch: 24 })),
    ];
    XLSX.utils.book_append_sheet(wb, equationSheet, "IDF Equations");

    const validFlowLength =
        Number.isFinite(effectiveFlowPathLengthMetres) &&
        effectiveFlowPathLengthMetres > 0
          ? effectiveFlowPathLengthMetres
          : 0,
      validSlope =
        Number.isFinite(effectiveCatchmentSlopeMPerM) &&
        effectiveCatchmentSlopeMPerM > 0
          ? effectiveCatchmentSlopeMPerM
          : 0,
      selectedTc = timeOfConcentrationMinutes ?? 0,
      selectedCurveCoefficient = idfEquation
        ? idfEquation.a * designReturnPeriod ** idfEquation.m
        : 0,
      designSheet = XLSX.utils.aoa_to_sheet([
        ["Formula-driven hydrologic design calculation"],
        ["Parameter", "Value", "Units", "Equation / audit note"],
        ["Longest flow path, L", validFlowLength, "m", "Input from MGHydro, uploaded geometry or manual entry"],
        ["Flow-path slope, S", validSlope, "m/m", "Input slope used by the Kirpich equation"],
        ["Kirpich coefficient", 0.0195, "minutes", "Metric Kirpich coefficient"],
        ["Length exponent", 0.77, "—", "Kirpich exponent on L"],
        ["Slope exponent", -0.385, "—", "Kirpich exponent on S"],
        ["Kirpich time of concentration", kirpichConcentrationValue ?? 0, "minutes", "tc=0.0195×L^0.77×S^-0.385"],
        ["Selected tc method", timeOfConcentrationMode === "kirpich" ? "Kirpich metric equation" : "Manual project value", "—", "Controls the duration used in the IDF equation"],
        ["Selected time of concentration", selectedTc, "minutes", timeOfConcentrationMode === "kirpich" ? "Linked to calculated Kirpich tc" : "Manual project input"],
        ["Design return period, T", designReturnPeriod, "years", "User-selected design return period"],
        ["Sherman coefficient, a", idfEquation?.a ?? 0, "—", "Fitted from the active IDF curves"],
        ["Return-period exponent, m", idfEquation?.m ?? 0, "—", "Fitted from the active IDF curves"],
        ["Duration exponent, n", idfEquation?.n ?? 0, "—", "Fitted from the active IDF curves"],
        ["Selected-curve coefficient, C_T", selectedCurveCoefficient, "—", "C_T=a×T^m"],
        ["Design intensity, i(tc,T)", designIntensity ?? 0, "mm/hour", "i=C_T×tc^-n"],
        ["Design rainfall depth over tc", designRainfallDepth ?? 0, "mm", "P=i×tc/60"],
        ["Global equation log-space R²", idfEquation?.rSquared ?? 0, "—", "Goodness of fit for i(t,T)=a×T^m×t^-n"],
      ]);
    designSheet.B8 = {
      t: "n",
      f: 'IF(AND(B3>0,B4>0),B5*POWER(B3,B6)*POWER(B4,B7),"")',
      v: kirpichConcentrationValue ?? 0,
    };
    if (timeOfConcentrationMode === "kirpich")
      designSheet.B10 = { t: "n", f: "B8", v: selectedTc };
    designSheet.B15 = {
      t: "n",
      f: 'IF(AND(B11>1,B12>0),B12*POWER(B11,B13),"")',
      v: selectedCurveCoefficient,
    };
    designSheet.B16 = {
      t: "n",
      f: 'IF(AND(B10>0,B15>0),B15*POWER(B10,-B14),"")',
      v: designIntensity ?? 0,
    };
    designSheet.B17 = {
      t: "n",
      f: 'IF(AND(B16>0,B10>0),B16*B10/60,"")',
      v: designRainfallDepth ?? 0,
    };
    designSheet["!cols"] = [
      { wch: 34 },
      { wch: 22 },
      { wch: 16 },
      { wch: 60 },
    ];
    XLSX.utils.book_append_sheet(wb, designSheet, "Design Calculations");
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        {
          tc_method:
            timeOfConcentrationMode === "kirpich"
              ? "Kirpich metric equation"
              : "Manual project value",
          geometry_source:
            timeOfConcentrationMode !== "kirpich"
              ? "not applicable"
              : flowGeometryMode === "manual"
                ? "Manual L and S"
                : watershedGeometryResult?.pathSource ?? "not calculated",
          geometry_precision:
            watershedGeometryResult?.precision ?? "not applicable",
          longest_flow_path_m:
            timeOfConcentrationMode === "kirpich"
              ? effectiveFlowPathLengthMetres || "not entered"
              : "not applicable",
          selected_flow_path_slope_method:
            flowGeometryMode === "manual"
              ? "Manual average flow-path slope"
              : watershedSlopeMethod === "10-85"
                ? "10–85% flow-path slope"
                : "Endpoint flow-path slope",
          selected_flow_path_slope_percent:
            timeOfConcentrationMode === "kirpich"
              ? effectiveCatchmentSlopeMPerM * 100 || "not entered"
              : "not applicable",
          endpoint_slope_percent:
            watershedGeometryResult
              ? watershedGeometryResult.endpointSlopeMPerM * 100
              : "not available",
          slope_10_85_percent:
            watershedGeometryResult
              ? watershedGeometryResult.slope10To85MPerM * 100
              : "not available",
          outlet_elevation_m:
            watershedGeometryResult?.outletElevationMetres ?? "not available",
          upstream_elevation_m:
            watershedGeometryResult?.upstreamElevationMetres ?? "not available",
          elevation_source:
            watershedGeometryResult?.elevationSource ?? "not applicable",
          tc_minutes: timeOfConcentrationMinutes ?? "not calculated",
          design_return_period_years: designReturnPeriod,
          idf_chart_equation: formatShermanEquation(idfEquation),
          equation_r_squared: idfEquation?.rSquared ?? "not fitted",
          design_intensity_mm_per_hour:
            designIntensity ?? "not calculated",
          design_depth_over_tc_mm:
            designRainfallDepth ?? "not calculated",
          supported_duration_range_minutes: "5–1440",
          engineering_note:
            "The IDF equation supplies intensity at duration t=tc; it does not independently determine tc. Verify the tc method and design criteria for the project.",
        },
      ]),
      "Time of Concentration",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        infrastructureGuidance.map((row) => ({
          return_period: row.period,
          annual_exceedance_probability: row.aep,
          infrastructure: row.infrastructure,
          application_note: row.use,
          literature_basis: row.basis,
          authority_warning:
            "Screening guide only; confirm the governing Pakistan authority, asset class, consequence category and climate allowance.",
        })),
      ),
      "Infrastructure Guide",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet([
        {
          boundary: sourceTab === "observed" ? "not used in fitting" : boundary,
          feature_count:
            sourceTab === "observed"
              ? "not applicable"
              : (geo?.features.length ?? 0),
          recommended_source: "OCHA COD-AB Pakistan",
          matched_boundary_name:
            sourceTab === "observed"
              ? "not evaluated — district selection disabled"
              : (matchedBoundaryName ?? "not matched"),
          spatial_extraction_mode:
            sourceTab === "observed"
              ? "Uploaded station / gauge series"
              : spatialMode === "district"
                ? "District boundary average"
                : "Point coordinates",
          latitude: coordinateValid ? coordinateLat : "not provided",
          longitude: coordinateValid ? coordinateLon : "not provided",
          coordinate_inside_selected_district:
            sourceTab === "observed"
              ? "not evaluated — district selection disabled"
              : (coordinateInsideDistrict ?? "not evaluated"),
          coordinate_status: coordinateStatus,
          district:
            sourceTab === "observed"
              ? "not used for uploaded gauge analysis"
              : district,
        },
      ]),
      "Boundary Audit",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["Reference", "URL"], ...refs]),
      "References",
    );
    XLSX.writeFile(
      wb,
      `${(sourceTab === "observed" ? name : district).replaceAll(" ", "-") || "precipitation"}-idf-curves.xlsx`,
    );
  }
  async function report(format: "html" | "docx" = "html") {
    const node = document.querySelector("#report")?.cloneNode(true) as
      | HTMLElement
      | undefined;
    if (!node) return;
    node.querySelector(".report-actions")?.remove();
    const reportName =
      sourceTab === "observed" ? name || "Observed gauge" : district;
    try {
      if (format === "docx") {
        const { buildWordReport } = await import("../lib/report-export");
        save(await buildWordReport(node, `${reportName} IDF technical report`), `${reportFileStem(reportName)}-IDF-technical-report.docx`);
        return;
      }
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeReportText(reportName)} IDF technical report</title><style>${REPORT_EXPORT_CSS}${REPORT_LAYOUT_CSS}</style></head><body>${node.outerHTML}</body></html>`;
      save(new Blob([html], { type: "text/html;charset=utf-8" }), `${reportFileStem(reportName)}-IDF-technical-report.html`);
    } catch (error) {
      window.alert(`Report export failed: ${error instanceof Error ? error.message : "Please try HTML or Print / Save PDF."}`);
    }
  }
  return (
    <main>
      <style>{REPORT_LAYOUT_CSS}</style>
      <header className="site-header">
        <a className="brand" href="#top">
          <span className="brand-icon" aria-hidden="true">IDF</span>
          <span>Pakistan IDF Atlas</span>
        </a>
        <nav>
          <a href="#source">Data</a>
          <a href="#boundary">Map</a>
          <a href="#curves">Analysis</a>
          <a href="#report">Report</a>
          <a href="/downloads/Pakistan-IDF-Atlas-User-Manual.html">Manual</a>
        </nav>
        <span className="data-current">
          <i />
          Professional analysis workspace
        </span>
      </header>
      <section className="hero-section" id="top">
        <div className="hero-copy">
          <div>
            <p className="eyebrow">
              Observed and online precipitation · Pakistan
            </p>
            <h1>Precipitation IDF Analysis</h1>
            <p>
              Upload gauge data or retrieve ERA5, ERA5-Land, CHIRPS, IMERG and
              NASA POWER precipitation, or directly retrieve NASA
              NEX-GDDP-CMIP6 projections; quality-check, fit, compare,
              visualize and export a traceable analysis.
            </p>
          </div>
          <div className="hero-actions">
            <a
              href="/downloads/Pakistan_IDF_Atlas_Standalone_Windows_OfflineInstaller_2026-08-20.zip?v=2026.08.20.4.1"
              download
            >
              Download Windows app + offline installer
            </a>
          </div>
        </div>
        <div className="screening-notice">
          <p>
            <strong>Scientific scope:</strong> daily input directly supports
            24-hour rainfall; native hourly input directly supports rolling 1-
            to 24-hour rainfall. CHIRPS has no hourly product, and authenticated
            IMERG half-hourly archive access is not connected.
          </p>
        </div>
        <nav className="workflow-ribbon" aria-label="IDF analysis workflow">
          <a href="#source">
            <span>01</span><strong>Choose data</strong><small>Observed, online or CMIP6</small>
          </a>
          <a href="#boundary">
            <span>02</span><strong>Select location</strong><small>District boundary or coordinates</small>
          </a>
          <a href="#curves">
            <span>03</span><strong>Run IDF</strong><small>Stationary or nonstationary</small>
          </a>
          <a href="#curves">
            <span>04</span><strong>Compare methods</strong><small>GEV, Gumbel, LP3 and Sherman</small>
          </a>
          <a href="#report">
            <span>05</span><strong>Export results</strong><small>Charts, Excel and report</small>
          </a>
        </nav>
      </section>
      <section id="source" className="content-width workspace">
        <div className="section-title">
          <p className="eyebrow">Source workspace</p>
          <h2>Observed, online and CMIP6 precipitation</h2>
          <p>
            Keep gauge observations, present-climate grids and future GCM
            projections separate so provenance and bias remain visible.
          </p>
        </div>
        <div className="source-tabs" role="tablist">
          <button
            className={sourceTab === "observed" ? "active" : ""}
            onClick={() => {
              setSourceTab("observed");
              if (modelTab === "nonstationary") setMethod("gev");
            }}
          >
            ▤ Observed Excel data
          </button>
          <button
            className={sourceTab === "online" ? "active" : ""}
            onClick={() => {
              setSourceTab("online");
              if (modelTab === "nonstationary") setMethod("gev");
            }}
          >
            ◎ Online source data
          </button>
          <button
            className={sourceTab === "cmip6" ? "active" : ""}
            onClick={() => {
              setSourceTab("cmip6");
              setModelTab("nonstationary");
              setNonstationaryCovariate("time");
              setMethod("gev");
              setCustomReferenceYear(CMIP6_PERIODS[cmipPeriod].midpoint);
            }}
          >
            ◈ CMIP6 projections
          </button>
        </div>
        {sourceTab === "observed" ? (
          <>
            <div className="model-tabs observed-resolution-tabs" role="tablist">
              <button
                className={observedResolution === "daily" ? "active" : ""}
                onClick={() => setObservedResolution("daily")}
              >
                <strong>Daily observations</strong>
                <span>Direct support at 24 hours</span>
              </button>
              <button
                className={observedResolution === "hourly" ? "active" : ""}
                onClick={() => {
                  setObservedResolution("hourly");
                  setModelTab("stationary");
                }}
              >
                <strong>Hourly observations</strong>
                <span>Direct support from 1 to 24 hours</span>
              </button>
            </div>
            {observedResolution === "daily" && (
              <div className="upload-grid panel">
                <div className="dropzone">
                  <input
                    ref={input}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => upload(e.target.files?.[0])}
                  />
                  <strong>Excel / CSV daily precipitation</strong>
                  <p>
                    Automatically scans every worksheet and detects Date,
                    Date-Time, or separate Year/Month/Day/Hour columns. Daily or
                    hourly mode is chosen automatically.
                  </p>
                  <button onClick={() => input.current?.click()}>
                    Auto-read entire workbook
                  </button>
                  <button
                    className="secondary-action"
                    onClick={downloadObservedPrecipitation}
                    disabled={!qc.records.length}
                  >
                    Download selected daily data
                  </button>
                  <small>{message}</small>
                </div>
                <div className="formgrid">
                  <label>
                    Source / station
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label>
                    District selection
                    <select
                      value={district}
                      onChange={(e) => chooseDistrict(e.target.value)}
                      disabled={manualObservedLoaded}
                      aria-disabled={manualObservedLoaded}
                    >
                      {allDistricts.map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                    {manualObservedLoaded && (
                      <small className="field-note">
                        Disabled: uploaded gauge data are fitted independently
                        of district boundaries.
                      </small>
                    )}
                  </label>
                  <label>
                    Custom start date
                    <input
                      type="date"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </label>
                  <label>
                    Custom end date
                    <input
                      type="date"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  </label>
                  <label>
                    Subdaily exponent
                    <input
                      type="number"
                      min=".1"
                      max=".9"
                      step=".01"
                      value={exponent}
                      onChange={(e) => setExponent(+e.target.value)}
                    />
                  </label>
                  <label>
                    Boundary vintage
                    <input
                      value={boundary}
                      onChange={(e) => setBoundary(e.target.value)}
                    />
                  </label>
                </div>
              </div>
            )}
            {observedResolution === "hourly" && (
              <div className="upload-grid panel">
                <div className="dropzone">
                  <input
                    ref={hourlyInput}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => uploadHourly(e.target.files?.[0])}
                  />
                  <strong>Excel / CSV hourly precipitation</strong>
                  <p>
                    Reads Timestamp, Date + Time, or Year/Month/Day/Hour/Minute
                    layouts. Minute and sub-hourly interval depths are summed
                    into clock-hour totals without timezone conversion.
                  </p>
                  <button onClick={() => hourlyInput.current?.click()}>
                    Auto-read entire workbook
                  </button>
                  <button
                    className="secondary-action"
                    onClick={downloadHourlyTemplate}
                  >
                    Download CSV template
                  </button>
                  <button
                    className="secondary-action"
                    onClick={downloadObservedPrecipitation}
                    disabled={!hourlyQc.records.length}
                  >
                    Download selected hourly data
                  </button>
                  <small>{message}</small>
                </div>
                <div className="formgrid">
                  <label>
                    Source / station
                    <input
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label>
                    District selection
                    <select
                      value={district}
                      onChange={(e) => chooseDistrict(e.target.value)}
                      disabled={manualObservedLoaded}
                      aria-disabled={manualObservedLoaded}
                    >
                      {allDistricts.map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                    {manualObservedLoaded && (
                      <small className="field-note">
                        Disabled: uploaded gauge data are fitted independently
                        of district boundaries.
                      </small>
                    )}
                  </label>
                  <label>
                    Custom start date
                    <input
                      type="date"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </label>
                  <label>
                    Custom end date
                    <input
                      type="date"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  </label>
                  <label>
                    Sub-hourly exponent
                    <input
                      type="number"
                      min=".1"
                      max=".9"
                      step=".01"
                      value={exponent}
                      onChange={(e) => setExponent(+e.target.value)}
                    />
                  </label>
                  <label>
                    Boundary vintage
                    <input
                      value={boundary}
                      onChange={(e) => setBoundary(e.target.value)}
                    />
                  </label>
                </div>
              </div>
            )}
            {observedResolution === "daily" && raw.length > 0 && (
              <article className="panel data-editor">
                <div className="panel-head">
                  <div>
                    <span>Editable source records</span>
                    <h2>Observed daily precipitation</h2>
                  </div>
                  <span className="badge">
                    Showing first 100 of {raw.length.toLocaleString()}
                  </span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Precipitation (mm)</th>
                        <th>QC state</th>
                      </tr>
                    </thead>
                    <tbody>
                      {raw.slice(0, 100).map((r, i) => (
                        <tr key={`${r.date}-${i}`}>
                          <td>
                            <input
                              type="date"
                              value={r.date}
                              onChange={(e) =>
                                updateRow(i, "date", e.target.value)
                              }
                            />
                          </td>
                          <td>
                            <input
                              type="number"
                              min="0"
                              step="0.1"
                              value={r.precipitationMm}
                              onChange={(e) =>
                                updateRow(i, "precipitationMm", e.target.value)
                              }
                            />
                          </td>
                          <td>{r.qc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            )}
            {observedResolution === "hourly" && hourlyRaw.length > 0 && (
              <article className="panel data-editor">
                <div className="panel-head">
                  <div>
                    <span>Source records</span>
                    <h2>Observed hourly precipitation</h2>
                  </div>
                  <span className="badge">
                    Showing first 100 of {hourlyRaw.length.toLocaleString()}
                  </span>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Timestamp</th>
                        <th>Hourly depth (mm)</th>
                        <th>QC state</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hourlyRaw.slice(0, 100).map((row, i) => (
                        <tr key={`${row.timestamp}-${i}`}>
                          <td>{row.timestamp}</td>
                          <td>{row.precipitationMm}</td>
                          <td>{row.qc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            )}
          </>
        ) : sourceTab === "online" ? (
          <article className="panel online-workspace">
            <div>
              <span className="source-orb">◎</span>
              <p className="eyebrow">Live present-climate extraction</p>
              <h2>{SOURCE_META[onlineSource].label}</h2>
              <p>
                {onlineSource === "era5" || onlineSource === "era5land"
                  ? "Hourly or daily"
                  : "Daily"}{" "}
                ·{" "}
                {SOURCE_META[onlineSource].coverage}
              </p>
            </div>
            <div className="formgrid">
              <label>
                Online dataset
                <select
                  value={onlineSource}
                  onChange={(e) => {
                    const next = e.target.value as LiveOnlineSource;
                    const nextFirstDate = LIVE_SOURCE_CONFIG[next].firstDate;
                    setOnlineSource(next);
                    setOnlineQuotaBlocked(false);
                    setOnlineStart((current) =>
                      !current || current < nextFirstDate
                        ? nextFirstDate
                        : current,
                    );
                    setOnlineMessage(
                      "Choose the spatial mode and date range, then retrieve this provider series.",
                    );
                    if (
                      next !== "era5" &&
                      next !== "era5land" &&
                      onlineResolution === "hourly"
                    )
                      setOnlineResolution("daily");
                  }}
                  disabled={onlineBusy || cmipBusy}
                >
                  <option value="era5">ERA5 reanalysis · rainfall available</option>
                  <option value="era5land" disabled>
                    ERA5-Land · rainfall unavailable through this API
                  </option>
                  <option value="chirps">CHIRPS daily</option>
                  <option value="imerg">NASA IMERG V07 Late daily</option>
                  <option value="imergEarly">
                    NASA IMERG V07 Early daily
                  </option>
                  <option value="power">
                    NASA POWER MERRA-2 corrected daily
                  </option>
                </select>
              </label>
              <label>
                Temporal resolution
                <select
                  value={onlineResolution}
                  onChange={(e) => {
                    const next = e.target.value as OnlineTemporalResolution;
                    setOnlineResolution(next);
                    if (next === "hourly") setModelTab("stationary");
                  }}
                  disabled={onlineBusy || cmipBusy}
                >
                  <option value="daily">
                    Daily series · supports 24-hour IDF
                  </option>
                  <option
                    value="hourly"
                    disabled={onlineSource !== "era5"}
                  >
                    Hourly series · ERA5
                  </option>
                </select>
                <small className="field-note">
                  {onlineSource === "era5"
                    ? "Hourly ERA5 supports rolling 1-, 2-, 3-, 6-, 12- and 24-hour maxima. ERA5-Land precipitation is not exposed by the connected API."
                    : onlineSource === "era5land"
                      ? ERA5_LAND_PRECIPITATION_NOTICE
                    : onlineSource === "chirps"
                      ? "CHIRPS is daily; shorter durations must be derived."
                      : onlineSource === "power"
                        ? "NASA POWER PRECTOTCORR is retrieved as corrected daily precipitation; shorter durations must be derived."
                        : "This public IMERG connection is daily. NASA's native 30-minute archive requires authenticated access."}
                </small>
              </label>
              <label>
                District
                <select
                  value={district}
                  onChange={(e) => chooseDistrict(e.target.value)}
                  disabled={onlineBusy || spatialMode === "point"}
                >
                  {allDistricts.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
                <small className="field-note">
                  All {OCHA_ADM2_CATALOGUE_COUNT} verified OCHA ADM2 polygons
                  are available. Retrieval uses one selected district at a
                  time; point mode uses the entered coordinates.
                </small>
              </label>
              <label>
                Start date
                <input
                  type="date"
                  value={onlineStart}
                  min={
                    LIVE_SOURCE_CONFIG[onlineSource].firstDate
                  }
                  onChange={(e) => setOnlineStart(e.target.value)}
                  disabled={onlineBusy}
                />
                <small className="field-note">
                  Blank defaults to{" "}
                  {
                    LIVE_SOURCE_CONFIG[onlineSource].firstDate
                  }
                  ; hourly requests are limited to 45 calendar years.
                </small>
              </label>
              <label>
                End date
                <input
                  type="date"
                  value={onlineEnd}
                  onChange={(e) => setOnlineEnd(e.target.value)}
                  disabled={onlineBusy}
                />
                <small className="field-note">
                  Blank defaults to the last complete calendar year.
                </small>
              </label>
            </div>
            <div className="live-extraction-card">
              <div>
                <span>Direct source retrieval</span>
                <strong>
                  {spatialMode === "district"
                    ? `${district} polygon ${onlineResolution} series`
                    : `Point/grid-cell ${onlineResolution} series at ${coordinateValid ? `${coordinateLat.toFixed(5)}, ${coordinateLon.toFixed(5)}` : "coordinates required"}`}
                </strong>
                <small>
                  {spatialMode === "district" && matchedBoundaryIdentity
                    ? `${matchedBoundaryIdentity.source} · ${matchedBoundaryIdentity.code} · ${matchedBoundaryIdentity.version} · valid from ${matchedBoundaryIdentity.validOn}. `
                    : ""}
                  {onlineSource === "era5"
                    ? `ERA5 ${onlineResolution} precipitation is retrieved directly from the provider service. District mode combines a quota-bounded ${ERA5_DISTRICT_CELL_LIMIT[onlineResolution]}-cell representative sample with documented approximate overlap weights; point mode uses the nearest returned grid cell. Successful provider batches are cached in this browser to avoid repeated quota use. ERA5-Land remains available elsewhere for supported land-surface covariates, but not as a rainfall source through this connection.`
                    : onlineSource === "era5land"
                      ? ERA5_LAND_PRECIPITATION_NOTICE
                    : onlineSource === "power"
                      ? "Corrected daily MERRA-2 precipitation is retrieved through NASA POWER. District mode forms an approximate overlap-weighted mean from representative native cells; point mode uses the returned cell."
                      : `Daily precipitation is retrieved through ClimateSERV using ${onlineSource === "chirps" ? "10-year" : "5-year"} processing jobs for reliability. The service calculates statistics for the submitted point buffer or exact district polygon.`}
                </small>
              </div>
              <button
                className="primary-extract"
                onClick={extractOnlinePrecipitation}
                disabled={
                  onlineBusy ||
                  onlineSource === "era5land" ||
                  (spatialMode === "point" && !coordinateValid) ||
                  (spatialMode === "district" && !matchedBoundaryFeature)
                }
              >
                {onlineBusy
                  ? `Retrieving… ${onlineProgress}%`
                  : onlineReady
                    ? "Retrieve updated source data"
                    : "Retrieve directly from source"}
              </button>
            </div>
            <div
              className={`online-extraction-status ${onlineReady ? "complete" : ""}`}
            >
              <div>
                <strong>
                  {onlineReady
                    ? "Retrieved source data ready"
                    : onlineBusy
                      ? "Provider processing"
                      : "Select options, then retrieve from source"}
                </strong>
                <span>{onlineMessage}</span>
                {onlineQuotaBlocked && onlineResolution === "daily" && (
                  <button
                    type="button"
                    className="secondary-action"
                    onClick={() => {
                      setOnlineSource("power");
                      setOnlineResolution("daily");
                      setStart((current) =>
                        !current || current < LIVE_SOURCE_CONFIG.power.firstDate
                          ? LIVE_SOURCE_CONFIG.power.firstDate
                          : current,
                      );
                      setOnlineQuotaBlocked(false);
                      setOnlineMessage(
                        "NASA POWER MERRA-2 has been selected as an alternative daily reanalysis. Click Retrieve directly from source to continue; the report will identify the changed dataset.",
                      );
                    }}
                  >
                    Select NASA POWER alternative
                  </button>
                )}
              </div>
              {onlineBusy && <progress max="100" value={onlineProgress} />}{" "}
              {onlineReady && onlineMetadata && (
                <dl>
                  <div>
                    <dt>Dataset</dt>
                    <dd>{onlineMetadata.dataset}</dd>
                  </div>
                  <div>
                    <dt>Temporal resolution</dt>
                    <dd>{onlineMetadata.temporalResolution}</dd>
                  </div>
                  {onlineMetadata.extractionMode === "district" && (
                    <div>
                      <dt>District boundary</dt>
                      <dd>
                        {onlineMetadata.districtName ?? district} · {onlineMetadata.districtCode ?? "code not reported"}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt>Record</dt>
                    <dd>
                      {onlineMetadata.returnedStart}–
                      {onlineMetadata.returnedEnd}
                    </dd>
                  </div>
                  <div>
                    <dt>Accepted intervals</dt>
                    <dd>{onlineMetadata.acceptedRecords.toLocaleString()}</dd>
                  </div>
                  <div>
                    <dt>Eligible years</dt>
                    <dd>{onlineStationarity.n}</dd>
                  </div>
                  <div>
                    <dt>Spatial method</dt>
                    <dd>{onlineMetadata.spatialMethod}</dd>
                  </div>
                  <div>
                    <dt>Retrieved</dt>
                    <dd>
                      {new Date(onlineMetadata.retrievedAt).toLocaleString()}
                    </dd>
                  </div>
                </dl>
              )}
            </div>
            <div className="source-download-card">
              <div>
                <span>Source and reproducibility</span>
                <strong>{SOURCE_META[onlineSource].accessLabel}</strong>
                <small>{SOURCE_META[onlineSource].accessMode}</small>
              </div>
              <div className="source-download-actions">
                <a
                  href={SOURCE_META[onlineSource].accessUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open provider website
                </a>
                <button
                  onClick={downloadOnlinePrecipitation}
                  disabled={!onlineReady}
                >
                  Download retrieved precipitation
                </button>
                <button
                  onClick={() =>
                    setShowOnlinePrecipitationPlot(
                      !showOnlinePrecipitationPlot,
                    )
                  }
                  disabled={!onlineReady}
                  aria-expanded={showOnlinePrecipitationPlot}
                  aria-controls="retrieved-precipitation-plot"
                >
                  {showOnlinePrecipitationPlot
                    ? "Hide precipitation plot"
                    : "Plot retrieved precipitation"}
                </button>
                <button
                  onClick={downloadSourceRequest}
                  disabled={spatialMode === "point" && !coordinateValid}
                >
                  Download request record
                </button>
              </div>
            </div>
            {onlineReady &&
              onlineMetadata &&
              showOnlinePrecipitationPlot && (
                <section
                  className="precipitation-plot-card"
                  id="retrieved-precipitation-plot"
                >
                  <div className="precipitation-plot-head">
                    <div>
                      <span>Retrieved provider record</span>
                      <h3>Precipitation through time</h3>
                      <p>
                        Plot the accepted source values at their native
                        resolution or aggregate them to clearer daily, monthly
                        or annual totals.
                      </p>
                    </div>
                    <div className="precipitation-plot-actions">
                      <label>
                        Plot interval
                        <select
                          value={onlinePlotInterval}
                          onChange={(event) =>
                            setOnlinePlotInterval(
                              event.target
                                .value as PrecipitationPlotInterval,
                            )
                          }
                        >
                          <option value="native">
                            {onlineResolution === "hourly"
                              ? "Hourly values · native"
                              : "Daily values · native"}
                          </option>
                          {onlineResolution === "hourly" && (
                            <option value="daily">Daily totals</option>
                          )}
                          <option value="monthly">Monthly totals</option>
                          <option value="annual">Annual totals</option>
                        </select>
                      </label>
                      <button type="button" onClick={precipitationPlotPng}>
                        Download plot PNG
                      </button>
                    </div>
                  </div>
                  <PrecipitationSeriesChart
                    records={onlinePlotRecords}
                    resolution={onlineMetadata.temporalResolution}
                    interval={onlinePlotInterval}
                    dataset={onlineMetadata.dataset}
                    location={onlinePlotLocation}
                  />
                </section>
              )}
            <details className="status-explainer">
              <summary>What happens after direct source retrieval?</summary>
              <p>
                {onlineResolution === "hourly"
                  ? "After retrieval succeeds, the atlas automatically checks native hourly ERA5 timestamps and non-negative values, retains years with at least 90% hourly coverage, calculates rolling 1-, 2-, 3-, 6-, 12- and 24-hour annual maxima, fits each duration separately and derives only 5- to 30-minute values from the one-hour fit. The retrieved hourly series can also be plotted, aggregated and downloaded."
                  : "After retrieval succeeds, the atlas automatically checks the provider’s daily dates and non-negative values, retains years with at least 90% daily coverage, fits the annual daily maxima and derives durations below 24 hours with the displayed scaling exponent. The retrieved daily series can also be plotted, aggregated and downloaded."}
              </p>
            </details>
          </article>
        ) : (
          <article className="panel online-workspace cmip6-workspace">
            <div>
              <span className="source-orb">◈</span>
              <p className="eyebrow">Climate projection catalogue</p>
              <h2>NASA NEX-GDDP-CMIP6 v2</h2>
              <p>
                Daily · 0.25° · 35 model/grid entries · direct NASA retrieval
                through 2100
              </p>
            </div>
            <div className="formgrid">
              <label>
                GCM selection mode
                <select
                  value={cmipSelectionMode}
                  onChange={(e) =>
                    setCmipSelectionMode(e.target.value as Cmip6SelectionMode)
                  }
                  disabled={cmipBusy}
                >
                  <option value="ensemble">Multi-model median</option>
                  <option value="individual">Individual GCM model</option>
                </select>
              </label>
              {cmipSelectionMode === "individual" && (
                <label>
                  Individual GCM
                  <select
                    value={cmipModel}
                    onChange={(e) => {
                      setCmipModel(
                        e.target.value as (typeof CMIP6_MODELS)[number],
                      );
                      setCmipMember("auto");
                      setCmipHistoricalLoadedKey("");
                    }}
                    disabled={cmipBusy}
                  >
                    <optgroup label="Recommended Pakistan 10-model ensemble">
                      {PAKISTAN_IDF_ENSEMBLE_MODELS.map((model) => (
                        <option key={model}>{model}</option>
                      ))}
                    </optgroup>
                    <optgroup label="Additional NASA catalogue models">
                      {CMIP6_MODELS.filter(
                        (model) =>
                          !PAKISTAN_IDF_ENSEMBLE_MODELS.includes(
                            model as (typeof PAKISTAN_IDF_ENSEMBLE_MODELS)[number],
                          ),
                      ).map((model) => (
                        <option key={model}>{model}</option>
                      ))}
                    </optgroup>
                  </select>
                  <small className="field-note">
                    Complete 35-entry NASA catalogue. Retrieval checks the
                    selected model, SSP and realization before downloading
                    precipitation.
                  </small>
                </label>
              )}
              <label>
                SSP scenario
                <select
                  value={cmipScenario}
                  onChange={(e) => {
                    setCmipScenario(e.target.value as Cmip6Scenario);
                    setCmipMember("auto");
                  }}
                  disabled={cmipBusy}
                >
                  {Object.entries(CMIP6_SCENARIOS).map(([id, s]) => (
                    <option key={id} value={id}>
                      {s.label} · {s.description}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Future analysis period
                <select
                  value={cmipPeriod}
                  onChange={(e) => {
                    const period = e.target.value as Cmip6Period;
                    setCmipPeriod(period);
                    setCustomReferenceYear(CMIP6_PERIODS[period].midpoint);
                  }}
                  disabled={cmipBusy}
                >
                  {Object.entries(CMIP6_PERIODS).map(([id, p]) => (
                    <option key={id} value={id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                District
                <select
                  value={district}
                  onChange={(e) => chooseDistrict(e.target.value)}
                  disabled={cmipBusy}
                >
                  {allDistricts.map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="projection-summary">
              <div>
                <span>Selected pathway</span>
                <strong>{CMIP6_SCENARIOS[cmipScenario].label}</strong>
                <small>{CMIP6_SCENARIOS[cmipScenario].description}</small>
              </div>
              <div>
                <span>Time slice</span>
                <strong>{cmipPeriod}</strong>
                <small>Reference year {cmipMidpoint}</small>
              </div>
              <div>
                <span>
                  {cmipSelectionMode === "individual"
                    ? "Individual GCM"
                    : "Ensemble summary"}
                </span>
                <strong>{cmipModelLabel}</strong>
                <small>
                  {cmipSelectionMode === "individual"
                    ? "Selected model is retrieved and fitted separately"
                    : "Model-specific return levels must be summarized before taking the median"}{" "}
                  · variable pr
                </small>
              </div>
              <div>
                <span>NASA realization</span>
                <strong>
                  {cmipMetadata?.member ??
                    (cmipMember === "auto"
                      ? "Checked automatically"
                      : cmipMember)}
                </strong>
                <small>
                  {cmipImportedReady
                    ? `${cmipImportedModels.length} bias-corrected models · 24-hour return levels`
                    : cmipDataReady
                    ? `${cmipQc.records.length.toLocaleString()} accepted daily values · ${cmipStationarity.n} eligible maxima`
                    : "No sample multiplier · IDF remains blank until data are retrieved"}
                </small>
              </div>
            </div>
            <div className="source-download-card">
              <div>
                <span>Official projection data access</span>
                <strong>{SOURCE_META.cmip6.accessLabel}</strong>
                <small>{SOURCE_META.cmip6.accessMode}</small>
              </div>
              <div className="source-download-actions">
                <button
                  type="button"
                  className="primary-extract"
                  onClick={retrieveCmipPrecipitation}
                  disabled={
                    cmipBusy ||
                    cmipSelectionMode !== "individual" ||
                    (spatialMode === "point" && !cmipCoordinateReady) ||
                    (spatialMode === "district" && !matchedBoundaryFeature)
                  }
                >
                  {cmipBusy
                    ? `Retrieving NASA data · ${cmipProgress}%`
                    : cmipSelectionMode === "individual"
                      ? "Retrieve GCM data & develop IDF"
                      : "Choose an individual GCM"}
                </button>
                <a
                  href={SOURCE_META.cmip6.accessUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  Browse official NASA catalogue
                </a>
                <input
                  ref={cmipInput}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  hidden
                  onChange={(event) =>
                    uploadCmipPrecipitation(event.target.files?.[0])
                  }
                />
                <button
                  type="button"
                  onClick={() => cmipInput.current?.click()}
                  disabled={cmipBusy}
                >
                  Upload GCM data instead
                </button>
                <input
                  ref={cmipResultsInput}
                  type="file"
                  accept=".xlsx,.xls"
                  hidden
                  onChange={(event) =>
                    uploadBiasCorrectedCmipWorkbook(event.target.files?.[0])
                  }
                />
                <button
                  type="button"
                  onClick={() => cmipResultsInput.current?.click()}
                  disabled={cmipBusy}
                >
                  Import bias-corrected results workbook
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setShowCmipPrecipitationPlot(
                      !showCmipPrecipitationPlot,
                    )
                  }
                  disabled={!cmipDataReady || cmipBusy}
                  aria-expanded={showCmipPrecipitationPlot}
                  aria-controls="gcm-precipitation-plot"
                >
                  {showCmipPrecipitationPlot
                    ? "Hide GCM plot"
                    : "Plot GCM precipitation"}
                </button>
                <button
                  type="button"
                  onClick={downloadCmipPrecipitation}
                  disabled={!cmipDataReady || cmipBusy}
                >
                  Download retrieved GCM data
                </button>
                <button
                  onClick={downloadSourceRequest}
                  disabled={
                    cmipBusy || (spatialMode === "point" && !coordinateValid)
                  }
                >
                  Download model request workbook
                </button>
              </div>
            </div>
            <section className="gcm-validation-card" aria-label="Reference validation and multi-model uncertainty">
              <div><span>Pakistan-wide engineering workflow</span><h3>Daily QDM bias correction and multi-model uncertainty</h3><p>Choose any verified point inside Pakistan. The atlas compares the 1985–2014 historical GCM grid cell with a nearby gauge when at least 20 overlapping years are available, or with explicitly labelled ERA5 reanalysis otherwise. Monthly multiplicative quantile delta mapping corrects every future daily value before annual maxima and the 24-hour GEV are fitted. Shorter durations still require observed hourly ratios.</p></div>
              <label>
                Bias-correction reference
                <select value={cmipBiasReference} onChange={event => { setCmipBiasReference(event.target.value as Cmip6BiasReference); setCmipHistoricalRaw([]); setCmipEra5ReferenceRaw([]); setCmipHistoricalLoadedKey(""); setCmipHistoricalMessage("Reference changed. Retrieve the historical GCM and selected reference again before applying correction."); }} disabled={cmipBusy}>
                  <option value="auto">Automatic · gauge first, ERA5 if unavailable</option>
                  <option value="gauge">Observed gauge only</option>
                  <option value="era5">ERA5 reanalysis</option>
                </select>
              </label>
              <div className="gcm-validation-actions">
                <button type="button" onClick={retrieveHistoricalCmipForBiasCorrection} disabled={cmipBusy || spatialMode !== "point" || !cmipCoordinateReady || (cmipBiasReference === "gauge" && gaugeHistoricalQc.eligibleYears < 20)}>Retrieve historical GCM & bias-correction reference</button>
                <button type="button" disabled={!cmipValidatedRows.length || cmipSelectionMode !== "individual" || !cmipQdmReady} onClick={storeCorrectedCmipModel}>Add QDM-corrected model to ensemble</button>
                <button type="button" disabled={cmipBusy || cmipRecommendedStored >= PAKISTAN_IDF_ENSEMBLE_MODELS.length} onClick={selectNextPakistanEnsembleModel}>Select next recommended model</button>
                <button type="button" disabled={!cmipActiveEnsembleModels.length} onClick={() => setCmipEnsembleModels(previous => previous.filter(item => item.selectionKey !== currentCmipEnsembleKey))}>Clear this location ensemble</button>
              </div>
              <div className="gcm-evidence-grid">
                <div><span>Pakistan location</span><strong>{spatialMode === "point" && cmipCoordinateReady ? `Verified project grid cell · ${coordinateLat.toFixed(5)}, ${coordinateLon.toFixed(5)}` : spatialMode === "point" && coordinateValid ? "Outside verified Pakistan boundaries" : "Switch to Point/grid-cell"}</strong></div>
                <div><span>Historical overlap</span><strong>{cmipImportedReady ? cmipImportedWorkbook?.historicalPeriod : `${cmipHistoricalQc.eligibleYears || 0} GCM years · ${cmipReferenceAms.length} ${cmipReferenceLabel} years`}</strong></div>
                <div><span>Daily bias correction</span><strong>{cmipImportedReady ? `Precomputed and validated in workbook · ${cmipReferenceLabel}` : cmipQdmReady ? `12 monthly QDM groups · ${useEra5BiasReference ? "reanalysis-corrected" : "gauge-corrected"}` : `Pending historical + ${cmipReferenceLabel} comparison`}</strong></div>
                <div><span>Sub-daily basis</span><strong>{observedResolution === "hourly" && hourlyRaw.length ? "Observed hourly duration ratios" : "Unavailable · 24-hour result only"}</strong></div>
                <div><span>Active ensemble</span><strong>{cmipActiveEnsembleModels.length} models stored · {cmipRecommendedStored}/10 recommended · minimum 3</strong></div>
                <div><span>Record status</span><strong>{cmipImportedReady ? cmipImportedWorkbook?.validationStatus : projectionEvidenceStatus(cmipStationarity.n, 500)}</strong></div>
              </div>
              <p className="gcm-validation-message">{cmipHistoricalMessage}</p>
              {cmipImportedReady && cmipImportedWorkbook && (
                <details className="qdm-monthly-audit" open>
                  <summary>
                    Imported workbook validation · {cmipImportedWorkbook.validationStatus}
                  </summary>
                  <ul>
                    {cmipImportedWorkbook.validationCaveats.map((caveat) => (
                      <li key={caveat}>{caveat}</li>
                    ))}
                    {cmipImportedWorkbook.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </details>
              )}
              {cmipBiasComparison.length > 0 && (
                <div className="table-scroll gcm-bias-table">
                  <table>
                    <caption>Raw versus daily-QDM-corrected future 24-hour fit · {modelTab} GEV</caption>
                    <thead><tr><th>Return period</th><th>Historical GCM</th><th>{cmipReferenceLabel}</th><th>Corrected/raw fit ratio</th><th>Future raw</th><th>Future corrected</th></tr></thead>
                    <tbody>{cmipBiasComparison.map(row => (
                      <tr key={`bias-${row.returnPeriodYears}`}>
                        <th>{row.returnPeriodYears} years</th>
                        <td>{row.historicalGcmMm.toFixed(2)} mm</td>
                        <td>{row.referenceMm.toFixed(2)} mm</td>
                        <td>{row.factor.toFixed(3)}×</td>
                        <td>{row.futureRawMm.toFixed(2)} mm</td>
                        <td><strong>{row.futureCorrectedMm.toFixed(2)} mm</strong></td>
                      </tr>
                    ))}</tbody>
                  </table>
                </div>
              )}
              {cmipQdm.summaries.length > 0 && (
                <details className="qdm-monthly-audit">
                  <summary>Monthly QDM audit · 12 calendar groups</summary>
                  <div className="table-scroll">
                    <table>
                      <thead><tr><th>Month</th><th>Future days</th><th>Historical GCM days</th><th>{cmipReferenceLabel} days</th><th>Median factor</th><th>P10–P90 factor</th></tr></thead>
                      <tbody>{cmipQdm.summaries.map(summary => (
                        <tr key={`qdm-${summary.month}`}><th>{new Date(2000, summary.month - 1, 1).toLocaleString("en", { month: "short" })}</th><td>{summary.futureRecords.toLocaleString()}</td><td>{summary.historicalGcmRecords.toLocaleString()}</td><td>{summary.referenceRecords.toLocaleString()}</td><td>{summary.medianFactor.toFixed(3)}×</td><td>{summary.p10Factor.toFixed(3)}–{summary.p90Factor.toFixed(3)}×</td></tr>
                      ))}</tbody>
                    </table>
                  </div>
                </details>
              )}
              {cmipActiveEnsembleModels.length > 0 && <p className="gcm-validation-message">Stored models for this exact Pakistan point, SSP, period, reference and fitting method: {cmipActiveEnsembleModels.map(item => item.model).join(", ")}. Ensemble output reports the model median with 10th–90th percentile bounds and remains unavailable until at least three corrected models are stored.</p>}
            </section>
            <div
              className={`online-extraction-status ${cmipResultsReady ? "complete" : ""}`}
              aria-live="polite"
            >
              <div>
                <strong>
                  {cmipImportedReady
                    ? "Bias-corrected CMIP6 ensemble imported"
                    : cmipDataReady
                    ? "Actual GCM precipitation fitted"
                    : cmipRaw.length
                      ? "Loaded GCM data does not match the active selection"
                      : cmipBusy
                        ? "Retrieving annual NASA subsets"
                        : "GCM precipitation retrieval"}
                </strong>
                <span>
                  {cmipRaw.length && !cmipDataReady && !cmipImportedReady
                    ? "The model, scenario, period or spatial selection changed after upload. Re-upload the matching file so the chart cannot be mislabelled."
                    : cmipDataMessage}
                </span>
              </div>
              {cmipBusy && (
                <progress max="100" value={cmipProgress}>
                  {cmipProgress}%
                </progress>
              )}
              {cmipDataReady && cmipMetadata && (
                <dl>
                  <div>
                    <dt>Model / member</dt>
                    <dd>
                      {cmipMetadata.model} · {cmipMetadata.member}
                    </dd>
                  </div>
                  <div>
                    <dt>Returned period</dt>
                    <dd>
                      {cmipMetadata.returnedStart} –{" "}
                      {cmipMetadata.returnedEnd}
                    </dd>
                  </div>
                  <div>
                    <dt>Spatial extraction</dt>
                    <dd>
                      {cmipMetadata.extractionMode} ·{" "}
                      {cmipMetadata.extractedGridCells} grid cell
                      {cmipMetadata.extractedGridCells === 1 ? "" : "s"}
                    </dd>
                  </div>
                  <div>
                    <dt>Model calendar</dt>
                    <dd>
                      {cmipMetadata.sourceCalendar} · calendar rule recorded
                    </dd>
                  </div>
                </dl>
              )}
            </div>
            {cmipDataReady && showCmipPrecipitationPlot && (
              <section
                className="precipitation-plot-card"
                id="gcm-precipitation-plot"
              >
                <div className="precipitation-plot-head">
                  <div>
                    <span>Retrieved GCM record</span>
                    <h3>GCM precipitation through time</h3>
                    <p>
                      The chart shows the accepted daily <code>pr</code> export
                      for the selected model, SSP, time slice and spatial
                      extraction. Monthly and annual views are precipitation
                      totals, not averages.
                    </p>
                    {spatialMode === "district" && (
                      <p className="gcm-spatial-warning">
                        <strong>District-mean series:</strong> each daily bar is
                        the mean across {cmipMetadata?.extractedGridCells ?? "the accepted"} coarse
                        0.25° grid cells. Local storm peaks are smoothed. For a
                        local/grid-cell extreme, switch Spatial extraction to
                        Point/grid-cell and enter the site coordinates.
                      </p>
                    )}
                  </div>
                  <div className="precipitation-plot-actions">
                    <label>
                      Plot interval
                      <select
                        value={cmipPlotInterval}
                        onChange={(event) =>
                          setCmipPlotInterval(
                            event.target.value as PrecipitationPlotInterval,
                          )
                        }
                      >
                        <option value="native">Daily values · native</option>
                        <option value="annual-maxima">Annual maximum daily precipitation · peaks</option>
                        <option value="monthly">Monthly totals</option>
                        <option value="annual">Annual totals</option>
                      </select>
                    </label>
                    <button type="button" onClick={precipitationPlotPng}>
                      Download GCM plot PNG
                    </button>
                  </div>
                </div>
                <PrecipitationSeriesChart
                  records={cmipPlotRecords}
                  resolution="daily"
                  interval={cmipPlotInterval}
                  dataset={`NASA NEX-GDDP-CMIP6 · ${cmipModelLabel} · ${CMIP6_SCENARIOS[cmipScenario].label} · ${cmipPeriod} · ${cmipQdmReady ? "daily QDM corrected" : "raw"}`}
                  location={cmipPlotLocation}
                />
              </section>
            )}
            <details className="status-explainer">
              <summary>What happens after direct GCM retrieval?</summary>
              <p>
                The atlas reads the model, SSP and realization from the
                official NASA catalogue, requests annual spatial subsets,
                converts daily <code>pr</code> from kg m⁻² s⁻¹ to mm/day,
                checks dates and values, retains sufficiently complete years,
                and waits for the matching historical model and reference. It
                then applies monthly multiplicative QDM to the future daily
                record, extracts corrected annual maxima and fits the selected
                probability distributions. The fitted 24-hour IDF uses the
                corrected series. Durations below 24 hours remain unavailable
                unless observed hourly duration ratios are loaded.
              </p>
            </details>
          </article>
        )}
        <article className="panel spatial-selector">
          <div>
            <p className="eyebrow">Spatial extraction</p>
            <h2>
              {manualObservedLoaded
                ? "Gauge location"
                : "District series or source grid point"}
            </h2>
            <p>
              {manualObservedLoaded
                ? "Manual observations are treated as station/gauge data. District selection and district-boundary averaging are disabled. Fitting uses only the uploaded, quality-controlled time series; coordinates are optional metadata."
                : sourceTab === "online"
                  ? "Choose a point/grid-cell series or a spatial district series. The selected geometry is sent to the online retrieval workflow and recorded in the report."
                  : "Choose a point/grid-cell series or verified district polygon for direct NASA NEX-GDDP-CMIP6 extraction."}
            </p>
          </div>
          <div className="spatial-mode-buttons">
            <button
              className={spatialMode === "district" ? "active" : ""}
              onClick={() => setSpatialMode("district")}
              disabled={manualObservedLoaded || onlineBusy || cmipBusy}
              aria-disabled={manualObservedLoaded}
            >
              <strong>District spatial series</strong>
              <span>
                {manualObservedLoaded
                  ? "Disabled for uploaded observations"
                  : `Use the verified ${district} polygon`}
              </span>
            </button>
            <button
              className={spatialMode === "point" ? "active" : ""}
              onClick={() => setSpatialMode("point")}
              disabled={onlineBusy || cmipBusy}
            >
              <strong>Point/grid-cell series</strong>
              <span>
                {manualObservedLoaded
                  ? "Optional gauge metadata; does not alter observations"
                  : "Use coordinates to retrieve the provider grid cell"}
              </span>
            </button>
          </div>
          {spatialMode === "point" && (
            <div className="coordinate-entry">
              <label>
                Latitude
                <input
                  type="number"
                  min="-90"
                  max="90"
                  step="0.00001"
                  inputMode="decimal"
                  value={stationLat}
                  onChange={(e) => setStationLat(e.target.value)}
                  placeholder="e.g. 34.01500"
                  disabled={onlineBusy || cmipBusy}
                />
              </label>
              <label>
                Longitude
                <input
                  type="number"
                  min="-180"
                  max="180"
                  step="0.00001"
                  inputMode="decimal"
                  value={stationLon}
                  onChange={(e) => setStationLon(e.target.value)}
                  placeholder="e.g. 71.52500"
                  disabled={onlineBusy || cmipBusy}
                />
              </label>
              {sourceTab === "cmip6" && (
                <button
                  type="button"
                  className="district-point-action"
                  onClick={useDistrictRepresentativePoint}
                  disabled={!districtRepresentativePoint || cmipBusy}
                >
                  Use representative point inside {district}
                </button>
              )}
            </div>
          )}
          <p
            className={`coordinate-status ${spatialMode === "point" && coordinateValid && (!coordinateInsidePakistan || coordinateInsideDistrict === false) && !manualObservedLoaded ? "warning" : ""}`}
          >
            <strong>{spatialLabel}</strong>
            <span>{coordinateStatus}</span>
          </p>
          {manualObservedLoaded ? (
            <small className="spatial-caveat">
              The boundary map is reference-only; district selection is disabled
              and no polygon is used to average, alter, or fit the uploaded
              rainfall.
            </small>
          ) : sourceTab === "online" ? (
            <small className="spatial-caveat">
              Changing the source, date range, district, spatial mode or
              coordinates requires a new extraction. IDF results appear only
              when the retrieved series matches the active selection.
            </small>
          ) : (
            <small className="spatial-caveat">
              Direct NASA retrieval uses the selected point or district
              geometry. Changing the GCM, SSP, period or spatial selection
              requires a new retrieval. Gauge evaluation remains required
              before engineering design.
            </small>
          )}
        </article>
        <div className="kpis">
          {sourceTab === "observed" ? (
            <>
              <article className="kpi-card">
                <div>
                  <span>Accepted rows</span>
                  <strong>{activeObservedQc.records.length}</strong>
                  <small>
                    {activeObservedQc.start || "—"} to{" "}
                    {activeObservedQc.end || "—"}
                  </small>
                </div>
              </article>
              <article className="kpi-card amber">
                <div>
                  <span>Completeness</span>
                  <strong>{activeObservedQc.completeness.toFixed(1)}%</strong>
                  <small>
                    {activeObservedQc.missing} missing ·{" "}
                    {activeObservedQc.duplicates} duplicates ·{" "}
                    {activeObservedQc.invalid} invalid
                  </small>
                </div>
              </article>
              <article className="kpi-card blue">
                <div>
                  <span>Eligible annual maxima</span>
                  <strong>{stationarity.n} years</strong>
                  <small>
                    Each retained year has ≥
                    {activeObservedQc.yearCompletenessThreshold}%{" "}
                    {observedResolution} coverage
                  </small>
                </div>
              </article>
            </>
          ) : sourceTab === "cmip6" ? (
            <>
              <article className="kpi-card">
                <div>
                  <span>GCM data status</span>
                  <strong>
                    {cmipImportedReady
                      ? "Corrected ensemble imported"
                      : cmipDataReady
                        ? "Retrieved"
                        : "Not retrieved"}
                  </strong>
                  <small>
                    {cmipImportedReady
                      ? `${cmipImportedWorkbook?.locationName} · ${cmipImportedModels.length} models`
                      : cmipDataReady
                      ? `${cmipModelLabel} · ${cmipMetadata?.member ?? "uploaded series"}`
                      : `${CMIP6_SCENARIOS[cmipScenario].label} · ${cmipPeriod}`}
                  </small>
                </div>
              </article>
              <article className="kpi-card amber">
                <div>
                  <span>{cmipImportedReady ? "Model return-level rows" : "Accepted daily values"}</span>
                  <strong>
                    {cmipImportedReady
                      ? cmipImportedWorkbook?.modelRows.toLocaleString()
                      : cmipDataReady
                      ? cmipQc.records.length.toLocaleString()
                      : "—"}
                  </strong>
                  <small>
                    {cmipImportedReady
                      ? "Precomputed 24-hour GEV results; daily series not imported"
                      : cmipDataReady
                      ? `${cmipQc.completeness.toFixed(1)}% temporal completeness`
                      : "Actual NASA pr values required"}
                  </small>
                </div>
              </article>
              <article className="kpi-card blue">
                <div>
                  <span>{cmipImportedReady ? "Ensemble uncertainty" : "Eligible annual maxima"}</span>
                  <strong>
                    {cmipImportedReady
                      ? "P10 · median · P90"
                      : cmipDataReady
                        ? `${cmipStationarity.n} years`
                        : "—"}
                  </strong>
                  <small>
                    {cmipImportedReady
                      ? `${cmipImportedWorkbook?.validationStatus} · 24-hour only`
                      : cmipDataReady
                      ? `Each retained year has ≥${cmipQc.yearCompletenessThreshold}% daily coverage`
                      : spatialMode === "district"
                        ? district
                        : "Point coordinates required"}
                  </small>
                </div>
              </article>
            </>
          ) : (
            <>
              <article className="kpi-card">
                <div>
                  <span>Data status</span>
                  <strong>{onlineReady ? "Retrieved" : "Not retrieved"}</strong>
                  <small>
                    {onlineReady && onlineMetadata
                      ? onlineMetadata.dataset
                      : "Run extraction for the active selection"}
                  </small>
                </div>
              </article>
              <article className="kpi-card amber">
                <div>
                  <span>Accepted {onlineResolution} values</span>
                  <strong>
                    {onlineReady
                      ? onlineQc.records.length.toLocaleString()
                      : "—"}
                  </strong>
                  <small>
                    {onlineReady
                      ? `${onlineQc.completeness.toFixed(1)}% temporal completeness`
                      : SOURCE_META[onlineSource].coverage}
                  </small>
                </div>
              </article>
              <article className="kpi-card blue">
                <div>
                  <span>Eligible annual maxima</span>
                  <strong>
                    {onlineReady ? `${onlineStationarity.n} years` : "—"}
                  </strong>
                  <small>
                    {onlineReady
                      ? `Each retained year has ≥${onlineQc.yearCompletenessThreshold}% ${onlineResolution} coverage`
                      : spatialMode === "district"
                        ? district
                        : "Point coordinates required"}
                  </small>
                </div>
              </article>
            </>
          )}
        </div>
      </section>
      <section id="boundary" className="content-width boundary-section">
        <div className="section-title">
          <p className="eyebrow">Administrative geography</p>
          <h2>Interactive Pakistan district and tehsil boundaries</h2>
          <p>
            {manualObservedLoaded
              ? "District selection is disabled for uploaded observations. Pan and zoom remain available for geographic reference only."
              : sourceTab === "online"
                ? "Zoom or pan, then click a district to select and lock its exact polygon before online extraction. Hover does not submit provider jobs."
                : "Zoom or pan, then click a district to select and lock its exact polygon before direct NASA GCM retrieval. Hover changes only the selection; it does not start a provider request."}
          </p>
        </div>
        <div className="boundary-toolbar">
          <button
            className={boundaryLevel === "district" ? "active" : ""}
            onClick={() => loadOnlineBoundary("district", district)}
          >
            Online districts
          </button>
          <button
            className={boundaryLevel === "tehsil" ? "active" : ""}
            onClick={() => loadOnlineBoundary("tehsil", district)}
          >
            Online tehsils
          </button>
          <button onClick={() => boundaryInput.current?.click()}>
            Upload official SHP ZIP / GeoJSON
          </button>
          <input
            className="hidden-input"
            ref={boundaryInput}
            type="file"
            accept=".zip,.geojson,.json"
            onChange={(e) => loadBoundary(e.target.files?.[0])}
          />
        </div>
        <div className="boundary-grid">
          <article className="panel map-card">
            <div className="panel-head">
              <div>
                <span>Versioned online geometry</span>
                <h2>
                  {boundaryLevel === "district" ? "District" : "Tehsil"}{" "}
                  polygons
                </h2>
              </div>
              <span className="badge">
                {geo?.features.length ?? 0} features
              </span>
            </div>
            <div className="selected-map-banner">
              <span>
                {manualObservedLoaded
                  ? "District control"
                  : districtLocked
                    ? "Locked district"
                    : boundaryLevel === "district"
                      ? "District preview"
                      : "Selected tehsil"}
              </span>
              <strong>
                {manualObservedLoaded
                  ? "Disabled for uploaded observations"
                  : `⌖ ${boundaryLevel === "district" ? district : mapSelection}`}
              </strong>
              {!manualObservedLoaded && boundaryLevel === "district" && (
                <small
                  className={matchedBoundaryName ? "match-ok" : "match-missing"}
                >
                  {matchedBoundaryName
                    ? `Exact boundary: ${matchedBoundaryName}`
                    : "Exact polygon unavailable"}
                </small>
              )}
              {!manualObservedLoaded && districtLocked && (
                <button
                  className="unlock-map-selection"
                  onClick={() => setDistrictLocked(false)}
                >
                  Unlock district
                </button>
              )}
            </div>
            <BoundaryMap
              key={boundary}
              geo={geo}
              selected={boundaryLevel === "district" ? district : mapSelection}
              point={coordinatePoint}
              hoverAvailable={
                sourceTab === "cmip6" && boundaryLevel === "district"
              }
              locked={districtLocked}
              selectionDisabled={manualObservedLoaded}
              onSelect={chooseBoundaryFeature}
              onHover={previewBoundaryFeature}
            />
          </article>
          <article className="panel boundary-audit">
            <h2>Boundary audit</h2>
            <p>{geoMessage}</p>
            <dl>
              <div>
                <dt>Spatial extraction</dt>
                <dd>{spatialLabel}</dd>
              </div>
              <div>
                <dt>Coordinate validation</dt>
                <dd
                  className={
                    spatialMode === "point" &&
                    coordinateInsideDistrict === false &&
                    !manualObservedLoaded
                      ? "match-missing"
                      : "match-ok"
                  }
                >
                  {coordinateStatus}
                </dd>
              </div>
              <div>
                <dt>District selection</dt>
                <dd>
                  {manualObservedLoaded
                    ? "Disabled — not used in observed fitting"
                    : district}
                </dd>
              </div>
              <div>
                <dt>Boundary match</dt>
                <dd
                  className={
                    manualObservedLoaded || matchedBoundaryName
                      ? "match-ok"
                      : "match-missing"
                  }
                >
                  {manualObservedLoaded
                    ? "Not evaluated — no boundary used in fitting"
                    : matchedBoundaryName
                      ? `Matched exactly to ${matchedBoundaryName}`
                      : "No exact polygon in this layer"}
                </dd>
              </div>
              <div>
                <dt>Map selection</dt>
                <dd>
                  {manualObservedLoaded
                    ? "Disabled — reference view only"
                    : mapSelection}
                </dd>
              </div>
              <div>
                <dt>Boundary identity</dt>
                <dd>
                  {manualObservedLoaded
                    ? "Reference only — not used in fitting"
                    : boundary}
                </dd>
              </div>
              <div>
                <dt>Feature count</dt>
                <dd>{geo?.features.length ?? "Not loaded"}</dd>
              </div>
              <div>
                <dt>District source</dt>
                <dd>
                  <a
                    href="https://data.humdata.org/dataset/cod-ab-pak"
                    target="_blank"
                    rel="noreferrer"
                  >
                    OCHA Pakistan COD-AB
                  </a>
                </dd>
              </div>
            </dl>
            {!manualObservedLoaded &&
              boundaryLevel === "district" &&
              !matchedBoundaryName && (
                <p className="boundary-warning">
                  <strong>{district}</strong> is not represented by a separate
                  polygon in the loaded COD-AB edition. Upload a newer verified
                  OCHA/PBS boundary to display it without substituting a parent
                  district.
                </p>
              )}
            <p className="caution">
              The default district layer contains 160 OCHA COD-AB units
              represented through 27 September 2024; the downloadable package
              was refreshed on 26 January 2026. The optional online tehsil layer
              remains a 2017 geoBoundaries layer with 554 units. Record the
              selected boundary identity in every official publication.
            </p>
          </article>
        </div>
      </section>
      <section id="curves" className="content-width model-area">
        <div className="model-tabs" role="tablist">
          <button
            className={modelTab === "stationary" ? "active" : ""}
            onClick={() => setModelTab("stationary")}
          >
            <strong>Stationary IDF</strong>
            <span>
              {sourceTab === "cmip6"
                ? "Fit the retrieved future annual-maxima sample"
                : "Distribution parameters remain constant"}
            </span>
          </button>
          <button
            className={modelTab === "nonstationary" ? "active" : ""}
            onClick={() => {
              setModelTab("nonstationary");
              setMethod("gev");
              if (sourceTab === "cmip6") setNonstationaryCovariate("time");
            }}
            disabled={activeNativeHourly}
          >
            <strong>Nonstationary IDF</strong>
            <span>
              {sourceTab === "cmip6"
                ? "Time-varying GEV fitted within the retrieved time slice"
                : activeNativeHourly
                  ? "Use stationary duration-specific fits"
                  : "Fitted time-varying GEV or declared covariate sensitivity"}
            </span>
          </button>
          {modelTab === "nonstationary" &&
            (sourceTab === "cmip6" ? (
              <label>
                Period midpoint
                <select value={cmipMidpoint} disabled>
                  {[2030, 2050, 2070, 2090].map((y) => (
                    <option key={y}>{y}</option>
                  ))}
                </select>
                <small>Set by the selected CMIP6 time slice.</small>
              </label>
            ) : (
              <div className="covariate-controls">
                <label>
                  Curve-driving covariate
                  <select
                    value={
                      nonstationaryCovariate === "time"
                        ? "time"
                        : selectedCovariateId
                    }
                    onChange={(e) => {
                      if (e.target.value === "time") {
                        setNonstationaryCovariate("time");
                      } else {
                        setSelectedCovariateId(e.target.value);
                        setNonstationaryCovariate("matched");
                      }
                    }}
                  >
                    <option value="time">Time · fitted GEV location</option>
                    {annualCovariates.map((candidate) => (
                      <option value={candidate.id} key={candidate.id}>
                        {candidate.label} · matched annual series
                      </option>
                    ))}
                    {!annualCovariates.length && (
                      <option value="unavailable" disabled>
                        ENSO and physical covariates · retrieve or upload data
                      </option>
                    )}
                  </select>
                  <small>
                    A curve can use time or one retrieved/uploaded annual
                    covariate. The comparison table evaluates all eligible
                    candidates.
                  </small>
                </label>
                {nonstationaryCovariate === "time" ? (
                  <>
                    <label>
                      Reference-year basis
                      <select
                        value={referenceYearBasis}
                        onChange={(e) =>
                          setReferenceYearBasis(
                            e.target.value as ReferenceYearBasis,
                          )
                        }
                      >
                        <option value="record-center">
                          Automatic · mean eligible AMS year
                        </option>
                        <option value="latest-eligible">
                          Latest eligible AMS year
                        </option>
                        <option value="custom">Custom evaluation year</option>
                      </select>
                      <small>
                        Default: ȳ = Σ eligible annual-maxima years / n.
                        Centering changes the intercept reference, not the
                        fitted trend.
                      </small>
                    </label>
                    <label>
                      Reference year
                      <input
                        type="number"
                        min="1900"
                        max="2100"
                        step="0.01"
                        value={referenceYear}
                        disabled={referenceYearBasis !== "custom"}
                        onChange={(e) =>
                          setCustomReferenceYear(+e.target.value)
                        }
                      />
                      <small>
                        {referenceYearSelection.eligibleYearCount
                          ? `${referenceYearSelection.formula}. ${referenceYearStatus}. ${referenceYearSelection.eligibleYearCount} eligible years (${referenceYearSelection.firstEligibleYear}–${referenceYearSelection.lastEligibleYear}).`
                          : `${referenceYearStatus} · ≥20 eligible years required`}
                      </small>
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      Covariate evaluation basis
                      <select
                        value={covariateEvaluationBasis}
                        onChange={(e) =>
                          setCovariateEvaluationBasis(
                            e.target.value as
                              | "record-mean"
                              | "latest-matched"
                              | "custom",
                          )
                        }
                      >
                        <option value="record-mean">
                          Mean of matched years
                        </option>
                        <option value="latest-matched">
                          Latest matched annual value
                        </option>
                        <option value="custom">Custom value</option>
                      </select>
                      <small>
                        Evaluation changes the conditional return level; it
                        does not change the fitted coefficient.
                      </small>
                    </label>
                    <label>
                      Evaluation value
                      <input
                        type="number"
                        step="any"
                        value={
                          Number.isFinite(covariateEvaluationValue)
                            ? covariateEvaluationValue
                            : ""
                        }
                        disabled={covariateEvaluationBasis !== "custom"}
                        onChange={(e) =>
                          setCustomCovariateValue(+e.target.value)
                        }
                      />
                      <small>
                        {selectedAnnualCovariate
                          ? `${selectedAnnualCovariate.units}. ${covariateEvaluationStatus}; matched range ${covariateRange.min.toFixed(3)}–${covariateRange.max.toFixed(3)}.`
                          : "Retrieve or upload and select an annual covariate series."}
                      </small>
                    </label>
                  </>
                )}
                <div className="covariate-online">
                  <label>
                    Online annual covariate
                    <select
                      value={onlineCovariateSource}
                      onChange={(event) =>
                        setOnlineCovariateSource(
                          event.target.value as OnlineCovariateSource,
                        )
                      }
                      disabled={onlineCovariateBusy}
                    >
                      <option value="enso">
                        ENSO · NOAA Niño 3.4 anomaly
                      </option>
                      <option value="temperature">
                        Temperature · ERA5 2 m air temperature
                      </option>
                      <option value="moisture">
                        Moisture · LIS 0–10 cm soil moisture
                      </option>
                      <option value="urbanization">
                        Urbanization · Pakistan national share
                      </option>
                    </select>
                  </label>
                  <button
                    type="button"
                    onClick={() => void retrieveOnlineCovariates()}
                    disabled={onlineCovariateBusy || ams.length < 20}
                  >
                    {onlineCovariateBusy
                      ? `Retrieving… ${onlineCovariateProgress}%`
                      : "Retrieve selected online & develop IDF"}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void retrieveOnlineCovariates([
                        "enso",
                        "temperature",
                        "moisture",
                        "urbanization",
                      ])
                    }
                    disabled={onlineCovariateBusy || ams.length < 20}
                  >
                    Retrieve all & compare IDF
                  </button>
                  {onlineCovariateBusy && (
                    <progress max="100" value={onlineCovariateProgress} />
                  )}
                  <small>
                    Uses the eligible annual-maxima years. ENSO is global;
                    ERA5 temperature and LIS soil moisture follow the active
                    point/district geometry; World Bank urbanization is a
                    Pakistan national screening proxy, not local built-up area.
                  </small>
                </div>
                <div
                  className={`covariate-next-process ${onlineCovariateBusy ? "running" : ""}`}
                  role="status"
                  aria-live="polite"
                >
                  <span>Automatic next process</span>
                  <strong>
                    Retrieve → match years → compare models → develop IDF
                  </strong>
                  <p>{covariateWorkflowStatus}</p>
                  <ol>
                    <li>Match the covariate to eligible annual-maxima years.</li>
                    <li>Fit stationary, time and physical-covariate GEV models.</li>
                    <li>
                      Check AICc, PIT residuals, coefficient uncertainty and the
                      chronological holdout.
                    </li>
                    <li>
                      Generate the supported IDF, or retain stationary GEV when
                      nonstationarity is not supported.
                    </li>
                  </ol>
                </div>
                <div className="covariate-upload">
                  <input
                    ref={covariateInput}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={(e) => uploadCovariates(e.target.files?.[0])}
                    aria-label="Upload annual covariate workbook"
                  />
                  <button type="button" onClick={downloadCovariateTemplate}>
                    Download covariate template
                  </button>
                  <small>{covariateMessage}</small>
                </div>
                {!!onlineCovariateMetadata.length && (
                  <details className="covariate-provenance">
                    <summary>
                      Online covariate provenance ({onlineCovariateMetadata.length})
                    </summary>
                    {onlineCovariateMetadata.map((row) => (
                      <p key={row.source}>
                        <strong>{row.dataset}:</strong> {row.provider}; {row.spatialScope}; {row.returnedStartYear}–{row.returnedEndYear}; {row.acceptedAnnualValues} annual values. {row.limitations}
                      </p>
                    ))}
                  </details>
                )}
              </div>
            ))}
        </div>
        <div className="curve-section" id="idf-results">
          <article className="panel">
            <div className="panel-head">
              <div>
                <span>{sourceLabel} · durations ≤ 24 hours</span>
                <h2>
                  {sourceTab === "cmip6"
                    ? `${CMIP6_SCENARIOS[cmipScenario].label} · ${cmipPeriod} · retrieved GCM`
                    : modelTab === "stationary"
                      ? "Stationary"
                      : covariateLabel}{" "}
                  {activeFrequencyMethodLabel}{" "}
                  IDF curves
                </h2>
              </div>
              <div className="actions">
                {modelTab === "nonstationary" ? (
                  <select
                    value="gev-mle"
                    disabled
                    aria-label="Nonstationary frequency fitting method"
                  >
                    <option value="gev-mle">GEV · maximum likelihood</option>
                  </select>
                ) : (
                  <select
                    value={method}
                    onChange={(e) => setMethod(e.target.value as Method)}
                    aria-label="Stationary frequency fitting method"
                  >
                    {Object.entries(METHOD_LABEL).map(([k, v]) => (
                      <option value={k} key={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  value={axis}
                  onChange={(e) =>
                    setAxis(e.target.value === "linear" ? "linear" : "log")
                  }
                >
                  <option value="log">Logarithmic intensity axis</option>
                  <option value="linear">Linear intensity axis</option>
                </select>
                <button onClick={chartPng}>Download image</button>
                <button onClick={excel} disabled={!results.length}>
                  Download Excel
                </button>
              </div>
            </div>
            <PowerIntensityCalculator rows={shown} />
            {shown.some((r) => r.durationMinutes <= 1440) ? (
              <>
                <IdfChart
                  rows={shown}
                  axis={axis}
                  equationFit={idfEquation}
                  timeOfConcentrationMinutes={timeOfConcentrationMinutes}
                  designReturnPeriod={designReturnPeriod}
                  designIntensity={designIntensity}
                />
                <section
                  className="tc-calculator"
                  aria-labelledby="tc-calculator-title"
                >
                  <div className="tc-calculator-head">
                    <div>
                      <span>Hydrologic design helper</span>
                      <h3 id="tc-calculator-title">
                        Time of concentration and IDF intensity
                      </h3>
                    </div>
                    <code>{formatShermanEquation(idfEquation)}</code>
                  </div>
                  <div className="tc-mode-tabs" aria-label="Time of concentration method">
                    <button
                      id="tc-mode-kirpich"
                      type="button"
                      className={
                        timeOfConcentrationMode === "manual" ? "active" : ""
                      }
                      onClick={() => setTimeOfConcentrationMode("manual")}
                    >
                      Enter t<sub>c</sub> manually
                    </button>
                    <button
                      type="button"
                      className={
                        timeOfConcentrationMode === "kirpich" ? "active" : ""
                      }
                      onClick={() => setTimeOfConcentrationMode("kirpich")}
                    >
                      Calculate with Kirpich
                    </button>
                  </div>
                  {timeOfConcentrationMode === "kirpich" && (
                    <div
                      className="flow-geometry-tabs"
                      aria-label="Flow-path geometry source"
                    >
                      <button
                        id="flow-geometry-mghydro"
                        type="button"
                        className={flowGeometryMode === "manual" ? "active" : ""}
                        onClick={() => setFlowGeometryMode("manual")}
                      >
                        Manual L and S
                      </button>
                      <button
                        type="button"
                        className={flowGeometryMode === "mghydro" ? "active" : ""}
                        onClick={() => setFlowGeometryMode("mghydro")}
                      >
                        MGHydro automatic
                      </button>
                      <button
                        type="button"
                        className={flowGeometryMode === "upload" ? "active" : ""}
                        onClick={() => setFlowGeometryMode("upload")}
                      >
                        HEC-HMS / QGIS upload
                      </button>
                    </div>
                  )}
                  <div className="tc-input-grid">
                    <label>
                      Design return period
                      <select
                        value={designReturnPeriod}
                        onChange={(event) =>
                          setDesignReturnPeriod(Number(event.target.value))
                        }
                      >
                        {PERIODS.map((period) => (
                          <option key={period} value={period}>
                            {period} years
                          </option>
                        ))}
                      </select>
                    </label>
                    {timeOfConcentrationMode === "manual" && (
                      <label>
                        Time of concentration, t<sub>c</sub> (minutes)
                        <input
                          type="number"
                          min="0.01"
                          step="0.1"
                          inputMode="decimal"
                          value={manualTimeOfConcentration}
                          onChange={(event) =>
                            setManualTimeOfConcentration(event.target.value)
                          }
                          placeholder="e.g. 35"
                        />
                      </label>
                    )}
                    {timeOfConcentrationMode === "kirpich" &&
                      flowGeometryMode === "manual" && (
                        <>
                          <label>
                            Longest flow-path length, L (m)
                            <input
                              type="number"
                              min="0.01"
                              step="1"
                              inputMode="decimal"
                              value={flowPathLengthMetres}
                              onChange={(event) =>
                                setFlowPathLengthMetres(event.target.value)
                              }
                              placeholder="e.g. 1200"
                            />
                          </label>
                          <label>
                            Average flow-path slope, S (%)
                            <input
                              type="number"
                              min="0.0001"
                              step="0.01"
                              inputMode="decimal"
                              value={catchmentSlopePercent}
                              onChange={(event) =>
                                setCatchmentSlopePercent(event.target.value)
                              }
                              placeholder="e.g. 2.5"
                            />
                          </label>
                        </>
                      )}
                  </div>
                  {timeOfConcentrationMode === "kirpich" &&
                    flowGeometryMode === "mghydro" && (
                      <div className="watershed-auto-panel">
                        <GoogleMapsOutlet
                          geo={pakistanDistrictGeo ?? geo}
                          latitude={
                            watershedOutletPointValid
                              ? watershedOutletLatitudeNumber
                              : null
                          }
                          longitude={
                            watershedOutletPointValid
                              ? watershedOutletLongitudeNumber
                              : null
                          }
                          onSelect={(latitude, longitude) => {
                            setWatershedOutletLatitude(latitude.toFixed(6));
                            setWatershedOutletLongitude(longitude.toFixed(6));
                            setWatershedGeometryResult(null);
                            setWatershedGeometryMessage(
                              `Outlet selected at ${latitude.toFixed(5)}, ${longitude.toFixed(5)}. Calculate with MGHydro to delineate the watershed and derive L and S.`,
                            );
                          }}
                        />
                        <div className="watershed-auto-grid">
                          <label>
                            Outlet latitude
                            <input
                              id="watershed-outlet-latitude"
                              type="number"
                              step="0.000001"
                              value={watershedOutletLatitude}
                              onChange={(event) =>
                                setWatershedOutletLatitude(event.target.value)
                              }
                              placeholder="34.647370"
                            />
                          </label>
                          <label>
                            Outlet longitude
                            <input
                              id="watershed-outlet-longitude"
                              type="number"
                              step="0.000001"
                              value={watershedOutletLongitude}
                              onChange={(event) =>
                                setWatershedOutletLongitude(event.target.value)
                              }
                              placeholder="72.035980"
                            />
                          </label>
                          <label>
                            MGHydro precision
                            <select
                              value={watershedPrecision}
                              onChange={(event) =>
                                setWatershedPrecision(
                                  event.target.value === "low" ? "low" : "high",
                                )
                              }
                            >
                              <option value="high">Higher precision</option>
                              <option value="low">Lower precision</option>
                            </select>
                          </label>
                          <label>
                            Slope used in Kirpich
                            <select
                              value={watershedSlopeMethod}
                              onChange={(event) =>
                                setWatershedSlopeMethod(
                                  event.target.value === "endpoint"
                                    ? "endpoint"
                                    : "10-85",
                                )
                              }
                            >
                              <option value="10-85">10–85% flow-path slope</option>
                              <option value="endpoint">Endpoint slope</option>
                            </select>
                          </label>
                        </div>
                        <div className="watershed-auto-actions">
                          <button type="button" onClick={useActiveAtlasOutlet}>
                            Use active atlas location
                          </button>
                          <button
                            id="calculate-mghydro"
                            type="button"
                            className="primary"
                            onClick={() => void calculateMghydroGeometry()}
                            disabled={watershedGeometryBusy}
                          >
                            {watershedGeometryBusy
                              ? "Calculating watershed…"
                              : "Calculate L and S with MGHydro"}
                          </button>
                        </div>
                        <p
                          id="watershed-geometry-status"
                          className="watershed-status"
                          role="status"
                        >
                          {watershedGeometryMessage}
                        </p>
                      </div>
                    )}
                  {timeOfConcentrationMode === "kirpich" &&
                    flowGeometryMode === "upload" && (
                      <div className="watershed-auto-panel">
                        <div className="flow-upload-row">
                          <label>
                            Longest flow-path file
                            <input
                              type="file"
                              accept=".geojson,.json,.zip"
                              onChange={(event) =>
                                void uploadFlowPathGeometry(event.target.files?.[0])
                              }
                              disabled={watershedGeometryBusy}
                            />
                          </label>
                          <label>
                            Slope used in Kirpich
                            <select
                              value={watershedSlopeMethod}
                              onChange={(event) =>
                                setWatershedSlopeMethod(
                                  event.target.value === "endpoint"
                                    ? "endpoint"
                                    : "10-85",
                                )
                              }
                            >
                              <option value="10-85">10–85% flow-path slope</option>
                              <option value="endpoint">Endpoint slope</option>
                            </select>
                          </label>
                        </div>
                        <p className="watershed-status" role="status">
                          {flowPathFileName
                            ? `${flowPathFileName} · ${watershedGeometryMessage}`
                            : watershedGeometryMessage}
                        </p>
                        <small className="flow-upload-note">
                          Upload one selected longest path as GeoJSON or a zipped
                          line shapefile exported from HEC-HMS, QGIS or ArcGIS.
                          Length follows the line; slope is sampled from the
                          global elevation service.
                        </small>
                      </div>
                    )}
                  {timeOfConcentrationMode === "kirpich" &&
                    flowGeometryMode !== "manual" &&
                    watershedGeometryResult && (
                      <div className="watershed-result-shell">
                        <WatershedGeometryPreview result={watershedGeometryResult} />
                        <div className="watershed-result-detail">
                          <div>
                            <span>Longest flow path</span>
                            <strong>
                              {(watershedGeometryResult.lengthMetres / 1000).toFixed(3)} km
                            </strong>
                          </div>
                          <div>
                            <span>10–85% slope</span>
                            <strong>
                              {(watershedGeometryResult.slope10To85MPerM * 100).toFixed(3)}%
                            </strong>
                          </div>
                          <div>
                            <span>Endpoint slope</span>
                            <strong>
                              {(watershedGeometryResult.endpointSlopeMPerM * 100).toFixed(3)}%
                            </strong>
                          </div>
                          <div>
                            <span>Elevation range</span>
                            <strong>
                              {watershedGeometryResult.outletElevationMetres.toFixed(0)}–
                              {watershedGeometryResult.upstreamElevationMetres.toFixed(0)} m
                            </strong>
                          </div>
                          <p>{watershedGeometryResult.limitations}</p>
                          <button type="button" onClick={downloadWatershedGeometry}>
                            Download watershed and flow path
                          </button>
                        </div>
                      </div>
                    )}
                  <div className="tc-result-grid" aria-live="polite">
                    <div>
                      <span>Time of concentration</span>
                      <strong>
                        {timeOfConcentrationMinutes != null
                          ? `${timeOfConcentrationMinutes.toFixed(2)} min`
                          : "Enter inputs"}
                      </strong>
                      <small>
                        {timeOfConcentrationMode === "kirpich"
                          ? flowGeometryMode === "mghydro"
                            ? "Kirpich · MGHydro geometry"
                            : flowGeometryMode === "upload"
                              ? "Kirpich · uploaded flow path"
                              : "Kirpich · manual L and S"
                          : "Project-supplied value"}
                      </small>
                    </div>
                    <div>
                      <span>{designReturnPeriod}-year intensity at t<sub>c</sub></span>
                      <strong>
                        {designIntensity != null
                          ? `${designIntensity.toFixed(2)} mm/h`
                          : "—"}
                      </strong>
                      <small>Calculated from the displayed chart equation</small>
                    </div>
                    <div>
                      <span>Rainfall depth over t<sub>c</sub></span>
                      <strong>
                        {designRainfallDepth != null
                          ? `${designRainfallDepth.toFixed(2)} mm`
                          : "—"}
                      </strong>
                      <small>P=i × t<sub>c</sub>/60</small>
                    </div>
                  </div>
                  <div className="tc-equation-row">
                    <p>
                      <strong>Kirpich:</strong>{" "}
                      <code>t<sub>c</sub>=0.0195L<sup>0.77</sup>S<sup>−0.385</sup></code>
                      <small>L in metres, S in m/m, t<sub>c</sub> in minutes.</small>
                    </p>
                    <p>
                      <strong>Design intensity:</strong>{" "}
                      <code>i(t<sub>c</sub>,T)=aT<sup>m</sup>/(t<sub>c</sub>+b)<sup>n</sup></code>
                      <small>The amber line and point identify the active result.</small>
                    </p>
                  </div>
                  <p className="tc-caution">
                    <strong>Important:</strong> An IDF curve does not determine
                    t<sub>c</sub> by itself. It supplies rainfall intensity for a
                    storm duration set equal to the independently estimated
                    t<sub>c</sub>. The calculator reports intensity only for the
                    displayed 5–1440 minute range.
                    {timeOfConcentrationMinutes != null &&
                      !concentrationWithinIdfRange &&
                      " The current time of concentration is outside that range."}
                  </p>
                </section>
                {!cmipImportedReady && PERIODS.some((T) => T > Math.max(1, activeStationarity.n)) && (
                    <p className="validation-note">
                      <strong>Rare-event extrapolation:</strong> 250- and
                      500-year estimates extend far beyond the{" "}
                      {activeStationarity.n}-year eligible record. Treat them as
                      highly uncertain model extrapolations; the bootstrap
                      interval does not capture model-form, covariate-choice,
                      source bias or sub-daily downscaling uncertainty.
                    </p>
                  )}
              </>
            ) : (
              <div className="empty">
                {modelTab === "nonstationary" &&
                sourceTab !== "cmip6"
                  ? nonstationaryCovariate === "time"
                    ? "Load or retrieve at least 20 eligible annual maxima to fit the time-varying GEV model."
                    : "Load or retrieve at least 20 eligible annual maxima and retrieve or upload a matched annual covariate series."
                  : sourceTab === "observed"
                    ? `Load at least 8 annual maxima from years with ≥90% ${observedResolution} coverage.`
                    : sourceTab === "online"
                      ? spatialMode === "point" && !coordinateValid
                        ? "Enter valid latitude and longitude, then extract the online precipitation series."
                        : "Extract online precipitation for the active source, dates and spatial selection to calculate the IDF curves."
                      : cmipSelectionMode !== "individual"
                        ? "Choose an individual GCM, then retrieve and fit it before forming a multi-model median."
                        : "Retrieve the selected NASA GCM precipitation series to calculate IDF curves."}
              </div>
            )}
          </article>
          <article className="panel method-table">
            <span className="selected-district">
              ⌖ {sourceTab === "observed" ? name : spatialLabel}
            </span>
            <h2>Distribution and IDF method comparison</h2>
            <p>
              The same eligible 24-hour annual-maxima sample is fitted with{" "}
              {DISTRIBUTION_METHODS.length} probability distributions. Sherman
              is reported separately as an IDF equation calibrated to GEV
              levels; it is not ranked as a probability distribution. The fitted
              time model uses GEV maximum likelihood with μ(y)=μ₀+μ₁(y−ȳ),
              constant scale and shape, and AICc comparison against a stationary
              MLE.
            </p>
            {sourceTab !== "cmip6" || cmipDataReady ? (
              <>
                <div className="diagnostic-summary">
                  <div>
                    <span>Eligible maxima</span>
                    <strong>{activeStationarity.n}</strong>
                  </div>
                  <div>
                    <span>
                      {modelTab === "nonstationary" &&
                      sourceTab !== "cmip6"
                        ? "Covariate decision"
                        : "Lowest-RMSE distribution"}
                    </span>
                    <strong>
                      {modelTab === "nonstationary" &&
                      sourceTab !== "cmip6"
                        ? covariateComparison.decision
                        : recommendation
                          ? METHOD_LABEL[recommendation]
                          : "Not issued"}
                    </strong>
                  </div>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Method</th>
                        <th>10-year · 24h</th>
                        <th>100-year · 24h</th>
                        <th>250-year · 24h</th>
                        <th>500-year · 24h</th>
                        <th>Fit RMSE</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ALL_METHODS.map((m) => {
                        const d = activeDiagnostics.find((x) => x.method === m);
                        return (
                          <tr
                            key={m}
                            className={
                              recommendation === m ? "recommended-row" : ""
                            }
                          >
                            <td>
                              {METHOD_LABEL[m]}
                              {recommendation === m && (
                                <small>Lowest distribution RMSE</small>
                              )}
                              {m === "sherman" && (
                                <small>
                                  Equation · excluded from distribution ranking
                                </small>
                              )}
                            </td>
                            <td>
                              {results.find(
                                (r) =>
                                  r.method === m &&
                                  r.durationMinutes === 1440 &&
                                  r.returnPeriodYears === 10,
                              )?.intensityMmHr ?? "—"}{" "}
                              mm/hr
                            </td>
                            <td>
                              {results.find(
                                (r) =>
                                  r.method === m &&
                                  r.durationMinutes === 1440 &&
                                  r.returnPeriodYears === 100,
                              )?.intensityMmHr ?? "—"}{" "}
                              mm/hr
                            </td>
                            <td>
                              {results.find(
                                (r) =>
                                  r.method === m &&
                                  r.durationMinutes === 1440 &&
                                  r.returnPeriodYears === 250,
                              )?.intensityMmHr ?? "—"}{" "}
                              mm/hr
                            </td>
                            <td>
                              {results.find(
                                (r) =>
                                  r.method === m &&
                                  r.durationMinutes === 1440 &&
                                  r.returnPeriodYears === 500,
                              )?.intensityMmHr ?? "—"}{" "}
                              mm/hr
                            </td>
                            <td>
                              {modelTab === "nonstationary" &&
                              sourceTab !== "cmip6" &&
                              m === "gev"
                                ? "MLE/AICc"
                                : Number.isFinite(d?.rmseMm)
                                  ? `${d?.rmseMm} mm (${d?.nrmsePercent}%)`
                                  : "—"}
                            </td>
                            <td>
                              {modelTab === "nonstationary" &&
                              sourceTab !== "cmip6" &&
                              m === "gev"
                                ? activeNonstationaryStatus
                                : (d?.status ?? "—")}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <details className="parameter-details">
                  <summary>Fitted parameter notes</summary>
                  {modelTab === "nonstationary" &&
                  sourceTab !== "cmip6" &&
                  activeNonstationaryStatus === "Fitted" ? (
                    <>
                      {nonstationaryCovariate === "time" ? (
                        <p>
                          <strong>Time-varying GEV:</strong> μ₀=
                          {nonstationaryTime.fit.locationAtCenter.toFixed(3)} mm,
                          μ₁=
                          {nonstationaryTime.fit.locationSlopeMmPerYear.toFixed(4)}{" "}
                          mm/year, σ={nonstationaryTime.fit.scale.toFixed(3)} mm,
                          ξ={nonstationaryTime.fit.shape.toFixed(4)}.
                        </p>
                      ) : nonstationaryMatched ? (
                        <p>
                          <strong>{nonstationaryMatched.fit.covariateLabel} GEV:</strong>{" "}
                          μ₀={nonstationaryMatched.fit.locationAtCenter.toFixed(3)} mm,
                          μ₁={nonstationaryMatched.fit.locationSlopePerUnit.toFixed(5)} mm/{nonstationaryMatched.fit.units}, σ=
                          {nonstationaryMatched.fit.scale.toFixed(3)} mm, ξ=
                          {nonstationaryMatched.fit.shape.toFixed(4)}.
                        </p>
                      ) : null}
                      <p>
                        <strong>Model comparison:</strong> stationary AICc=
                        {nonstationaryCovariate === "time"
                          ? nonstationaryTime.fit.stationaryAicc.toFixed(2)
                          : nonstationaryMatched?.fit.stationaryAicc.toFixed(2)},
                        nonstationary AICc=
                        {nonstationaryCovariate === "time"
                          ? nonstationaryTime.fit.nonstationaryAicc.toFixed(2)
                          : nonstationaryMatched?.fit.nonstationaryAicc.toFixed(2)},
                        ΔAICc (stationary−nonstationary)=
                        {nonstationaryCovariate === "time"
                          ? nonstationaryTime.fit.deltaAicc.toFixed(2)
                          : nonstationaryMatched?.fit.deltaAicc.toFixed(2)}.
                        Differences within ±2 are treated as inconclusive.
                      </p>
                    </>
                  ) : (
                    activeDiagnostics.map((d) => (
                      <p key={d.method}>
                        <strong>{METHOD_LABEL[d.method]}:</strong>{" "}
                        {d.parameters}
                      </p>
                    ))
                  )}
                </details>
                <div className="covariate-comparison">
                  <div className="comparison-heading">
                    <div>
                      <span>Nonstationary model selection</span>
                      <h3>Time, ENSO and physically plausible covariates</h3>
                    </div>
                    <strong>{covariateComparison.decision}</strong>
                  </div>
                  <p>
                    {covariateComparison.decisionReason} Every ranked model uses
                    the same {covariateComparison.commonYears.length} annual
                    maxima. Correlation is neither calculated nor used for
                    selection.
                  </p>
                  {covariateComparison.rows.length ? (
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>Model</th>
                            <th>AICc · Δ · weight</th>
                            <th>Location coefficient · 95% CI</th>
                            <th>PIT residual checks</th>
                            <th>Held-out log score</th>
                            <th>Decision evidence</th>
                          </tr>
                        </thead>
                        <tbody>
                          {covariateComparison.rows.map((row) => (
                            <tr
                              key={row.modelId}
                              className={
                                covariateComparison.selectedModelId ===
                                row.modelId
                                  ? "recommended-row"
                                  : ""
                              }
                            >
                              <td>
                                <strong>{row.label}</strong>
                                <small>{row.physicalRationale}</small>
                                <small>
                                  <strong>Source:</strong> {row.source}
                                </small>
                              </td>
                              <td>
                                {row.aicc.toFixed(2)} · {row.deltaAicc.toFixed(2)} ·{" "}
                                {row.akaikeWeight.toFixed(3)}
                              </td>
                              <td>
                                {row.modelId === "stationary"
                                  ? "Not applicable"
                                  : `${row.locationSlopePerUnit.toFixed(5)} mm/${row.units} · ${row.slopeCiLower.toFixed(5)} to ${row.slopeCiUpper.toFixed(5)}`}
                              </td>
                              <td>
                                {row.residualStatus} · KS D={row.pitKsD.toFixed(3)} · lag-1={row.residualLag1.toFixed(3)}
                              </td>
                              <td>
                                {Number.isFinite(row.holdoutMeanNll)
                                  ? `${row.holdoutMeanNll.toFixed(4)} (${row.holdoutDeltaVsStationary >= 0 ? "+" : ""}${row.holdoutDeltaVsStationary.toFixed(4)} vs stationary)`
                                  : "Unavailable"}
                              </td>
                              <td>{row.selectionEvidence}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div className="screening-notice">
                      <p>{covariateComparison.decisionReason}</p>
                    </div>
                  )}
                  <p className="validation-note">
                    <strong>Selection rule:</strong>{" "}
                    {covariateComparison.selectionRule} {covariateComparison.holdoutRule}{" "}
                    {covariateComparison.uncertaintyRule}
                  </p>
                  {!!covariateComparison.excluded.length && (
                    <details>
                      <summary>
                        Candidates not ranked ({covariateComparison.excluded.length})
                      </summary>
                      {covariateComparison.excluded.map((row) => (
                        <p key={`${row.modelId}-${row.reason}`}>
                          <strong>{row.label}:</strong> {row.reason}
                        </p>
                      ))}
                    </details>
                  )}
                </div>
                <p className="validation-note">
                  Stationary limits use 200 deterministic nonparametric
                  bootstrap resamples; fitted time-varying GEV limits use 80
                  paired bootstrap refits. Neither interval includes model-form,
                  covariate-choice, provider bias, spatial aggregation or
                  sub-daily downscaling uncertainty.
                </p>
              </>
            ) : (
              <div className="screening-notice">
                <p>
                  {cmipImportedReady ? (
                    <>
                      <strong>Imported-results boundary:</strong> the workbook
                      supplies model-specific, bias-corrected GEV return levels,
                      not the daily annual-maxima samples needed to compare
                      alternative distributions inside the Atlas. The ensemble
                      chart and P10–P90 spread remain available above.
                    </>
                  ) : (
                    <>
                      <strong>No statistical recommendation:</strong> retrieve an
                      individual NASA GCM precipitation series for the active
                      selection before fitting and comparing distributions.
                    </>
                  )}
                </p>
              </div>
            )}
            {modelTab === "nonstationary" && (
              <p className="trend-note">
                {sourceTab === "cmip6"
                  ? nonstationaryTime.fit.status === "Fitted"
                    ? `${CMIP6_SCENARIOS[cmipScenario].label}, ${cmipPeriod}, ${cmipModel}. A time-varying GEV was fitted to the retrieved GCM annual maxima at reference year ${referenceYear}; location changes ${nonstationaryTime.fit.locationSlopeMmPerYear.toFixed(4)} mm/year and ΔAICc=${nonstationaryTime.fit.deltaAicc.toFixed(2)}. This is a model-specific projection, not a multi-model ensemble confidence interval.`
                    : `The retrieved GCM record does not support the time-varying GEV: ${nonstationaryTime.fit.status}.`
                  : nonstationaryCovariate === "time"
                    ? nonstationaryTime.fit.status === "Fitted"
                      ? `Fitted nonstationary GEV at ${referenceYear}: location changes ${nonstationaryTime.fit.locationSlopeMmPerYear.toFixed(4)} mm/year; ΔAICc=${nonstationaryTime.fit.deltaAicc.toFixed(2)} and preference=${nonstationaryTime.fit.preferred}. ${referenceYearStatus}. AICc preference is evidence for relative fit, not proof that time is the physical cause.`
                      : `Time-varying GEV unavailable: ${nonstationaryTime.fit.status}. At least 20 eligible annual maxima are required.`
                    : nonstationaryMatched?.fit.status === "Fitted"
                      ? `${nonstationaryMatched.fit.covariateLabel} is fitted at ${covariateEvaluationValue.toFixed(3)} ${nonstationaryMatched.fit.units}; location changes ${nonstationaryMatched.fit.locationSlopePerUnit.toFixed(5)} mm/${nonstationaryMatched.fit.units}. ${covariateEvaluationStatus}. The overall decision is “${covariateComparison.decision}”; correlation is not used.`
                      : `Matched-covariate GEV unavailable. Retrieve or upload at least 20 annual covariate values aligned with eligible annual maxima.`}
              </p>
            )}
          </article>
        </div>
      </section>
      <aside className="content-width report-download-panel" aria-label="Report downloads">
        <h2>Report and user manual</h2>
        <p>Exports reflect the current data, model and method. Review the result status before sharing. Save the Excel workbook alongside the report to retain the calculation evidence.</p>
        <div className="report-actions">
          <button onClick={() => window.print()}>Print / Save PDF</button>
          <button onClick={() => report("docx")}>Download Word report (.docx)</button>
          <button onClick={() => report("html")}>Download editable HTML</button>
          <a href="/downloads/Pakistan-IDF-Atlas-User-Manual.pdf" download>Download user manual (PDF)</a>
          <a href="/downloads/Pakistan-IDF-Atlas-Sample-Report.pdf" download>Sample report (synthetic data)</a>
        </div>
      </aside>
      <section id="report" className="content-width report">
        <div className="print-header">
          Pakistan IDF Atlas · Intensity-Duration-Frequency Technical Report
        </div>
        <div className="print-footer">
          {reportId} · Generated {reportDate}
        </div>

        <div className="report-cover">
          <div>
            <div className="report-brand">
              <span className="report-brand-mark">◆</span>
              <span>Pakistan IDF Atlas</span>
            </div>
            <p className="eyebrow">Precipitation frequency analysis</p>
          </div>
          <div className="report-cover-title">
            <p className="eyebrow">Technical report</p>
            <h1>
              {sourceTab === "observed"
                ? "Observed precipitation"
                : sourceTab === "cmip6"
                  ? cmipImportedReady
                    ? "Bias-corrected CMIP6 ensemble"
                    : "Retrieved CMIP6 precipitation"
                  : "Online gridded precipitation"}{" "}
              and {modelTab === "stationary" ? "stationary" : "nonstationary"}{" "}
              IDF assessment
            </h1>
            <p className="report-cover-subtitle">
              {sourceTab === "observed"
                ? `${name} · uploaded gauge series · district independent`
                : `${spatialLabel} · maximum modeled duration 24 hours${sourceTab === "cmip6" ? ` · projections through ${cmipPeriod.split("-")[1]}` : ""}`}
            </p>
            <p className="report-classification">{analysisClassification}</p>
          </div>
          <div className="document-control">
            <dl>
              <div>
                <dt>Report identifier</dt>
                <dd>{reportId}</dd>
              </div>
              <div>
                <dt>Issue date</dt>
                <dd>{reportDate}</dd>
              </div>
              <div>
                <dt>Prepared for</dt>
                <dd>Hydrologists, planners and engineering reviewers</dd>
              </div>
              <div>
                <dt>Revision</dt>
                <dd>2.0 · generated from active analysis</dd>
              </div>
              <div>
                <dt>Precipitation source</dt>
                <dd>{sourceLabel}</dd>
              </div>
              <div>
                <dt>Administrative boundary</dt>
                <dd>
                  {sourceTab === "observed"
                    ? "Not used for uploaded gauge fitting"
                    : boundary}
                </dd>
              </div>
              <div>
                <dt>Selected model</dt>
                <dd>
                  {sourceTab === "cmip6"
                    ? `${cmipModel} · ${CMIP6_SCENARIOS[cmipScenario].label} · ${cmipPeriod}`
                    : modelTab === "stationary"
                      ? "Stationary · parameters constant"
                      : nonstationaryCovariate === "time"
                        ? `Time-varying GEV evaluated at ${referenceYear}`
                        : selectedAnnualCovariate
                          ? `${selectedAnnualCovariate.label} GEV evaluated at ${covariateEvaluationValue.toFixed(3)} ${selectedAnnualCovariate.units}`
                          : "Matched-covariate GEV unavailable"}
                </dd>
              </div>
              <div>
                <dt>Selected method</dt>
                <dd>{activeFrequencyMethodLabel}</dd>
              </div>
            </dl>
          </div>
        </div>

        <nav className="report-contents" aria-label="Report contents">
          <p className="eyebrow">Professional technical report</p>
          <h2>Contents</h2>
          <ol>
            <li>
              <a href="#report-executive">Executive summary</a>
            </li>
            <li>
              <a href="#report-scope">Purpose and how to read the report</a>
            </li>
            <li>
              <a href="#report-data">Data used and quality checks</a>
            </li>
            <li>
              <a href="#report-methods">Analysis method</a>
            </li>
            <li>
              <a href="#report-results">IDF results and model checks</a>
            </li>
            <li>
              <a href="#report-limitations">Uncertainty and limitations</a>
            </li>
            <li>
              <a href="#report-conclusions">Conclusions and recommendations</a>
            </li>
            <li>
              <a href="#report-references">
                References and supporting calculations
              </a>
            </li>
          </ol>
        </nav>

        <section id="report-executive" className="report-section">
          <h2>
            <span>1.0</span> Executive summary
          </h2>
          <p className="report-summary">
            {sourceTab === "cmip6" && cmipImportedReady && cmipImportedWorkbook
              ? `The Atlas imported ${cmipImportedModels.length} model-specific, bias-corrected GEV curves for ${cmipImportedWorkbook.locationName}, ${CMIP6_SCENARIOS[cmipScenario].label}, ${cmipPeriod}. The 24-hour ensemble median is ${selected10?.intensityMmHr.toFixed(2) ?? "—"} mm/hour for the 10-year event and ${selected500?.intensityMmHr.toFixed(2) ?? "—"} mm/hour for the 500-year event; the displayed lower and upper bounds are the model P10 and P90, not sampling-confidence limits. Workbook validation status: ${cmipImportedWorkbook.validationStatus}.`
              : sourceTab === "cmip6" && !cmipDataReady
              ? `No NASA NEX-GDDP-CMIP6 precipitation has been retrieved for ${cmipModel}, ${CMIP6_SCENARIOS[cmipScenario].label}, ${cmipPeriod} and ${spatialLabel}; therefore no GCM-derived IDF result is reported.`
              : sourceTab === "online" && !onlineReady
                ? `No provider series has been retrieved for the active ${SOURCE_META[onlineSource].label} and ${spatialLabel} selection, so no online IDF result is reported.`
                : activeStationarity.n < 8
                  ? `The ${sourceTab === "online" ? "retrieved online" : "uploaded"} record produced ${activeStationarity.n} eligible annual maxima. At least eight are required to estimate stationary IDF values, so no frequency result should be adopted from this record.`
                  : modelTab === "nonstationary" &&
                      nonstationaryCovariate === "time"
                    ? nonstationaryTime.fit.status === "Fitted"
                      ? `A time-varying GEV was fitted to ${activeStationarity.n} eligible annual maxima. At reference year ${referenceYear}, the estimated 24-hour intensity is ${selected10?.intensityMmHr.toFixed(2) ?? "—"} mm/hour for the 10-year event and ${selected500?.intensityMmHr.toFixed(2) ?? "—"} mm/hour for the 500-year event. The model comparison is ${nonstationaryTime.fit.preferred.toLowerCase()} (ΔAICc=${nonstationaryTime.fit.deltaAicc.toFixed(2)}); ${referenceYearStatus.toLowerCase()}.`
                      : `A time-varying GEV cannot be estimated from ${nonstationaryTime.fit.n} eligible annual maxima; at least 20 are required.`
                    : modelTab === "nonstationary"
                      ? nonstationaryMatched?.fit.status === "Fitted"
                        ? `A ${nonstationaryMatched.fit.covariateLabel}-dependent GEV was fitted to ${nonstationaryMatched.fit.n} matched annual maxima and evaluated at ${covariateEvaluationValue.toFixed(3)} ${nonstationaryMatched.fit.units}. The estimated 24-hour intensity is ${selected10?.intensityMmHr.toFixed(2) ?? "—"} mm/hour for the 10-year event and ${selected500?.intensityMmHr.toFixed(2) ?? "—"} mm/hour for the 500-year event. The model decision is ${covariateComparison.decision.toLowerCase()}; correlation was not used.`
                        : "The selected annual covariate does not have at least 20 values matched to eligible annual maxima, so no nonstationary frequency result is issued."
                    : `The ${sourceTab === "online" ? onlineMetadata?.dataset : sourceTab === "cmip6" ? `${cmipMetadata?.dataset ?? "uploaded GCM record"} (${cmipModel}, ${cmipMetadata?.member ?? "member not reported"})` : `uploaded ${observedResolution} record`} produced ${activeStationarity.n} eligible 24-hour annual maxima. Using ${METHOD_LABEL[method]}, the estimated 24-hour intensity is ${selected10?.intensityMmHr.toFixed(2) ?? "—"} mm/hour for the 10-year event and ${selected500?.intensityMmHr.toFixed(2) ?? "—"} mm/hour for the 500-year event. The 250- and 500-year results extend far beyond the record and require independent review.`}
          </p>
          <div className="report-decision">
            <h3>Assessment at a glance</h3>
            <dl>
              <div><dt>Result status</dt><dd>{shown.length ? analysisClassification : "No fitted result — this document records setup and methodology only."}</dd></div>
              <div><dt>Basis of assessment</dt><dd>{activeFrequencyMethodLabel} · {modelTab === "stationary" ? "stationary parameters" : covariateLabel}. {sourceTab === "cmip6" && cmipImportedReady ? "Imported model curves; annual maxima were not re-fitted." : `${activeStationarity.n} eligible 24-hour annual maxima.`}</dd></div>
              <div><dt>Duration support</dt><dd>{sourceTab === "cmip6" && cmipImportedReady ? "24-hour return levels only. No sub-daily results inferred." : activeNativeHourly ? "Native hourly observations support 1–24-hour rolling totals; shorter durations are derived." : "Daily data support 24-hour totals. Any shorter duration is derived and must be checked against local evidence."}</dd></div>
              <div><dt>Required next action</dt><dd>{shown.length ? "Check source quality, duration assumptions and model sensitivity; obtain independent hydrologic review before design adoption." : "Upload a suitable gauge record or retrieve precipitation, then run the analysis and export again."}</dd></div>
            </dl>
          </div>
          <div className="report-table-wrap">
            <table>
              <caption>Decision summary · selected 24-hour return levels</caption>
              <thead><tr><th scope="col">Return period (years)</th><th scope="col">Annual exceedance probability</th><th scope="col">Intensity (mm/hour)</th><th scope="col">24-hour depth (mm)</th></tr></thead>
              <tbody>{[10, 50, 100, 250, 500].map((period) => {
                const row = selected24h.find((item) => item.returnPeriodYears === period);
                return <tr key={period}><th scope="row">{period}</th><td>{(100 / period).toFixed(1)}%</td><td>{row ? row.intensityMmHr.toFixed(2) : "Not estimated"}</td><td>{row ? (row.intensityMmHr * 24).toFixed(2) : "Not estimated"}</td></tr>;
              })}</tbody>
            </table>
          </div>
          <div className="report-kpis">
            <div>
              <span>10-year · 24-hour</span>
              <strong>
                {selected10
                  ? `${selected10.intensityMmHr.toFixed(2)} mm/hr`
                  : "—"}
              </strong>
              <small>
                {sourceTab === "cmip6"
                  ? "GCM-derived fitted intensity"
                  : "Estimated intensity"}
              </small>
            </div>
            <div>
              <span>50-year · 24-hour</span>
              <strong>
                {selected50
                  ? `${selected50.intensityMmHr.toFixed(2)} mm/hr`
                  : "—"}
              </strong>
              <small>{activeFrequencyMethodLabel}</small>
            </div>
            <div>
              <span>100-year · 24-hour</span>
              <strong>
                {selected100
                  ? `${selected100.intensityMmHr.toFixed(2)} mm/hr`
                  : "—"}
              </strong>
              <small>
                {modelTab === "nonstationary"
                  ? covariateLabel
                  : "Stationary model"}
              </small>
            </div>
            <div>
              <span>250-year · 24-hour</span>
              <strong>
                {selected250
                  ? `${selected250.intensityMmHr.toFixed(2)} mm/hr`
                  : "—"}
              </strong>
              <small>Rare-event extrapolation</small>
            </div>
            <div>
              <span>500-year · 24-hour</span>
              <strong>
                {selected500
                  ? `${selected500.intensityMmHr.toFixed(2)} mm/hr`
                  : "—"}
              </strong>
              <small>Highest uncertainty · 0.2% AEP</small>
            </div>
          </div>
        </section>

        <section id="report-scope" className="report-section">
          <h2>
            <span>2.0</span> Purpose and how to read this report
          </h2>
          <p>
            This report estimates rainfall intensity for selected storm
            durations and annual exceedance probabilities from the active
            dataset. It documents the data used, the checks applied, the fitted
            method, the uncertainty and the limits on engineering use. It is a
            technical analysis record, not regulatory approval or independent
            design certification.
          </p>
          <div className="report-objectives">
            <div>
              <h3>What was analysed?</h3>
              <p>
                {sourceTab === "observed"
                  ? `The uploaded ${observedResolution} gauge series for ${name}. District boundaries are not used in the calculation.`
                  : sourceTab === "online"
                    ? onlineReady && onlineMetadata
                      ? `The retrieved ${onlineMetadata.dataset} ${onlineMetadata.temporalResolution} series for ${spatialLabel}. ${onlineMetadata.spatialMethod}.`
                      : "No online series has been retrieved for the active selection."
                    : cmipImportedReady && cmipImportedWorkbook
                      ? `Model-specific, bias-corrected 24-hour GEV return levels for ${cmipImportedWorkbook.locationName}; ${cmipImportedModels.length} models are summarized as P10, median and P90.`
                    : cmipDataReady
                      ? `The retrieved daily ${cmipMetadata?.dataset ?? "GCM"} precipitation series for ${spatialLabel}; ${cmipMetadata?.spatialMethod ?? "the uploaded processed spatial series was used"}.`
                      : "No GCM precipitation series has been retrieved for the active selection."}
              </p>
            </div>
            <div>
              <h3>What does “T-year” mean?</h3>
              <p>
                A T-year value has a 1/T chance of being exceeded in any year.
                For example, a 100-year value has 1% annual exceedance
                probability; it does not occur on a fixed 100-year schedule.
              </p>
            </div>
            <div>
              <h3>Which durations are measured?</h3>
              <p>
                {activeNativeHourly
                  ? "Native hourly data directly support fitted 1-, 2-, 3-, 6-, 12- and 24-hour durations. Values below one hour are derived."
                  : "Daily data directly support 24 hours only. All shorter durations are derived with the stated scaling equation."}
              </p>
            </div>
            <div>
              <h3>How should rare values be used?</h3>
              <p>
                Results for 250 and 500 years are model extrapolations well
                beyond most records. Use them only with uncertainty, method
                sensitivity and independent hydrologic review.
              </p>
            </div>
          </div>
        </section>

        <section id="report-data" className="report-section">
          <h2>
            <span>3.0</span> Data sources and quality
          </h2>
          <p className="report-status">
            <strong>Spatial treatment:</strong>{" "}
            {sourceTab === "observed" ? (
              "The uploaded gauge series is fitted directly. District boundaries do not enter quality control, annual-maxima extraction, distribution fitting, uncertainty, or IDF calculations."
            ) : sourceTab === "online" ? (
              (onlineMetadata?.spatialMethod ??
              "No online spatial extraction has completed for the active selection.")
            ) : (
              <>
                {cmipImportedReady && cmipImportedWorkbook
                  ? `Imported project point at ${cmipImportedWorkbook.latitude.toFixed(4)}, ${cmipImportedWorkbook.longitude.toFixed(4)}; no district averaging.`
                  : cmipMetadata?.spatialMethod ??
                  "No CMIP6 spatial extraction has completed for the active selection."}
              </>
            )}
          </p>
          <h3>3.1 Source provenance</h3>
          <p>
            {sourceTab === "observed"
              ? "All compatible worksheets in the user-selected Excel or CSV file are scanned and processed locally. The report retains the source label, native interval, date range, quality-control counts, optional gauge coordinates and precipitation unit. District selection and polygon averaging are disabled, and the workbook is not transmitted to a server."
              : sourceTab === "cmip6"
                ? cmipImportedReady && cmipImportedWorkbook
                  ? `The imported workbook supplied ${cmipImportedWorkbook.modelRows} model-specific, bias-corrected 24-hour GEV return-level rows for ${cmipImportedWorkbook.locationName}, ${CMIP6_SCENARIOS[cmipScenario].label} and ${cmipPeriod}. The historical correction reference is ${cmipImportedWorkbook.referenceLabel} (${cmipImportedWorkbook.historicalPeriod}); source validation status is ${cmipImportedWorkbook.validationStatus}. No daily precipitation values were inferred or imported into the active analysis.`
                : cmipDataReady
                  ? `${cmipMetadata?.dataset ?? "The uploaded GCM record"} supplied daily 0.25° bias-corrected projection precipitation for ${cmipModel}, ${CMIP6_SCENARIOS[cmipScenario].label}, ${cmipMetadata?.member ?? "member not reported"}, ${cmipPeriod}, and ${spatialLabel}. ${cmipMetadata ? `The series was retrieved through ${cmipMetadata.retrievalService}, converted from ${cmipMetadata.sourceUnits} to ${cmipMetadata.outputUnits}, and contains ${cmipMetadata.acceptedRecords.toLocaleString()} accepted values. Source calendar: ${cmipMetadata.sourceCalendar}. ${cmipMetadata.calendarConversion}` : "The processed daily series was supplied by the user."}`
                  : `NASA NEX-GDDP-CMIP6 is selected for ${cmipModel}, ${CMIP6_SCENARIOS[cmipScenario].label}, ${cmipPeriod}, but no precipitation series has been retrieved.`
                : onlineReady && onlineMetadata
                  ? `${onlineMetadata.dataset} was retrieved from ${onlineMetadata.provider} through ${onlineMetadata.retrievalService}. The returned ${onlineMetadata.temporalResolution} series covers ${onlineMetadata.returnedStart} to ${onlineMetadata.returnedEnd}; ${onlineMetadata.spatialMethod}. Retrieval time, provider, timestamps, units and spatial method are retained in the report and workbook.`
                  : `No online precipitation has been retrieved for the active ${SOURCE_META[onlineSource].label} selection. No IDF result is reported until extraction completes.`}
          </p>
          <div className="report-table-wrap">
            <table className="report-source-table">
              <caption>
                Table 3-1. Analysis population, provenance and metric
                definitions
              </caption>
              <tbody>
                <tr>
                  <th>Precipitation source</th>
                  <td>{sourceLabel}</td>
                  <td>
                    {sourceTab === "observed"
                      ? `User-supplied observed ${observedResolution} precipitation`
                      : sourceTab === "cmip6"
                        ? cmipImportedReady
                          ? `User-supplied validated results workbook; ${cmipImportedModels.length} model-specific curves`
                        : cmipDataReady
                          ? `${cmipMetadata?.provider ?? "User upload"}; ${cmipMetadata?.retrievalService ?? "processed GCM table"}`
                          : "CMIP6 series not retrieved"
                        : onlineReady && onlineMetadata
                          ? `${onlineMetadata.provider}; ${onlineMetadata.retrievalService}`
                          : "Online series not retrieved"}
                  </td>
                </tr>
                <tr>
                  <th>Temporal support</th>
                  <td>
                    {sourceTab === "observed"
                      ? observedResolution === "hourly"
                        ? "Hourly totals"
                        : "Daily totals"
                      : sourceTab === "cmip6"
                        ? "Daily; historical 1950–2014 and scenarios 2015–2100"
                        : (onlineMetadata?.nativeResolution ??
                          SOURCE_META[onlineSource].temporal)}
                  </td>
                  <td>
                    {activeNativeHourly
                      ? "Native support: rolling 1-, 2-, 3-, 6-, 12- and 24-hour durations"
                      : "Native support: 24-hour duration"}
                  </td>
                </tr>
                <tr>
                  <th>Analysis period</th>
                  <td>
                    {sourceTab === "observed"
                      ? `${activeObservedQc.start || "not specified"} to ${activeObservedQc.end || "not specified"}`
                      : sourceTab === "cmip6"
                        ? `${cmipPeriod}; midpoint ${cmipMidpoint}`
                        : onlineReady && onlineMetadata
                          ? `${onlineMetadata.returnedStart} to ${onlineMetadata.returnedEnd}`
                          : "not retrieved"}
                  </td>
                  <td>
                    {sourceTab === "cmip6"
                      ? `${CMIP6_SCENARIOS[cmipScenario].label}; ${cmipModel}`
                      : "Selected range applied before QC and fitting"}
                  </td>
                </tr>
                <tr>
                  <th>Spatial assignment</th>
                  <td>
                    {sourceTab === "observed"
                      ? "Uploaded station / gauge series"
                      : sourceTab === "online"
                        ? spatialLabel
                        : cmipImportedReady
                          ? spatialLabel
                          : district}
                  </td>
                  <td>
                    {sourceTab === "observed" ? (
                      "District selection disabled; no boundary used in fitting"
                    ) : sourceTab === "online" ? (
                      (onlineMetadata?.spatialMethod ??
                      "No completed extraction")
                    ) : (
                      <>
                        {boundary}; polygon match:{" "}
                        {matchedBoundaryName ?? "not verified"}
                      </>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>Analysis sample</th>
                  <td>
                    {sourceTab === "observed"
                      ? `${activeObservedQc.records.length.toLocaleString()} accepted ${observedResolution} rows; ${stationarity.n} eligible annual maxima`
                      : sourceTab === "cmip6"
                        ? cmipImportedReady && cmipImportedWorkbook
                          ? `${cmipImportedWorkbook.modelRows.toLocaleString()} corrected model/return-period rows; ${cmipImportedModels.length} active models`
                        : cmipDataReady
                          ? `${cmipQc.records.length.toLocaleString()} accepted daily values; ${cmipStationarity.n} eligible annual maxima`
                          : "No GCM precipitation values retrieved"
                        : onlineReady
                          ? `${onlineQc.records.length.toLocaleString()} accepted ${onlineResolution} values; ${onlineStationarity.n} eligible annual maxima`
                          : "No product values retrieved"}
                  </td>
                  <td>
                    {sourceTab === "observed"
                      ? `${activeObservedQc.completeness.toFixed(2)}% span completeness; ${activeObservedQc.missing} missing ${observedResolution} intervals; ${activeObservedQc.duplicates} duplicates; ${activeObservedQc.invalid} invalid values`
                      : sourceTab === "cmip6"
                        ? cmipImportedReady && cmipImportedWorkbook
                          ? `${cmipImportedWorkbook.validationStatus}; coordinates, labels, depth/intensity conversion, monotonicity, shared return periods and ensemble reconciliation checked`
                        : cmipDataReady
                          ? `${cmipQc.completeness.toFixed(2)}% span completeness; ${cmipQc.missing} missing daily intervals; ${cmipQc.duplicates} duplicates; ${cmipQc.invalid} invalid values`
                          : "Model, realization, calendar and spatial QA pending retrieval"
                        : onlineReady
                          ? `${onlineQc.completeness.toFixed(2)}% span completeness; ${onlineQc.missing} missing ${onlineResolution} intervals; ${onlineQc.duplicates} duplicates; ${onlineQc.invalid} invalid values`
                          : "Product-specific QA pending extraction"}
                  </td>
                </tr>
                <tr>
                  <th>Response metric</th>
                  <td>Rainfall intensity (mm/hour)</td>
                  <td>Precipitation depth divided by duration in hours</td>
                </tr>
                <tr>
                  <th>Return periods</th>
                  <td>2, 5, 10, 25, 50, 100, 250 and 500 years</td>
                  <td>
                    AEP=1/T; 250- and 500-year levels are high-uncertainty
                    extrapolations
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {sourceTab === "cmip6" && (
            <>
              <h3>3.2 CMIP6 configuration</h3>
              <div className="report-table-wrap">
                <table>
                  <caption>
                    Table 3-2. Selected climate-projection configuration
                  </caption>
                  <tbody>
                    <tr>
                      <th>Dataset</th>
                      <td>NASA NEX-GDDP-CMIP6 v2</td>
                      <th>Catalogue</th>
                      <td>{CMIP6_MODELS.length} model/grid entries</td>
                    </tr>
                    <tr>
                      <th>Selection mode</th>
                      <td>
                        {cmipSelectionMode === "individual"
                          ? "Individual GCM model"
                          : "Multi-model ensemble summary"}
                      </td>
                      <th>GCM / ensemble</th>
                      <td>{cmipModel}</td>
                    </tr>
                    <tr>
                      <th>Scenario</th>
                      <td>
                        {CMIP6_SCENARIOS[cmipScenario].label} ·{" "}
                        {CMIP6_SCENARIOS[cmipScenario].description}
                      </td>
                      <th>Future period</th>
                      <td>
                        {cmipPeriod} · midpoint {cmipMidpoint}
                      </td>
                    </tr>
                    <tr>
                      <th>Realization member</th>
                      <td>{cmipImportedReady ? "Multiple members recorded by model in source workbook" : (cmipMetadata?.member ?? "not retrieved")}</td>
                      <th>{cmipImportedReady ? "Imported model rows" : "Accepted daily values"}</th>
                      <td>{cmipImportedReady ? cmipImportedWorkbook?.modelRows : cmipDataReady ? cmipQc.records.length : 0}</td>
                    </tr>
                    <tr>
                      <th>Native projection support</th>
                      <td>
                        0.25° global, daily precipitation (<code>pr</code>)
                      </td>
                      <th>Workflow status</th>
                      <td>
                        {cmipImportedReady
                          ? "Bias-corrected model-specific GEV rows summarized as median and P10–P90; 24-hour only"
                        : cmipDataReady
                          ? "Retrieved series used for QC, annual maxima, distribution fitting and IDF"
                          : "Direct retrieval is available; no active GCM series"}
                      </td>
                    </tr>
                    <tr>
                      <th>CF time-coordinate units</th>
                      <td>
                        {cmipMetadata?.sourceTimeUnits ?? "not retrieved"}
                      </td>
                      <th>Source calendar</th>
                      <td>{cmipMetadata?.sourceCalendar ?? "not retrieved"}</td>
                    </tr>
                    <tr>
                      <th>Calendar treatment</th>
                      <td colSpan={3}>
                        {cmipMetadata?.calendarConversion ??
                          "Calendar metadata and conversion pending retrieval"}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
          <h3>{sourceTab === "cmip6" ? "3.3" : "3.2"} Quality-control rules</h3>
          <p>
            {sourceTab === "cmip6"
              ? cmipImportedReady && cmipImportedWorkbook
                ? `The Atlas validated the workbook coordinates, supported SSP and period labels, 24-hour depth/intensity identity, increasing model curves, common return periods, minimum ensemble size and optional ensemble summary. The source workbook reports ${cmipImportedWorkbook.validationStatus}; its listed caveats remain binding because daily series and annual maxima were not re-fitted inside the Atlas.`
              : cmipDataReady
                ? `The workflow verified the selected model, SSP, realization, annual files, daily dates, precipitation units, source calendar and spatial request; converted flux to mm/day; retained complete model years; and fitted model-specific annual maxima. ${cmipMetadata?.calendarConversion ?? "Calendar treatment was not reported."} ${cmipMetadata?.spatialMethod ?? "The uploaded spatial series was used."} Historical gauge evaluation and multi-model ensemble synthesis remain required before design use.`
                : "A production CMIP6 workflow must verify model, experiment, ensemble member, grid, calendar, units and missing days; convert precipitation flux consistently; compare historical simulations against quality-controlled gauges; and preserve model-by-scenario provenance. No active series has been retrieved."
              : sourceTab === "online"
                ? onlineResolution === "hourly"
                  ? "Returned ERA5 timestamps are retained in UTC, sorted and de-duplicated; null, non-numeric and negative precipitation values are rejected; missing hours are counted; and only years with at least 90% expected hourly coverage are retained. Rolling 1-, 2-, 3-, 6-, 12- and 24-hour annual maxima are calculated only from consecutive hourly values."
                  : "Returned dates are sorted and de-duplicated; null, non-numeric and negative precipitation values are rejected; missing calendar days are counted; and only years with at least 90% expected daily coverage are retained for annual maxima. Provider bias, gauge comparison and precipitation-product structural uncertainty are not removed by these automated checks."
                : observedResolution === "hourly"
                  ? "Timestamps are normalized to whole local clock hours without timezone conversion and de-duplicated; non-numeric or negative precipitation is rejected; missing hours are counted; and only years with at least 90% hourly coverage are eligible. Rolling 1-, 2-, 3-, 6-, 12- and 24-hour annual maxima are calculated from consecutive observations."
                  : "Dates are sorted and de-duplicated, non-numeric or negative precipitation values are rejected, missing calendar days are counted, and only years with at least 90% expected daily coverage are eligible for the annual-maxima series. These automated checks support traceability but do not replace metadata-led homogenization of station relocations, instruments or observation practices, consistent with WMO climate-data guidance."}
          </p>
        </section>

        <section id="report-methods" className="report-section section-break">
          <h2>
            <span>4.0</span> Methodology
          </h2>
          <p>
            The workflow follows an annual-maxima frequency-analysis structure
            commonly used in hydrology (Hosking, 1990; Katz et al., 2002).
            Equation definitions are reproduced in Appendix A.
          </p>
          <div className="method-flow">
            <div>
              <span>01</span>
              <strong>Ingest and screen</strong>
              <small>Dates, units, range and completeness</small>
            </div>
            <div>
              <span>02</span>
              <strong>Build AMS</strong>
              <small>Eligible one-day annual maxima</small>
            </div>
            <div>
              <span>03</span>
              <strong>Fit and diagnose</strong>
              <small>Distributions, trend and uncertainty</small>
            </div>
            <div>
              <span>04</span>
              <strong>Convert to IDF</strong>
              <small>Depth-duration scaling and intensity</small>
            </div>
          </div>
          <h3>4.1 Literature and implementation alignment</h3>
          <div className="report-table-wrap">
            <table>
              <caption>
                Table 4-1. Literature basis, implementation status and
                interpretation
              </caption>
              <thead>
                <tr>
                  <th>Analysis component</th>
                  <th>Literature or guidance</th>
                  <th>Implemented use</th>
                  <th>Technical boundary</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Data quality and homogenization</th>
                  <td>WMO climate-data guidance</td>
                  <td>
                    Automated range, duplicate, missing-day and
                    annual-completeness checks
                  </td>
                  <td>
                    Station history and neighbour-based homogenization still
                    require expert review
                  </td>
                </tr>
                <tr>
                  <th>Annual maxima and extremes</th>
                  <td>Katz et al. (2002)</td>
                  <td>
                    Calendar-year one-day annual-maxima series and return-level
                    estimation
                  </td>
                  <td>
                    Block-maxima results depend on record length and
                    independence
                  </td>
                </tr>
                <tr>
                  <th>Stationary distribution suite</th>
                  <td>
                    Hosking (1990); Katz et al. (2002); USGS Bulletin 17C for
                    LP3 context
                  </td>
                  <td>
                    Six alternatives fitted to the same annual-maxima sample:
                    GEV by L-moments; Gumbel, Lognormal, Gamma and Weibull by
                    moment-based estimates; LP3 in log space
                  </td>
                  <td>
                    The lowest RMSE is a screening preference only; probability
                    plots, uncertainty and tail sensitivity remain essential
                  </td>
                </tr>
                <tr>
                  <th>Nonstationary GEV</th>
                  <td>
                    Cheng and AghaKouchak (2014); Agilan and Umamahesh (2017,
                    2018); Kim et al. (2017)
                  </td>
                  <td>
                    Maximum-likelihood GEV with μ(y)=μ₀+μ₁(y−ȳ), constant σ and
                    ξ; stationary and nonstationary MLE compared by AICc
                  </td>
                  <td>
                    Time is a statistical index, not automatically a physical
                    cause; covariate and parameter uncertainty remain material
                  </td>
                </tr>
                <tr>
                  <th>Rare return periods</th>
                  <td>Wehner et al. (2024); Patel and Schneider (2026)</td>
                  <td>
                    250- and 500-year estimates, bootstrap intervals and
                    explicit extrapolation warnings
                  </td>
                  <td>
                    Short records can strongly bias ξ and rare return levels;
                    intervals exclude model-form uncertainty
                  </td>
                </tr>
                <tr>
                  <th>IDF duration relationship</th>
                  <td>Koutsoyiannis et al. (1998)</td>
                  <td>
                    Transparent power-law duration scaling followed by
                    conversion to mm/hour
                  </td>
                  <td>
                    Daily data directly support 24 hours only; shorter durations
                    are derived
                  </td>
                </tr>
                <tr>
                  <th>Trend assessment</th>
                  <td>Mann (1945)</td>
                  <td>
                    Two-sided Mann–Kendall test retained as a diagnostic, not as
                    the nonstationary model
                  </td>
                  <td>
                    No serial-correlation correction; non-rejection is not proof
                    of stationarity
                  </td>
                </tr>
                <tr>
                  <th>Pakistan climate drivers</th>
                  <td>Masood et al. (2023); Hussain et al. (2023)</td>
                  <td>
                    Annual ENSO and other candidate drivers can be uploaded,
                    physically documented, aligned to eligible maxima and
                    compared with time and stationarity
                  </td>
                  <td>
                    Relationships vary by precipitation index, season, elevation
                    and station; no universal coefficient is assumed and
                    correlation alone cannot select a covariate
                  </td>
                </tr>
                <tr>
                  <th>LP3 comparison</th>
                  <td>USGS Bulletin 17C</td>
                  <td>
                    Log-Pearson III benchmark in the stationary multi-method
                    table
                  </td>
                  <td>
                    Not full Bulletin 17C compliance or a flood-frequency
                    implementation
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <h3>4.2 Infrastructure design-return-period guide</h3>
          <div className="report-table-wrap">
            <table>
              <caption>
                Table 4-2. Literature-reported return periods and typical
                infrastructure applications
              </caption>
              <thead>
                <tr>
                  <th>Return period</th>
                  <th>AEP</th>
                  <th>Typical infrastructure</th>
                  <th>How to use it</th>
                  <th>Literature basis</th>
                </tr>
              </thead>
              <tbody>
                {infrastructureGuidance.map((row) => (
                  <tr key={row.period}>
                    <th>{row.period}</th>
                    <td>{row.aep}</td>
                    <td>{row.infrastructure}</td>
                    <td>{row.use}</td>
                    <td>{row.basis}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="report-note">
            <strong>Design-authority warning.</strong> This table is a
            literature-based orientation aid, not a Pakistan-wide code
            prescription. The governing authority may require a different event,
            a separate check flood, climate-change allowance, freeboard,
            blockage/scour analysis, or a consequence-based standard. Rainfall
            return period is also not automatically identical to the resulting
            flow or flood return period.
          </p>
          <h3>
            4.3 Stationary, nonstationary and reference-year interpretation
          </h3>
          <p>
            <strong>Stationary</strong> means the probability distribution used
            for annual precipitation maxima has parameters that do not change
            with time or another predictor. A 100-year intensity therefore has
            the same model value in every year. <strong>Nonstationary</strong>{" "}
            means at least one parameter or return level changes with a
            covariate such as time, temperature, ENSO or urbanization. The
            return level is conditional on a stated covariate value, so it must
            be reported with that value rather than as a timeless quantity.
          </p>
          <div className="report-table-wrap">
            <table>
              <caption>
                Table 4-3. How to calculate, select and interpret the evaluation
                point
              </caption>
              <thead>
                <tr>
                  <th>Selection</th>
                  <th>Calculated value / use</th>
                  <th>Interpretation</th>
                  <th>Warning</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Automatic record-centre</th>
                  <td>
                    {referenceYearSelection.eligibleYearCount
                      ? `${referenceYearSelection.formula}`
                      : "Calculated after eligible annual maxima are created"}
                  </td>
                  <td>
                    Default evaluation point; the arithmetic mean of eligible
                    AMS years makes the centered-year covariate zero
                  </td>
                  <td>
                    It is a statistical reference time, not automatically the
                    asset design year
                  </td>
                </tr>
                <tr>
                  <th>Latest eligible AMS year</th>
                  <td>
                    {referenceYearSelection.eligibleYearCount
                      ? referenceYearSelection.lastEligibleYear
                      : "After an observed record is loaded"}
                  </td>
                  <td>
                    Evaluates conditions at the latest year supported by an
                    eligible annual maximum
                  </td>
                  <td>More sensitive to slope uncertainty than the centre</td>
                </tr>
                <tr>
                  <th>Custom year inside AMS span</th>
                  <td>
                    {referenceYearSelection.eligibleYearCount
                      ? `${referenceYearSelection.firstEligibleYear}–${referenceYearSelection.lastEligibleYear}`
                      : "After an observed record is loaded"}
                  </td>
                  <td>Interpolation of the implemented time relationship</td>
                  <td>Still conditional on the assumed linear model</td>
                </tr>
                <tr>
                  <th>Custom year outside AMS span</th>
                  <td>Use only for a stated planning horizon</td>
                  <td>Extrapolation beyond the data</td>
                  <td>Not a climate projection; uncertainty grows rapidly</td>
                </tr>
                <tr>
                  <th>CMIP6 period midpoint</th>
                  <td>{cmipMidpoint}</td>
                  <td>Label for the selected 20-year time slice</td>
                  <td>
                    Not a single-year observation or a fitted reference year
                  </td>
                </tr>
                <tr>
                  <th>Matched covariate evaluation</th>
                  <td>
                    {selectedAnnualCovariate
                      ? `${selectedAnnualCovariate.label} = ${covariateEvaluationValue.toFixed(3)} ${selectedAnnualCovariate.units}`
                      : "Requires a retrieved or uploaded annual covariate series"}
                  </td>
                  <td>
                    Conditional return level at the selected mean, latest or
                    custom annual covariate value
                  </td>
                  <td>
                    The coefficient is fitted from matched annual data and
                    reported with a 95% moving-block bootstrap interval
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="report-note">
            <strong>Reference-year rule.</strong> The software default is
            calculated automatically as ȳ=Σyᵢ/n using only eligible
            annual-maxima years. Centering is a regression re-parameterization:
            it makes μ₀ the fitted location at the centre of the observed time
            covariate without changing μ₁ or the fitted trend. Cheng and
            AghaKouchak (2014) and Sarhadi and Soulis (2017) formulate GEV
            parameters as functions of time; Agilan and Umamahesh (2017, 2018)
            emphasize covariate choice and uncertainty. Literature does not
            prescribe one universal future reference year. A latest or custom
            year is therefore an evaluation choice, and a year outside the
            eligible AMS span is explicitly classified as extrapolation rather
            than a climate projection.
          </p>
          {!!onlineCovariateMetadata.length && (
            <>
              <h3>4.4 Online annual-covariate provenance</h3>
              <p>
                The following series were retrieved from documented providers.
                They are aligned to eligible annual-maxima years before model
                comparison. Retrieval does not establish causation, remove
                provider bias or replace the physical-mechanism requirement.
              </p>
              <div className="report-table-wrap">
                <table>
                  <caption>
                    Table 4-4. Online covariate sources, processing and limits
                  </caption>
                  <thead>
                    <tr>
                      <th>Dataset and provider</th>
                      <th>Spatial basis</th>
                      <th>Annual coverage</th>
                      <th>Limitation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {onlineCovariateMetadata.map((row) => (
                      <tr key={`report-${row.source}`}>
                        <td>
                          <strong>{row.dataset}</strong>
                          <br />
                          {row.provider} · {row.retrievalService}
                        </td>
                        <td>
                          {row.spatialScope}. {row.spatialMethod}
                        </td>
                        <td>
                          {row.returnedStartYear}–{row.returnedEndYear} · {row.acceptedAnnualValues} accepted years
                          <br />
                          {row.completenessRule}
                        </td>
                        <td>{row.limitations}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {sourceTab === "cmip6" && (
            <>
              <h3>4.3 CMIP6 projection workflow</h3>
              <ol className="methodology-steps">
                <li>
                  <strong>Acquire and identify.</strong> Retrieve daily
                  precipitation (<code>pr</code>) for the selected GCM, ensemble
                  member, historical experiment and SSP experiment; retain
                  dataset version, grid, calendar and checksum metadata.
                </li>
                <li>
                  <strong>Convert and aggregate.</strong> Convert precipitation
                  flux to daily depth using the model calendar and units. For a
                  CF <code>365_day</code>/<code>noleap</code> calendar, preserve
                  the model year and month/day without inserting 29 February;
                  use the selected project grid cell for local design. District
                  means remain spatial screening series.
                </li>
                <li>
                  <strong>Evaluate and bias-adjust.</strong> Compare historical
                  1985–2014 simulations with at least 20 overlapping years of
                  quality-controlled gauge data, or explicitly labelled ERA5
                  reanalysis when gauge coverage is inadequate. Apply
                  multiplicative QDM independently in each calendar month to
                  the future daily record before extracting extremes.
                </li>
                <li>
                  <strong>Fit model-specific extremes.</strong> Fit every model
                  separately and calculate 2- to 500-year return levels; flag
                  250- and 500-year values as extreme extrapolations for short
                  time slices.
                </li>
                <li>
                  <strong>Summarize the ensemble.</strong> Report the median and
                  inter-model range from model-specific return levels without
                  pooling model-years.
                </li>
                <li>
                  <strong>Downscale duration.</strong> Treat daily CMIP6 output
                  as support for 24-hour precipitation only; validate any
                  sub-daily downscaling independently.
                </li>
              </ol>
              <p className="report-note">
                <strong>Current implementation.</strong> The complete 35-entry
                NASA v2 catalogue is selectable for any verified Pakistan
                point. The established 10-model Pakistan set is highlighted;
                each model is retrieved, daily-QDM corrected and fitted
                separately. Stored models are isolated by coordinates, SSP,
                period, reference and fitting method before the median and
                P10–P90 inter-model range are calculated.
              </p>
            </>
          )}
          <h3>
            {sourceTab === "cmip6" ? "4.4" : "4.3"} Calculation sequence and
            model definitions
          </h3>
          <ol className="methodology-steps">
            <li>
              <strong>Ingestion and QC.</strong> Parse the selected native
              timestamp and precipitation columns; apply the custom date range;
              retain one record per day or hour; reject non-numeric or negative
              precipitation; and inventory missing, duplicate and invalid
              records.
            </li>
            <li>
              <strong>Annual-maxima series.</strong> Retain each calendar year
              with at least 90% coverage at the selected native interval. Daily
              input yields one-day maxima; hourly input yields rolling maxima
              for each supported 1- to 24-hour duration. The software requires
              at least 8 eligible maxima for fitting and at least 30 before
              issuing a diagnostic preference based on the lowest RMSE.
            </li>
            <li>
              <strong>Stationarity assessment.</strong> Apply the two-sided
              Mann–Kendall monotonic-trend test at α=0.05 and estimate Sen’s
              median slope (Mann, 1945). Lag-1 correlation is reported as an
              independence diagnostic; the p-value is not adjusted for serial
              correlation.
            </li>
            <li>
              <strong>Stationary probability distributions.</strong> Fit six
              alternatives to the same annual-maxima sample: GEV by L-moments;
              Gumbel EV1 by sample moments; two-parameter Lognormal in
              natural-log space; two-parameter Gamma from the sample mean and
              variance; two-parameter Weibull from the sample coefficient of
              variation; and Log-Pearson III in base-10 log space. LP3 is an
              implemented comparison, not a claim of full Bulletin 17C
              compliance. Quantiles are compared at Gringorten plotting
              positions using RMSE on the 24-hour depth scale. Sherman is
              excluded from this distribution ranking because it is an IDF
              equation, not a probability model.
            </li>
            <li>
              <strong>Sherman representation.</strong> Regress GEV return levels
              into a constrained power law in return period and duration with
              b=0. The Sherman curve is therefore a compact representation of
              the GEV-based IDF surface, not an independent probability
              distribution.
            </li>
            <li>
              <strong>Duration and intensity conversion.</strong> For daily
              input, preserve 24 hours as the observation-supported duration and
              derive shorter durations with the selected power exponent. For
              hourly input, fit each rolling 1-, 2-, 3-, 6-, 12- and 24-hour
              annual-maxima series separately; derive only the 5-, 10-, 15- and
              30-minute depths from the 1-hour fit. Divide depth by duration in
              hours to obtain mm/hour.
            </li>
            <li>
              <strong>Uncertainty.</strong> At every fitted duration, resample
              the eligible annual-maxima series 200 times with replacement and
              report the 2.5th and 97.5th percentiles. These intervals describe
              sampling variability conditional on the selected distribution and
              duration-support rule.
            </li>
            <li>
              <strong>Reference-year calculation.</strong> Calculate ȳ=Σyᵢ/n
              from the years that survive annual completeness screening. Use ȳ
              by default, the last eligible yᵢ for the latest-supported option,
              or a declared custom year. Classify custom values outside
              min(yᵢ)–max(yᵢ) as extrapolation.
            </li>
            <li>
              <strong>Time-varying GEV.</strong> Fit stationary and
              nonstationary GEV models by maximum likelihood to the same annual
              maxima. The nonstationary model uses μ(y)=μ₀+μ₁(y−ȳ) with constant
              scale and shape; compare models using AICc and report conditional
              return levels at the calculated or selected reference year with
              paired-bootstrap intervals.
            </li>
            <li>
              <strong>Covariate comparison.</strong> Match annual ENSO,
              temperature, moisture, urbanization or another physically
              justified series to the same eligible annual maxima. Fit a GEV
              location coefficient for each candidate, compare AICc on the
              common years, examine probability-integral-transform residuals,
              quantify the coefficient with a 95% moving-block bootstrap, and
              evaluate the chronologically held-out final 25% of years using
              mean negative log-likelihood. Correlation is not used to rank or
              select a model.
            </li>
          </ol>
          <h3>{sourceTab === "cmip6" ? "4.5" : "4.4"} Interpretation rule</h3>
          <p className="report-note">
            <strong>Interpretation boundary.</strong>{" "}
            {sourceTab === "observed"
              ? observedResolution === "hourly"
                ? `Rolling 1-, 2-, 3-, 6-, 12- and 24-hour values are directly supported by the uploaded hourly series. The 5- to 30-minute values use P(t)=P(1h)(t/1h)^${exponent.toFixed(2)} and remain derived.`
                : `Only the 24-hour values are directly supported by the uploaded daily series. Durations below 24 hours use P(t)=P(24h)(t/24h)^${exponent.toFixed(2)} and are derived estimates, not observed sub-daily extremes.`
              : sourceTab === "cmip6"
              ? cmipImportedReady && cmipImportedWorkbook
                ? `The imported workbook supplies model-specific, bias-corrected 24-hour GEV return levels for ${cmipImportedWorkbook.locationName}, ${CMIP6_SCENARIOS[cmipScenario].label} and ${cmipPeriod}. The Atlas independently checks coordinates, scenario/period labels, depth-to-intensity conversion, monotonicity, shared return periods and ensemble reconciliation, then reports the model median with P10–P90 spread. It does not infer daily precipitation, sampling-confidence limits or sub-daily curves from the summary values.`
              : cmipDataReady
                ? cmipQdmReady
                  ? `Every future daily precipitation value for ${cmipModel}, ${CMIP6_SCENARIOS[cmipScenario].label}, ${cmipMetadata?.member ?? "member not reported"} and ${cmipPeriod} is bias-corrected by calendar-month multiplicative QDM using the 1985–2014 historical GCM and ${cmipReferenceLabel}. Annual maxima and the active ${modelTab} 24-hour GEV are fitted after correction. ${useEra5BiasReference ? "This is reanalysis-corrected, not gauge-corrected." : "This is gauge-corrected."} Sub-daily values are shown only when observed hourly duration ratios are available.`
                  : `The fitted values use the retrieved NASA NEX-GDDP-CMIP6 daily precipitation for ${cmipModel}, ${CMIP6_SCENARIOS[cmipScenario].label}, ${cmipMetadata?.member ?? "member not reported"} and ${cmipPeriod}. Bias correction has not yet been applied; retrieve the historical GCM and selected reference before design use.`
                : `NASA NEX-GDDP-CMIP6 is selected for ${cmipModel}, ${CMIP6_SCENARIOS[cmipScenario].label} and ${cmipPeriod}, but no daily precipitation has been retrieved or fitted.`
                : onlineReady && onlineResolution === "hourly"
                  ? `The rolling 1-, 2-, 3-, 6-, 12- and 24-hour frequency estimates are fitted independently to native hourly ${onlineMetadata?.dataset} values. The 5- to 30-minute values use P(t)=P(1h)(t/1h)^${exponent.toFixed(2)} and remain derived.`
                  : onlineReady
                    ? `The 24-hour frequency estimates are fitted to the retrieved ${onlineMetadata?.dataset} daily series. Durations below 24 hours use P(t)=P(24h)(t/24h)^${exponent.toFixed(2)} and are derived estimates, not provider-observed sub-daily extremes.`
                    : "No online IDF values are displayed until the provider series is retrieved."}
          </p>
        </section>

        <section id="report-results" className="report-section section-break">
          <h2>
            <span>5.0</span> Results and diagnostics
          </h2>
          <h3>5.1 How to read these results</h3>
          <p>
            The report separates measured input from calculated output so the
            reader can see what the data actually support. A fitted IDF value is
            always a model estimate; the key distinction is whether its storm
            duration is supported by the uploaded interval or derived from a
            coarser interval.
          </p>
          <div className="report-table-wrap">
            <table>
              <caption>Table 5-1. Result status and appropriate use</caption>
              <thead>
                <tr>
                  <th>Result type</th>
                  <th>What it means here</th>
                  <th>How it may be used</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Supported duration</th>
                  <td>
                    {activeNativeHourly
                      ? "The native hourly series supports rolling 1-, 2-, 3-, 6-, 12- and 24-hour annual maxima."
                      : sourceTab === "observed"
                        ? "The uploaded daily series supports 24-hour annual maxima."
                        : sourceTab === "cmip6" && cmipImportedReady
                          ? "The imported, model-specific GEV curves support only the reported 24-hour return levels."
                        : sourceTab === "cmip6" && cmipDataReady
                          ? "The retrieved daily GCM series supports fitted 24-hour annual maxima."
                        : sourceTab === "online" && onlineReady
                          ? "The retrieved online daily series supports 24-hour annual maxima."
                          : "No fitted provider rainfall is available for this configuration."}
                  </td>
                  <td>
                    {sourceTab === "cmip6"
                      ? cmipImportedReady
                        ? "Use as climate-screening evidence only, with the workbook caveats, local gauge validation and independent engineering review."
                      : cmipDataReady
                        ? "Use only after historical-model evaluation, local gauge bias assessment, multi-model comparison and independent review."
                        : "Retrieve and fit model precipitation before interpreting the result."
                      : "Proceed to technical review subject to data-source bias, quality checks, model assumptions and uncertainty."}
                  </td>
                </tr>
                <tr>
                  <th>Derived duration</th>
                  <td>
                    {activeNativeHourly
                      ? `The 5- to 30-minute values are calculated from the one-hour fit with exponent ${exponent.toFixed(2)}.`
                      : `Values below 24 hours are calculated from the 24-hour fit with exponent ${exponent.toFixed(2)}.`}
                  </td>
                  <td>
                    Use only when the scaling equation is acceptable for the
                    project and its added uncertainty is acknowledged.
                  </td>
                </tr>
                <tr>
                  <th>Rare return period</th>
                  <td>
                    The 250- and 500-year values are tail extrapolations from
                    the fitted distribution, not storms observed every 250 or
                    500 years.
                  </td>
                  <td>
                    Use only as a high-consequence sensitivity check with method
                    comparison and independent review.
                  </td>
                </tr>
                <tr>
                  <th>Online or climate status</th>
                  <td>
                    {sourceTab === "cmip6"
                      ? cmipImportedReady && cmipImportedWorkbook
                        ? `${cmipImportedModels.length} model-specific bias-corrected 24-hour GEV curves were imported for ${cmipImportedWorkbook.locationName}. The displayed bounds are the P10 and P90 across models; validation status is ${cmipImportedWorkbook.validationStatus}.`
                      : cmipDataReady && cmipMetadata
                        ? `${cmipMetadata.acceptedRecords.toLocaleString()} daily ${cmipMetadata.variable} values were retrieved from ${cmipMetadata.dataset} and fitted for ${cmipMetadata.model}, ${CMIP6_SCENARIOS[cmipScenario].label}, ${cmipMetadata.member}, ${cmipPeriod}.`
                        : "The model, scenario and period are selected, but GCM rainfall values have not been retrieved or fitted."
                      : sourceTab === "online"
                        ? onlineReady && onlineMetadata
                          ? `${onlineMetadata.acceptedRecords.toLocaleString()} provider ${onlineMetadata.temporalResolution} values were retrieved and fitted; ${onlineMetadata.spatialMethod}.`
                          : `The product is selected, but its ${onlineResolution} series has not been retrieved.`
                        : "Not applicable to the uploaded gauge result."}
                  </td>
                  <td>
                    {sourceTab === "cmip6"
                      ? cmipImportedReady
                        ? "Bias-corrected multi-model climate-screening result; not an unreviewed final design value."
                      : cmipDataReady
                        ? "GCM-derived projection result; not a design value until the stated validation and ensemble steps are completed."
                        : "No GCM-derived result is available."
                      : sourceTab === "online"
                        ? "Compare with local gauges and obtain independent review before design use."
                        : "Not applicable."}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <h3>5.2 Selected IDF result</h3>
          <p>
            {results.length
              ? `For ${sourceTab === "observed" ? name : spatialLabel}, the selected curve family reports rainfall intensity for 2-, 5-, 10-, 25-, 50-, 100-, 250- and 500-year return periods. The estimated 100-year, 24-hour intensity is ${selected100?.intensityMmHr.toFixed(2) ?? "—"} mm/hour. The estimated 250- and 500-year values are ${selected250?.intensityMmHr.toFixed(2) ?? "—"} and ${selected500?.intensityMmHr.toFixed(2) ?? "—"} mm/hour. These last two values are model extrapolations and not observed storm magnitudes.`
              : "No IDF result is available for the active inputs."}
          </p>
          {shown.some((r) => r.durationMinutes <= 1440) && (
            <figure className="report-chart">
              <IdfChart
                rows={shown}
                axis={axis}
                svgId="report-idf-svg"
                equationFit={idfEquation}
                timeOfConcentrationMinutes={timeOfConcentrationMinutes}
                designReturnPeriod={designReturnPeriod}
                designIntensity={designIntensity}
              />
              <figcaption>
                <strong>Figure 5-1.</strong> IDF curves for{" "}
                {sourceTab === "observed" ? name : spatialLabel}, based on{" "}
                {sourceLabel} and{" "}
                {activeFrequencyMethodLabel}
                .{" "}
                {sourceTab === "cmip6"
                  ? cmipImportedReady
                    ? "The plotted curve is the median of model-specific, bias-corrected 24-hour GEV return levels; the band is the inter-model P10–P90 spread."
                  : cmipDataReady
                    ? `The curve is fitted from the retrieved ${cmipModel} daily precipitation series${modelTab === "nonstationary" ? ` and evaluated at ${referenceYear}` : ""}.`
                    : "No GCM curve is plotted until precipitation is retrieved."
                  : modelTab === "nonstationary"
                    ? `The curve is conditional on ${covariateLabel.toLowerCase()}.`
                    : "The fitted distribution is stationary."}{" "}
                Duration is shown in minutes and intensity in mm/hour.
                {idfEquation
                  ? ` The chart equation is ${formatShermanEquation(idfEquation)} (log-space R²=${idfEquation.rSquared.toFixed(3)}).`
                  : " A chart equation is not reported because fewer than two storm durations are available."}
              </figcaption>
            </figure>
          )}
          {timeOfConcentrationMinutes != null && (
            <p className="report-note">
              <strong>Time-of-concentration design lookup.</strong>{" "}
              {timeOfConcentrationMode === "kirpich"
                ? `Using the metric Kirpich equation with L=${effectiveFlowPathLengthMetres.toFixed(2)} m and S=${(effectiveCatchmentSlopeMPerM * 100).toFixed(3)}%${flowGeometryMode === "manual" ? " from manual geometry" : ` from ${watershedGeometryResult?.pathSource ?? "the automatic geometry workflow"} using the ${watershedSlopeMethod === "10-85" ? "10–85%" : "endpoint"} slope`}, t₍c₎=${timeOfConcentrationMinutes.toFixed(2)} minutes.`
                : `The project-supplied time of concentration is ${timeOfConcentrationMinutes.toFixed(2)} minutes.`}{" "}
              {designIntensity != null && designRainfallDepth != null
                ? `For T=${designReturnPeriod} years, the displayed IDF equation gives i=${designIntensity.toFixed(2)} mm/hour and P=${designRainfallDepth.toFixed(2)} mm over t₍c₎.`
                : "The value is outside the supported 5–1440 minute range or a multi-duration chart equation is unavailable."}
            </p>
          )}
          {selected24h.length > 0 && (
            <div className="report-table-wrap">
              <table className="report-idf-table">
                <caption>
                  Table 5-2. Selected-method 24-hour intensity and uncertainty
                  (mm/hour)
                </caption>
                <thead>
                  <tr>
                    <th>Return period</th>
                    <th>Intensity</th>
                    <th>Lower</th>
                    <th>Upper</th>
                    <th>Interval interpretation</th>
                  </tr>
                </thead>
                <tbody>
                  {selected24h.map((r) => (
                    <tr key={r.returnPeriodYears}>
                      <th>{r.returnPeriodYears}-year</th>
                      <td>{r.intensityMmHr.toFixed(2)}</td>
                      <td>{r.ciLower.toFixed(2)}</td>
                      <td>{r.ciUpper.toFixed(2)}</td>
                      <td>
                        {sourceTab === "cmip6"
                          ? cmipImportedReady
                            ? "P10–P90 spread across model-specific corrected return levels"
                            : "95% bootstrap on the fitted GCM annual-maxima sample"
                          : "95% nonparametric bootstrap interval"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>5.3 Method comparison</h3>
          {results.length > 0 && (
            <div className="report-table-wrap">
              <table className="report-idf-table">
                <caption>
                  {cmipImportedReady
                    ? "Table 5-3. Imported GEV ensemble at 24 hours (mm/hour)"
                    : "Table 5-3. Comparison of six fitted probability distributions and the Sherman IDF equation at 24 hours (mm/hour)"}
                </caption>
                <thead>
                  <tr>
                    <th>Method</th>
                    {PERIODS.map((T) => (
                      <th key={T}>{T}-year</th>
                    ))}
                    <th>Fit check</th>
                  </tr>
                </thead>
                <tbody>
                  {(cmipImportedReady ? (["gev"] as Method[]) : ALL_METHODS).map((m) => {
                    const d = activeDiagnostics.find((x) => x.method === m);
                    return (
                      <tr key={m}>
                        <th>{METHOD_LABEL[m]}</th>
                        {PERIODS.map((T) => (
                          <td key={T}>
                            {results
                              .find(
                                (r) =>
                                  r.method === m &&
                                  r.durationMinutes === 1440 &&
                                  r.returnPeriodYears === T,
                              )
                              ?.intensityMmHr.toFixed(2) ?? "—"}
                          </td>
                        ))}
                        <td>
                          {sourceTab !== "cmip6"
                            ? Number.isFinite(d?.rmseMm)
                              ? `RMSE ${d?.rmseMm} mm; normalized RMSE ${d?.nrmsePercent}%`
                              : "Not fitted"
                            : cmipImportedReady
                              ? `${cmipImportedModels.length}-model imported ensemble`
                            : cmipDataReady
                              ? "Retrieved GCM fit"
                              : "No GCM series retrieved"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <h3>5.4 Stationarity and goodness-of-fit diagnostics</h3>
          {sourceTab !== "cmip6" ? (
            <>
              <div className="report-table-wrap">
                <table>
                  <caption>
                    Table 5-4. 24-hour annual-maxima stationarity assessment
                  </caption>
                  <tbody>
                    <tr>
                      <th>Eligible years</th>
                      <td>{activeStationarity.n}</td>
                      <th>Status</th>
                      <td>{activeStationarity.status}</td>
                    </tr>
                    <tr>
                      <th>Mann–Kendall S</th>
                      <td>{activeStationarity.s}</td>
                      <th>Standardized Z</th>
                      <td>{activeStationarity.z.toFixed(3)}</td>
                    </tr>
                    <tr>
                      <th>Two-sided p-value</th>
                      <td>
                        {Number.isFinite(activeStationarity.pValue)
                          ? activeStationarity.pValue.toFixed(4)
                          : "—"}
                      </td>
                      <th>Decision at α=0.05</th>
                      <td>
                        {Number.isFinite(activeStationarity.pValue)
                          ? activeStationarity.pValue < 0.05
                            ? "Reject no-trend null"
                            : "Do not reject no-trend null"
                          : "Not estimable"}
                      </td>
                    </tr>
                    <tr>
                      <th>Sen slope</th>
                      <td>
                        {Number.isFinite(activeStationarity.senSlopeMmPerYear)
                          ? `${activeStationarity.senSlopeMmPerYear.toFixed(3)} mm/year`
                          : "—"}
                      </td>
                      <th>Normalized slope</th>
                      <td>
                        {Number.isFinite(
                          activeStationarity.senSlopePercentPerYear,
                        )
                          ? `${activeStationarity.senSlopePercentPerYear.toFixed(3)}%/year`
                          : "—"}
                      </td>
                    </tr>
                    <tr>
                      <th>Lag-1 correlation</th>
                      <td>
                        {Number.isFinite(activeStationarity.lag1)
                          ? activeStationarity.lag1.toFixed(3)
                          : "—"}
                      </td>
                      <th>Serial adjustment</th>
                      <td>Not applied</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="report-table-wrap">
                <table>
                  <caption>
                    Table 5-5. Distribution fit diagnostics for 24-hour annual
                    maxima
                  </caption>
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Sample n</th>
                      <th>RMSE (mm)</th>
                      <th>Normalized RMSE</th>
                      <th>Parameter summary</th>
                      <th>Interpretation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeDiagnostics.map((d) => (
                      <tr key={d.method}>
                        <th>{METHOD_LABEL[d.method]}</th>
                        <td>{d.n}</td>
                        <td>
                          {Number.isFinite(d.rmseMm)
                            ? d.rmseMm.toFixed(2)
                            : "—"}
                        </td>
                        <td>
                          {Number.isFinite(d.nrmsePercent)
                            ? `${d.nrmsePercent.toFixed(1)}%`
                            : "—"}
                        </td>
                        <td>{d.parameters}</td>
                        <td>
                          {d.method === recommendation
                            ? "Lowest RMSE; review with probability plots"
                            : d.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="report-table-wrap">
                <table>
                  <caption>
                    Table 5-6. Stationary, time and physically plausible
                    covariate model comparison on shared annual-maxima years
                  </caption>
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>n</th>
                      <th>AICc</th>
                      <th>ΔAICc</th>
                      <th>Akaike weight</th>
                      <th>Coefficient (95% CI)</th>
                      <th>PIT residuals</th>
                      <th>Held-out mean NLL</th>
                      <th>Selection evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {covariateComparison.rows.map((row) => (
                      <tr key={`report-${row.modelId}`}>
                        <th>{row.label}</th>
                        <td>{row.n}</td>
                        <td>{row.aicc.toFixed(2)}</td>
                        <td>{row.deltaAicc.toFixed(2)}</td>
                        <td>{row.akaikeWeight.toFixed(3)}</td>
                        <td>
                          {row.modelId === "stationary"
                            ? "Not applicable"
                            : `${row.locationSlopePerUnit.toFixed(5)} (${row.slopeCiLower.toFixed(5)}, ${row.slopeCiUpper.toFixed(5)}) mm/${row.units}`}
                        </td>
                        <td>
                          {row.residualStatus}; KS D={row.pitKsD.toFixed(3)};
                          lag-1={row.residualLag1.toFixed(3)}
                        </td>
                        <td>
                          {Number.isFinite(row.holdoutMeanNll)
                            ? row.holdoutMeanNll.toFixed(4)
                            : "Unavailable"}
                        </td>
                        <td>{row.selectionEvidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="report-note">
                <strong>Covariate decision: {covariateComparison.decision}.</strong>{" "}
                {covariateComparison.decisionReason} {covariateComparison.selectionRule}{" "}
                Correlation is not a selection criterion. Models are ranked only
                on {covariateComparison.commonYears.length} common years; excluded
                candidates and their reasons are retained in the Excel export.
              </p>
            </>
          ) : (
            <p className="report-note">
              {cmipImportedReady
                ? "Stationarity and alternative-distribution diagnostics cannot be re-created from imported summary return levels. Refer to the workbook validation and model-specific source sheets."
                : "No stationarity test or fitted goodness-of-fit statistic is reported until a matching CMIP6 precipitation series is retrieved and fitted."}
            </p>
          )}
        </section>

        <section id="report-limitations" className="report-section">
          <h2>
            <span>6.0</span> Uncertainty, limitations and robustness
          </h2>
          <div className="limitations">
            <ul>
              {sourceTab === "observed" ? (
                <>
                  <li>
                    {observedResolution === "hourly"
                      ? "Hourly input directly supports rolling 1- to 24-hour estimates when consecutive observations and annual coverage pass QC; 5- to 30-minute values remain derived."
                      : "Daily input directly supports only the 24-hour frequency estimate. Engineering-grade sub-daily IDF requires duration-specific observed maxima."}
                  </li>
                  <li>
                    Automated QC does not homogenize station moves, gauge
                    changes, observation-time changes or undocumented
                    corrections; station metadata and neighbouring-gauge
                    comparison remain necessary.
                  </li>
                  <li>
                    The Mann–Kendall test is unadjusted for serial dependence
                    and has limited power in short records. Failure to reject
                    the no-trend null is not proof of stationarity.
                  </li>
                  <li>
                    Bootstrap limits quantify sampling variability only. They
                    exclude structural model choice, duration scaling, gauge
                    undercatch, spatial aggregation and boundary uncertainty.
                  </li>
                  <li>
                    Return periods substantially longer than the eligible record
                    are extrapolations and require sensitivity testing across
                    methods and influential events.
                  </li>
                </>
              ) : sourceTab === "cmip6" ? (
                <>
                  <li>
                    {cmipImportedReady && cmipImportedWorkbook
                      ? `${cmipImportedModels.length} model-specific, bias-corrected 24-hour GEV curves were imported for ${cmipImportedWorkbook.locationName}; source-workbook status is ${cmipImportedWorkbook.validationStatus}.`
                      : cmipDataReady
                      ? `${cmipQc.records.length.toLocaleString()} daily NEX-GDDP-CMIP6 values were retrieved and fitted for the selected model, member, scenario, period and geometry.`
                      : "No NEX-GDDP-CMIP6 precipitation is fitted until the selected model, member, scenario, period and geometry have been retrieved successfully."}
                  </li>
                  <li>
                    A 20- or 30-year time slice provides limited information for 50-
                    and 100-year return levels; longer windows, nonstationary
                    fits or carefully justified regional methods require
                    sensitivity analysis.
                  </li>
                  <li>
                    {cmipImportedReady
                      ? "The P10–P90 band quantifies model spread only. Sampling, reference-tail, internal-variability, SSP, member-selection and temporal-downscaling uncertainty remain separate."
                      : "Bias adjustment, model structural uncertainty, internal variability, SSP uncertainty, ensemble-member selection and temporal downscaling are not quantified."}
                  </li>
                  <li>
                    Daily CMIP6 precipitation directly supports only 24-hour
                    accumulations. Sub-daily IDF requires validated temporal
                    downscaling or convection-permitting information.
                  </li>
                  <li>
                    The multi-model median must be calculated from
                    model-specific return levels; models and years must not be
                    pooled as independent samples.
                  </li>
                  {cmipImportedReady &&
                    cmipImportedWorkbook?.validationCaveats.map((caveat) => (
                      <li key={`report-${caveat}`}>{caveat}</li>
                    ))}
                </>
              ) : (
                <>
                  <li>
                    The retrieved gridded product is not a rain gauge. Compare
                    extremes with quality-controlled local gauges and assess
                    systematic bias before design adoption.
                  </li>
                  <li>
                    {onlineResolution === "hourly"
                      ? "Native hourly ERA5 directly supports rolling 1- to 24-hour estimates after completeness and continuity checks; 5- to 30-minute values remain derived."
                      : "Daily online input directly supports only the 24-hour estimate. All shorter durations are derived from the displayed scaling exponent and require local hourly or sub-hourly validation."}
                  </li>
                  <li>
                    {onlineMetadata?.spatialMethod ??
                      "The selected spatial method has not been completed."}
                  </li>
                  <li>
                    Provider revisions, satellite retrieval error, reanalysis
                    model error, terrain representation and spatial aggregation
                    uncertainty are not included in the bootstrap interval.
                  </li>
                  <li>
                    Return periods substantially longer than the eligible online
                    record, especially 250 and 500 years, are highly uncertain
                    tail extrapolations.
                  </li>
                </>
              )}
              <li>
                District-scale interpretation requires a documented
                point-to-polygon or grid-area aggregation rule and a verified
                administrative-boundary vintage.
              </li>
            </ul>
          </div>
          <p>
            <strong>Report status:</strong>{" "}
            {sourceTab === "cmip6"
              ? cmipImportedReady && cmipImportedWorkbook
                ? `Imported bias-corrected multi-model result · ${cmipImportedWorkbook.validationStatus}. Suitable for climate screening and research with the listed caveats; not for unreviewed final design.`
              : !cmipDataReady
                ? "No GCM precipitation has been retrieved for the active selection."
                : activeStationarity.n < 8
                  ? "The retrieved GCM series has insufficient eligible years for frequency fitting."
                  : "Model-specific GCM precipitation retrieved and fitted; provisional projection requiring historical gauge evaluation, bias assessment, multi-model comparison and independent review."
              : sourceTab === "online" && !onlineReady
                ? "No online series has been retrieved for the active selection."
                : activeStationarity.n < 8
                  ? "Insufficient eligible years for frequency fitting."
                  : activeStationarity.n < 30 ||
                      activeStationarity.pValue < 0.05
                    ? "Provisional result requiring the stated caveats, gauge comparison and independent review."
                    : "Suitable for hydrologic review with the stated limitations; not independently certified for design adoption."}
          </p>
        </section>

        <section
          id="report-conclusions"
          className="report-section section-break"
        >
          <h2>
            <span>7.0</span> Conclusions and recommendations
          </h2>
          <h3>7.1 Conclusion</h3>
          <p>
            {sourceTab === "cmip6"
              ? cmipImportedReady && cmipImportedWorkbook
                ? `The ${CMIP6_SCENARIOS[cmipScenario].label} ${cmipPeriod} ensemble for ${cmipImportedWorkbook.locationName} is integrated from ${cmipImportedModels.length} separately fitted, bias-corrected model curves. The Atlas reports the model median with P10–P90 spread at 24 hours only. The result remains ${cmipImportedWorkbook.validationStatus.toLowerCase()} and requires gauge verification and independent engineering review before design adoption.`
              : cmipDataReady
                ? `The ${CMIP6_SCENARIOS[cmipScenario].label} ${cmipPeriod} daily precipitation for ${cmipModel}, ${cmipMetadata?.member ?? "member not reported"}, was retrieved for ${spatialLabel} and fitted model-specifically. The result is GCM-derived, but independent gauge evaluation and a multi-model ensemble remain necessary before design adoption.`
                : `No ${cmipModel} precipitation series was retrieved for the ${CMIP6_SCENARIOS[cmipScenario].label} ${cmipPeriod} and ${spatialLabel} selection, so no GCM-derived IDF conclusion is issued.`
              : sourceTab === "online" && !onlineReady
                ? `No ${SOURCE_META[onlineSource].label} IDF result is available because the active point or district series has not been retrieved.`
                : activeStationarity.n < 8
                  ? `The ${sourceTab === "online" ? "retrieved online" : "uploaded"} record does not contain enough eligible annual maxima for a defensible frequency fit.`
                  : modelTab === "nonstationary" &&
                      nonstationaryCovariate === "time"
                    ? nonstationaryTime.fit.status === "Fitted"
                      ? `The fitted time-varying GEV changes location by ${nonstationaryTime.fit.locationSlopeMmPerYear.toFixed(4)} mm/year, with ΔAICc=${nonstationaryTime.fit.deltaAicc.toFixed(2)} and ${nonstationaryTime.fit.preferred.toLowerCase()} model preference. The result is evaluated at ${referenceYear}; ${referenceYearStatus.toLowerCase()}. This comparison does not establish time as a physical cause, and 250- and 500-year levels remain very uncertain extrapolations.`
                      : `The nonstationary model is not estimable with ${activeStationarity.n} eligible maxima; at least 20 are required.`
                    : modelTab === "nonstationary"
                      ? nonstationaryMatched?.fit.status === "Fitted"
                        ? `The ${nonstationaryMatched.fit.covariateLabel} GEV changes location by ${nonstationaryMatched.fit.locationSlopePerUnit.toFixed(5)} mm/${nonstationaryMatched.fit.units}. The curve is evaluated at ${covariateEvaluationValue.toFixed(3)} ${nonstationaryMatched.fit.units}; ${covariateEvaluationStatus.toLowerCase()}. The full comparison decision is ${covariateComparison.decision.toLowerCase()}. No covariate is selected from correlation.`
                        : "A matched-covariate model cannot be estimated until at least 20 annual covariate values align with eligible annual maxima."
                      : activeStationarity.n < 30
                        ? `The stationary curves are provisional because only ${activeStationarity.n} eligible annual maxima are available. Rare return periods require independent regional evidence and expert review.`
                        : activeStationarity.pValue < 0.05
                          ? "A monotonic trend is detected, challenging a time-invariant stationary model; compare the fitted time-varying GEV before adoption."
                          : `Stationarity is not rejected and ${activeStationarity.n} eligible maxima are available, but this is not proof of stationarity and rare return levels remain model-dependent.`}
          </p>
          <h3>7.2 Recommendations</h3>
          <ol>
            <li>
              Confirm station or product metadata, precipitation units, daily
              accumulation time and missing-value codes before accepting the
              record for design.
            </li>
            <li>
              Use observed 5-minute, hourly or other duration-specific annual
              maxima for sub-daily IDF. Where unavailable, label only the
              24-hour result as directly supported by the daily source.
            </li>
            <li>
              Review probability plots, residuals, extreme-event influence and
              bootstrap stability across all six fitted distributions; do not
              choose a method from RMSE alone.
            </li>
            <li>
              Preserve the online provider, product, retrieval time, requested
              geometry, grid details and returned period with every result;
              assess satellite or reanalysis bias against quality-controlled
              local gauges where available.
            </li>
            {sourceTab === "cmip6" && (
              <li>
                Process historical and SSP precipitation for each GCM
                separately; evaluate historical extremes against gauges;
                calculate model-specific return levels; and summarize model,
                scenario, internal-variability, bias-adjustment and sampling
                uncertainty without pooling models as observations.
              </li>
            )}
            <li>
              For time nonstationarity, center time near the record midpoint,
              report whether the evaluation year is interpolation or
              extrapolation, and compare the fitted model against the stationary
              alternative.
            </li>
            <li>
              For ENSO, match an annual or seasonally justified Niño 3.4/ONI
              series to each annual maximum, estimate the coefficient rather
              than assuming it, evaluate lag and season definitions, and verify
              spatially varying relationships for the selected Pakistan
              district.
            </li>
            <li>
              Compare time, ENSO and other physically plausible covariates using
              AICc, residual diagnostics, parameter uncertainty and
              out-of-sample performance; do not select a covariate from
              correlation alone.
            </li>
            <li>
              Obtain independent hydrologic and engineering review before
              applying any return level to drainage, flood-control or
              infrastructure design.
            </li>
          </ol>
        </section>

        <section
          id="report-references"
          className="report-section section-break"
        >
          <h2>
            <span>8.0</span> References
          </h2>
          <ol className="report-reference-list">
            {refs.map(([t, u], i) => (
              <li key={u}>
                <span>[{i + 1}] </span>
                <a href={u} target="_blank" rel="noreferrer">
                  {t}
                </a>
              </li>
            ))}
          </ol>
        </section>

        <section className="report-section section-break">
          <h2>Appendix A · Equations and parameter definitions</h2>
          <div className="equation-grid">
            <p>
              <strong>GEV return level</strong>
              <code>{"z_T(y)=μ(y)+(σ/ξ)[{−ln(1−1/T)}^(−ξ)−1]"}</code>
              <small>
                μ is location, σ is positive scale and ξ is shape; the Gumbel
                limit applies as ξ approaches zero.
              </small>
            </p>
            <p>
              <strong>Fitted time-varying location</strong>
              <code>{"μ(y)=μ₀+μ₁(y−ȳ)"}</code>
              <small>
                Year is centered before maximum-likelihood fitting; scale and
                shape remain constant to limit over-parameterization.
              </small>
            </p>
            <p>
              <strong>Model comparison</strong>
              <code>{"AICc=2k−2ln(L)+2k(k+1)/(n−k−1)"}</code>
              <small>
                Stationary and time-varying MLE fits use the same annual maxima;
                |ΔAICc|≤2 is treated as inconclusive.
              </small>
            </p>
            <p>
              <strong>Gumbel EV1 return level</strong>
              <code>{"z_T=μ−β ln{−ln(1−1/T)}"}</code>
              <small>μ is location and β is scale.</small>
            </p>
            <p>
              <strong>Log-Pearson III</strong>
              <code>{"log₁₀z_T=μ_log+K(T,G)σ_log"}</code>
              <small>K depends on return period T and log-space skew G.</small>
            </p>
            <p>
              <strong>Two-parameter Lognormal</strong>
              <code>{"z_T=exp[μ_ln+σ_ln Φ⁻¹(1−1/T)]"}</code>
              <small>
                μ_ln and σ_ln are the mean and sample standard deviation of
                natural-log annual maxima.
              </small>
            </p>
            <p>
              <strong>Two-parameter Gamma</strong>
              <code>{"z_T=θ G⁻¹(1−1/T;k)"}</code>
              <small>
                G⁻¹ is the unit-scale Gamma quantile; k=(x̄/s)² and θ=s²/x̄.
              </small>
            </p>
            <p>
              <strong>Two-parameter Weibull</strong>
              <code>{"z_T=λ[ln(T)]^(1/k)"}</code>
              <small>
                Shape k is solved from the sample coefficient of variation; λ is
                the scale parameter.
              </small>
            </p>
            <p>
              <strong>Sherman IDF representation</strong>
              <code>{"i(t,T)=aT^m/(t+b)^n; b=0"}</code>
              <small>
                The equation shown on the active curve is fitted in log space
                to the displayed return periods and durations. It is a compact
                chart representation; the selected probability model remains
                the source of the tabulated return levels.
              </small>
            </p>
            <p>
              <strong>Kirpich time of concentration</strong>
              <code>{"t_c=0.0195L^0.77S^(−0.385)"}</code>
              <small>
                L is the longest flow path in metres, S is average flow-path
                slope in m/m and t_c is in minutes. IDF intensity is then
                evaluated at storm duration t=t_c.
              </small>
            </p>
            <p>
              <strong>Automatic longest-path slope</strong>
              <code>{"S_L=(z_up−z_out)/L; S_10–85=(z_85−z_10)/(0.75L)"}</code>
              <small>
                MGHydro mode finds the hydraulically farthest connected path in
                its upstream river network. Upload mode follows the selected
                HEC-HMS/QGIS line. Elevations are sampled from Copernicus DEM
                GLO-90; the selected slope is passed to Kirpich.
              </small>
            </p>
            <p>
              <strong>Design rainfall at t_c</strong>
              <code>{"i_c=aT^m/(t_c+b)^n; P_c=i_c t_c/60"}</code>
              <small>
                i_c is in mm/hour and P_c is the rainfall depth in millimetres
                over the time of concentration.
              </small>
            </p>
            <p>
              <strong>Daily-to-duration scaling</strong>
              <code>{`P_t=P_24(t/24)^${exponent.toFixed(2)}`}</code>
              <small>
                Values for t&lt;24 hours are derived rather than observed.
              </small>
            </p>
            <p>
              <strong>Covariate-dependent GEV location</strong>
              <code>{"μ(x)=μ₀+μ₁[(x−x̄)/sₓ]"}</code>
              <small>
                μ₁ is fitted by maximum likelihood; the reported physical-unit
                coefficient is μ₁/sₓ with a moving-block bootstrap interval.
              </small>
            </p>
          </div>
          {sourceTab === "cmip6" && (
            <div className="equation-grid">
              <p>
                <strong>CMIP6 model-specific retrieval</strong>
                <code>{"q_T=F_GEV^{-1}(1−1/T | AMS(pr×86400))"}</code>
                <small>
                  Daily precipitation flux pr is retrieved from the selected
                  NASA NEX-GDDP-CMIP6 files, converted from kg m⁻² s⁻¹ to
                  mm/day, mapped with the reported model-calendar rule,
                  screened for annual completeness, reduced to annual maxima,
                  and fitted model-specifically. No screening multiplier enters
                  the calculation.
                </small>
              </p>
              <p>
                <strong>Production ensemble summary</strong>
                <code>{"Q_ensemble(T)=median_m{Q_m(T)}"}</code>
                <small>
                  Production results must instead fit each extracted GCM m
                  independently, then summarize model-specific return levels
                  without pooling model-years.
                </small>
              </p>
            </div>
          )}
        </section>

        <section className="report-section section-break">
          <h2>Appendix B · Complete IDF intensity matrix</h2>
          <p>
            The table reports the selected {activeFrequencyMethodLabel} curve
            family.
            Values are rainfall intensity in mm/hour.
          </p>
          {results.length > 0 ? (
            <div className="report-table-wrap">
              <table className="report-idf-table">
                <caption>
                  Table B-1. Duration by return-period intensity matrix
                  (mm/hour)
                </caption>
                <thead>
                  <tr>
                    <th>Duration</th>
                    {PERIODS.map((T) => (
                      <th key={T}>{T}-year</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reportDurations.map((d) => (
                    <tr key={d}>
                      <th>
                        {d < 60
                          ? `${d} min`
                          : d === 1440
                            ? "24 hr"
                            : `${d / 60} hr`}
                      </th>
                      {PERIODS.map((T) => (
                        <td key={T}>
                          {results
                            .find(
                              (r) =>
                                r.method === method &&
                                r.durationMinutes === d &&
                                r.returnPeriodYears === T,
                            )
                            ?.intensityMmHr.toFixed(2) ?? "—"}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="report-note">
              No IDF matrix is available for the active inputs.
            </p>
          )}
        </section>

        <section className="report-section">
          <h2>Appendix C · Assumptions and reporting controls</h2>
          <div className="report-table-wrap">
            <table>
              <caption>Table C-1. Declared analysis assumptions</caption>
              <thead>
                <tr>
                  <th>Topic</th>
                  <th>Implemented assumption</th>
                  <th>Required interpretation</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>Maximum duration</th>
                  <td>24 hours</td>
                  <td>
                    {activeNativeHourly
                      ? "Native hourly precipitation directly supports rolling 1- to 24-hour estimates."
                      : "Daily precipitation directly supports the 24-hour estimate only."}
                  </td>
                </tr>
                <tr>
                  <th>Sub-native duration</th>
                  <td>
                    Power-law depth scaling; exponent {exponent.toFixed(2)}
                  </td>
                  <td>
                    {activeNativeHourly
                      ? "Only 5- to 30-minute values are derived from the 1-hour fit."
                      : "All durations below 24 hours are derived."}
                  </td>
                </tr>
                <tr>
                  <th>Stationarity diagnostic</th>
                  <td>Two-sided Mann–Kendall test; α=0.05</td>
                  <td>
                    Diagnostic only; non-rejection is not proof of stationarity.
                  </td>
                </tr>
                <tr>
                  <th>Nonstationary tab</th>
                  <td>
                    {activeNativeHourly
                      ? "Disabled in the hourly workflow"
                      : sourceTab === "cmip6"
                        ? `Fitted GEV location trend at the ${cmipMidpoint} period midpoint; AICc preference ${nonstationaryTime.fit.preferred}`
                        : nonstationaryCovariate === "time"
                          ? `Fitted GEV location trend at ${referenceYear}; AICc preference ${nonstationaryTime.fit.preferred}`
                          : selectedAnnualCovariate
                            ? `Fitted ${selectedAnnualCovariate.label} GEV at ${covariateEvaluationValue.toFixed(3)} ${selectedAnnualCovariate.units}; ${covariateComparison.decision}`
                            : "Retrieved or uploaded matched annual covariate required"}
                  </td>
                  <td>
                    {activeNativeHourly
                      ? "Use stationary duration-specific fits; a future extension must fit nonstationarity consistently at every duration."
                      : sourceTab === "cmip6"
                        ? "Maximum-likelihood fit to retrieved GCM annual maxima with constant scale and shape; ≥20 eligible maxima"
                        : nonstationaryCovariate === "time"
                          ? "Maximum-likelihood fit with constant scale and shape; ≥20 eligible maxima"
                          : "Maximum-likelihood fit on matched common years; AICc, PIT residuals, coefficient uncertainty and chronological holdout are all required"}
                  </td>
                </tr>
                <tr>
                  <th>Reference-year status</th>
                  <td>
                    {sourceTab === "cmip6"
                      ? "CMIP6 period midpoint"
                      : referenceYearStatus}
                  </td>
                  <td>
                    The year is an evaluation point, not an additional
                    observation.
                  </td>
                </tr>
                <tr>
                  <th>Uncertainty</th>
                  <td>
                    {sourceTab === "cmip6"
                      ? modelTab === "nonstationary"
                        ? "80 moving-block bootstrap refits"
                        : "200 nonparametric bootstrap resamples"
                      : modelTab === "nonstationary"
                        ? "80 paired or moving-block bootstrap refits"
                        : "200 nonparametric bootstrap resamples"}
                  </td>
                  <td>
                    Sampling uncertainty only; model-form, provider bias and
                    covariate-choice uncertainty excluded.
                  </td>
                </tr>
                <tr>
                  <th>Rare return periods</th>
                  <td>250 and 500 years (0.4% and 0.2% AEP)</td>
                  <td>
                    Highly uncertain extrapolations, especially when record
                    length is below 50 years.
                  </td>
                </tr>
                <tr>
                  <th>District boundary</th>
                  <td>
                    {sourceTab === "observed"
                      ? "Not used for uploaded gauge analysis"
                      : boundary}
                  </td>
                  <td>
                    {sourceTab === "observed"
                      ? "No district polygon enters the observed-data calculation."
                      : sourceTab === "online"
                        ? (onlineMetadata?.spatialMethod ??
                          "No completed extraction")
                        : `Polygon match: ${matchedBoundaryName ?? "not independently verified"}.`}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {sourceTab === "cmip6" && (
            <div className="report-table-wrap">
              <table>
                <caption>
                  Table C-2. CMIP6 retrieval and projection assumptions
                </caption>
                <thead>
                  <tr>
                    <th>Topic</th>
                    <th>Selected value</th>
                    <th>Required interpretation</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th>Dataset</th>
                    <td>
                      NASA NEX-GDDP-CMIP6 v2 · {CMIP6_MODELS.length} model/grid
                      entries
                    </td>
                    <td>
                      {cmipDataReady
                        ? "Actual daily precipitation retrieved or uploaded and fitted."
                        : "No active precipitation series; IDF output remains blank."}
                    </td>
                  </tr>
                  <tr>
                    <th>Selection mode</th>
                    <td>
                      {cmipSelectionMode === "individual"
                        ? "Individual GCM model"
                        : "Multi-model ensemble summary"}
                    </td>
                    <td>
                      Individual-model results must remain separate from
                      ensemble statistics.
                    </td>
                  </tr>
                  <tr>
                    <th>GCM / ensemble</th>
                    <td>{cmipModel}</td>
                    <td>
                      {cmipDataReady
                        ? `${cmipMetadata?.member ?? "Uploaded realization"} is fitted separately.`
                        : "Choose an individual GCM and retrieve its NASA series."}
                    </td>
                  </tr>
                  <tr>
                    <th>Scenario and period</th>
                    <td>
                      {CMIP6_SCENARIOS[cmipScenario].label}; {cmipPeriod}
                    </td>
                    <td>
                      Projection horizon reaches 2100; SSPs are conditional
                      pathways, not forecasts.
                    </td>
                  </tr>
                  <tr>
                    <th>Realization</th>
                    <td>{cmipMetadata?.member ?? "not retrieved"}</td>
                    <td>
                      The archive member is recorded explicitly with the
                      model-specific result.
                    </td>
                  </tr>
                  <tr>
                    <th>Analysis sample</th>
                    <td>
                      {cmipDataReady
                        ? `${cmipQc.records.length.toLocaleString()} daily values; ${cmipStationarity.n} eligible maxima`
                        : "not retrieved"}
                    </td>
                    <td>
                      No screening multiplier is applied; the returned
                      precipitation values are fitted directly.
                    </td>
                  </tr>
                  <tr>
                    <th>Daily temporal support</th>
                    <td>24-hour precipitation</td>
                    <td>
                      Sub-daily values require validated temporal downscaling.
                    </td>
                  </tr>
                  <tr>
                    <th>Uncertainty</th>
                    <td>Not estimated</td>
                    <td>
                      Sampling, GCM, scenario, realization, bias-adjustment and
                      downscaling uncertainty must be reported separately.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="report-section section-break">
          <h2>Appendix D · Essential terms</h2>
          <p>
            Only the terms required to interpret the results are defined below.
          </p>
          <div className="report-table-wrap">
            <table className="glossary-table">
              <caption>
                Table D-1. Plain-language definitions used in this report
              </caption>
              <thead>
                <tr>
                  <th>Term</th>
                  <th>Meaning in this report</th>
                </tr>
              </thead>
              <tbody>
                {glossary.map(([term, definition]) => (
                  <tr key={term}>
                    <th>{term}</th>
                    <td>{definition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <div className="report-actions">
          <button onClick={() => window.print()}>Print / Save PDF</button>
          <button onClick={() => report("docx")}>
            Download Word report (.docx)
          </button>
          <button onClick={() => report("html")}>Download editable HTML</button>
        </div>
      </section>
      <footer>
        Pakistan IDF Atlas · Dual-source edition · Results preserve source,
        model, method, uncertainty and boundary provenance.
      </footer>
    </main>
  );
}
