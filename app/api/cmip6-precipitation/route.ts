import {
  CMIP6_ARCHIVE_SERVICE,
  CMIP6_CATALOG_BASE,
  CMIP6_NCSS_BASE,
  CMIP6_NCSS_SERVICE,
  CMIP6_PUBLIC_ARCHIVE,
  CMIP6_PUBLIC_ARCHIVE_SERVICE,
  cmip6GeometryBounds,
  cmip6ModelFolder,
  isCmip6Model,
  isCmip6Scenario,
  parseCmip6Members,
  parseCmip6NcssCsv,
  parseCmip6YearFiles,
  type Cmip6Catalogue,
  type Cmip6Model,
} from "../../../lib/cmip6-online";
import { peshawarCmip6Archive } from "../../../lib/cmip6-archive-cache";
import { parseCmip6NcssNetcdf } from "../../../lib/cmip6-netcdf";
import type { OnlineGeometry } from "../../../lib/online-precipitation";

type CatalogueRequest = {
  action: "catalogue";
  model?: unknown;
  scenario?: unknown;
  member?: unknown;
  startYear?: unknown;
  endYear?: unknown;
  mode?: unknown;
  geometry?: unknown;
  allowArchive?: unknown;
};

type YearRequest = {
  action: "year";
  spatialDate?: unknown;
  model?: unknown;
  scenario?: unknown;
  member?: unknown;
  year?: unknown;
  fileName?: unknown;
  mode?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  geometry?: unknown;
  allowArchive?: unknown;
  preferArchive?: unknown;
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

const retryableNasaStatuses = new Set([429, 500, 502, 503, 504]);

async function nasaFetch(url: string, description: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let failure = "did not respond";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let response: Response | undefined;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(Math.min(remaining, Math.floor(timeoutMs / 2))),
        headers: {
          accept:
            "application/x-netcdf,application/xml,text/csv,text/plain;q=0.9,*/*;q=0.1",
        },
      });
    } catch (error) {
      failure = error instanceof Error && error.name === "TimeoutError"
        ? "exceeded the response time limit"
        : "could not be reached";
    }
    if (response) {
      if (response.ok) return response;
      failure = `returned HTTP ${response.status}`;
      await response.body?.cancel();
      if (!retryableNasaStatuses.has(response.status)) break;
    }
    const delay = 750 * 2 ** attempt;
    if (attempt === 2 || Date.now() + delay >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(
    `NASA NCCS THREDDS ${failure} for ${description}. Retry the same selection to reuse completed annual subsets in this tab.`,
  );
}

function validateModelScenario(body: CatalogueRequest | YearRequest) {
  if (!isCmip6Model(body.model))
    throw new Error("Choose a supported NASA NEX-GDDP-CMIP6 model.");
  if (!isCmip6Scenario(body.scenario) && body.scenario !== "historical")
    throw new Error("Choose a supported CMIP6 SSP scenario.");
  return { model: body.model, scenario: body.scenario as "historical" | import("../../../lib/idf-data").Cmip6Scenario };
}

async function listNasaArchive(prefix: string, delimiter?: string) {
  const url = new URL(CMIP6_PUBLIC_ARCHIVE);
  url.searchParams.set("list-type", "2");
  url.searchParams.set("encoding-type", "url");
  url.searchParams.set("prefix", prefix);
  if (delimiter) url.searchParams.set("delimiter", delimiter);
  const response = await fetch(url, {signal: AbortSignal.timeout(12_000)});
  if (!response.ok) throw new Error(`NASA Open Data catalogue returned HTTP ${response.status} for ${prefix}.`);
  const xml = await response.text();
  if (/<IsTruncated>true<\/IsTruncated>/.test(xml)) {
    throw new Error(`NASA Open Data returned an incomplete catalogue for ${prefix}.`);
  }
  return xml;
}

async function archiveCatalogue(
  model: Cmip6Model,
  scenario: Cmip6Catalogue["scenario"],
  modelFolder: string,
  requestedMember: string,
  startYear: number,
  endYear: number,
) {
  const prefix = `NEX-GDDP-CMIP6/${modelFolder}/${scenario}/`;
  const membersXml = await listNasaArchive(prefix, "/");
  const availableMembers = [...membersXml.matchAll(/<CommonPrefixes>\s*<Prefix>([^<]+)<\/Prefix>/g)]
    .map(match => decodeURIComponent(match[1]).slice(prefix.length).replace(/\/$/, ""))
    .filter(member => /^r\d+i\d+p\d+f\d+$/i.test(member))
    .sort();
  const selectedMember = requestedMember || availableMembers[0];
  if (!selectedMember || !availableMembers.includes(selectedMember)) {
    throw new Error(`NASA Open Data has no ${requestedMember || "realization"} for ${model} ${scenario}.`);
  }
  const filesXml = await listNasaArchive(`${prefix}${selectedMember}/pr/`);
  const byYear = new Map<number, {fileName: string; revision: number}>();
  for (const match of filesXml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
    const fileName = decodeURIComponent(match[1]).split("/").at(-1)!;
    const parts = /^pr_day_[A-Za-z0-9_.()-]+_(\d{4})_v2\.(\d+)\.nc$/.exec(fileName);
    if (!parts) continue;
    const year = Number(parts[1]);
    const revision = Number(parts[2]);
    if (year >= startYear && year <= endYear && revision > (byYear.get(year)?.revision ?? -1)) {
      byYear.set(year, {fileName, revision});
    }
  }
  const files = Array.from(byYear, ([year, {fileName}]) => ({year, fileName})).sort((a, b) => a.year - b.year);
  const missing = Array.from({length: endYear - startYear + 1}, (_, index) => startYear + index)
    .filter(year => !byYear.has(year));
  if (missing.length) {
    throw new Error(`NASA Open Data has no matching v2 precipitation files for ${model} ${scenario} ${selectedMember} in ${missing.join(", ")}.`);
  }
  const catalogue: Cmip6Catalogue = {
    model, modelFolder, scenario, availableMembers, selectedMember, files,
    retrievalService: CMIP6_PUBLIC_ARCHIVE_SERVICE,
  };
  return Response.json(catalogue);
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
  const requestedMember = typeof body.member === "string" && body.member !== "auto" ? body.member : "";
  if (requestedMember && !/^r\d+i\d+p\d+f\d+$/i.test(requestedMember)) {
    throw new Error("The requested CMIP6 realization identifier is invalid.");
  }
  const geometry = isGeometry(body.geometry) ? body.geometry : undefined;
  const archive = await peshawarCmip6Archive({ ...body, geometry });
  if (archive) {
    const files = Object.entries(archive.files)
      .filter(([, file]) => file.scenario === scenario && file.year >= startYear && file.year <= endYear)
      .map(([fileName, file]) => ({ year: file.year, fileName }))
      .sort((a, b) => a.year - b.year);
    if (files.length === endYear - startYear + 1) {
      const response: Cmip6Catalogue = {
        model, modelFolder, scenario, availableMembers: [archive.member],
        selectedMember: archive.member, files, retrievalService: CMIP6_ARCHIVE_SERVICE,
      };
      return Response.json(response);
    }
  }
  const fromArchive = () => archiveCatalogue(model, scenario, modelFolder, requestedMember, startYear, endYear);
  const scenarioCatalogueUrl = `${CMIP6_CATALOG_BASE}/${encodeURIComponent(modelFolder)}/${scenario}/catalog.xml`;
  let scenarioXml: string;
  try {
    scenarioXml = await (await nasaFetch(scenarioCatalogueUrl, `${model} ${scenario} catalogue`, 18_000)).text();
  } catch (error) {
    if (body.allowArchive === true) return fromArchive();
    throw error;
  }
  const availableMembers = parseCmip6Members(scenarioXml);
  if (!availableMembers.length && body.allowArchive === true) return fromArchive();
  if (!availableMembers.length)
    throw new Error(
      `NASA lists no ${scenario} realization for ${model}. Choose another model or SSP.`,
    );
  if (requestedMember && !availableMembers.includes(requestedMember))
    throw new Error(
      `${requestedMember} is not available for ${model} ${scenario}. Available member${availableMembers.length === 1 ? "" : "s"}: ${availableMembers.join(", ")}.`,
    );
  const selectedMember = requestedMember || availableMembers[0];
  const precipitationCatalogueUrl = `${CMIP6_CATALOG_BASE}/${encodeURIComponent(modelFolder)}/${scenario}/${selectedMember}/pr/catalog.xml`;
  let precipitationXml: string;
  try {
    precipitationXml = await (
      await nasaFetch(precipitationCatalogueUrl, `${model} ${scenario} ${selectedMember} precipitation catalogue`, 18_000)
    ).text();
  } catch (error) {
    if (body.allowArchive === true) return fromArchive();
    throw error;
  }
  const files = parseCmip6YearFiles(precipitationXml).filter(
    (file) => file.year >= startYear && file.year <= endYear,
  );
  const expectedYears = endYear - startYear + 1;
  if (files.length !== expectedYears) {
    if (body.allowArchive === true) return fromArchive();
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
    !fileName.includes(`_${scenario}_${member}_`)
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
  if(body.spatialDate!==undefined && typeof body.spatialDate!=='string')throw Error('Spatial date must be an ISO date string.');
  const spatialDate=typeof body.spatialDate==='string'?body.spatialDate:undefined;
  if(spatialDate){
    if(body.mode!=='district'||!/^\d{4}-\d{2}-\d{2}$/.test(spatialDate)||Number(spatialDate.slice(0,4))!==year||!Number.isFinite(Date.parse(spatialDate+'T00:00:00Z'))||new Date(spatialDate+'T00:00:00Z').toISOString().slice(0,10)!==spatialDate)throw Error('Choose a valid spatial date inside this annual file.');
    url.searchParams.set('time_start',spatialDate+'T00:00:00Z');url.searchParams.set('time_end',spatialDate+'T23:59:59Z');
  }else url.searchParams.set("time", "all");
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

  const geometry = isGeometry(body.geometry) ? body.geometry : undefined;
  const archive = await peshawarCmip6Archive({ ...body, member, geometry });
  const archivedYear = archive?.files[fileName];
  const cached = archivedYear?.year === year && archivedYear.scenario === scenario ? archivedYear : null;
  const usePublicArchive = () => Response.json({
    status: "archive",
    year,
    sourceFileUrl: `${CMIP6_PUBLIC_ARCHIVE}/NEX-GDDP-CMIP6/${datasetPath}`,
    retrievalService: CMIP6_PUBLIC_ARCHIVE_SERVICE,
  });
  let parsed: ReturnType<typeof parseCmip6NcssCsv> | ReturnType<typeof parseCmip6NcssNetcdf>;
  if (cached) {
    const bytes = Uint8Array.from(atob(cached.netcdf), character => character.charCodeAt(0));
    parsed = parseCmip6NcssNetcdf(bytes, "district", geometry, spatialDate);
  } else {
    if (body.allowArchive === true && body.preferArchive === true) return usePublicArchive();
    try {
      const response = await nasaFetch(url.toString(), `${model} ${scenario} ${member}, ${year}`, 110_000);
      const contentLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > 16_000_000) {
        await response.body?.cancel();
        throw new Error("The annual district subset exceeds the interactive response limit.");
      }
      parsed = body.mode === "point"
        ? parseCmip6NcssCsv(await response.text(), "point")
        : parseCmip6NcssNetcdf(await response.arrayBuffer(), "district", geometry, spatialDate);
    } catch (error) {
      // Use the identical annual file. A spatial-date absence is reported as
      // a model-calendar gap after the archive is decoded as well.
      if (body.allowArchive === true) return usePublicArchive();
      throw error;
    }
  }
  return Response.json(
    {
      status: "complete",
      year,
      records: spatialDate ? parsed.records.filter(row=>row.date===spatialDate) : parsed.records,
      providerSubsetUrl: spatialDate ? (cached?.sourceUrl ?? url.toString()) : undefined,
      retrievalService: cached ? CMIP6_ARCHIVE_SERVICE : CMIP6_NCSS_SERVICE,
      spatialCells: "spatialCells" in parsed ? parsed.spatialCells : undefined,
      extractedGridCells: parsed.extractedGridCells,
      returnedLatitude: parsed.returnedLatitude,
      returnedLongitude: parsed.returnedLongitude,
      nearestCellFallback: parsed.nearestCellFallback,
      gridSelection: "gridSelection" in parsed ? parsed.gridSelection : "point",
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
      /NASA NCCS THREDDS|NASA Open Data.*HTTP|NASA returned|NetCDF|network error|request window/i.test(
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
