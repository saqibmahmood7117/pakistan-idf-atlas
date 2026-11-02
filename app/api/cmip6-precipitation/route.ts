import {
  CMIP6_CATALOG_BASE,
  CMIP6_NCSS_BASE,
  cmip6GeometryBounds,
  cmip6ModelFolder,
  isCmip6Model,
  isCmip6Scenario,
  parseCmip6Members,
  parseCmip6NcssCsv,
  parseCmip6YearFiles,
  type Cmip6Catalogue,
} from "../../../lib/cmip6-online";
import { parseCmip6NcssNetcdf } from "../../../lib/cmip6-netcdf";
import type { OnlineGeometry } from "../../../lib/online-precipitation";

type CatalogueRequest = {
  action: "catalogue";
  model?: unknown;
  scenario?: unknown;
  member?: unknown;
  startYear?: unknown;
  endYear?: unknown;
};

type YearRequest = {
  action: "year";
  model?: unknown;
  scenario?: unknown;
  member?: unknown;
  year?: unknown;
  fileName?: unknown;
  mode?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  geometry?: unknown;
};

function isGeometry(value: unknown): value is OnlineGeometry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; coordinates?: unknown };
  return (
    (candidate.type === "Polygon" ||
      candidate.type === "MultiPolygon") &&
    Array.isArray(candidate.coordinates)
  );
}

async function nasaFetch(url: string, timeoutMs = 80_000) {
  const retryable = new Set([429, 500, 502, 503, 504]);
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept:
            "application/x-netcdf,application/xml,text/csv,text/plain;q=0.9,*/*;q=0.1",
        },
      });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
      if (!retryable.has(response.status) || attempt === 3)
        throw new Error(
          `NASA NCCS THREDDS returned HTTP ${response.status}. Retry the selected model later; completed annual subsets remain cached in this browser tab.`,
        );
    } catch (error) {
      lastError = error;
      if (
        error instanceof Error &&
        /NASA NCCS THREDDS returned HTTP/.test(error.message)
      )
        throw error;
      if (attempt === 3)
        throw new Error(
          `NASA NCCS THREDDS did not respond within the supported request window (${error instanceof Error ? error.message : "network error"}). Retry to resume from the completed annual subsets.`,
        );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(8_000, 750 * 2 ** attempt)),
    );
  }
  throw new Error(
    `NASA NCCS THREDDS did not return a usable response (${lastError instanceof Error ? lastError.message : "network error"}).`,
  );
}

function validateModelScenario(body: CatalogueRequest | YearRequest) {
  if (!isCmip6Model(body.model))
    throw new Error("Choose a supported NASA NEX-GDDP-CMIP6 model.");
  if (!isCmip6Scenario(body.scenario) && body.scenario !== "historical")
    throw new Error("Choose a supported CMIP6 SSP scenario.");
  return { model: body.model, scenario: body.scenario as "historical" | import("../../../lib/idf-data").Cmip6Scenario };
}

async function catalogue(body: CatalogueRequest) {
  const { model, scenario } = validateModelScenario(body);
  const startYear = Number(body.startYear);
  const endYear = Number(body.endYear);
  if (
    !Number.isInteger(startYear) ||
    !Number.isInteger(endYear) ||
    startYear < (scenario === "historical" ? 1950 : 2015) ||
    endYear > (scenario === "historical" ? 2014 : 2100) ||
    startYear > endYear ||
    endYear - startYear > 30
  )
    throw new Error(
      scenario === "historical"
        ? "Choose a valid historical period of at most 30 years between 1950 and 2014."
        : "Choose a valid future period of at most 30 years between 2015 and 2100.",
    );
  const modelFolder = cmip6ModelFolder(model);
  const scenarioCatalogueUrl = `${CMIP6_CATALOG_BASE}/${encodeURIComponent(modelFolder)}/${scenario}/catalog.xml`;
  const scenarioXml = await (await nasaFetch(scenarioCatalogueUrl, 35_000)).text();
  const availableMembers = parseCmip6Members(scenarioXml);
  if (!availableMembers.length)
    throw new Error(
      `NASA lists no ${scenario} realization for ${model}. Choose another model or SSP.`,
    );
  const requestedMember =
    typeof body.member === "string" && body.member !== "auto"
      ? body.member
      : "";
  if (
    requestedMember &&
    !/^r\d+i\d+p\d+f\d+$/i.test(requestedMember)
  )
    throw new Error("The requested CMIP6 realization identifier is invalid.");
  if (requestedMember && !availableMembers.includes(requestedMember))
    throw new Error(
      `${requestedMember} is not available for ${model} ${scenario}. Available member${availableMembers.length === 1 ? "" : "s"}: ${availableMembers.join(", ")}.`,
    );
  const selectedMember = requestedMember || availableMembers[0];
  const precipitationCatalogueUrl = `${CMIP6_CATALOG_BASE}/${encodeURIComponent(modelFolder)}/${scenario}/${selectedMember}/pr/catalog.xml`;
  const precipitationXml = await (
    await nasaFetch(precipitationCatalogueUrl, 35_000)
  ).text();
  const files = parseCmip6YearFiles(precipitationXml).filter(
    (file) => file.year >= startYear && file.year <= endYear,
  );
  const expectedYears = endYear - startYear + 1;
  if (files.length !== expectedYears) {
    const returned = new Set(files.map((file) => file.year));
    const missing = Array.from(
      { length: expectedYears },
      (_, index) => startYear + index,
    ).filter((year) => !returned.has(year));
    throw new Error(
      `NASA does not expose a complete ${startYear}–${endYear} precipitation series for ${model} ${scenario} ${selectedMember}. Missing year${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
    );
  }
  const response: Cmip6Catalogue = {
    model,
    modelFolder,
    scenario,
    availableMembers,
    selectedMember,
    files,
  };
  return Response.json(response, {
    headers: { "cache-control": "public, max-age=3600" },
  });
}

async function annualSubset(body: YearRequest) {
  const { model, scenario } = validateModelScenario(body);
  const modelFolder = cmip6ModelFolder(model);
  const member =
    typeof body.member === "string" ? body.member.trim() : "";
  const year = Number(body.year);
  const fileName =
    typeof body.fileName === "string" ? body.fileName.trim() : "";
  if (!/^r\d+i\d+p\d+f\d+$/i.test(member))
    throw new Error("The CMIP6 realization identifier is invalid.");
  if (!Number.isInteger(year) || year < (scenario === "historical" ? 1950 : 2015) || year > (scenario === "historical" ? 2014 : 2100))
    throw new Error(`The requested ${scenario === "historical" ? "historical" : "future projection"} year is invalid.`);
  if (
    !/^[A-Za-z0-9_.()-]+\.nc$/.test(fileName) ||
    !fileName.startsWith("pr_day_") ||
    !new RegExp(`_${year}(?:_v[A-Za-z0-9.-]+)?\\.nc$`).test(fileName) ||
    !fileName.includes(`_${scenario}_`)
  )
    throw new Error("The NASA annual precipitation filename is invalid.");
  if (body.mode !== "point" && body.mode !== "district")
    throw new Error("Choose point or district GCM extraction.");
  if (
    body.mode === "point" &&
    (!Number.isFinite(Number(body.latitude)) ||
      !Number.isFinite(Number(body.longitude)) ||
      Number(body.latitude) < -90 ||
      Number(body.latitude) > 90 ||
      Number(body.longitude) < -180 ||
      Number(body.longitude) > 180)
  )
    throw new Error("Point GCM extraction requires valid coordinates.");
  if (body.mode === "district" && !isGeometry(body.geometry))
    throw new Error("District GCM extraction requires the selected polygon.");

  const datasetPath = `${encodeURIComponent(modelFolder)}/${scenario}/${member}/pr/${encodeURIComponent(fileName)}`;
  const url = new URL(`${CMIP6_NCSS_BASE}/${datasetPath}`);
  url.searchParams.set("var", "pr");
  url.searchParams.set("time", "all");
  url.searchParams.set("addLatLon", "true");
  if (body.mode === "point") {
    url.searchParams.set("accept", "csv");
    url.searchParams.set("latitude", Number(body.latitude).toFixed(5));
    url.searchParams.set("longitude", Number(body.longitude).toFixed(5));
  } else {
    url.searchParams.set("accept", "netCDF");
    const bounds = cmip6GeometryBounds(body.geometry as OnlineGeometry);
    const padding = 0.13;
    url.searchParams.set("north", Math.min(90, bounds.north + padding).toFixed(5));
    url.searchParams.set("south", Math.max(-60, bounds.south - padding).toFixed(5));
    url.searchParams.set("east", Math.min(180, bounds.east + padding).toFixed(5));
    url.searchParams.set("west", Math.max(-180, bounds.west - padding).toFixed(5));
    url.searchParams.set("horizStride", "1");
  }

  const response = await nasaFetch(url.toString(), 110_000);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 16_000_000)
    throw new Error(
      "The annual district subset exceeds the interactive response limit. Choose point extraction for this exceptionally large district.",
    );
  const parsed =
    body.mode === "point"
      ? parseCmip6NcssCsv(await response.text(), "point")
      : parseCmip6NcssNetcdf(
          await response.arrayBuffer(),
          "district",
          body.geometry as OnlineGeometry,
        );
  return Response.json(
    {
      status: "complete",
      year,
      records: parsed.records,
      extractedGridCells: parsed.extractedGridCells,
      returnedLatitude: parsed.returnedLatitude,
      returnedLongitude: parsed.returnedLongitude,
      nearestCellFallback: parsed.nearestCellFallback,
      sourceTimeUnits: parsed.sourceTimeUnits,
      sourceCalendar: parsed.sourceCalendar,
      calendarConversion: parsed.calendarConversion,
    },
    { headers: { "cache-control": "public, max-age=86400" } },
  );
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CatalogueRequest | YearRequest;
    if (body.action === "catalogue") return await catalogue(body);
    if (body.action === "year") return await annualSubset(body);
    throw new Error("Choose a supported CMIP6 retrieval action.");
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "CMIP6 precipitation retrieval failed.";
    const providerFailure =
      /NASA NCCS THREDDS|NASA returned|NetCDF|network error|request window/i.test(
        message,
      );
    return Response.json(
      { error: message },
      {
        status: providerFailure ? 502 : 400,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}

// Vercel request limit; availability depends on the selected hosting plan.
export const maxDuration = 300;
