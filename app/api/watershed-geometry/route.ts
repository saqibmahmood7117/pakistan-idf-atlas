import {
  coordinateAtFlowFraction,
  extractLineStrings,
  flowPathLengthMetres,
  longestConnectedFlowPath,
  normalizeFeatureCollection,
  type Position,
  type WatershedGeometryResult,
} from "../../../lib/watershed-geometry";

const MGHYDRO_BASE = "https://mghydro.com/app";
const ELEVATION_API = "https://api.open-meteo.com/v1/elevation";

type RequestBody =
  | {
      action: "mghydro";
      latitude: number;
      longitude: number;
      precision?: "low" | "high";
    }
  | {
      action: "profile";
      coordinates: Position[];
    };

function json(
  body: { status: "complete"; result: WatershedGeometryResult } | { status: "error"; error: string },
  status = 200,
) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function providerJson(url: string, timeoutMs = 120_000) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "The provider could not delineate a watershed at this outlet. Move the point onto the mapped river and try again."
        : `The provider returned HTTP ${response.status}. Try again later.`,
    );
  return (await response.json()) as unknown;
}

async function elevations(coordinates: Position[]) {
  const url = new URL(ELEVATION_API);
  url.searchParams.set(
    "latitude",
    coordinates.map((coordinate) => coordinate[1].toFixed(6)).join(","),
  );
  url.searchParams.set(
    "longitude",
    coordinates.map((coordinate) => coordinate[0].toFixed(6)).join(","),
  );
  const payload = (await providerJson(url.toString(), 30_000)) as {
      elevation?: unknown;
    },
    values = Array.isArray(payload.elevation)
      ? payload.elevation.map(Number)
      : [Number(payload.elevation)];
  if (
    values.length !== coordinates.length ||
    values.some((value) => !Number.isFinite(value))
  )
    throw new Error("The elevation service returned incomplete terrain values.");
  return values;
}

async function profileCoordinates(sourceCoordinates: Position[]) {
  let coordinates = sourceCoordinates.filter(
    (coordinate) =>
      Array.isArray(coordinate) &&
      coordinate.length >= 2 &&
      Number.isFinite(coordinate[0]) &&
      Number.isFinite(coordinate[1]),
  );
  if (coordinates.length < 2)
    throw new Error("The flow path must contain at least two valid coordinates.");
  if (coordinates.length > 50_000)
    throw new Error("The uploaded flow path exceeds the 50,000-vertex limit.");
  const endpointElevations = await elevations([
    coordinates[0],
    coordinates.at(-1)!,
  ]);
  if (endpointElevations[0] > endpointElevations[1])
    coordinates = [...coordinates].reverse();
  const outlet = coordinateAtFlowFraction(coordinates, 0)!,
    point10 = coordinateAtFlowFraction(coordinates, 0.1)!,
    point85 = coordinateAtFlowFraction(coordinates, 0.85)!,
    upstream = coordinateAtFlowFraction(coordinates, 1)!,
    [outletElevationMetres, elevation10Metres, elevation85Metres, upstreamElevationMetres] =
      await elevations([outlet, point10, point85, upstream]),
    lengthMetres = flowPathLengthMetres(coordinates),
    endpointSlopeMPerM =
      (upstreamElevationMetres - outletElevationMetres) / lengthMetres,
    slope10To85MPerM =
      (elevation85Metres - elevation10Metres) / (0.75 * lengthMetres);
  if (!(lengthMetres > 0)) throw new Error("The calculated flow-path length is zero.");
  if (!(endpointSlopeMPerM > 0) || !(slope10To85MPerM > 0))
    throw new Error(
      "The terrain profile did not rise from outlet to upstream end. Check the outlet, flow-path direction and DEM suitability.",
    );
  return {
    lengthMetres,
    endpointSlopeMPerM,
    slope10To85MPerM,
    outletElevationMetres,
    upstreamElevationMetres,
    elevation10Metres,
    elevation85Metres,
    coordinates,
  };
}

async function mghydroResult(
  latitude: number,
  longitude: number,
  precision: "low" | "high",
) {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -60 ||
    latitude > 85 ||
    longitude < -180 ||
    longitude > 180
  )
    throw new Error(
      "Enter an outlet within MGHydro coverage: latitude −60 to 85 and longitude −180 to 180.",
    );
  const query = new URLSearchParams({
      lat: latitude.toFixed(6),
      lng: longitude.toFixed(6),
      precision,
      simplify: "true",
      beautify: "false",
    }),
    watershedPayload = await providerJson(
      `${MGHYDRO_BASE}/watershed_api?${query}`,
    ),
    watershed = normalizeFeatureCollection(watershedPayload);
  if (!watershed?.features.length)
    throw new Error("MGHydro returned no watershed polygon for this outlet.");

  // MGHydro asks API clients to avoid asynchronous requests and pause between calls.
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const riverPayload = await providerJson(
      `${MGHYDRO_BASE}/upstream_rivers_api?${query}`,
    ),
    lines = extractLineStrings(riverPayload),
    longest = longestConnectedFlowPath(lines, [longitude, latitude]);
  if (!longest || longest.lengthMetres < 10)
    throw new Error(
      "MGHydro returned a watershed but no connected upstream flow path. Move the outlet onto the mapped channel and retry.",
    );
  const profile = await profileCoordinates(longest.coordinates);
  return {
    status: "complete" as const,
    result: {
      ...profile,
      source: "mghydro" as const,
      precision,
      outletLatitude: profile.coordinates[0][1],
      outletLongitude: profile.coordinates[0][0],
      watershed,
      pathSource:
        "MGHydro Global Watersheds API · MERIT-Hydro/MERIT-Basins upstream river network",
      elevationSource:
        "Open-Meteo Elevation API · Copernicus DEM GLO-90 (90 m)",
      retrievedAt: new Date().toISOString(),
      limitations:
        "The path is the hydraulically farthest connected route in the returned river network. Mapped river lengths can be underestimated, outlet snapping can select the wrong branch, and 90 m DEM elevations smooth local terrain. Visually review the watershed and path before design use.",
    },
  };
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as RequestBody;
    if (body.action === "mghydro")
      return json(
        await mghydroResult(
          Number(body.latitude),
          Number(body.longitude),
          body.precision === "low" ? "low" : "high",
        ),
      );
    if (body.action === "profile") {
      const profile = await profileCoordinates(body.coordinates ?? []);
      return json({
        status: "complete",
        result: {
          ...profile,
          source: "uploaded-flow-path",
          precision: "uploaded",
          outletLatitude: profile.coordinates[0][1],
          outletLongitude: profile.coordinates[0][0],
          watershed: null,
          pathSource: "User-uploaded HEC-HMS/QGIS flow-path geometry",
          elevationSource:
            "Open-Meteo Elevation API · Copernicus DEM GLO-90 (90 m)",
          retrievedAt: new Date().toISOString(),
          limitations:
            "Length follows the uploaded line. Confirm that it represents the hydraulically longest path from the outlet; 90 m DEM elevations can smooth local terrain.",
        },
      });
    }
    return json({ status: "error", error: "Unsupported calculation action." }, 400);
  } catch (error) {
    return json(
      {
        status: "error",
        error:
          error instanceof Error
            ? error.message
            : "The watershed geometry calculation failed.",
      },
      400,
    );
  }
}

// Vercel request limit; availability depends on the selected hosting plan.
export const maxDuration = 300;
