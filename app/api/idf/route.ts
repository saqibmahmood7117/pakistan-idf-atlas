import { buildIdfRows, cmip6ModelScreeningFactor, cmip6ScreeningFactor, CMIP6_MODELS, CMIP6_PERIODS, CMIP6_SCENARIOS, DISTRICTS, type Cmip6Period, type Cmip6Scenario, type ModelType, type SourceId, type SpatialExtraction } from "../../../lib/idf-data";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const district = url.searchParams.get("district") ?? "Peshawar";
  const source = (url.searchParams.get("source") ?? "fused") as SourceId;
  const model = (url.searchParams.get("model") ?? "stationary") as ModelType;
  const referenceYear = Number(url.searchParams.get("referenceYear") ?? 2025);
  const scenario = (url.searchParams.get("scenario") ?? "ssp245") as Cmip6Scenario;
  const period = (url.searchParams.get("period") ?? "2041-2070") as Cmip6Period;
  const gcmMode = url.searchParams.get("gcmMode") ?? "ensemble";
  const gcmModel = url.searchParams.get("gcmModel") ?? "ACCESS-CM2";
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
      "fused",
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
  if (!["stationary", "nonstationary"].includes(model)) {
    return Response.json({ error: "Unsupported model" }, { status: 400 });
  }
  if (!["district", "point"].includes(spatialMode)) {
    return Response.json({ error: "Unsupported spatial extraction mode" }, { status: 400 });
  }
  if (spatialMode === "point" && (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180)) {
    return Response.json({ error: "Point extraction requires valid latitude and longitude" }, { status: 400 });
  }
  if (source === "cmip6" && (!Object.hasOwn(CMIP6_SCENARIOS, scenario) || !Object.hasOwn(CMIP6_PERIODS, period))) {
    return Response.json({ error: "Unsupported CMIP6 scenario or period" }, { status: 400 });
  }
  if (source === "cmip6" && !["ensemble", "individual"].includes(gcmMode)) {
    return Response.json({ error: "Unsupported CMIP6 GCM selection mode" }, { status: 400 });
  }
  if (source === "cmip6" && gcmMode === "individual" && !CMIP6_MODELS.includes(gcmModel as (typeof CMIP6_MODELS)[number])) {
    return Response.json({ error: "Unsupported individual CMIP6 GCM" }, { status: 400 });
  }

  const selectedGcm = gcmModel as (typeof CMIP6_MODELS)[number];
  const spatial: SpatialExtraction = spatialMode === "point" ? { mode: "point", latitude, longitude } : { mode: "district" };
  const modelFingerprint = source === "cmip6" && gcmMode === "individual" ? cmip6ModelScreeningFactor(selectedGcm) : 1;
  const factor = source === "cmip6" ? cmip6ScreeningFactor(scenario, period, model, gcmMode as "ensemble" | "individual", selectedGcm) : 1;
  const rows = buildIdfRows(district, source, source === "cmip6" ? "stationary" : model, source === "cmip6" ? CMIP6_PERIODS[period].midpoint : referenceYear, spatial).map((row) => ({
    ...row,
    model,
    depthMm: Number((row.depthMm * factor).toFixed(2)),
    intensityMmHr: Number((row.intensityMmHr * factor).toFixed(2)),
    ciLower: Number((row.ciLower * factor).toFixed(2)),
    ciUpper: Number((row.ciUpper * factor).toFixed(2)),
  }));

  return Response.json({
    boundaryVersion: "PBS-2023",
    dataStatus: "screening_demo",
    warning: source === "cmip6" ? "CMIP6 interface-screening values only. The individual-model fingerprint is deterministic and is not calculated from downloaded GCM precipitation. Live extraction, historical evaluation, bias adjustment and ensemble fitting are not connected; do not use for design." : "Not an official PMD engineering product. Replace with validated source adapters before design use.",
    spatialExtraction: spatialMode === "point"
      ? { mode: "point", latitude, longitude, method: "Containing or nearest provider grid cell; screening profile only until pixels are ingested" }
      : { mode: "district", district, method: "Polygon-intersection overlap-area-weighted daily mean; screening profile only until pixels are ingested" },
    projection: source === "cmip6" ? { dataset: "NASA NEX-GDDP-CMIP6 v2", catalogueModelGridEntries: CMIP6_MODELS.length, selectionMode: gcmMode, modelOrEnsemble: gcmMode === "ensemble" ? "Multi-model median" : gcmModel, scenario: CMIP6_SCENARIOS[scenario].label, period, midpoint: CMIP6_PERIODS[period].midpoint, modelScreeningFingerprint: Number(modelFingerprint.toFixed(4)), combinedScreeningFactor: Number(factor.toFixed(4)), status: "screening_demo" } : null,
    rows,
  });
}
