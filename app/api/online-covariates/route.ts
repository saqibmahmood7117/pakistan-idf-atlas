import type { AnnualCovariate } from "../../../lib/observed-idf";
import {
  ONLINE_COVARIATE_CONFIG,
  annualMeanFromDatedValues,
  onlineCovariateSourceText,
  parseCpcNino34Annual,
  parseNoaaNino34Annual,
  parseWorldBankUrbanAnnual,
  validateOnlineCovariateRequest,
  type OnlineCovariateMetadata,
  type OnlineCovariateRequest,
  type OnlineCovariateResponse,
} from "../../../lib/online-covariates";
import {
  climateServDate,
  climateServRecords,
  era5DistrictGrid,
  pointBufferGeometry,
  splitDateRange,
  validIsoDate,
  type OnlineGeometry,
  type OnlineJob,
  type WeightedGridPoint,
} from "../../../lib/online-precipitation";

const NOAA_NINO34 =
  "https://psl.noaa.gov/data/correlation/nina34.anom.data";
const NOAA_CPC_NINO34 =
  "https://www.cpc.ncep.noaa.gov/data/indices/ersst5.nino.mth.91-20.ascii";
const WORLD_BANK_URBAN =
  "https://api.worldbank.org/v2/country/PAK/indicator/SP.URB.TOTL.IN.ZS";
const OPEN_METEO_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive";
const CLIMATE_SERV_BASE = "https://climateserv.servirglobal.net/api";
const LIS_SURFACE_SOIL_MOISTURE = 664;

function json(body: OnlineCovariateResponse, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function providerFetch(
  url: string,
  init?: RequestInit,
  timeoutMs = 60_000,
  maxAttempts = 4,
) {
  const retryable = new Set([429, 502, 503, 504]);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.ok) return response;
    if (!retryable.has(response.status) || attempt === maxAttempts - 1)
      throw new Error(
        `The covariate provider returned HTTP ${response.status}. Try again later or retrieve one covariate at a time.`,
      );
    const retryAfter = Number(response.headers.get("retry-after"));
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(10_000, retryAfter * 1000)
          : 750 * 2 ** attempt,
      ),
    );
  }
  throw new Error("The covariate provider did not return a usable response.");
}

function complete(
  covariate: AnnualCovariate,
  metadata: OnlineCovariateMetadata,
) {
  covariate.source = onlineCovariateSourceText(metadata);
  return json({ status: "complete", progress: 100, covariate, metadata });
}

function annualBounds(values: Array<{ year: number; value: number }>) {
  if (!values.length)
    throw new Error(
      "The provider returned no complete annual values for the requested period.",
    );
  return {
    returnedStartYear: values[0].year,
    returnedEndYear: values.at(-1)!.year,
  };
}

async function retrieveEnso(body: OnlineCovariateRequest) {
  let values: Array<{ year: number; value: number }> = [],
    retrievalService = "NOAA CPC ERSSTv5 monthly Niño-region file";
  try {
    const response = await providerFetch(
      NOAA_CPC_NINO34,
      undefined,
      30_000,
      2,
    );
    values = parseCpcNino34Annual(
      await response.text(),
      body.startYear,
      body.endYear,
    );
    if (!values.length)
      throw new Error("The NOAA CPC file contained no usable Niño 3.4 values.");
  } catch {
    const response = await providerFetch(NOAA_NINO34, undefined, 30_000, 2);
    values = parseNoaaNino34Annual(
      await response.text(),
      body.startYear,
      body.endYear,
    );
    retrievalService =
      "NOAA PSL standard monthly time-series file · nina34.anom.data";
  }
  const
    bounds = annualBounds(values),
    config = ONLINE_COVARIATE_CONFIG.enso,
    metadata: OnlineCovariateMetadata = {
      source: "enso",
      dataset: config.dataset,
      provider: config.provider,
      providerUrl: config.providerUrl,
      retrievalService,
      spatialScope: "Global climate index; no district or point extraction",
      spatialMethod:
        "Calendar-year mean of monthly Niño 3.4 SST anomalies; a year is accepted with at least 10 valid months",
      nativeResolution: "Monthly index for 5°N–5°S, 170°W–120°W",
      requestedStartYear: body.startYear,
      requestedEndYear: body.endYear,
      ...bounds,
      sourceRecords: values.length * 12,
      acceptedAnnualValues: values.length,
      completenessRule: "At least 10 valid monthly values per calendar year",
      limitations:
        "ENSO is a large-scale climate index, not a local meteorological measurement. A documented regional mechanism is still required.",
      retrievedAt: new Date().toISOString(),
    };
  return complete(
    {
      id: "online-noaa-nino34",
      label: "NOAA Niño 3.4 annual mean anomaly",
      kind: "enso",
      units: "°C anomaly",
      physicalRationale:
        "Tropical Pacific SST anomalies can alter monsoon circulation and moisture transport into South Asia; the candidate must still pass AICc, residual, uncertainty and held-out checks.",
      source: "",
      physicallyPlausible: true,
      values,
    },
    metadata,
  );
}

async function retrieveUrbanization(body: OnlineCovariateRequest) {
  const start = Math.max(
      body.startYear,
      ONLINE_COVARIATE_CONFIG.urbanization.firstYear,
    ),
    url = new URL(WORLD_BANK_URBAN);
  url.searchParams.set("format", "json");
  url.searchParams.set("per_page", "1000");
  url.searchParams.set("date", `${start}:${body.endYear}`);
  const response = await providerFetch(url.toString()),
    payload: unknown = await response.json(),
    values = parseWorldBankUrbanAnnual(payload, start, body.endYear),
    bounds = annualBounds(values),
    config = ONLINE_COVARIATE_CONFIG.urbanization,
    metadata: OnlineCovariateMetadata = {
      source: "urbanization",
      dataset: config.dataset,
      provider: config.provider,
      providerUrl: config.providerUrl,
      retrievalService: config.retrievalService,
      spatialScope: "Pakistan national series; not district- or point-specific",
      spatialMethod:
        "Annual Pakistan urban-population share returned by indicator SP.URB.TOTL.IN.ZS",
      nativeResolution: "Annual national indicator",
      requestedStartYear: body.startYear,
      requestedEndYear: body.endYear,
      ...bounds,
      sourceRecords: values.length,
      acceptedAnnualValues: values.length,
      completenessRule: "Provider-reported annual values; missing years are not imputed",
      limitations:
        "This is a national proxy, not local imperviousness or district built-up fraction. Treat any apparent support cautiously and replace it with a local GHSL or planning series for design use.",
      retrievedAt: new Date().toISOString(),
    };
  return complete(
    {
      id: "online-world-bank-pak-urban-share",
      label: "Pakistan urban population share · national proxy",
      kind: "urbanization",
      units: "% of total population",
      physicalRationale:
        "Urban development can modify local runoff and, in some settings, convection; this national series is only a screening proxy and does not establish a local causal mechanism.",
      source: "",
      physicallyPlausible: true,
      values,
    },
    metadata,
  );
}

type OpenMeteoTemperaturePayload = {
  latitude?: number;
  longitude?: number;
  daily?: {
    time?: string[];
    temperature_2m_max?: Array<number | null>;
    temperature_2m_min?: Array<number | null>;
  };
};

async function fetchTemperatureBatch(
  points: WeightedGridPoint[],
  start: string,
  end: string,
) {
  const url = new URL(OPEN_METEO_ARCHIVE);
  url.searchParams.set(
    "latitude",
    points.map((point) => point.latitude.toFixed(4)).join(","),
  );
  url.searchParams.set(
    "longitude",
    points.map((point) => point.longitude.toFixed(4)).join(","),
  );
  url.searchParams.set("start_date", start);
  url.searchParams.set("end_date", end);
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min");
  url.searchParams.set("models", "era5");
  url.searchParams.set("timezone", "UTC");
  url.searchParams.set("cell_selection", "nearest");
  const response = await providerFetch(url.toString(), undefined, 90_000),
    payload: unknown = await response.json(),
    locations = (Array.isArray(payload) ? payload : [
      payload,
    ]) as OpenMeteoTemperaturePayload[];
  if (locations.length !== points.length)
    throw new Error(
      "ERA5 temperature retrieval returned an unexpected number of grid-cell series.",
    );
  return locations;
}

async function retrieveTemperature(body: OnlineCovariateRequest) {
  const firstYear = Math.max(
      body.startYear,
      ONLINE_COVARIATE_CONFIG.temperature.firstYear,
    ),
    districtGrid =
      body.mode === "district" ? era5DistrictGrid(body.geometry!, 48) : null,
    points: WeightedGridPoint[] = districtGrid?.points ?? [
      {
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
        weight: 1,
      },
    ],
    datedValues: Array<{ date: string; value: number }> = [];
  let sourceRecords = 0;
  const chunks = splitDateRange(
    `${firstYear}-01-01`,
    `${body.endYear}-12-31`,
    20,
  );
  for (const chunk of chunks) {
    let times: string[] | null = null,
      weightedSum: number[] = [],
      validWeight: number[] = [];
    for (let offset = 0; offset < points.length; offset += 8) {
      const batch = points.slice(offset, offset + 8),
        locations = await fetchTemperatureBatch(
          batch,
          chunk.start,
          chunk.end,
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
            "ERA5 grid-cell temperature series returned inconsistent dates.",
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
    }
    for (let item = 0; item < (times?.length ?? 0); item += 1)
      if (validWeight[item] > 0 && validIsoDate(times![item]))
        datedValues.push({
          date: times![item],
          value: weightedSum[item] / validWeight[item],
        });
  }
  const values = annualMeanFromDatedValues(datedValues),
    bounds = annualBounds(values),
    config = ONLINE_COVARIATE_CONFIG.temperature,
    spatialScope =
      body.mode === "district"
        ? "Selected district"
        : `Requested point ${Number(body.latitude).toFixed(5)}, ${Number(body.longitude).toFixed(5)}`,
    spatialMethod =
      body.mode === "district"
        ? `Approximate overlap-weighted mean of ${points.length} representative ERA5 cells; overlap fractions estimated on a 5×5 sub-grid`
        : "Nearest ERA5 grid cell returned by the retrieval service",
    metadata: OnlineCovariateMetadata = {
      source: "temperature",
      dataset: config.dataset,
      provider: config.provider,
      providerUrl: config.providerUrl,
      retrievalService: config.retrievalService,
      spatialScope,
      spatialMethod,
      nativeResolution: "0.25° ERA5; daily midrange calculated from daily Tmax and Tmin",
      requestedStartYear: body.startYear,
      requestedEndYear: body.endYear,
      ...bounds,
      sourceRecords,
      acceptedAnnualValues: values.length,
      completenessRule:
        "Calendar-year mean retained when at least 90% of daily midrange values are available",
      limitations:
        "Annual temperature is the mean daily midrange, (Tmax + Tmin)/2, not an hourly arithmetic mean. District weights approximate polygon overlap.",
      retrievedAt: new Date().toISOString(),
    };
  return complete(
    {
      id: "online-era5-temperature",
      label: `ERA5 annual 2 m temperature · ${body.mode === "district" ? "district" : "point"}`,
      kind: "temperature",
      units: "°C",
      physicalRationale:
        "Air temperature is physically related to atmospheric moisture-holding capacity, but support for an extreme-rainfall model must be demonstrated by the full comparison diagnostics.",
      source: "",
      physicallyPlausible: true,
      values,
    },
    metadata,
  );
}

async function submitMoistureJob(
  geometry: OnlineGeometry,
  start: string,
  end: string,
) {
  const form = new URLSearchParams({
    datatype: String(LIS_SURFACE_SOIL_MOISTURE),
    begintime: climateServDate(start),
    endtime: climateServDate(end),
    intervaltype: "0",
    operationtype: "5",
    dateType_Category: "default",
    isZip_CurrentDataType: "false",
    geometry: JSON.stringify(geometry),
  });
  const response = await providerFetch(
      `${CLIMATE_SERV_BASE}/submitDataRequest/`,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: form.toString(),
      },
    ),
    payload: unknown = await response.json(),
    id = Array.isArray(payload) ? String(payload[0] ?? "") : "";
  if (!/^[0-9a-f-]{36}$/i.test(id))
    throw new Error("ClimateSERV did not return a valid soil-moisture job.");
  return id;
}

async function startMoisture(body: OnlineCovariateRequest) {
  const startYear = Math.max(
      body.startYear,
      ONLINE_COVARIATE_CONFIG.moisture.firstYear,
    ),
    geometry =
      body.mode === "point"
        ? pointBufferGeometry(Number(body.longitude), Number(body.latitude))
        : body.geometry!,
    chunks = splitDateRange(
      `${startYear}-01-01`,
      `${body.endYear}-12-31`,
      20,
    ),
    jobs: OnlineJob[] = [];
  for (const chunk of chunks)
    jobs.push({
      id: await submitMoistureJob(geometry, chunk.start, chunk.end),
      ...chunk,
    });
  return json({
    status: "processing",
    progress: 0,
    jobs,
    message: `${jobs.length} ClimateSERV soil-moisture job${jobs.length === 1 ? "" : "s"} submitted.`,
  });
}

async function pollMoisture(body: OnlineCovariateRequest) {
  const jobs = body.jobs ?? [];
  if (
    !jobs.length ||
    jobs.length > 4 ||
    jobs.some((job) => !/^[0-9a-f-]{36}$/i.test(job.id))
  )
    throw new Error("The soil-moisture provider job list is missing or invalid.");
  const progressValues: number[] = [];
  for (const job of jobs) {
    const url = new URL(`${CLIMATE_SERV_BASE}/getDataRequestProgress/`);
    url.searchParams.set("id", job.id);
    const response = await providerFetch(url.toString(), undefined, 25_000),
      payload: unknown = await response.json(),
      value = Number(Array.isArray(payload) ? payload[0] : payload);
    if (!Number.isFinite(value) || value < 0)
      throw new Error("ClimateSERV reported a failed soil-moisture job.");
    progressValues.push(Math.min(100, value));
  }
  const progress = Math.round(
    progressValues.reduce((sum, value) => sum + value, 0) /
      progressValues.length,
  );
  if (progressValues.some((value) => value < 100))
    return json({
      status: "processing",
      progress,
      jobs,
      message: `Soil-moisture processing is ${progress}% complete.`,
    });

  const datedValues: Array<{ date: string; value: number }> = [];
  for (const job of jobs) {
    const url = new URL(`${CLIMATE_SERV_BASE}/getDataFromRequest/`);
    url.searchParams.set("id", job.id);
    const response = await providerFetch(url.toString(), undefined, 60_000);
    for (const record of climateServRecords(await response.json()))
      datedValues.push({ date: record.date, value: record.precipitationMm });
  }
  const values = annualMeanFromDatedValues(datedValues),
    bounds = annualBounds(values),
    config = ONLINE_COVARIATE_CONFIG.moisture,
    metadata: OnlineCovariateMetadata = {
      source: "moisture",
      dataset: config.dataset,
      provider: config.provider,
      providerUrl: config.providerUrl,
      retrievalService: config.retrievalService,
      spatialScope:
        body.mode === "district"
          ? "Selected district"
          : `0.002° square centred on ${Number(body.latitude).toFixed(5)}, ${Number(body.longitude).toFixed(5)}`,
      spatialMethod:
        body.mode === "district"
          ? "ClimateSERV daily polygon mean for the submitted district geometry"
          : "ClimateSERV daily polygon mean for a 0.002° point buffer",
      nativeResolution: "Daily LIS-modeled 0–10 cm soil moisture",
      requestedStartYear: body.startYear,
      requestedEndYear: body.endYear,
      ...bounds,
      sourceRecords: datedValues.length,
      acceptedAnnualValues: values.length,
      completenessRule:
        "Calendar-year mean retained when at least 90% of daily values are available",
      limitations:
        "This is modeled near-surface soil moisture, not gauge-measured atmospheric moisture. The connected series begins in 2000 and may shorten the shared comparison period.",
      retrievedAt: new Date().toISOString(),
    };
  return complete(
    {
      id: "online-lis-soil-moisture",
      label: `LIS annual 0–10 cm soil moisture · ${body.mode === "district" ? "district" : "point"}`,
      kind: "moisture",
      units: "m³/m³",
      physicalRationale:
        "Near-surface soil moisture represents land-surface wetness and land–atmosphere coupling, but it should influence design rainfall only when the complete diagnostic evidence supports the relationship.",
      source: "",
      physicallyPlausible: true,
      values,
    },
    metadata,
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as OnlineCovariateRequest;
    validateOnlineCovariateRequest(body);
    if (body.action === "poll") {
      if (body.source !== "moisture")
        throw new Error("Only asynchronous soil-moisture jobs can be polled.");
      return await pollMoisture(body);
    }
    if (body.action !== "start")
      throw new Error("Unsupported covariate extraction action.");
    if (body.source === "enso") return await retrieveEnso(body);
    if (body.source === "temperature") return await retrieveTemperature(body);
    if (body.source === "moisture") return await startMoisture(body);
    return await retrieveUrbanization(body);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Online annual-covariate retrieval failed.";
    const status = /provider|ClimateSERV|ERA5|World Bank|NOAA|fetch|network|timed|HTTP/i.test(
      message,
    )
      ? 502
      : 400;
    return json({ status: "error", error: message }, status);
  }
}

// Vercel request limit; availability depends on the selected hosting plan.
export const maxDuration = 300;
