import type { Dataset, File } from "h5wasm";
import { cmip6GeometryBounds } from "./cmip6-online.ts";
import { summarizeCmip6Grid, type Cmip6GridLocation } from "./cmip6-netcdf.ts";

type Bounds = ReturnType<typeof cmip6GeometryBounds>;

// Common region for the Atlas boundary layer and project points. A cached
// annual native-grid cutout serves multiple districts and point locations.
const ATLAS_REGION = { west: 60.5, east: 80.75, south: 23, north: 37.5 };

export type Cmip6ArchiveGrid = {
  timeValues: number[];
  timeUnits: string;
  calendar: string;
  latitudes: number[];
  longitudes: number[];
  sourceUnits: string;
  scaleFactor: number;
  addOffset: number;
  missingValues: number[];
  rates: Float32Array | Float64Array;
};

export function cmip6ArchiveBounds(location: Cmip6GridLocation): Bounds {
  const bounds = location.geometry
    ? cmip6GeometryBounds(location.geometry)
    : { west: location.longitude!, east: location.longitude!, south: location.latitude!, north: location.latitude! };
  const padded = {
    west: bounds.west - 0.13,
    east: bounds.east + 0.13,
    south: bounds.south - 0.13,
    north: bounds.north + 0.13,
  };
  if (padded.west >= ATLAS_REGION.west && padded.east <= ATLAS_REGION.east &&
      padded.south >= ATLAS_REGION.south && padded.north <= ATLAS_REGION.north)
    return ATLAS_REGION;
  return padded;
}

function variable(file: File, name: string) {
  const dataset = file.get(name);
  if (!dataset || !("slice" in dataset)) throw new Error(`The NASA NetCDF file is missing ${name}.`);
  return dataset as Dataset;
}

function numbers(dataset: Dataset) {
  const value = dataset.value;
  if (!value || !ArrayBuffer.isView(value))
    throw new Error("The NASA NetCDF coordinate axis is not numeric.");
  return Array.from(value as ArrayLike<number>, Number);
}

function axisSlice(values: number[], lower: number, upper: number): [number, number] {
  const first = values.findIndex(value => value >= lower && value <= upper);
  const last = values.findLastIndex(value => value >= lower && value <= upper);
  if (first < 0 || values.slice(first, last + 1).some(value => value < lower || value > upper)) {
    throw new Error("The NASA NetCDF grid cannot supply a contiguous subset for this location.");
  }
  return [first, last + 1];
}

export function readCmip6ArchiveGrid(file: File, bounds: Bounds): Cmip6ArchiveGrid {
  const time = variable(file, "time");
  const pr = variable(file, "pr");
  const timeValues = numbers(time);
  const latitudes = numbers(variable(file, "lat"));
  const longitudes = numbers(variable(file, "lon")).map(value => value > 180 ? value - 360 : value);
  const shape = pr.shape;
  if (shape?.length !== 3 || shape[0] !== timeValues.length ||
      shape[1] !== latitudes.length || shape[2] !== longitudes.length) {
    throw new Error("The NASA NetCDF precipitation array has unexpected time, latitude or longitude dimensions.");
  }
  const latitudeSlice = axisSlice(latitudes, bounds.south, bounds.north);
  const longitudeSlice = axisSlice(longitudes, bounds.west, bounds.east);
  const count = timeValues.length * (latitudeSlice[1] - latitudeSlice[0]) * (longitudeSlice[1] - longitudeSlice[0]);
  if (count > 4_000_000) throw new Error("The requested NASA archive region exceeds the interactive subset limit.");
  const values = pr.slice([[], latitudeSlice, longitudeSlice]);
  if (!(values instanceof Float32Array || values instanceof Float64Array) || values.length !== count) {
    throw new Error("The NASA NetCDF archive returned invalid native precipitation values.");
  }

  return {
    timeValues,
    timeUnits: String(time.attrs.units?.value ?? ""),
    calendar: String(time.attrs.calendar?.value ?? "standard"),
    latitudes: latitudes.slice(...latitudeSlice),
    longitudes: longitudes.slice(...longitudeSlice),
    sourceUnits: String(pr.attrs.units?.value ?? ""),
    scaleFactor: Number(pr.attrs.scale_factor?.value ?? 1),
    addOffset: Number(pr.attrs.add_offset?.value ?? 0),
    missingValues: [pr.attrs._FillValue?.value, pr.attrs.missing_value?.value].map(Number).filter(Number.isFinite),
    rates: values,
  };
}

export function summarizeCmip6ArchiveGrid(grid: Cmip6ArchiveGrid, location: Cmip6GridLocation, spatialDate?: string) {
  const {rates, ...metadata} = grid;
  const width = grid.longitudes.length;
  const area = grid.latitudes.length * width;
  return summarizeCmip6Grid({
    ...metadata,
    readRate: (time, latitude, longitude) => rates[time * area + latitude * width + longitude],
  }, location, spatialDate);
}
