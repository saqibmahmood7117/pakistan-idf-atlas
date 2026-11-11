import type { DailyRecord, HourlyRecord } from "./observed-idf";

export type LiveOnlineSource =
  | "era5"
  | "ifs"
  | "era5land"
  | "chirps"
  | "imerg"
  | "imergEarly"
  | "power";
export type OnlineGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };
export type OnlineExtractionMode = "point" | "district";
export type OnlineTemporalResolution = "daily" | "hourly";

export type OnlineJob = {
  id: string;
  start: string;
  end: string;
};

export type OnlineExtractionMetadata = {
  source: LiveOnlineSource;
  dataset: string;
  provider: string;
  providerUrl: string;
  retrievalService: string;
  temporalResolution: OnlineTemporalResolution;
  extractionMode: OnlineExtractionMode;
  spatialMethod: string;
  nativeResolution: string;
  requestedStart: string;
  requestedEnd: string;
  returnedStart: string;
  returnedEnd: string;
  acceptedRecords: number;
  requestedLatitude?: number;
  requestedLongitude?: number;
  districtName?: string;
  districtCode?: string;
  boundarySource?: string;
  boundaryVersion?: string;
  boundaryValidOn?: string;
  returnedLatitude?: number;
  returnedLongitude?: number;
  candidateGridCells?: number;
  extractedGridCells?: number;
  gridSamplingLimited?: boolean;
  providerJobs?: number;
  sourceCaveat?: string;
  retrievedAt: string;
};

export const ERA5_MULTI_LOCATION_BATCH_SIZE: Record<OnlineTemporalResolution, number> = {
  daily: 16,
  hourly: 4,
};

export const ERA5_REQUEST_PACING_MS: Record<OnlineTemporalResolution, number> = {
  daily: 250,
  hourly: 450,
};

export const ERA5_DISTRICT_CELL_LIMIT: Record<
  OnlineTemporalResolution,
  number
> = {
  daily: 4,
  hourly: 2,
};

export type OnlineExtractionResponse =
  | { status: "processing"; progress: number; jobs: OnlineJob[]; message: string }
  | { status: "complete"; progress: 100; records: DailyRecord[]; hourlyRecords?: never; metadata: OnlineExtractionMetadata & { temporalResolution: "daily" } }
  | { status: "complete"; progress: 100; records?: never; hourlyRecords: HourlyRecord[]; metadata: OnlineExtractionMetadata & { temporalResolution: "hourly" } }
  | { status: "error"; error: string };

export const LIVE_SOURCE_CONFIG = {
  era5: {
    dataset: "ERA5 reanalysis",
    provider: "Copernicus Climate Change Service / ECMWF",
    retrievalService: "Open-Meteo Historical Weather API",
    providerUrl: "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels",
    nativeResolution: "0.25° hourly reanalysis",
    firstDate: "1981-01-01",
    supportedResolutions: ["daily", "hourly"] as const,
    extractionFamily: "open-meteo" as const,
    openMeteoModel: "era5",
    latitudeResolution: 0.25,
    longitudeResolution: 0.25,
  },
  ifs: {
    dataset: "ECMWF IFS operational analysis archive",
    provider: "ECMWF · distributed by Open-Meteo",
    retrievalService: "Open-Meteo Historical Weather API · explicit ecmwf_ifs model",
    providerUrl: "https://open-meteo.com/en/docs/historical-weather-api",
    nativeResolution: "Approximately 9 km global IFS archive; hourly precipitation",
    firstDate: "2017-01-01",
    supportedResolutions: ["daily", "hourly"] as const,
    extractionFamily: "open-meteo" as const,
    openMeteoModel: "ecmwf_ifs",
    // Representative request mesh, not a claim that IFS has a regular 0.1° native grid.
    latitudeResolution: 0.1,
    longitudeResolution: 0.1,
  },
  era5land: {
    dataset: "ERA5-Land reanalysis",
    provider: "Copernicus Climate Change Service / ECMWF",
    retrievalService: "Open-Meteo Historical Weather API",
    providerUrl:
      "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land",
    nativeResolution: "0.1° hourly land-surface reanalysis",
    firstDate: "1950-01-01",
    supportedResolutions: ["daily", "hourly"] as const,
    extractionFamily: "open-meteo" as const,
    openMeteoModel: "era5_land",
    latitudeResolution: 0.1,
    longitudeResolution: 0.1,
    precipitationAvailable: false,
  },
  chirps: {
    dataset: "CHIRPS daily precipitation",
    provider: "UCSB Climate Hazards Center",
    retrievalService: "SERVIR ClimateSERV API · datatype 0",
    providerUrl: "https://www.chc.ucsb.edu/data/chirps",
    nativeResolution: "0.05° daily satellite–gauge product",
    firstDate: "1981-01-01",
    supportedResolutions: ["daily"] as const,
    extractionFamily: "climateserv" as const,
    climateServDatatype: 0,
  },
  imerg: {
    dataset: "NASA IMERG V07 Late daily precipitation",
    provider: "NASA GPM",
    retrievalService: "SERVIR ClimateSERV API · datatype 226",
    providerUrl: "https://gpm.nasa.gov/data/imerg",
    nativeResolution: "0.1° daily satellite precipitation",
    firstDate: "2000-06-01",
    supportedResolutions: ["daily"] as const,
    extractionFamily: "climateserv" as const,
    climateServDatatype: 226,
  },
  imergEarly: {
    dataset: "NASA IMERG V07 Early daily precipitation",
    provider: "NASA GPM",
    retrievalService: "SERVIR ClimateSERV API · datatype 227",
    providerUrl: "https://gpm.nasa.gov/data/imerg",
    nativeResolution: "0.1° daily near-real-time satellite precipitation",
    firstDate: "2000-06-01",
    supportedResolutions: ["daily"] as const,
    extractionFamily: "climateserv" as const,
    climateServDatatype: 227,
  },
  power: {
    dataset: "NASA POWER MERRA-2 corrected precipitation",
    provider: "NASA POWER / GMAO",
    retrievalService: "NASA POWER Daily API",
    providerUrl: "https://power.larc.nasa.gov/",
    nativeResolution: "0.5° latitude × 0.625° longitude MERRA-2 meteorology",
    firstDate: "1981-01-01",
    supportedResolutions: ["daily"] as const,
    extractionFamily: "nasa-power" as const,
    latitudeResolution: 0.5,
    longitudeResolution: 0.625,
  },
} as const;

export const IFS_PRECIPITATION_NOTICE =
  "ECMWF IFS is an operational model-analysis archive from 2017, not a homogeneous long-term reanalysis or a rain gauge. Model upgrades can affect consistency; its short record limits rare-event inference. District extraction uses a representative 0.1° request mesh mapped to nearest IFS cells, not an exact native-grid area integral. This source shares Open-Meteo quotas with ERA5.";

export function requirePrecipitationMillimetres(units: unknown) {
  if (units !== "mm") throw new Error("The precipitation provider returned missing or unsupported units; expected mm. No values were fitted.");
}

export const ERA5_LAND_PRECIPITATION_NOTICE =
  "Open-Meteo's explicit ERA5-Land model does not provide precipitation values. Select ERA5 reanalysis for hourly or daily reanalysis rainfall. ERA5-Land remains suitable for supported land-surface variables such as temperature and soil moisture.";

const DAY_MS = 86_400_000;

export function isoDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function validIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
}

export function splitDateRange(start: string, end: string, maximumCalendarYears = 20) {
  if (!validIsoDate(start) || !validIsoDate(end) || start > end) throw new Error("Enter a valid start and end date.");
  const chunks: { start: string; end: string }[] = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  const final = new Date(`${end}T00:00:00Z`);
  while (cursor <= final) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCFullYear(chunkEnd.getUTCFullYear() + maximumCalendarYears);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() - 1);
    if (chunkEnd > final) chunkEnd.setTime(final.getTime());
    chunks.push({ start: isoDate(cursor), end: isoDate(chunkEnd) });
    cursor = new Date(chunkEnd.getTime() + DAY_MS);
  }
  return chunks;
}

export function pointBufferGeometry(longitude: number, latitude: number, halfSizeDegrees = 0.001): OnlineGeometry {
  const west = longitude - halfSizeDegrees;
  const east = longitude + halfSizeDegrees;
  const south = latitude - halfSizeDegrees;
  const north = latitude + halfSizeDegrees;
  return {
    type: "Polygon",
    coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
  };
}

function pointInRing(longitude: number, latitude: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > latitude !== yj > latitude && longitude < ((xj - xi) * (latitude - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

export function pointInOnlineGeometry(longitude: number, latitude: number, geometry: OnlineGeometry) {
  const inPolygon = (polygon: number[][][]) => Boolean(
    polygon[0] && pointInRing(longitude, latitude, polygon[0]) && !polygon.slice(1).some((hole) => pointInRing(longitude, latitude, hole)),
  );
  return geometry.type === "Polygon" ? inPolygon(geometry.coordinates) : geometry.coordinates.some(inPolygon);
}

function geometryBounds(geometry: OnlineGeometry) {
  const points: number[][] = [];
  const visit = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === "number" && typeof value[1] === "number") points.push(value as number[]);
    else value.forEach(visit);
  };
  visit(geometry.coordinates);
  if (!points.length) throw new Error("The selected district has no usable polygon coordinates.");
  return {
    west: Math.min(...points.map((point) => point[0])),
    east: Math.max(...points.map((point) => point[0])),
    south: Math.min(...points.map((point) => point[1])),
    north: Math.max(...points.map((point) => point[1])),
  };
}

export type WeightedGridPoint = { latitude: number; longitude: number; weight: number };

export function regularDistrictGrid(
  geometry: OnlineGeometry,
  latitudeResolution: number,
  longitudeResolution: number,
  maximumRepresentativeCells = 48,
) {
  const halfLatitude = latitudeResolution / 2;
  const halfLongitude = longitudeResolution / 2;
  const bounds = geometryBounds(geometry);
  const westIndex = Math.floor(
    (bounds.west - halfLongitude) / longitudeResolution,
  );
  const eastIndex = Math.ceil(
    (bounds.east + halfLongitude) / longitudeResolution,
  );
  const southIndex = Math.floor(
    (bounds.south - halfLatitude) / latitudeResolution,
  );
  const northIndex = Math.ceil(
    (bounds.north + halfLatitude) / latitudeResolution,
  );
  const candidates: WeightedGridPoint[] = [];
  const samplesPerSide = 5;
  for (let latIndex = southIndex; latIndex <= northIndex; latIndex += 1) {
    const latitude = latIndex * latitudeResolution;
    for (let lonIndex = westIndex; lonIndex <= eastIndex; lonIndex += 1) {
      const longitude = lonIndex * longitudeResolution;
      let inside = 0;
      for (let row = 0; row < samplesPerSide; row += 1) {
        for (let column = 0; column < samplesPerSide; column += 1) {
          const sampleLat =
            latitude -
            halfLatitude +
            ((row + 0.5) / samplesPerSide) * latitudeResolution;
          const sampleLon =
            longitude -
            halfLongitude +
            ((column + 0.5) / samplesPerSide) * longitudeResolution;
          if (pointInOnlineGeometry(sampleLon, sampleLat, geometry)) inside += 1;
        }
      }
      if (inside) {
        const overlapFraction = inside / (samplesPerSide * samplesPerSide);
        const latitudeAreaFactor = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
        candidates.push({ latitude, longitude, weight: overlapFraction * latitudeAreaFactor });
      }
    }
  }
  if (!candidates.length) {
    const longitude = (bounds.west + bounds.east) / 2;
    const latitude = (bounds.south + bounds.north) / 2;
    candidates.push({
      latitude:
        Math.round(latitude / latitudeResolution) * latitudeResolution,
      longitude:
        Math.round(longitude / longitudeResolution) * longitudeResolution,
      weight: 1,
    });
  }
  if (candidates.length <= maximumRepresentativeCells) {
    const total = candidates.reduce((sum, point) => sum + point.weight, 0);
    return { points: candidates.map((point) => ({ ...point, weight: point.weight / total })), candidateCount: candidates.length, limited: false };
  }

  const selected: WeightedGridPoint[] = [candidates.reduce((best, point) => point.weight > best.weight ? point : best)];
  const squaredDistance = (a: WeightedGridPoint, b: WeightedGridPoint) => {
    const longitudeScale = Math.cos((((a.latitude + b.latitude) / 2) * Math.PI) / 180);
    return (a.latitude - b.latitude) ** 2 + ((a.longitude - b.longitude) * longitudeScale) ** 2;
  };
  while (selected.length < maximumRepresentativeCells) {
    let next: WeightedGridPoint | null = null;
    let bestScore = -1;
    for (const candidate of candidates) {
      if (selected.includes(candidate)) continue;
      const nearest = Math.min(...selected.map((point) => squaredDistance(candidate, point)));
      const score = nearest * Math.sqrt(candidate.weight);
      if (score > bestScore) {
        bestScore = score;
        next = candidate;
      }
    }
    if (!next) break;
    selected.push(next);
  }
  const representativeWeights = new Map(selected.map((point) => [point, 0]));
  for (const candidate of candidates) {
    const nearest = selected.reduce((best, point) => squaredDistance(candidate, point) < squaredDistance(candidate, best) ? point : best);
    representativeWeights.set(nearest, (representativeWeights.get(nearest) ?? 0) + candidate.weight);
  }
  const total = [...representativeWeights.values()].reduce((sum, weight) => sum + weight, 0);
  return {
    points: selected.map((point) => ({ ...point, weight: (representativeWeights.get(point) ?? 0) / total })),
    candidateCount: candidates.length,
    limited: true,
  };
}

export function era5DistrictGrid(
  geometry: OnlineGeometry,
  maximumRepresentativeCells = 48,
) {
  return regularDistrictGrid(geometry, 0.25, 0.25, maximumRepresentativeCells);
}

export function reanalysisDistrictGrid(
  source: "era5" | "era5land" | "ifs",
  geometry: OnlineGeometry,
  maximumRepresentativeCells = 48,
) {
  const config = LIVE_SOURCE_CONFIG[source];
  return regularDistrictGrid(
    geometry,
    config.latitudeResolution,
    config.longitudeResolution,
    maximumRepresentativeCells,
  );
}

export function powerDistrictGrid(
  geometry: OnlineGeometry,
  maximumRepresentativeCells = 8,
) {
  const config = LIVE_SOURCE_CONFIG.power;
  return regularDistrictGrid(
    geometry,
    config.latitudeResolution,
    config.longitudeResolution,
    maximumRepresentativeCells,
  );
}

export function climateServDate(value: string) {
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}

export function climateServRecords(payload: unknown) {
  const data = typeof payload === "object" && payload !== null && Array.isArray((payload as { data?: unknown }).data)
    ? (payload as { data: unknown[] }).data
    : [];
  const records: DailyRecord[] = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null) continue;
    const row = item as { year?: unknown; month?: unknown; day?: unknown; epochTime?: unknown; value?: unknown; raw_value?: unknown };
    let date = "";
    if ([row.year, row.month, row.day].every((value) => Number.isFinite(Number(value)))) {
      date = `${String(Number(row.year)).padStart(4, "0")}-${String(Number(row.month)).padStart(2, "0")}-${String(Number(row.day)).padStart(2, "0")}`;
    } else if (Number.isFinite(Number(row.epochTime))) {
      date = isoDate(new Date(Number(row.epochTime) * 1000));
    }
    const valueObject = typeof row.value === "object" && row.value !== null ? row.value as Record<string, unknown> : {};
    const value = Number(valueObject.avg ?? row.raw_value);
    if (validIsoDate(date) && Number.isFinite(value) && value >= 0 && value < 5000) records.push({ date, precipitationMm: value, qc: "online provider value" });
  }
  return records;
}

export function nasaPowerRecords(
  payload: unknown,
  parameter = "PRECTOTCORR",
) {
  if (typeof payload !== "object" || payload === null) return [];
  const parameters = (payload as { properties?: { parameter?: unknown } })
    .properties?.parameter;
  if (typeof parameters !== "object" || parameters === null) return [];
  const values = (parameters as Record<string, unknown>)[parameter];
  if (typeof values !== "object" || values === null) return [];
  const records: DailyRecord[] = [];
  for (const [key, rawValue] of Object.entries(
    values as Record<string, unknown>,
  )) {
    if (!/^\d{8}$/.test(key)) continue;
    const date = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
    const value = Number(rawValue);
    if (
      validIsoDate(date) &&
      Number.isFinite(value) &&
      value >= 0 &&
      value < 5000
    ) {
      records.push({
        date,
        precipitationMm: value,
        qc: "NASA POWER provider daily value",
      });
    }
  }
  return records.sort((a, b) => a.date.localeCompare(b.date));
}

export function mergeDailyRecords(groups: DailyRecord[][]) {
  const merged = new Map<string, DailyRecord>();
  for (const group of groups) for (const record of group) merged.set(record.date, record);
  return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function mergeHourlyRecords(groups: HourlyRecord[][]) {
  const merged = new Map<string, HourlyRecord>();
  for (const group of groups) for (const record of group) merged.set(record.timestamp, record);
  return [...merged.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export type PrecipitationPlotInterval =
  | "native"
  | "daily"
  | "monthly"
  | "annual"
  | "annual-maxima";

export type PrecipitationPlotRecord = {
  timestamp: string;
  precipitationMm: number;
};

export type PrecipitationPlotPoint = {
  timestamp: string;
  precipitationMm: number;
  sourceIntervals: number;
};

export function aggregatePrecipitationForPlot(
  records: PrecipitationPlotRecord[],
  interval: PrecipitationPlotInterval,
) {
  if (interval === "native")
    return records
      .filter(
        (record) =>
          /^\d{4}-\d{2}-\d{2}/.test(record.timestamp) &&
          Number.isFinite(record.precipitationMm) &&
          record.precipitationMm >= 0,
      )
      .map((record) => ({
        ...record,
        sourceIntervals: 1,
      }))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  if (interval === "annual-maxima") {
    const maxima = new Map<string, PrecipitationPlotPoint>();
    for (const record of records) {
      if (
        !/^\d{4}-\d{2}-\d{2}/.test(record.timestamp) ||
        !Number.isFinite(record.precipitationMm) ||
        record.precipitationMm < 0
      )
        continue;
      const year = record.timestamp.slice(0, 4);
      const current = maxima.get(year);
      if (!current || record.precipitationMm > current.precipitationMm)
        maxima.set(year, {
          timestamp: record.timestamp,
          precipitationMm: record.precipitationMm,
          sourceIntervals: 1,
        });
    }
    return [...maxima.values()].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );
  }
  const grouped = new Map<string, PrecipitationPlotPoint>();
  for (const record of records) {
    if (
      !/^\d{4}-\d{2}-\d{2}/.test(record.timestamp) ||
      !Number.isFinite(record.precipitationMm) ||
      record.precipitationMm < 0
    )
      continue;
    const key =
      interval === "daily"
        ? record.timestamp.slice(0, 10)
        : interval === "monthly"
          ? record.timestamp.slice(0, 7)
          : record.timestamp.slice(0, 4);
    const timestamp =
      interval === "daily"
        ? `${key}T00:00`
        : interval === "monthly"
          ? `${key}-01T00:00`
          : `${key}-01-01T00:00`;
    const current = grouped.get(key);
    if (current) {
      current.precipitationMm += record.precipitationMm;
      current.sourceIntervals += 1;
    } else {
      grouped.set(key, {
        timestamp,
        precipitationMm: record.precipitationMm,
        sourceIntervals: 1,
      });
    }
  }
  return [...grouped.values()].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
}

export function peakPreservingPrecipitationPlot(
  points: PrecipitationPlotPoint[],
  maximumPoints = 800,
) {
  if (points.length <= maximumPoints) return points;
  const bucketSize = Math.ceil(points.length / maximumPoints),
    reduced: PrecipitationPlotPoint[] = [];
  for (let index = 0; index < points.length; index += bucketSize) {
    const bucket = points.slice(index, index + bucketSize);
    reduced.push(
      bucket.reduce((peak, point) =>
        point.precipitationMm > peak.precipitationMm ? point : peak,
      ),
    );
  }
  return reduced;
}
