import type { AnnualCovariate } from "./observed-idf";
import type {
  OnlineExtractionMode,
  OnlineGeometry,
  OnlineJob,
} from "./online-precipitation";

export type OnlineCovariateSource =
  | "enso"
  | "temperature"
  | "moisture"
  | "urbanization";

export type OnlineCovariateMetadata = {
  source: OnlineCovariateSource;
  dataset: string;
  provider: string;
  providerUrl: string;
  retrievalService: string;
  spatialScope: string;
  spatialMethod: string;
  nativeResolution: string;
  requestedStartYear: number;
  requestedEndYear: number;
  returnedStartYear: number;
  returnedEndYear: number;
  sourceRecords: number;
  acceptedAnnualValues: number;
  completenessRule: string;
  limitations: string;
  retrievedAt: string;
};

export type OnlineCovariateResponse =
  | {
      status: "processing";
      progress: number;
      jobs: OnlineJob[];
      message: string;
    }
  | {
      status: "complete";
      progress: 100;
      covariate: AnnualCovariate;
      metadata: OnlineCovariateMetadata;
    }
  | { status: "error"; error: string };

export type OnlineCovariateRequest = {
  action: "start" | "poll";
  source: OnlineCovariateSource;
  mode: OnlineExtractionMode;
  startYear: number;
  endYear: number;
  latitude?: number;
  longitude?: number;
  geometry?: OnlineGeometry;
  jobs?: OnlineJob[];
};

export const ONLINE_COVARIATE_CONFIG = {
  enso: {
    label: "ENSO · NOAA Niño 3.4 anomaly",
    firstYear: 1950,
    provider: "NOAA Physical Sciences Laboratory / CPC",
    dataset: "Niño 3.4 SST anomaly from NOAA ERSST",
    providerUrl: "https://psl.noaa.gov/data/timeseries/month/Nino34_CPC/",
    retrievalService:
      "NOAA PSL standard monthly time-series file · nina34.anom.data",
  },
  temperature: {
    label: "Temperature · ERA5 2 m air temperature",
    firstYear: 1950,
    provider: "Copernicus Climate Change Service / ECMWF",
    dataset: "ERA5 2 m air temperature",
    providerUrl:
      "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels",
    retrievalService: "Open-Meteo Historical Weather API",
  },
  moisture: {
    label: "Moisture · LIS 0–10 cm soil moisture",
    firstYear: 2000,
    provider: "NASA Land Information System / SERVIR",
    dataset: "LIS-modeled soil moisture, 0–10 cm",
    providerUrl: "https://climateserv.servirglobal.net/develop-api",
    retrievalService: "SERVIR ClimateSERV API · datatype 664",
  },
  urbanization: {
    label: "Urbanization · Pakistan urban population share",
    firstYear: 1960,
    provider: "World Bank World Development Indicators",
    dataset: "Urban population (% of total population) · SP.URB.TOTL.IN.ZS",
    providerUrl:
      "https://data.worldbank.org/indicator/SP.URB.TOTL.IN.ZS?locations=PK",
    retrievalService: "World Bank Indicators API",
  },
} as const;

const validYear = (year: number) =>
  Number.isInteger(year) && year >= 1800 && year <= 2200;

export function validateOnlineCovariateRequest(
  request: OnlineCovariateRequest,
) {
  if (!(request.source in ONLINE_COVARIATE_CONFIG))
    throw new Error("Choose a supported online covariate source.");
  if (!validYear(request.startYear) || !validYear(request.endYear))
    throw new Error("The covariate request needs valid four-digit years.");
  if (request.startYear > request.endYear)
    throw new Error("The covariate start year must not exceed the end year.");
  if (request.endYear - request.startYear + 1 > 76)
    throw new Error("Online covariate retrieval is limited to 76 calendar years.");
  const firstYear = ONLINE_COVARIATE_CONFIG[request.source].firstYear;
  if (request.endYear < firstYear)
    throw new Error(
      `${ONLINE_COVARIATE_CONFIG[request.source].label} begins in ${firstYear}.`,
    );
  const requiresSpatialInput = request.action === "start";
  if (
    requiresSpatialInput &&
    (request.source === "temperature" || request.source === "moisture") &&
    request.mode === "point" &&
    (!Number.isFinite(request.latitude) ||
      !Number.isFinite(request.longitude) ||
      Number(request.latitude) < -90 ||
      Number(request.latitude) > 90 ||
      Number(request.longitude) < -180 ||
      Number(request.longitude) > 180)
  )
    throw new Error(
      "Point covariate retrieval requires valid latitude and longitude.",
    );
  if (
    requiresSpatialInput &&
    (request.source === "temperature" || request.source === "moisture") &&
    request.mode === "district" &&
    !isOnlineGeometry(request.geometry)
  )
    throw new Error(
      "District covariate retrieval requires the selected district polygon.",
    );
}

export function isOnlineGeometry(value: unknown): value is OnlineGeometry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; coordinates?: unknown };
  return (
    (candidate.type === "Polygon" || candidate.type === "MultiPolygon") &&
    Array.isArray(candidate.coordinates)
  );
}

export function parseNoaaNino34Annual(
  text: string,
  startYear: number,
  endYear: number,
) {
  const tokens = text.trim().split(/\s+/),
    values: { year: number; value: number }[] = [];
  for (let index = 2; index + 12 < tokens.length; index += 13) {
    const year = Number(tokens[index]);
    if (!Number.isInteger(year)) break;
    const months = tokens
      .slice(index + 1, index + 13)
      .map(Number)
      .filter((value) => Number.isFinite(value) && value > -90 && value < 90);
    if (
      year >= startYear &&
      year <= endYear &&
      months.length >= 10
    )
      values.push({
        year,
        value: months.reduce((sum, value) => sum + value, 0) / months.length,
      });
  }
  return values;
}

/** Parse CPC's row-per-month ERSST Niño-region file.
 * Expected columns are: year, month, Niño1+2, anomaly, Niño3, anomaly,
 * Niño4, anomaly, Niño3.4, anomaly.  Header and malformed rows are ignored.
 */
export function parseCpcNino34Annual(
  text: string,
  startYear: number,
  endYear: number,
) {
  const grouped = new Map<number, number[]>();
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/).map(Number);
    if (fields.length < 10) continue;
    const year = fields[0],
      month = fields[1],
      anomaly = fields[9];
    if (
      !Number.isInteger(year) ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12 ||
      year < startYear ||
      year > endYear ||
      !Number.isFinite(anomaly) ||
      anomaly <= -90 ||
      anomaly >= 90
    )
      continue;
    const values = grouped.get(year) ?? [];
    values.push(anomaly);
    grouped.set(year, values);
  }
  return [...grouped]
    .filter(([, values]) => values.length >= 10)
    .sort((a, b) => a[0] - b[0])
    .map(([year, values]) => ({
      year,
      value: values.reduce((sum, value) => sum + value, 0) / values.length,
    }));
}

export function parseWorldBankUrbanAnnual(
  payload: unknown,
  startYear: number,
  endYear: number,
) {
  if (!Array.isArray(payload) || !Array.isArray(payload[1])) return [];
  return (payload[1] as Array<Record<string, unknown>>)
    .flatMap((row) => {
      const year = Number(row.date),
        value = Number(row.value);
      return Number.isInteger(year) &&
        year >= startYear &&
        year <= endYear &&
        row.value !== null &&
        row.value !== "" &&
        Number.isFinite(value)
        ? [{ year, value }]
        : [];
    })
    .sort((a, b) => a.year - b.year);
}

export function annualMeanFromDatedValues(
  records: Array<{ date: string; value: number }>,
  minimumCompleteness = 0.9,
) {
  const grouped = new Map<number, { sum: number; count: number }>();
  for (const record of records) {
    const year = Number(record.date.slice(0, 4));
    if (!validYear(year) || !Number.isFinite(record.value)) continue;
    const group = grouped.get(year) ?? { sum: 0, count: 0 };
    group.sum += record.value;
    group.count += 1;
    grouped.set(year, group);
  }
  return [...grouped]
    .filter(([year, group]) => {
      const expected =
        (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000;
      return group.count / expected >= minimumCompleteness;
    })
    .sort((a, b) => a[0] - b[0])
    .map(([year, group]) => ({ year, value: group.sum / group.count }));
}

export function onlineCovariateSourceText(
  metadata: OnlineCovariateMetadata,
) {
  return `${metadata.dataset}; ${metadata.provider}; ${metadata.spatialScope}; ${metadata.spatialMethod}; retrieved ${metadata.retrievedAt}`;
}
