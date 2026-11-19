import { NetCDFReader, type Variable } from "netcdfjs";
import {
  pointInOnlineGeometry,
  type OnlineGeometry,
} from "./online-precipitation.ts";
import { cmip6GeometryBounds, type Cmip6GridSelection } from "./cmip6-online.ts";
import { gridCellOverlap } from "./grid-cell-overlap.ts";
import type { DailyRecord } from "./observed-idf.ts";

type VariableAttribute = {
  name: string;
  value: number | string;
};

function flattenNumbers(value: unknown, output: number[] = []) {
  if (typeof value === "number") {
    output.push(value);
    return output;
  }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    for (const item of Array.from(value as ArrayLike<unknown>))
      flattenNumbers(item, output);
  }
  return output;
}

function variableAttribute(variable: Variable, name: string) {
  const attributes = variable.attributes as unknown as VariableAttribute[];
  return attributes.find(
    (attribute) => attribute.name.toLowerCase() === name.toLowerCase(),
  )?.value;
}

function findVariable(reader: NetCDFReader, names: string[]) {
  const lowered = names.map((name) => name.toLowerCase());
  return reader.variables.find((variable) =>
    lowered.includes(variable.name.toLowerCase()),
  );
}

function parsedTimeUnits(units: string) {
  const cleaned = units.replaceAll("\0", "").trim();
  const match = cleaned.match(
    /^(days?|hours?|minutes?|seconds?)\s+since\s+(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}(?:\.\d+)?))?)?(?:\s*(Z|UTC|([+-])(\d{1,2})(?::?(\d{2}))?))?\s*$/i,
  );
  if (!match)
    throw new Error(
      `NASA returned unsupported NetCDF time units (${units || "not reported"}).`,
    );
  const unit = match[1].toLowerCase();
  const multiplierSeconds = unit.startsWith("day")
    ? 86_400
    : unit.startsWith("hour")
      ? 3_600
      : unit.startsWith("minute")
      ? 60
      : 1;
  const year = Number(match[2]);
  const month = Number(match[3]);
  const day = Number(match[4]);
  const hour = Number(match[5] ?? 0);
  const minute = Number(match[6] ?? 0);
  const second = Number(match[7] ?? 0);
  const timezoneOffsetSeconds = match[9]
    ? (match[9] === "+" ? 1 : -1) *
      (Number(match[10]) * 3_600 + Number(match[11] ?? 0) * 60)
    : 0;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second >= 60 ||
    Math.abs(timezoneOffsetSeconds) > 86_400
  )
    throw new Error(
      `NASA returned invalid NetCDF time units (${units || "not reported"}).`,
    );
  const baseDate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const baseTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}`;
  return {
    multiplierSeconds,
    year,
    month,
    day,
    secondOfDay:
      hour * 3_600 + minute * 60 + second - timezoneOffsetSeconds,
    baseDate,
    baseTime,
    timezoneOffsetSeconds,
  };
}

function gregorianTimeOffsetDate(value: number, units: string) {
  const parsed = parsedTimeUnits(units);
  const base =
    Date.parse(`${parsed.baseDate}T${parsed.baseTime}Z`) -
    parsed.timezoneOffsetSeconds * 1_000;
  const date = new Date(base + value * parsed.multiplierSeconds * 1_000);
  if (!Number.isFinite(date.getTime()))
    throw new Error("NASA returned an invalid NetCDF time coordinate.");
  return date.toISOString().slice(0, 10);
}

const NO_LEAP_MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function fixedCalendarOrdinal(
  year: number,
  month: number,
  day: number,
  monthDays: number[],
) {
  const daysPerYear = monthDays.reduce((sum, value) => sum + value, 0);
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > monthDays[month - 1]
  )
    throw new Error("NASA returned an invalid model-calendar base date.");
  return (
    year * daysPerYear +
    monthDays.slice(0, month - 1).reduce((sum, value) => sum + value, 0) +
    day -
    1
  );
}

function fixedCalendarYearDay(ordinal: number, daysPerYear: number) {
  const year = Math.floor(ordinal / daysPerYear);
  return {
    year,
    dayOfYear: ordinal - year * daysPerYear,
  };
}

function formatNoLeapDate(year: number, dayOfYear: number) {
  let remaining = dayOfYear;
  let month = 0;
  while (
    month < NO_LEAP_MONTH_DAYS.length - 1 &&
    remaining >= NO_LEAP_MONTH_DAYS[month]
  ) {
    remaining -= NO_LEAP_MONTH_DAYS[month];
    month += 1;
  }
  return `${String(year).padStart(4, "0")}-${String(month + 1).padStart(2, "0")}-${String(remaining + 1).padStart(2, "0")}`;
}

function noLeapTimeOffsetDate(value: number, units: string) {
  const parsed = parsedTimeUnits(units);
  const baseOrdinal = fixedCalendarOrdinal(
    parsed.year,
    parsed.month,
    parsed.day,
    NO_LEAP_MONTH_DAYS,
  );
  const wholeDayOrdinal = Math.floor(
    baseOrdinal +
      (parsed.secondOfDay + value * parsed.multiplierSeconds) / 86_400 +
      1e-9,
  );
  const { year, dayOfYear } = fixedCalendarYearDay(wholeDayOrdinal, 365);
  return formatNoLeapDate(year, dayOfYear);
}

export function cmip6NetcdfTimeDates(
  values: number[],
  units: string,
  calendarValue: string,
) {
  const calendar = calendarValue.replaceAll("\0", "").trim().toLowerCase();
  if (calendar === "365_day" || calendar === "noleap")
    return {
      dates: values.map((value) => noLeapTimeOffsetDate(value, units)),
      sourceCalendar: calendar,
      calendarConversion:
        "CF 365-day model years were mapped to the same Gregorian year, month and day. No 29 February was inserted; all 365 model-day precipitation values were retained for annual-maxima analysis.",
    };
  if (
    !calendar ||
    calendar === "standard" ||
    calendar === "gregorian" ||
    calendar === "proleptic_gregorian" ||
    calendar === "julian"
  )
    return {
      dates: values.map((value) => gregorianTimeOffsetDate(value, units)),
      sourceCalendar: calendar || "standard",
      calendarConversion:
        "NASA Gregorian-compatible time coordinates were retained without calendar conversion.",
    };
  throw new Error(
    `NASA returned the ${calendar || "unreported"} calendar. This calendar requires a separately documented resampling rule before it can be represented by unique Gregorian daily timestamps.`,
  );
}

function precipitationMultiplier(units: string) {
  const normalized = units
    .toLowerCase()
    .replaceAll("−", "-")
    .replaceAll("**", "")
    .replace(/\s+/g, " ")
    .trim();
  if (
    /kg\s*m-?2\s*s-?1/.test(normalized) ||
    /kg\/m2\/s/.test(normalized) ||
    normalized === "mm/s"
  )
    return 86_400;
  if (
    normalized === "mm/day" ||
    normalized === "mm d-1" ||
    normalized === "mm"
  )
    return 1;
  throw new Error(
    `NASA returned unsupported precipitation units (${units || "not reported"}).`,
  );
}

function dimensionSize(reader: NetCDFReader, dimensionId: number) {
  const dimension = reader.dimensions[dimensionId];
  if (!dimension)
    throw new Error("NASA returned an invalid NetCDF dimension reference.");
  if (
    dimension.size === 0 &&
    reader.recordDimension.id === dimensionId
  )
    return reader.recordDimension.length;
  return dimension.size;
}

function flatIndex(indices: number[], sizes: number[]) {
  let index = 0;
  for (let position = 0; position < sizes.length; position += 1)
    index = index * sizes[position] + indices[position];
  return index;
}

export function parseCmip6NcssNetcdf(
  data: ArrayBuffer | Uint8Array,
  mode: "point" | "district",
  geometry?: OnlineGeometry,
  spatialDate?: string,
) {
  const reader = new NetCDFReader(data);
  const timeVariable = findVariable(reader, ["time"]);
  const latitudeVariable = findVariable(reader, ["lat", "latitude"]);
  const longitudeVariable = findVariable(reader, ["lon", "longitude"]);
  const precipitationVariable = findVariable(reader, ["pr", "precipitation"]);
  if (
    !timeVariable ||
    !latitudeVariable ||
    !longitudeVariable ||
    !precipitationVariable
  )
    throw new Error(
      `NASA returned an unexpected NetCDF schema (${reader.variables.map((variable) => variable.name).join(", ")}).`,
    );

  const timeValues = flattenNumbers(reader.getDataVariable(timeVariable));
  const latitudes = flattenNumbers(reader.getDataVariable(latitudeVariable));
  const longitudes = flattenNumbers(
    reader.getDataVariable(longitudeVariable),
  ).map((value) => (value > 180 ? value - 360 : value));
  const precipitation = flattenNumbers(
    reader.getDataVariable(precipitationVariable),
  );
  if (
    !timeValues.length ||
    !latitudes.length ||
    !longitudes.length ||
    !precipitation.length
  )
    throw new Error("NASA returned an empty NetCDF precipitation subset.");

  const timeUnits = String(variableAttribute(timeVariable, "units") ?? "");
  const calendar = String(
    variableAttribute(timeVariable, "calendar") ?? "standard",
  ).toLowerCase();
  const sourceUnits = String(variableAttribute(precipitationVariable, "units") ?? "");
  const scaleFactor = Number(variableAttribute(precipitationVariable, "scale_factor") ?? 1);
  const addOffset = Number(variableAttribute(precipitationVariable, "add_offset") ?? 0);
  const missingValues = [
    variableAttribute(precipitationVariable, "_FillValue"),
    variableAttribute(precipitationVariable, "missing_value"),
  ].map(Number).filter(Number.isFinite);

  const dimensionNames = precipitationVariable.dimensions.map(
    (dimensionId) => reader.dimensions[dimensionId]?.name.toLowerCase() ?? "",
  );
  const dimensionSizes = precipitationVariable.dimensions.map(
    (dimensionId) => dimensionSize(reader, dimensionId),
  );
  const timePosition = dimensionNames.findIndex((name) => /time/.test(name));
  const latitudePosition = dimensionNames.findIndex((name) =>
    /^(lat|latitude)$/.test(name),
  );
  const longitudePosition = dimensionNames.findIndex((name) =>
    /^(lon|longitude)$/.test(name),
  );
  if (timePosition < 0 || latitudePosition < 0 || longitudePosition < 0)
    throw new Error(
      `NASA returned unsupported precipitation dimensions (${dimensionNames.join(", ")}).`,
    );
  if (
    dimensionSizes[timePosition] !== timeValues.length ||
    dimensionSizes[latitudePosition] !== latitudes.length ||
    dimensionSizes[longitudePosition] !== longitudes.length
  )
    throw new Error(
      "NASA returned inconsistent NetCDF coordinate and precipitation dimensions.",
    );

  return summarizeCmip6Grid({
    timeValues, timeUnits, calendar, latitudes, longitudes, sourceUnits,
    scaleFactor, addOffset, missingValues,
    readRate: (timeIndex, latitudeIndex, longitudeIndex) => {
      const indices = dimensionSizes.map(() => 0);
      indices[timePosition] = timeIndex;
      indices[latitudePosition] = latitudeIndex;
      indices[longitudePosition] = longitudeIndex;
      return precipitation[flatIndex(indices, dimensionSizes)];
    },
  }, {mode, geometry}, spatialDate);
}

type Cmip6GridData = {
  timeValues: ArrayLike<number>;
  timeUnits: string;
  calendar: string;
  latitudes: ArrayLike<number>;
  longitudes: ArrayLike<number>;
  sourceUnits: string;
  scaleFactor: number;
  addOffset: number;
  missingValues: number[];
  readRate: (timeIndex: number, latitudeIndex: number, longitudeIndex: number) => number;
};

export type Cmip6GridLocation = {
  mode: "point" | "district";
  geometry?: OnlineGeometry;
  latitude?: number;
  longitude?: number;
};

/** Shared spatial and calendar rules for live and archive NetCDF extraction. */
export function summarizeCmip6Grid(grid: Cmip6GridData, location: Cmip6GridLocation, spatialDate?: string) {
  const { latitudes, longitudes, timeUnits, calendar, sourceUnits, scaleFactor, addOffset, missingValues, readRate } = grid;
  const calendarTime = cmip6NetcdfTimeDates(Array.from(grid.timeValues), timeUnits, calendar);
  const dates = calendarTime.dates;
  const unitMultiplier = precipitationMultiplier(sourceUnits);
  const latitudeSize = latitudes.length > 1 ? Math.abs(latitudes[1] - latitudes[0]) : 0.25;
  const longitudeSize = longitudes.length > 1 ? Math.abs(longitudes[1] - longitudes[0]) : 0.25;
  const allCells = Array.from(latitudes).flatMap((latitude, latitudeIndex) =>
    Array.from(longitudes, (longitude, longitudeIndex) => ({
      latitude, longitude, latitudeIndex, longitudeIndex,
      weight: Math.max(0.01, Math.cos(latitude * Math.PI / 180)),
    })),
  );

  const nearestTo = (latitude: number, longitude: number, cells = allCells) => {
    let nearest: typeof allCells[number] | undefined;
    let distance = Infinity;
    for (const cell of cells) {
      const squared = (cell.latitude - latitude) ** 2 + (cell.longitude - longitude) ** 2;
      if (squared < distance) {
        nearest = cell;
        distance = squared;
      }
    }
    return nearest ? [nearest] : [];
  };

  let acceptedCells = allCells;
  let gridSelection: Cmip6GridSelection = location.mode === "district" ? "centres" : "point";
  if (location.mode === "point" && location.latitude != null && location.longitude != null) {
    acceptedCells = nearestTo(location.latitude, location.longitude);
  } else if (location.mode === "district" && location.geometry) {
    const geometry = location.geometry;
    const {west, east, south, north} = cmip6GeometryBounds(geometry);
    const candidates = allCells.filter(cell =>
      cell.latitude + latitudeSize / 2 >= south && cell.latitude - latitudeSize / 2 <= north &&
      cell.longitude + longitudeSize / 2 >= west && cell.longitude - longitudeSize / 2 <= east,
    );
    acceptedCells = candidates.filter(cell => pointInOnlineGeometry(cell.longitude, cell.latitude, geometry));
    if (!acceptedCells.length) {
      acceptedCells = candidates.map(cell => ({
        ...cell, weight: gridCellOverlap(geometry, cell.latitude, cell.longitude, latitudeSize, longitudeSize),
      })).filter(cell => cell.weight > 0);
      gridSelection = "overlap";
    }
    if (!acceptedCells.length) {
      acceptedCells = nearestTo((north + south) / 2, (east + west) / 2);
      gridSelection = "nearest";
    }
  }
  if (!acceptedCells.length)
    throw new Error("No NASA grid cells could be assigned to the selected extraction geometry.");

  const spatialCells: {latitude:number; longitude:number; precipitationMm:number; latitudeSize:number; longitudeSize:number; weight:number}[] = [];
  const records: DailyRecord[] = [];
  for (const [timeIndex, date] of dates.entries()) {
    let weightedSum = 0;
    let validWeight = 0;
    for (const cell of acceptedCells) {
      const raw = readRate(timeIndex, cell.latitudeIndex, cell.longitudeIndex);
      if (!Number.isFinite(raw) || missingValues.some(missing =>
        Math.abs(raw - missing) <= Math.max(1, Math.abs(missing)) * 1e-7,
      )) continue;
      const precipitationMm = (raw * scaleFactor + addOffset) * unitMultiplier;
      if (!Number.isFinite(precipitationMm) || precipitationMm < 0 || precipitationMm > 5_000) continue;
      if (spatialDate && date === spatialDate) {
        const {latitude, longitude, weight} = cell;
        spatialCells.push({latitude, longitude, precipitationMm, weight, latitudeSize, longitudeSize});
      }
      weightedSum += precipitationMm * cell.weight;
      validWeight += cell.weight;
    }
    if (validWeight > 0) {
      records.push({ date, precipitationMm: +(weightedSum / validWeight).toFixed(4), qc: "provider" });
    }
  }
  if (!records.length)
    throw new Error("NASA returned no usable non-negative daily precipitation values.");

  const firstCell = acceptedCells[0];
  return {
    records,
    spatialCells,
    extractedGridCells: acceptedCells.length,
    returnedLatitude: location.mode === "point" ? firstCell.latitude : undefined,
    returnedLongitude: location.mode === "point" ? firstCell.longitude : undefined,
    gridSelection,
    nearestCellFallback: gridSelection === "nearest",
    sourceUnits,
    sourceTimeUnits: timeUnits,
    sourceCalendar: calendarTime.sourceCalendar,
    calendarConversion: calendarTime.calendarConversion,
  };
}
