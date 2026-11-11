import { DISTRICTS, SOURCE_META, type SourceId } from "../../../lib/idf-data";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const district = url.searchParams.get("district") ?? "Peshawar";
  const source = (url.searchParams.get("source") ?? "fused") as SourceId;
  const spatialMode = url.searchParams.get("spatialMode") ?? "district";
  const latitudeValue = url.searchParams.get("latitude");
  const longitudeValue = url.searchParams.get("longitude");
  const latitude = latitudeValue === null || latitudeValue.trim() === "" ? NaN : Number(latitudeValue);
  const longitude = longitudeValue === null || longitudeValue.trim() === "" ? NaN : Number(longitudeValue);

  if (!DISTRICTS.some((item) => item.name === district)) {
    return Response.json({ error: "Unknown PBS-2023 district" }, { status: 400 });
  }
  if (
    ![
      "era5",
      "ifs",
      "era5land",
      "imerg",
      "imergEarly",
      "chirps",
      "power",
      "cmip6",
    ].includes(source)
  ) {
    return Response.json({ error: "Unsupported source" }, { status: 400 });
  }
  if (!["district", "point"].includes(spatialMode)) {
    return Response.json({ error: "Unsupported spatial extraction mode" }, { status: 400 });
  }
  if (spatialMode === "point" && (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)) {
    return Response.json({ error: "Point extraction requires valid latitude and longitude" }, { status: 400 });
  }

  const meta=SOURCE_META[source];
  return Response.json({
    dataStatus: "not_ingested",
    district,
    source,
    dataset: meta.label,
    spatialExtraction: spatialMode === "point"
      ? { mode: "point", latitude, longitude, method: "Containing or nearest provider grid cell" }
      : { mode: "district", district, method: "Clip intersecting cells and calculate an overlap-area-weighted daily mean" },
    message: spatialMode === "point"
      ? "No synthetic precipitation is returned. Download the real provider point/grid-cell series at the requested coordinates, record the returned grid-cell coordinates, then upload the processed series for empirical fitting."
      : "No synthetic precipitation is returned. Download the real provider raster files, clip all intersecting cells to the selected district, calculate an overlap-area-weighted daily mean, then upload the processed series for empirical fitting.",
    officialDownloadUrl: meta.accessUrl,
    providerAccess: meta.accessMode,
  }, {status:501});
}
