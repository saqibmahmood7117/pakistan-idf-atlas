import {
  ERA5_DISTRICT_CELL_LIMIT,
  ERA5_LAND_PRECIPITATION_NOTICE,
  ERA5_MULTI_LOCATION_BATCH_SIZE,
  ERA5_REQUEST_PACING_MS,
  LIVE_SOURCE_CONFIG,
  IFS_PRECIPITATION_NOTICE,
  requirePrecipitationMillimetres,
  climateServDate,
  climateServRecords,
  mergeDailyRecords,
  mergeHourlyRecords,
  nasaPowerRecords,
  pointBufferGeometry,
  powerDistrictGrid,
  reanalysisDistrictGrid,
  splitDateRange,
  validIsoDate,
  type LiveOnlineSource,
  type OnlineExtractionMetadata,
  type OnlineExtractionMode,
  type OnlineExtractionResponse,
  type OnlineGeometry,
  type OnlineJob,
  type OnlineTemporalResolution,
  type WeightedGridPoint,
} from "../../../lib/online-precipitation";
import type { DailyRecord, HourlyRecord } from "../../../lib/observed-idf";

const CLIMATE_SERV_BASE = "https://climateserv.servirglobal.net/api";
const OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const NASA_POWER_DAILY =
  "https://power.larc.nasa.gov/api/temporal/daily/point";
const MAX_DAILY_RECORD_YEARS = 60;
const MAX_HOURLY_RECORD_YEARS = 45;

type StartRequest = {
  action: "start";
  source: LiveOnlineSource;
  resolution?: OnlineTemporalResolution;
  mode: OnlineExtractionMode;
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
};

type PollRequest = {
  action: "poll";
  source: "chirps" | "imerg" | "imergEarly";
  resolution?: "daily";
  mode: OnlineExtractionMode;
  start: string;
  end: string;
  jobs: OnlineJob[];
  latitude?: number;
  longitude?: number;
  districtName?: string;
  districtCode?: string;
  boundarySource?: string;
  boundaryVersion?: string;
  boundaryValidOn?: string;
};

function json(body: OnlineExtractionResponse, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function isSource(value: unknown): value is LiveOnlineSource {
  return (
    value === "era5" ||
    value === "ifs" ||
    value === "era5land" ||
    value === "chirps" ||
    value === "imerg" ||
    value === "imergEarly" ||
    value === "power"
  );
}

function isGeometry(value: unknown): value is OnlineGeometry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; coordinates?: unknown };
  return (candidate.type === "Polygon" || candidate.type === "MultiPolygon") && Array.isArray(candidate.coordinates);
}

function validateCommon(body: StartRequest | PollRequest) {
  if (!isSource(body.source)) throw new Error("Unsupported online precipitation source.");
  if (body.source === "era5land")
    throw new Error(ERA5_LAND_PRECIPITATION_NOTICE);
  if (body.mode !== "point" && body.mode !== "district") throw new Error("Choose point or district extraction.");
  if (!validIsoDate(body.start) || !validIsoDate(body.end) || body.start > body.end) throw new Error("Enter a valid extraction date range.");
  const resolution = body.resolution ?? "daily";
  if (resolution !== "daily" && resolution !== "hourly") throw new Error("Choose daily or hourly temporal resolution.");
  if (
    resolution === "hourly" &&
    body.source !== "era5" && body.source !== "ifs"
  ) {
    throw new Error(
      body.source === "chirps"
        ? "CHIRPS is a daily product and has no hourly series. Choose daily resolution."
        : body.source === "power"
          ? "The connected NASA POWER option uses corrected daily precipitation. Choose daily resolution."
          : "The connected IMERG service supplies daily values only. Native 30-minute IMERG requires authenticated NASA archive access, which is not connected to this site.",
    );
  }
  const years = Number(body.end.slice(0, 4)) - Number(body.start.slice(0, 4)) + 1;
  const maximumYears = resolution === "hourly" ? MAX_HOURLY_RECORD_YEARS : MAX_DAILY_RECORD_YEARS;
  if (years > maximumYears) throw new Error(`${resolution === "hourly" ? "Hourly" : "Daily"} online extraction is limited to ${maximumYears} calendar years per analysis.`);
  const firstDate = LIVE_SOURCE_CONFIG[body.source].firstDate;
  if (body.start < firstDate) throw new Error(`${LIVE_SOURCE_CONFIG[body.source].dataset} begins on ${firstDate}.`);
  if (body.mode === "point") {
    if (!Number.isFinite(body.latitude) || !Number.isFinite(body.longitude) || Number(body.latitude) < -90 || Number(body.latitude) > 90 || Number(body.longitude) < -180 || Number(body.longitude) > 180) {
      throw new Error("Point extraction requires valid latitude and longitude.");
    }
  }
}

async function providerFetch(url: string, init?: RequestInit, timeoutMs = 45_000) {
  const retryable = new Set([429, 502, 503, 504]);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) return response;
    if (!retryable.has(response.status) || attempt === 4) {
      throw new Error(`The online provider returned HTTP ${response.status}. Please try again later or shorten the date range.`);
    }
    const retryAfterSeconds = Number(response.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(12_000, retryAfterSeconds * 1000)
      : Math.min(10_000, 1000 * 2 ** attempt);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error("The online provider did not return a usable response.");
}

async function submitClimateServJob(datatype: number, geometry: OnlineGeometry, start: string, end: string) {
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
  const response = await providerFetch(`${CLIMATE_SERV_BASE}/submitDataRequest/`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: form.toString(),
  });
  const payload: unknown = await response.json();
  const id = Array.isArray(payload) ? String(payload[0] ?? "") : "";
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("ClimateSERV did not return a valid processing job.");
  return id;
}

async function startClimateServ(body: StartRequest) {
  if (!isGeometry(body.geometry) && body.mode === "district") throw new Error("The selected district polygon is not available.");
  const config =
    LIVE_SOURCE_CONFIG[
      body.source as "chirps" | "imerg" | "imergEarly"
    ];
  if (!("climateServDatatype" in config)) throw new Error("This source is not available through ClimateSERV.");
  const geometry = body.mode === "point"
    ? pointBufferGeometry(Number(body.longitude), Number(body.latitude))
    : body.geometry!;
  const chunks = splitDateRange(
    body.start,
    body.end,
    body.source === "chirps" ? 10 : 5,
  );
  const jobs: OnlineJob[] = [];
  for (const chunk of chunks) {
    const id = await submitClimateServJob(config.climateServDatatype, geometry, chunk.start, chunk.end);
    jobs.push({ id, ...chunk });
    if (chunks.length > 1)
      await new Promise((resolve) => setTimeout(resolve, 350));
  }
  return json({
    status: "processing",
    progress: 0,
    jobs,
    message: `${jobs.length} provider job${jobs.length === 1 ? "" : "s"} submitted. Daily polygon statistics are processing.`,
  });
}

async function pollClimateServ(body: PollRequest) {
  if (!Array.isArray(body.jobs) || !body.jobs.length || body.jobs.length > 16 || body.jobs.some((job) => !/^[0-9a-f-]{36}$/i.test(job.id))) {
    throw new Error("The provider job list is missing or invalid.");
  }
  const progressValues: number[] = [];
  for (const job of body.jobs) {
    const url = new URL(`${CLIMATE_SERV_BASE}/getDataRequestProgress/`);
    url.searchParams.set("id", job.id);
    const response = await providerFetch(url.toString(), undefined, 25_000);
    const payload: unknown = await response.json();
    const value = Number(Array.isArray(payload) ? payload[0] : payload);
    if (!Number.isFinite(value) || value < 0)
      throw new Error(
        "ClimateSERV reported a failed processing job. The atlas now uses shorter jobs automatically; retry once, or select IMERG Early, CHIRPS, ERA5-Land or NASA POWER.",
      );
    progressValues.push(Math.min(100, value));
  }
  const progress = Math.round(progressValues.reduce((sum, value) => sum + value, 0) / progressValues.length);
  if (progressValues.some((value) => value < 100)) {
    return json({ status: "processing", progress, jobs: body.jobs, message: `Provider processing is ${progress}% complete.` });
  }

  const recordGroups: DailyRecord[][] = [];
  for (const job of body.jobs) {
    const url = new URL(`${CLIMATE_SERV_BASE}/getDataFromRequest/`);
    url.searchParams.set("id", job.id);
    const response = await providerFetch(url.toString(), undefined, 60_000);
    recordGroups.push(climateServRecords(await response.json()));
  }
  const records = mergeDailyRecords(recordGroups);
  if (!records.length) throw new Error("The provider completed the request but returned no usable non-negative precipitation values.");
  const config = LIVE_SOURCE_CONFIG[body.source];
  const metadata: OnlineExtractionMetadata & {
    temporalResolution: "daily";
  } = {
    source: body.source,
    dataset: config.dataset,
    provider: config.provider,
    providerUrl: config.providerUrl,
    retrievalService: config.retrievalService,
    temporalResolution: "daily",
    extractionMode: body.mode,
    spatialMethod: body.mode === "district"
      ? "Daily polygon mean calculated by the ClimateSERV zonal-statistics service for the submitted district geometry"
      : "Daily ClimateSERV polygon statistic from a 0.002° square centred on the requested coordinate",
    nativeResolution: config.nativeResolution,
    requestedStart: body.start,
    requestedEnd: body.end,
    returnedStart: records[0].date,
    returnedEnd: records.at(-1)!.date,
    acceptedRecords: records.length,
    requestedLatitude: body.mode === "point" ? body.latitude : undefined,
    requestedLongitude: body.mode === "point" ? body.longitude : undefined,
    districtName: body.mode === "district" ? body.districtName : undefined,
    districtCode: body.mode === "district" ? body.districtCode : undefined,
    boundarySource: body.mode === "district" ? body.boundarySource : undefined,
    boundaryVersion: body.mode === "district" ? body.boundaryVersion : undefined,
    boundaryValidOn: body.mode === "district" ? body.boundaryValidOn : undefined,
    providerJobs: body.jobs.length,
    retrievedAt: new Date().toISOString(),
  };
  return json({ status: "complete", progress: 100, records, metadata });
}

type OpenMeteoPayload = {
  hourly_units?: { precipitation?: string };
  daily_units?: { precipitation_sum?: string };
  latitude?: number;
  longitude?: number;
  daily?: { time?: string[]; precipitation_sum?: Array<number | null> };
  hourly?: { time?: string[]; precipitation?: Array<number | null> };
};

async function fetchOpenMeteoBatch(
  points: WeightedGridPoint[],
  start: string,
  end: string,
  resolution: OnlineTemporalResolution,
  model: "era5" | "era5_land" | "ecmwf_ifs",
) {
  const url = new URL(OPEN_METEO_ARCHIVE);
  url.searchParams.set("latitude", points.map((point) => point.latitude.toFixed(4)).join(","));
  url.searchParams.set("longitude", points.map((point) => point.longitude.toFixed(4)).join(","));
  url.searchParams.set("start_date", start);
  url.searchParams.set("end_date", end);
  if (resolution === "hourly") url.searchParams.set("hourly", "precipitation");
  else url.searchParams.set("daily", "precipitation_sum");
  url.searchParams.set("models", model);
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("cell_selection", "nearest");
  const response = await providerFetch(url.toString(), undefined, 90_000);
  const payload: unknown = await response.json();
  const locations = (Array.isArray(payload) ? payload : [payload]) as OpenMeteoPayload[];
  if (locations.length !== points.length)
    throw new Error(
      "The reanalysis provider returned an unexpected number of grid-cell series.",
    );
  if (model === "ecmwf_ifs") for (const location of locations) requirePrecipitationMillimetres(resolution === "hourly" ? location.hourly_units?.precipitation : location.daily_units?.precipitation_sum);
  return locations;
}

async function extractOpenMeteoReanalysis(body: StartRequest) {
  if (!isGeometry(body.geometry) && body.mode === "district") throw new Error("The selected district polygon is not available.");
  const source = body.source as "era5" | "era5land" | "ifs";
  const config = LIVE_SOURCE_CONFIG[source];
  const resolution = body.resolution ?? "daily";
  const districtGrid =
    body.mode === "district"
      ? reanalysisDistrictGrid(
          source,
          body.geometry!,
          ERA5_DISTRICT_CELL_LIMIT[resolution],
        )
      : null;
  const points: WeightedGridPoint[] = districtGrid?.points ?? [{ latitude: Number(body.latitude), longitude: Number(body.longitude), weight: 1 }];
  const dailyGroups: DailyRecord[][] = [];
  const hourlyGroups: HourlyRecord[][] = [];
  let returnedLatitude: number | undefined;
  let returnedLongitude: number | undefined;
  const chunks =
    resolution === "hourly"
      ? splitDateRange(body.start, body.end, 5)
      : splitDateRange(body.start, body.end, 20);
  const batchSize = ERA5_MULTI_LOCATION_BATCH_SIZE[resolution];
  let completedBatches = 0;
  const totalBatches = chunks.length * Math.ceil(points.length / batchSize);
  for (const chunk of chunks) {
    let times: string[] | null = null;
    let weightedSum: number[] = [];
    let validWeight: number[] = [];
    for (let offset = 0; offset < points.length; offset += batchSize) {
      const batch = points.slice(offset, offset + batchSize);
      const locations = await fetchOpenMeteoBatch(
        batch,
        chunk.start,
        chunk.end,
        resolution,
        config.openMeteoModel,
      );
      for (let index = 0; index < locations.length; index += 1) {
        const location = locations[index];
        const locationTimes = resolution === "hourly" ? location.hourly?.time ?? [] : location.daily?.time ?? [];
        const values = resolution === "hourly" ? location.hourly?.precipitation ?? [] : location.daily?.precipitation_sum ?? [];
        if (!times) {
          times = locationTimes;
          weightedSum = Array(locationTimes.length).fill(0);
          validWeight = Array(locationTimes.length).fill(0);
        }
        if (locationTimes.length !== times.length || locationTimes.some((time, item) => time !== times![item])) {
          throw new Error(`Reanalysis grid-cell series returned inconsistent ${resolution === "hourly" ? "timestamps" : "dates"}.`);
        }
        const weight = batch[index].weight;
        for (let item = 0; item < values.length; item += 1) {
          const value = values[item];
          if (Number.isFinite(value) && Number(value) >= 0 && Number(value) < 5000) {
            weightedSum[item] += Number(value) * weight;
            validWeight[item] += weight;
          }
        }
        if (body.mode === "point") {
          returnedLatitude = location.latitude;
          returnedLongitude = location.longitude;
        }
      }
      completedBatches += 1;
      if (completedBatches < totalBatches)
        await new Promise((resolve) =>
          setTimeout(resolve, ERA5_REQUEST_PACING_MS[resolution]),
        );
    }
    if (resolution === "hourly") {
      hourlyGroups.push((times ?? []).flatMap((timestamp, index) => validWeight[index] > 0 && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(timestamp)
        ? [{ timestamp, precipitationMm: weightedSum[index] / validWeight[index], qc: "online provider hourly value" }]
        : []));
    } else {
      dailyGroups.push((times ?? []).flatMap((date, index) => validWeight[index] > 0 && validIsoDate(date)
        ? [{ date, precipitationMm: weightedSum[index] / validWeight[index], qc: "online provider daily value" }]
        : []));
    }
  }
  const sourceLabel = source === "ifs" ? "ECMWF IFS archive" : source === "era5" ? "ERA5" : "ERA5-Land";
  const spatialMethod = body.mode === "point"
    ? `Nearest native ${sourceLabel} grid cell returned by the retrieval service; ${resolution} precipitation retained in UTC`
    : source === "ifs" ? `Approximate district ${resolution} mean from ${points.length} representative 0.1° request-mesh points mapped to nearest IFS cells; request-mesh polygon overlap weights are approximate, not exact native-grid area weights` : `Overlap-weighted district ${resolution} series approximated from ${points.length} spatially representative ${sourceLabel} cells; polygon overlap fractions estimated on a 5×5 sub-grid per candidate cell`;
  const metadataBase = {
    source,
    sourceCaveat: source === "ifs" ? IFS_PRECIPITATION_NOTICE : undefined,
    dataset:
      resolution === "hourly"
        ? `${sourceLabel} hourly precipitation`
        : `${sourceLabel} daily precipitation`,
    provider: config.provider,
    providerUrl: config.providerUrl,
    retrievalService: config.retrievalService,
    extractionMode: body.mode,
    spatialMethod,
    nativeResolution:
      resolution === "hourly"
        ? `${config.nativeResolution}; hourly precipitation totals`
        : `${config.nativeResolution}; hourly precipitation aggregated by the provider to daily totals`,
    requestedStart: body.start,
    requestedEnd: body.end,
    requestedLatitude: body.mode === "point" ? body.latitude : undefined,
    requestedLongitude: body.mode === "point" ? body.longitude : undefined,
    districtName: body.mode === "district" ? body.districtName : undefined,
    districtCode: body.mode === "district" ? body.districtCode : undefined,
    boundarySource: body.mode === "district" ? body.boundarySource : undefined,
    boundaryVersion: body.mode === "district" ? body.boundaryVersion : undefined,
    boundaryValidOn: body.mode === "district" ? body.boundaryValidOn : undefined,
    returnedLatitude,
    returnedLongitude,
    candidateGridCells: districtGrid?.candidateCount,
    extractedGridCells: points.length,
    gridSamplingLimited: districtGrid?.limited,
    retrievedAt: new Date().toISOString(),
  };
  if (resolution === "hourly") {
    const hourlyRecords = mergeHourlyRecords(hourlyGroups);
    if (!hourlyRecords.length)
      throw new Error(
        `${sourceLabel} returned no usable hourly precipitation values for this request.`,
      );
    const metadata: OnlineExtractionMetadata & { temporalResolution: "hourly" } = {
      ...metadataBase,
      temporalResolution: "hourly",
      returnedStart: hourlyRecords[0].timestamp,
      returnedEnd: hourlyRecords.at(-1)!.timestamp,
      acceptedRecords: hourlyRecords.length,
    };
    return json({ status: "complete", progress: 100, hourlyRecords, metadata });
  }
  const records = mergeDailyRecords(dailyGroups);
  if (!records.length)
    throw new Error(
      `${sourceLabel} returned no usable daily precipitation values for this request.`,
    );
  const metadata: OnlineExtractionMetadata & { temporalResolution: "daily" } = {
    ...metadataBase,
    temporalResolution: "daily",
    returnedStart: records[0].date,
    returnedEnd: records.at(-1)!.date,
    acceptedRecords: records.length,
  };
  return json({ status: "complete", progress: 100, records, metadata });
}

type NasaPowerPayload = {
  geometry?: { coordinates?: unknown[] };
  properties?: { parameter?: Record<string, unknown> };
};

async function fetchNasaPowerPoint(
  point: WeightedGridPoint,
  start: string,
  end: string,
) {
  const url = new URL(NASA_POWER_DAILY);
  url.searchParams.set("parameters", "PRECTOTCORR");
  url.searchParams.set("community", "AG");
  url.searchParams.set("longitude", point.longitude.toFixed(4));
  url.searchParams.set("latitude", point.latitude.toFixed(4));
  url.searchParams.set("start", start.replaceAll("-", ""));
  url.searchParams.set("end", end.replaceAll("-", ""));
  url.searchParams.set("format", "JSON");
  url.searchParams.set("time-standard", "UTC");
  const response = await providerFetch(url.toString(), undefined, 90_000);
  const payload = (await response.json()) as NasaPowerPayload;
  return { payload, records: nasaPowerRecords(payload) };
}

async function extractNasaPower(body: StartRequest) {
  if (!isGeometry(body.geometry) && body.mode === "district")
    throw new Error("The selected district polygon is not available.");
  const districtGrid =
    body.mode === "district" ? powerDistrictGrid(body.geometry!, 6) : null;
  const points: WeightedGridPoint[] = districtGrid?.points ?? [
    {
      latitude: Number(body.latitude),
      longitude: Number(body.longitude),
      weight: 1,
    },
  ];
  const groups: Array<{ records: DailyRecord[]; pointIndex: number }> = [];
  let returnedLatitude: number | undefined;
  let returnedLongitude: number | undefined;
  const chunks = splitDateRange(body.start, body.end, 10);
  for (let index = 0; index < points.length; index += 1) {
    for (const chunk of chunks) {
      const { payload, records } = await fetchNasaPowerPoint(
        points[index],
        chunk.start,
        chunk.end,
      );
      groups.push({ records, pointIndex: index });
      if (body.mode === "point") {
        const coordinates = payload.geometry?.coordinates;
        if (Array.isArray(coordinates)) {
          returnedLongitude = Number(coordinates[0]);
          returnedLatitude = Number(coordinates[1]);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const dateWeights = new Map<
    string,
    { weightedSum: number; validWeight: number }
  >();
  groups.forEach(({ records, pointIndex }) => {
    const weight = points[pointIndex].weight;
    for (const record of records) {
      const current = dateWeights.get(record.date) ?? {
        weightedSum: 0,
        validWeight: 0,
      };
      current.weightedSum += record.precipitationMm * weight;
      current.validWeight += weight;
      dateWeights.set(record.date, current);
    }
  });
  const records = [...dateWeights.entries()]
    .filter(([, value]) => value.validWeight > 0)
    .map(([date, value]) => ({
      date,
      precipitationMm: value.weightedSum / value.validWeight,
      qc: "NASA POWER provider daily value",
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!records.length)
    throw new Error(
      "NASA POWER returned no usable corrected daily precipitation values for this request.",
    );

  const config = LIVE_SOURCE_CONFIG.power;
  const metadata: OnlineExtractionMetadata & {
    temporalResolution: "daily";
  } = {
    source: "power",
    dataset: config.dataset,
    provider: config.provider,
    providerUrl: config.providerUrl,
    retrievalService: config.retrievalService,
    temporalResolution: "daily",
    extractionMode: body.mode,
    spatialMethod:
      body.mode === "point"
        ? "NASA POWER point series from the returned MERRA-2 meteorological grid cell; PRECTOTCORR retained in UTC"
        : `Approximate overlap-weighted district mean from ${points.length} representative NASA POWER MERRA-2 grid cells; polygon overlap fractions estimated on a 5×5 sub-grid per candidate cell`,
    nativeResolution: config.nativeResolution,
    requestedStart: body.start,
    requestedEnd: body.end,
    returnedStart: records[0].date,
    returnedEnd: records.at(-1)!.date,
    acceptedRecords: records.length,
    requestedLatitude: body.mode === "point" ? body.latitude : undefined,
    requestedLongitude: body.mode === "point" ? body.longitude : undefined,
    districtName: body.mode === "district" ? body.districtName : undefined,
    districtCode: body.mode === "district" ? body.districtCode : undefined,
    boundarySource:
      body.mode === "district" ? body.boundarySource : undefined,
    boundaryVersion:
      body.mode === "district" ? body.boundaryVersion : undefined,
    boundaryValidOn:
      body.mode === "district" ? body.boundaryValidOn : undefined,
    returnedLatitude,
    returnedLongitude,
    candidateGridCells: districtGrid?.candidateCount,
    extractedGridCells: points.length,
    gridSamplingLimited: districtGrid?.limited,
    retrievedAt: new Date().toISOString(),
  };
  return json({ status: "complete", progress: 100, records, metadata });
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as StartRequest | PollRequest;
    validateCommon(body);
    if (body.action === "poll") {
      if (
        body.source !== "chirps" &&
        body.source !== "imerg" &&
        body.source !== "imergEarly"
      )
        throw new Error("Only asynchronous ClimateSERV jobs can be polled.");
      return await pollClimateServ(body as PollRequest);
    }
    if (body.action !== "start") throw new Error("Unsupported extraction action.");
    if (body.source === "era5" || body.source === "era5land" || body.source === "ifs")
      return await extractOpenMeteoReanalysis(body as StartRequest);
    if (body.source === "power")
      return await extractNasaPower(body as StartRequest);
    return await startClimateServ(body as StartRequest);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Online precipitation extraction failed.";
    const status = /does not provide precipitation values/i.test(message)
      ? 400
      : /provider|ClimateSERV|ERA5|fetch|network|timed/i.test(message)
        ? 502
        : 400;
    return json({ status: "error", error: message }, status);
  }
}

// Vercel request limit; availability depends on the selected hosting plan.
export const maxDuration = 300;
