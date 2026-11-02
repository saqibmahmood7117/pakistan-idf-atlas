import type * as Xlsx from "xlsx";
import type { AnnualCovariate } from "./observed-idf";

export type CovariateWorkbookResult = {
  covariates: AnnualCovariate[];
  sheets: string[];
  candidateRows: number;
  acceptedValues: number;
  duplicateYears: number;
  ignoredColumns: string[];
};

const normalize = (value: unknown) =>
  String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const numberValue = (value: unknown) => {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim().replace(/,/g, "");
  return text === "" ? NaN : Number(text);
};
const slug = (value: string) =>
  normalize(value).replaceAll(" ", "-").replace(/^-+|-+$/g, "") || "covariate";

function inferredMetadata(label: string) {
  const text = normalize(label);
  if (/\b(enso|nino|nino 3 4|oni|southern oscillation)\b/.test(text))
    return {
      kind: "enso" as const,
      units: /soi|southern oscillation/.test(text) ? "index" : "°C anomaly",
      rationale:
        "Large-scale tropical Pacific variability can alter regional moisture transport and monsoon circulation.",
    };
  if (/\b(temperature|tas|tmean|mean temp|global mean temperature|gmt|gmst)\b/.test(text))
    return {
      kind: "temperature" as const,
      units: /anomaly/.test(text) ? "°C anomaly" : "°C",
      rationale:
        "Atmospheric temperature is physically related to moisture-holding capacity and extreme-rainfall intensity.",
    };
  if (/\b(precipitable water|pw|humidity|specific humidity|dew point|soil moisture|moisture)\b/.test(text))
    return {
      kind: "moisture" as const,
      units: /fraction|relative humidity/.test(text) ? "%" : "source units",
      rationale:
        "Atmospheric or land-surface moisture provides a physically interpretable constraint on storm rainfall potential.",
    };
  if (/\b(urban|urbanization|impervious|built up|builtup)\b/.test(text))
    return {
      kind: "urbanization" as const,
      units: /fraction|share/.test(text) ? "fraction" : "%",
      rationale:
        "Urbanization can modify convection and rainfall locally, but the series must represent the gauge or extraction area.",
    };
  if (/\b(monsoon index|monsoon circulation|iod|indian ocean dipole|pdo|mjo)\b/.test(text))
    return {
      kind: "climate-index" as const,
      units: "index",
      rationale:
        "A large-scale circulation index may be considered when a documented regional mechanism links it to extreme rainfall.",
    };
  return {
    kind: "other" as const,
    units: "source units",
    rationale: "",
  };
}

type Metadata = { units?: string; rationale?: string; source?: string };

function readMetadata(XLSX: typeof Xlsx, workbook: Xlsx.WorkBook) {
  const metadata = new Map<string, Metadata>();
  for (const sheetName of workbook.SheetNames) {
    if (!/metadata|dictionary|covariate info/i.test(sheetName)) continue;
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: "",
    });
    const headerIndex = rows.findIndex((row) =>
      row.some((cell) => /^(variable|column|covariate|name)$/i.test(String(cell).trim())),
    );
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex].map(normalize);
    const nameIndex = headers.findIndex((h) => /^(variable|column|covariate|name)$/.test(h));
    const unitsIndex = headers.findIndex((h) => /^units?$/.test(h));
    const rationaleIndex = headers.findIndex((h) => /rationale|mechanism|physical basis/.test(h));
    const sourceIndex = headers.findIndex((h) => /source|reference|provenance/.test(h));
    for (const row of rows.slice(headerIndex + 1)) {
      const name = String(row[nameIndex] ?? "").trim();
      if (!name) continue;
      metadata.set(normalize(name), {
        units: unitsIndex >= 0 ? String(row[unitsIndex] ?? "").trim() : "",
        rationale: rationaleIndex >= 0 ? String(row[rationaleIndex] ?? "").trim() : "",
        source: sourceIndex >= 0 ? String(row[sourceIndex] ?? "").trim() : "",
      });
    }
  }
  return metadata;
}

export function parseCovariateWorkbook(
  XLSX: typeof Xlsx,
  workbook: Xlsx.WorkBook,
): CovariateWorkbookResult {
  const metadata = readMetadata(XLSX, workbook);
  const covariates: AnnualCovariate[] = [];
  const ignoredColumns: string[] = [];
  const usedSheets = new Set<string>();
  let candidateRows = 0;
  let acceptedValues = 0;
  let duplicateYears = 0;

  for (const sheetName of workbook.SheetNames) {
    if (/metadata|dictionary|covariate info/i.test(sheetName)) continue;
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: "",
    });
    const headerIndex = rows.slice(0, 100).findIndex((row) =>
      row.some((cell) => /^(year|yr|yyyy)$/i.test(String(cell).trim())),
    );
    if (headerIndex < 0) continue;
    const headers = rows[headerIndex].map((cell) => String(cell ?? "").trim());
    const yearIndex = headers.findIndex((header) => /^(year|yr|yyyy)$/i.test(header));
    const maps = new Map<number, Map<number, number>>();
    for (let column = 0; column < headers.length; column++) {
      if (column !== yearIndex && headers[column]) maps.set(column, new Map());
    }
    for (const row of rows.slice(headerIndex + 1)) {
      if (!row.some((cell) => String(cell ?? "").trim() !== "")) continue;
      candidateRows++;
      const year = Math.trunc(numberValue(row[yearIndex]));
      if (!Number.isInteger(year) || year < 1800 || year > 2200) continue;
      for (const [column, values] of maps) {
        const value = numberValue(row[column]);
        if (!Number.isFinite(value)) continue;
        if (values.has(year)) duplicateYears++;
        values.set(year, value);
        acceptedValues++;
      }
    }
    for (const [column, values] of maps) {
      const label = headers[column];
      if (values.size < 8) {
        ignoredColumns.push(`${sheetName}: ${label || `column ${column + 1}`}`);
        continue;
      }
      const inferred = inferredMetadata(label);
      const supplied = metadata.get(normalize(label)) ?? {};
      const rationale = supplied.rationale || inferred.rationale;
      covariates.push({
        id: `${slug(sheetName)}-${slug(label)}`,
        label,
        kind: inferred.kind,
        units: supplied.units || inferred.units,
        physicalRationale: rationale,
        source: supplied.source || "Not stated in workbook",
        physicallyPlausible: inferred.kind !== "other" || rationale.trim().length >= 20,
        values: [...values]
          .sort((a, b) => a[0] - b[0])
          .map(([year, value]) => ({ year, value })),
      });
      usedSheets.add(sheetName);
    }
  }

  if (!covariates.length)
    throw new Error(
      "No annual covariate table was found. Include a Year column and at least one numeric covariate column with eight or more annual values.",
    );
  return {
    covariates,
    sheets: [...usedSheets],
    candidateRows,
    acceptedValues,
    duplicateYears,
    ignoredColumns,
  };
}
