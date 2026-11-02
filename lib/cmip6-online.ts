import { CMIP6_MODELS, CMIP6_SCENARIOS, type Cmip6Scenario } from "./idf-data.ts";
import { pointInOnlineGeometry, type OnlineGeometry } from "./online-precipitation.ts";
import type { DailyRecord } from "./observed-idf.ts";

export const CMIP6_CATALOG_BASE =
  "https://ds.nccs.nasa.gov/thredds/catalog/AMES/NEX/GDDP-CMIP6";
export const CMIP6_NCSS_BASE =
  "https://ds.nccs.nasa.gov/thredds/ncss/grid/AMES/NEX/GDDP-CMIP6";

export type Cmip6Model = (typeof CMIP6_MODELS)[number];

export type Cmip6Catalogue = {
  model: Cmip6Model;
  modelFolder: string;
  scenario: Cmip6Scenario | "historical";
  availableMembers: string[];
  selectedMember: string;
  files: Array<{ year: number; fileName: string }>;
};

export type Cmip6ExtractionMetadata = {
  dataset: "NASA NEX-GDDP-CMIP6 v2";
  provider: "NASA Center for Climate Simulation";
  providerUrl: string;
  retrievalService: "NCCS THREDDS NetCDF Subset Service";
  model: Cmip6Model;
  modelFolder: string;
  scenario: Cmip6Scenario;
  member: string;
  variable: "pr";
  sourceUnits: "kg m-2 s-1";
  sourceTimeUnits: string;
  outputUnits: "mm/day";
  nativeResolution: "Daily · 0.25°";
  sourceCalendar: string;
  calendarConversion: string;
  extractionMode: "point" | "district";
  spatialMethod: string;
  requestedStart: string;
  requestedEnd: string;
  returnedStart: string;
  returnedEnd: string;
  acceptedRecords: number;
  extractedGridCells: number;
  requestedLatitude?: number;
  requestedLongitude?: number;
  returnedLatitude?: number;
  returnedLongitude?: number;
  districtName?: string;
  districtCode?: string;
  boundarySource?: string;
  boundaryVersion?: string;
  boundaryValidOn?: string;
  retrievedAt: string;
};

export function isCmip6Model(value: unknown): value is Cmip6Model {
  return CMIP6_MODELS.includes(value as Cmip6Model);
}

export function isCmip6Scenario(value: unknown): value is Cmip6Scenario {
  return (
    typeof value === "string" &&
    Object.hasOwn(CMIP6_SCENARIOS, value)
  );
}

export function cmip6ModelFolder(model: Cmip6Model) {
  if (model === "GFDL-CM4 (gr1)") return "GFDL-CM4";
  if (model === "GFDL-CM4 (gr2)") return "GFDL-CM4_gr2";
  return model;
}

function xmlAttribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}="([^"]+)"`, "i"));
  return match?.[1] ?? "";
}

export function parseCmip6Members(xml: string) {
  const members = new Set<string>();
  for (const tag of xml.match(/<catalogRef\b[^>]*>/gi) ?? []) {
    const title =
      xmlAttribute(tag, "xlink:title") || xmlAttribute(tag, "name");
    const href =
      xmlAttribute(tag, "xlink:href") || xmlAttribute(tag, "href");
    const member =
      title.match(/^r\d+i\d+p\d+f\d+$/i)?.[0] ??
      href.match(/(?:^|\/)(r\d+i\d+p\d+f\d+)\/catalog\.xml$/i)?.[1];
    if (member) members.add(member);
  }
  return [...members].sort();
}

export function parseCmip6YearFiles(xml: string) {
  const files = new Map<number, string>();
  for (const tag of xml.match(/<dataset\b[^>]*>/gi) ?? []) {
    const urlPath = xmlAttribute(tag, "urlPath");
    const fileName = (urlPath || xmlAttribute(tag, "name")).split("/").at(-1);
    if (
      !fileName ||
      !/^pr_day_[A-Za-z0-9_.()-]+_\d{4}(?:_v[A-Za-z0-9.-]+)?\.nc$/.test(
        fileName,
      )
    )
      continue;
    const year = Number(
      fileName.match(/_(\d{4})(?:_v[A-Za-z0-9.-]+)?\.nc$/)?.[1],
    );
    if (Number.isInteger(year)) files.set(year, fileName);
  }
  return [...files.entries()]
    .map(([year, fileName]) => ({ year, fileName }))
    .sort((a, b) => a.year - b.year);
}

function csvRow(line: string) {
  const values: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else value += character;
  }
  values.push(value.trim());
  return values;
}

function normalizedLongitude(value: number) {
  return value > 180 ? value - 360 : value;
}

export function cmip6GeometryBounds(geometry: OnlineGeometry) {
  const longitudes: number[] = [];
  const latitudes: number[] = [];
  const visit = (value: unknown): void => {
    if (
      Array.isArray(value) &&
      value.length >= 2 &&
      typeof value[0] === "number" &&
      typeof value[1] === "number"
    ) {
      longitudes.push(Number(value[0]));
      latitudes.push(Number(value[1]));
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
  };
  visit(geometry.coordinates);
  if (!longitudes.length || !latitudes.length)
    throw new Error("The selected district polygon has no usable coordinates.");
  return {
    west: Math.min(...longitudes),
    east: Math.max(...longitudes),
    south: Math.min(...latitudes),
    north: Math.max(...latitudes),
  };
}

type ParsedNcssRow = {
  date: string;
  latitude: number;
  longitude: number;
  precipitationMm: number;
};

export function parseCmip6NcssCsv(
  text: string,
  mode: "point" | "district",
  geometry?: OnlineGeometry,
) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (lines.length < 2)
    throw new Error("NASA THREDDS returned no tabular precipitation values.");
  const headers = csvRow(lines[0]).map((header) => header.toLowerCase());
  const timeIndex = headers.findIndex((header) =>
    /(?:^|[ _])(time|date)(?:$|[ _])/.test(` ${header} `),
  );
  const latitudeIndex = headers.findIndex((header) => /lat/.test(header));
  const longitudeIndex = headers.findIndex((header) => /lon/.test(header));
  const precipitationIndex = headers.findIndex(
    (header) =>
      header === "pr" ||
      /^pr[\[( _]/.test(header) ||
      /precipitation/.test(header),
  );
  if (timeIndex < 0 || precipitationIndex < 0)
    throw new Error(
      `NASA THREDDS returned an unexpected CSV schema (${headers.join(", ")}).`,
    );

  const parsed: ParsedNcssRow[] = [];
  for (const line of lines.slice(1)) {
    const values = csvRow(line);
    const date = values[timeIndex]?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    const rate = Number(values[precipitationIndex]);
    const latitude =
      latitudeIndex >= 0 ? Number(values[latitudeIndex]) : Number.NaN;
    const longitude =
      longitudeIndex >= 0
        ? normalizedLongitude(Number(values[longitudeIndex]))
        : Number.NaN;
    if (
      !date ||
      !Number.isFinite(rate) ||
      rate < 0 ||
      !Number.isFinite(rate * 86_400)
    )
      continue;
    const precipitationMm = rate * 86_400;
    if (precipitationMm > 5_000) continue;
    parsed.push({ date, latitude, longitude, precipitationMm });
  }
  if (!parsed.length)
    throw new Error(
      "NASA THREDDS returned no usable non-negative daily precipitation values.",
    );

  const cellKey = (row: ParsedNcssRow) =>
    Number.isFinite(row.latitude) && Number.isFinite(row.longitude)
      ? `${row.latitude.toFixed(5)}|${row.longitude.toFixed(5)}`
      : "point";
  const allCells = new Map<string, { latitude: number; longitude: number }>();
  for (const row of parsed)
    allCells.set(cellKey(row), {
      latitude: row.latitude,
      longitude: row.longitude,
    });

  let acceptedCells = new Set(allCells.keys());
  let nearestCellFallback = false;
  if (mode === "district" && geometry) {
    acceptedCells = new Set(
      [...allCells.entries()]
        .filter(([, cell]) =>
          Number.isFinite(cell.latitude) && Number.isFinite(cell.longitude)
            ? pointInOnlineGeometry(
                cell.longitude,
                cell.latitude,
                geometry,
              )
            : false,
        )
        .map(([key]) => key),
    );
    if (!acceptedCells.size) {
      const bounds = cmip6GeometryBounds(geometry);
      const centerLatitude = (bounds.north + bounds.south) / 2;
      const centerLongitude = (bounds.east + bounds.west) / 2;
      const nearest = [...allCells.entries()]
        .filter(([, cell]) =>
          Number.isFinite(cell.latitude) && Number.isFinite(cell.longitude),
        )
        .sort(
          ([, a], [, b]) =>
            (a.latitude - centerLatitude) ** 2 +
            (a.longitude - centerLongitude) ** 2 -
            ((b.latitude - centerLatitude) ** 2 +
              (b.longitude - centerLongitude) ** 2),
        )[0];
      if (nearest) {
        acceptedCells.add(nearest[0]);
        nearestCellFallback = true;
      }
    }
  }

  const daily = new Map<
    string,
    { weightedSum: number; validWeight: number }
  >();
  for (const row of parsed) {
    if (!acceptedCells.has(cellKey(row))) continue;
    const weight = Number.isFinite(row.latitude)
      ? Math.max(0.01, Math.cos((row.latitude * Math.PI) / 180))
      : 1;
    const aggregate = daily.get(row.date) ?? {
      weightedSum: 0,
      validWeight: 0,
    };
    aggregate.weightedSum += row.precipitationMm * weight;
    aggregate.validWeight += weight;
    daily.set(row.date, aggregate);
  }
  const records: DailyRecord[] = [...daily.entries()]
    .filter(([, aggregate]) => aggregate.validWeight > 0)
    .map(([date, aggregate]) => ({
      date,
      precipitationMm: +(
        aggregate.weightedSum / aggregate.validWeight
      ).toFixed(4),
      qc: "provider",
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!records.length)
    throw new Error(
      "No NASA grid cells could be assigned to the selected extraction geometry.",
    );

  const firstCell = allCells.values().next().value as
    | { latitude: number; longitude: number }
    | undefined;
  return {
    records,
    extractedGridCells: acceptedCells.size,
    returnedLatitude:
      mode === "point" && Number.isFinite(firstCell?.latitude)
        ? firstCell?.latitude
        : undefined,
    returnedLongitude:
      mode === "point" && Number.isFinite(firstCell?.longitude)
        ? firstCell?.longitude
        : undefined,
    nearestCellFallback,
    sourceTimeUnits: "ISO-8601 UTC dates in NCSS CSV",
    sourceCalendar: "NCSS CSV ISO dates",
    calendarConversion:
      "NASA supplied ISO-formatted dates directly in the point CSV response; annual-file year membership was retained without resampling.",
  };
}
