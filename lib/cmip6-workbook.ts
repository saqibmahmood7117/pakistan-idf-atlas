import type { Cmip6Period, Cmip6Scenario } from "./idf-data.ts";
import type { ResultRow } from "./observed-idf.ts";
import type { WorkBook, utils } from "xlsx";

type WorkbookLike = Pick<WorkBook, "SheetNames" | "Sheets">;

type XlsxLike = {
  utils: Pick<typeof utils, "sheet_to_json">;
};

export type ImportedCmipProfile = {
  scenario: Cmip6Scenario;
  period: Cmip6Period;
  modelCount: number;
  returnPeriods: number[];
};

export type ImportedCmipModel = {
  model: string;
  member: string;
  scenario: Cmip6Scenario;
  period: Cmip6Period;
  rows: ResultRow[];
};

export type ImportedCmipWorkbook = {
  locationName: string;
  latitude: number;
  longitude: number;
  referenceLabel: string;
  historicalPeriod: string;
  validationStatus: string;
  validationCaveats: string[];
  models: ImportedCmipModel[];
  profiles: ImportedCmipProfile[];
  warnings: string[];
  modelRows: number;
};

const SUPPORTED_SCENARIOS = new Set<Cmip6Scenario>([
  "ssp126",
  "ssp245",
  "ssp370",
  "ssp585",
]);
const SUPPORTED_PERIODS = new Set<Cmip6Period>([
  "2021-2040",
  "2041-2060",
  "2061-2080",
  "2081-2100",
  "2021-2050",
  "2041-2070",
  "2071-2100",
]);

const asText = (value: unknown) => String(value ?? "").trim();
const asNumber = (value: unknown) => {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};
const normalizedHeader = (value: unknown) =>
  asText(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

function rowsFromSheet(XLSX: XlsxLike, workbook: WorkbookLike, name: string) {
  const actual = workbook.SheetNames.find(
    (sheet) => sheet.toLowerCase() === name.toLowerCase(),
  );
  if (!actual) throw new Error(`The workbook is missing the required “${name}” sheet.`);
  return XLSX.utils.sheet_to_json(workbook.Sheets[actual], {
    header: 1,
    defval: null,
    raw: true,
  }) as unknown[][];
}

function tableRows(rows: unknown[][]) {
  if (!rows.length) return [] as Record<string, unknown>[];
  const headers = rows[0].map(normalizedHeader);
  return rows.slice(1).flatMap((row) => {
    const record: Record<string, unknown> = {};
    headers.forEach((header, index) => {
      if (header) record[header] = row[index];
    });
    return Object.values(record).some((value) => value !== null && asText(value) !== "")
      ? [record]
      : [];
  });
}

function parseScenario(value: unknown): Cmip6Scenario {
  const normalized = asText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
  const scenario = normalized.startsWith("ssp") ? normalized : `ssp${normalized}`;
  if (!SUPPORTED_SCENARIOS.has(scenario as Cmip6Scenario))
    throw new Error(`Unsupported CMIP6 scenario in Model IDF: ${asText(value) || "blank"}.`);
  return scenario as Cmip6Scenario;
}

function parsePeriod(value: unknown): Cmip6Period {
  const normalized = asText(value).replace(/[–—]/g, "-").replace(/\s+/g, "");
  if (!SUPPORTED_PERIODS.has(normalized as Cmip6Period))
    throw new Error(`Unsupported analysis period in Model IDF: ${asText(value) || "blank"}.`);
  return normalized as Cmip6Period;
}

function percentile(values: number[], probability: number) {
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function closeEnough(a: number, b: number, tolerance = 0.08) {
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tolerance;
}

function metadataValue(rows: unknown[][], label: string) {
  const match = rows.find((row) => asText(row[0]).toLowerCase() === label.toLowerCase());
  return asText(match?.[1]);
}

function parseLocation(rows: unknown[][]) {
  const value = metadataValue(rows, "Location");
  const match = value.match(
    /(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?.*?(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?/i,
  );
  if (!match) throw new Error("The Read Me sheet must report the project latitude and longitude in its Location row.");
  let latitude = Number(match[1]);
  let longitude = Number(match[3]);
  if (match[2]?.toUpperCase() === "S") latitude *= -1;
  if (match[4]?.toUpperCase() === "W") longitude *= -1;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  )
    throw new Error("The workbook Location coordinates are invalid.");
  const locationName = value.split("·")[0]?.trim() || "Imported CMIP6 point";
  return { locationName, latitude, longitude };
}

export function parseBiasCorrectedCmipWorkbook(
  XLSX: XlsxLike,
  workbook: WorkbookLike,
): ImportedCmipWorkbook {
  const modelTable = tableRows(rowsFromSheet(XLSX, workbook, "Model IDF"));
  if (!modelTable.length) throw new Error("The Model IDF sheet contains no data rows.");
  const readMe = rowsFromSheet(XLSX, workbook, "Read Me");
  const validation = rowsFromSheet(XLSX, workbook, "Validation");
  const { locationName, latitude, longitude } = parseLocation(readMe);
  const rawReference = metadataValue(readMe, "Reference") || "not reported";
  const referenceLabel = /era5/i.test(rawReference)
    ? "ERA5 reanalysis"
    : /gauge|observ/i.test(rawReference)
      ? "observed gauge"
      : rawReference;
  const historicalPeriod = metadataValue(readMe, "Historical overlap") || "not reported";
  const validationTitle = asText(validation[0]?.[0]);
  const validationStatus = validationTitle.includes("·")
    ? validationTitle.split("·").at(-1)!.trim()
    : validationTitle || "Not reported";
  const validationTable = tableRows(validation.slice(4));
  const validationCaveats = validationTable.flatMap((record) => {
    const result = asText(record.result);
    const severity = asText(record.severity);
    if (!/caveat|withheld|share with caveats/i.test(result) && !/high/i.test(severity))
      return [];
    const check = asText(record.check) || "Validation caveat";
    const evidence = asText(record.evidence);
    const action = asText(record.required_action);
    return [`${check}: ${evidence}${action ? ` Required action: ${action}.` : ""}`];
  });

  const groups = new Map<
    string,
    { model: string; member: string; scenario: Cmip6Scenario; period: Cmip6Period; rows: ResultRow[] }
  >();
  let acceptedRows = 0;
  for (const record of modelTable) {
    const model = asText(record.model);
    const member = asText(record.member) || "not reported";
    if (!model) continue;
    const scenario = parseScenario(record.scenario);
    const period = parsePeriod(record.period);
    const returnPeriodYears = asNumber(record.return_period_years);
    const depthMm = asNumber(record.primary_corrected_24h_depth_mm);
    const suppliedIntensity = asNumber(record.primary_corrected_intensity_mm_hr);
    if (
      !(returnPeriodYears > 1) ||
      !(depthMm >= 0) ||
      !(suppliedIntensity >= 0)
    )
      throw new Error(`Invalid corrected return level for ${model}, ${scenario}, ${period}.`);
    const calculatedIntensity = depthMm / 24;
    if (!closeEnough(calculatedIntensity, suppliedIntensity, 0.025))
      throw new Error(
        `${model} ${scenario} ${period} ${returnPeriodYears}-year intensity does not equal corrected 24-hour depth ÷ 24.`,
      );
    const key = `${scenario}|${period}|${model}`;
    const group = groups.get(key) ?? { model, member, scenario, period, rows: [] };
    if (group.rows.some((row) => row.returnPeriodYears === returnPeriodYears))
      throw new Error(`Duplicate ${returnPeriodYears}-year row for ${model}, ${scenario}, ${period}.`);
    group.rows.push({
      method: "gev",
      durationMinutes: 1440,
      returnPeriodYears,
      depthMm,
      intensityMmHr: suppliedIntensity,
      ciLower: suppliedIntensity,
      ciUpper: suppliedIntensity,
      derived: false,
    });
    groups.set(key, group);
    acceptedRows += 1;
  }

  const models: ImportedCmipModel[] = [...groups.values()].map((group) => {
    const rows = group.rows.sort((a, b) => a.returnPeriodYears - b.returnPeriodYears);
    if (rows.length < 3)
      throw new Error(`${group.model} ${group.scenario} ${group.period} has fewer than three corrected return levels.`);
    if (rows.some((row, index) => index > 0 && row.depthMm <= rows[index - 1].depthMm))
      throw new Error(`${group.model} ${group.scenario} ${group.period} corrected depths are not strictly increasing with return period.`);
    return { ...group, rows };
  });
  if (!models.length) throw new Error("No model-specific corrected IDF rows could be imported.");

  const profileMap = new Map<string, ImportedCmipModel[]>();
  for (const model of models) {
    const key = `${model.scenario}|${model.period}`;
    profileMap.set(key, [...(profileMap.get(key) ?? []), model]);
  }
  const profiles: ImportedCmipProfile[] = [...profileMap.entries()].map(
    ([key, profileModels]) => {
      const [scenario, period] = key.split("|") as [Cmip6Scenario, Cmip6Period];
      if (profileModels.length < 3)
        throw new Error(`${scenario} ${period} contains fewer than three corrected models; an ensemble cannot be estimated.`);
      const expected = profileModels[0].rows.map((row) => row.returnPeriodYears).join("|");
      if (profileModels.some((model) => model.rows.map((row) => row.returnPeriodYears).join("|") !== expected))
        throw new Error(`${scenario} ${period} models do not share the same return periods.`);
      return {
        scenario,
        period,
        modelCount: profileModels.length,
        returnPeriods: profileModels[0].rows.map((row) => row.returnPeriodYears),
      };
    },
  );

  const warnings: string[] = [];
  const ensembleSheet = workbook.SheetNames.find(
    (sheet) => sheet.toLowerCase() === "ensemble idf",
  );
  if (ensembleSheet) {
    const ensembleRows = tableRows(
      XLSX.utils.sheet_to_json(workbook.Sheets[ensembleSheet], {
        header: 1,
        defval: null,
        raw: true,
      }) as unknown[][],
    );
    for (const summary of ensembleRows) {
      const scenario = parseScenario(summary.scenario);
      const period = parsePeriod(summary.period);
      const returnPeriod = asNumber(summary.return_period_years);
      const profileModels = profileMap.get(`${scenario}|${period}`) ?? [];
      const modelRows = profileModels.flatMap((model) =>
        model.rows.filter((row) => row.returnPeriodYears === returnPeriod),
      );
      if (!modelRows.length) continue;
      const depths = modelRows.map((row) => row.depthMm);
      const intensities = modelRows.map((row) => row.intensityMmHr);
      const checks = [
        [percentile(depths, 0.1), asNumber(summary.corrected_p10_24h_depth_mm)],
        [percentile(depths, 0.5), asNumber(summary.corrected_median_24h_depth_mm)],
        [percentile(depths, 0.9), asNumber(summary.corrected_p90_24h_depth_mm)],
        [percentile(intensities, 0.5), asNumber(summary.corrected_median_intensity_mm_hr)],
      ];
      if (checks.some(([calculated, supplied]) => !closeEnough(calculated, supplied)))
        warnings.push(`${scenario} ${period} ${returnPeriod}-year ensemble summary does not exactly reconcile with Model IDF.`);
    }
  } else {
    warnings.push("The optional Ensemble IDF sheet was not supplied, so only model-level checks were possible.");
  }

  return {
    locationName,
    latitude,
    longitude,
    referenceLabel,
    historicalPeriod,
    validationStatus,
    validationCaveats,
    models,
    profiles,
    warnings: [...new Set(warnings)],
    modelRows: acceptedRows,
  };
}
