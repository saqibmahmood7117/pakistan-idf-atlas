export const DISTRICTS_BY_REGION = {
  "Khyber Pakhtunkhwa": [
    "Upper Chitral", "Lower Chitral", "Upper Dir", "Lower Dir", "Swat",
    "Shangla", "Buner", "Malakand", "Bajaur", "Upper Kohistan",
    "Lower Kohistan", "Kolai Pallas Kohistan", "Mansehra", "Torghar",
    "Battagram", "Abbottabad", "Haripur", "Mardan", "Swabi", "Charsadda",
    "Peshawar", "Nowshera", "Khyber", "Mohmand", "Kohat", "Hangu", "Karak",
    "Orakzai", "Kurram", "Bannu", "Lakki Marwat", "North Waziristan",
    "Dera Ismail Khan", "Tank", "South Waziristan",
  ],
  Punjab: [
    "Attock", "Rawalpindi", "Jhelum", "Chakwal", "Sargodha", "Bhakkar",
    "Khushab", "Mianwali", "Faisalabad", "Jhang", "Chiniot", "Toba Tek Singh",
    "Gujranwala", "Hafizabad", "Gujrat", "Mandi Bahauddin", "Sialkot",
    "Narowal", "Lahore", "Kasur", "Sheikhupura", "Nankana Sahib", "Sahiwal",
    "Okara", "Pakpattan", "Vehari", "Multan", "Lodhran", "Khanewal",
    "Dera Ghazi Khan", "Rajanpur", "Layyah", "Muzaffargarh", "Bahawalpur",
    "Bahawalnagar", "Rahim Yar Khan",
  ],
  Sindh: [
    "Jacobabad", "Kashmore", "Shikarpur", "Larkana", "Kambar Shahdadkot",
    "Sukkur", "Ghotki", "Khairpur", "Naushahro Feroze", "Shaheed Benazirabad",
    "Sanghar", "Dadu", "Jamshoro", "Hyderabad", "Matiari", "Tando Allah Yar",
    "Tando Muhammad Khan", "Badin", "Thatta", "Sujawal", "Mirpur Khas",
    "Umerkot", "Tharparkar", "Karachi East", "Karachi West", "Karachi South",
    "Karachi Central", "Malir", "Korangi",
  ],
  Balochistan: [
    "Quetta", "Pishin", "Killa Abdullah", "Chaman", "Chagai", "Nushki",
    "Kharan", "Washuk", "Loralai", "Duki", "Barkhan", "Musa Khel",
    "Killa Saifullah", "Zhob", "Sherani", "Sibi", "Harnai", "Ziarat", "Kohlu",
    "Dera Bugti", "Jaffarabad", "Nasirabad", "Kachhi (Bolan)", "Jhal Magsi",
    "Sohbatpur", "Kalat", "Surab", "Mastung", "Khuzdar", "Awaran", "Lasbela",
    "Kech", "Gwadar", "Panjgur", "Lehri",
  ],
  "Azad Jammu & Kashmir": [
    "Hattian Bala", "Muzaffarabad", "Neelum", "Bagh", "Haveli", "Sudhnoti",
    "Poonch", "Bhimber", "Mirpur", "Kotli",
  ],
  "Gilgit-Baltistan": [
    "Gilgit", "Hunza", "Nagar", "Ghizer", "Skardu", "Kharmang", "Shigar",
    "Ghanche", "Astore", "Diamer", "Darel", "Tangir", "Gupis-Yasin", "Rondu",
  ],
  "Islamabad Capital Territory": ["Islamabad"],
} as const;

export type Region = keyof typeof DISTRICTS_BY_REGION;
export type SourceId =
  | "fused"
  | "era5"
  | "era5land"
  | "imerg"
  | "imergEarly"
  | "chirps"
  | "power"
  | "cmip6";
export type ModelType = "stationary" | "nonstationary";
export type SpatialExtraction =
  | { mode: "district" }
  | { mode: "point"; latitude: number; longitude: number };
export type Cmip6Scenario = "ssp126" | "ssp245" | "ssp370" | "ssp585";
export type Cmip6Period = "2021-2040" | "2041-2060" | "2061-2080" | "2081-2100" | "2021-2050" | "2041-2070" | "2071-2100";

export const CMIP6_SCENARIOS: Record<Cmip6Scenario, { label: string; description: string; screeningChange2100: number }> = {
  ssp126: { label: "SSP1-2.6", description: "Low-emissions pathway", screeningChange2100: 0.06 },
  ssp245: { label: "SSP2-4.5", description: "Intermediate pathway", screeningChange2100: 0.12 },
  ssp370: { label: "SSP3-7.0", description: "High-emissions pathway", screeningChange2100: 0.20 },
  ssp585: { label: "SSP5-8.5", description: "Very high-emissions pathway", screeningChange2100: 0.28 },
};
export const CMIP6_PERIODS: Record<Cmip6Period, { label: string; midpoint: number }> = {
  "2021-2040": { label: "Near term · 2021–2040 (20 years · provisional)", midpoint: 2030 },
  "2041-2060": { label: "Mid-century · 2041–2060 (20 years · provisional)", midpoint: 2050 },
  "2061-2080": { label: "Late century · 2061–2080 (20 years · provisional)", midpoint: 2070 },
  "2081-2100": { label: "End century · 2081–2100 (20 years · provisional)", midpoint: 2090 },
  "2021-2050": { label: "Near term · 2021–2050 (30 years)", midpoint: 2035 },
  "2041-2070": { label: "Mid-century · 2041–2070 (30 years)", midpoint: 2055 },
  "2071-2100": { label: "Late century · 2071–2100 (30 years)", midpoint: 2085 },
};
export const CMIP6_MODELS = [
  "ACCESS-CM2",
  "ACCESS-ESM1-5",
  "BCC-CSM2-MR",
  "CanESM5",
  "CESM2",
  "CESM2-WACCM",
  "CMCC-CM2-SR5",
  "CMCC-ESM2",
  "CNRM-CM6-1",
  "CNRM-ESM2-1",
  "EC-Earth3",
  "EC-Earth3-Veg-LR",
  "FGOALS-g3",
  "GFDL-CM4 (gr1)",
  "GFDL-CM4 (gr2)",
  "GFDL-ESM4",
  "GISS-E2-1-G",
  "HadGEM3-GC31-LL",
  "HadGEM3-GC31-MM",
  "IITM-ESM",
  "INM-CM4-8",
  "INM-CM5-0",
  "IPSL-CM6A-LR",
  "KACE-1-0-G",
  "KIOST-ESM",
  "MIROC-ES2L",
  "MIROC6",
  "MPI-ESM1-2-HR",
  "MPI-ESM1-2-LR",
  "MRI-ESM2-0",
  "NESM3",
  "NorESM2-LM",
  "NorESM2-MM",
  "TaiESM1",
  "UKESM1-0-LL",
] as const;

export const PAKISTAN_IDF_ENSEMBLE_MODELS = [
  "NESM3",
  "CMCC-ESM2",
  "CNRM-CM6-1",
  "CNRM-ESM2-1",
  "EC-Earth3-Veg-LR",
  "GFDL-ESM4",
  "INM-CM4-8",
  "INM-CM5-0",
  "MIROC6",
  "MRI-ESM2-0",
] as const satisfies readonly (typeof CMIP6_MODELS)[number][];

export const DISTRICTS = Object.entries(DISTRICTS_BY_REGION).flatMap(
  ([region, districts]) => districts.map((name) => ({ name, region: region as Region })),
);

export const DURATIONS = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
export const RETURN_PERIODS = [2, 5, 10, 25, 50, 100, 250, 500];

export const SOURCE_META = {
  fused: {
    label: "Gauge–Grid Fused",
    short: "Fused",
    temporal: "Daily / sub-daily",
    coverage: "District screening layer",
    status: "Demonstration profile",
    factor: 1,
    accessUrl: "",
    accessLabel: "No external product",
    accessMode: "Upload a documented gauge–grid dataset in the Observed Excel Data tab.",
  },
  era5: {
    label: "ERA5 reanalysis",
    short: "ERA5",
    temporal: "Hourly native data · daily sums retrieved · 1981–present in the atlas",
    coverage: "0.25° global reanalysis",
    status: "Live point and district extraction",
    factor: 0.94,
    accessUrl: "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-single-levels",
    accessLabel: "Copernicus ERA5 · retrieved through Open-Meteo",
    accessMode: "The atlas retrieves hourly or daily precipitation from the ERA5 model through the Open-Meteo Historical Weather API and records the temporal resolution, returned grid and spatial method.",
  },
  era5land: {
    label: "ERA5-Land reanalysis",
    short: "ERA5-Land",
    temporal: "Hourly native data · daily sums retrieved · 1950–present",
    coverage: "0.1° global land-surface reanalysis",
    status: "Live point and district extraction",
    factor: 0.96,
    accessUrl:
      "https://cds.climate.copernicus.eu/datasets/reanalysis-era5-land",
    accessLabel: "Copernicus ERA5-Land · retrieved through Open-Meteo",
    accessMode:
      "The atlas retrieves hourly or daily precipitation from ERA5-Land through the Open-Meteo Historical Weather API. District mode uses documented overlap-weighted representative 0.1° cells.",
  },
  imerg: {
    label: "NASA IMERG V07 Late daily",
    short: "IMERG V07 Late",
    temporal: "Daily · June 2000–present",
    coverage: "0.1° satellite precipitation",
    status: "Live point and district extraction",
    factor: 1.08,
    accessUrl: "https://gpm.nasa.gov/data/imerg",
    accessLabel: "NASA GPM · retrieved through SERVIR ClimateSERV",
    accessMode: "The atlas submits the selected point buffer or district polygon to ClimateSERV datatype 226 and retrieves provider-computed daily means.",
  },
  imergEarly: {
    label: "NASA IMERG V07 Early daily",
    short: "IMERG V07 Early",
    temporal: "Daily · June 2000–present",
    coverage: "0.1° near-real-time satellite precipitation",
    status: "Live point and district extraction",
    factor: 1.06,
    accessUrl: "https://gpm.nasa.gov/data/imerg",
    accessLabel: "NASA GPM · retrieved through SERVIR ClimateSERV",
    accessMode:
      "The atlas submits shorter point-buffer or district-polygon jobs to ClimateSERV datatype 227 and retrieves provider-computed daily means. Early Run is a separate near-real-time product and is never silently substituted for Late Run.",
  },
  chirps: {
    label: "CHIRPS daily",
    short: "CHIRPS",
    temporal: "Daily · 1981–present",
    coverage: "0.05° satellite–gauge",
    status: "Live point and district extraction",
    factor: 0.98,
    accessUrl: "https://www.chc.ucsb.edu/data/chirps",
    accessLabel: "UCSB Climate Hazards Center · retrieved through SERVIR ClimateSERV",
    accessMode: "The atlas submits the selected point buffer or exact district polygon to ClimateSERV datatype 0 and retrieves provider-computed daily means.",
  },
  power: {
    label: "NASA POWER MERRA-2 corrected daily",
    short: "NASA POWER",
    temporal: "Daily · 1981–near real time",
    coverage: "0.5° × 0.625° MERRA-2 meteorology",
    status: "Live point and district extraction",
    factor: 0.95,
    accessUrl: "https://power.larc.nasa.gov/",
    accessLabel: "NASA POWER Daily API · PRECTOTCORR",
    accessMode:
      "The atlas retrieves corrected daily MERRA-2 precipitation from NASA POWER. Point mode uses the returned grid cell; district mode forms an approximate overlap-weighted mean from representative native grid cells.",
  },
  cmip6: {
    label: "NASA NEX-GDDP-CMIP6",
    short: "CMIP6",
    temporal: "Daily · historical 1950–2014; scenarios 2015–2100",
    coverage: "0.25° global bias-corrected GCM projections",
    status: "Live model-specific point and district extraction",
    factor: 1,
    accessUrl: "https://ds.nccs.nasa.gov/thredds/catalog/AMES/NEX/GDDP-CMIP6/catalog.html",
    accessLabel: "NASA NCCS THREDDS",
    accessMode: "The atlas reads the selected model, SSP and realization from the public NASA catalogue, retrieves annual daily precipitation subsets through NCCS THREDDS, converts pr to mm/day and fits the returned series.",
  },
} as const;

const REGION_BASE: Record<Region, number> = {
  "Khyber Pakhtunkhwa": 78,
  Punjab: 65,
  Sindh: 54,
  Balochistan: 43,
  "Azad Jammu & Kashmir": 92,
  "Gilgit-Baltistan": 50,
  "Islamabad Capital Territory": 74,
};

const REGION_MAP: Record<Region, [number, number]> = {
  "Khyber Pakhtunkhwa": [357, 144],
  Punjab: [410, 263],
  Sindh: [316, 423],
  Balochistan: [203, 337],
  "Azad Jammu & Kashmir": [452, 128],
  "Gilgit-Baltistan": [398, 63],
  "Islamabad Capital Territory": [405, 201],
};

export function stableSeed(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

export function getDistrict(name: string) {
  return DISTRICTS.find((district) => district.name === name) ?? DISTRICTS.find((d) => d.name === "Peshawar")!;
}

export function districtProfile(name: string, source: SourceId = "fused") {
  const district = getDistrict(name);
  const seed = stableSeed(name);
  const base24 = (REGION_BASE[district.region] + (seed % 31) - 10) * SOURCE_META[source].factor;
  const validYears =
    source === "imerg" || source === "imergEarly"
      ? 25
      : source === "chirps" || source === "power"
        ? 44
        : source === "cmip6"
          ? 86
          : 34 + (seed % 12);
  const gradeIndex = source === "fused" ? seed % 5 : 2 + (seed % 3);
  const coverageGrade = gradeIndex <= 1 ? "A" : gradeIndex <= 3 ? "B" : "C";
  const [baseX, baseY] = REGION_MAP[district.region];
  const jitterX = (seed % 29) - 14;
  const jitterY = ((seed >> 4) % 25) - 12;
  const trend = 0.0032 + ((seed >> 7) % 31) / 10000;
  const dailyRainfall = Math.max(0, ((seed % 260) / 10) * SOURCE_META[source].factor);
  const pValue = Math.max(0.004, 0.16 - trend * 24);
  const changeYear = 1998 + (seed % 18);

  return {
    ...district,
    base24,
    validYears,
    coverageGrade,
    trend,
    dailyRainfall,
    mapX: baseX + jitterX,
    mapY: baseY + jitterY,
    pValue,
    changeYear,
    aiccDelta: 1.8 + (seed % 62) / 10,
    status: validYears >= 30 ? "Sufficient" : "Provisional",
  };
}

export type IdfRow = {
  district: string;
  region: Region;
  source: SourceId;
  model: ModelType;
  referenceYear: number;
  durationMinutes: number;
  returnPeriodYears: number;
  depthMm: number;
  intensityMmHr: number;
  ciLower: number;
  ciUpper: number;
  spatialMode: "district" | "point";
  spatialSelection: string;
  latitude: number | null;
  longitude: number | null;
  dataStatus: "screening_demo";
};

export function buildIdfRows(
  districtName: string,
  source: SourceId,
  model: ModelType,
  referenceYear: number,
  spatial: SpatialExtraction = { mode: "district" },
): IdfRow[] {
  const district = districtProfile(districtName, source);
  const pointValid = spatial.mode === "district" || (
    Number.isFinite(spatial.latitude) && Number.isFinite(spatial.longitude)
    && spatial.latitude >= -90 && spatial.latitude <= 90
    && spatial.longitude >= -180 && spatial.longitude <= 180
  );
  if (!pointValid) return [];
  const pointSeed = spatial.mode === "point"
    ? stableSeed(`${source}:${spatial.latitude.toFixed(5)}:${spatial.longitude.toFixed(5)}`)
    : 0;
  const pointFactor = spatial.mode === "point" ? 0.86 + (pointSeed % 2801) / 10000 : 1;
  const profile = spatial.mode === "point"
    ? {
        ...district,
        base24: district.base24 * pointFactor,
        trend: district.trend * (0.9 + (pointSeed % 2001) / 10000),
      }
    : district;
  const spatialSelection = spatial.mode === "district"
    ? `District area-weighted request · ${district.name}`
    : `Point/grid-cell request · ${spatial.latitude.toFixed(5)}, ${spatial.longitude.toFixed(5)}`;
  const nonstationaryFactor = model === "nonstationary"
    ? Math.exp(profile.trend * (referenceYear - 2000))
    : 1;

  return RETURN_PERIODS.flatMap((returnPeriod) => {
    const frequencyFactor = Math.pow(Math.log(returnPeriod * 1.5) / Math.log(3), 0.68);
    return DURATIONS.map((durationMinutes) => {
      const hours = durationMinutes / 60;
      const durationDepth = profile.base24 * Math.pow(hours / 24, 0.37);
      const depth = Math.max(0.1, durationDepth * frequencyFactor * nonstationaryFactor);
      const intensity = depth / hours;
      const spread = 0.11 + 0.018 * Math.log(returnPeriod) + (profile.validYears < 30 ? 0.08 : 0);
      return {
        district: profile.name,
        region: profile.region,
        source,
        model,
        referenceYear,
        durationMinutes,
        returnPeriodYears: returnPeriod,
        depthMm: Number(depth.toFixed(2)),
        intensityMmHr: Number(intensity.toFixed(2)),
        ciLower: Number((intensity * (1 - spread)).toFixed(2)),
        ciUpper: Number((intensity * (1 + spread)).toFixed(2)),
        spatialMode: spatial.mode,
        spatialSelection,
        latitude: spatial.mode === "point" ? spatial.latitude : null,
        longitude: spatial.mode === "point" ? spatial.longitude : null,
        dataStatus: "screening_demo" as const,
      };
    });
  });
}

export function cmip6ModelScreeningFactor(gcmModel: (typeof CMIP6_MODELS)[number]) {
  const index = CMIP6_MODELS.indexOf(gcmModel);
  if (index < 0 || CMIP6_MODELS.length < 2) return 1;
  const uniqueRank = (index * 13) % CMIP6_MODELS.length;
  return 0.92 + (uniqueRank / (CMIP6_MODELS.length - 1)) * 0.16;
}

export function cmip6ScreeningFactor(
  scenario: Cmip6Scenario,
  period: Cmip6Period,
  model: ModelType,
  selectionMode: "ensemble" | "individual" = "ensemble",
  gcmModel: (typeof CMIP6_MODELS)[number] = "ACCESS-CM2",
) {
  const modelFactor = selectionMode === "individual" ? cmip6ModelScreeningFactor(gcmModel) : 1;
  if (model === "stationary") return modelFactor;
  const midpoint = CMIP6_PERIODS[period].midpoint;
  const progress = Math.max(0, Math.min(1, (midpoint - 2020) / 80));
  return modelFactor * (1 + CMIP6_SCENARIOS[scenario].screeningChange2100 * progress);
}

export function buildDailyRows(districtName: string, source: SourceId, days = 30) {
  const seed = stableSeed(`${districtName}-${source}`);
  const end = new Date("2026-07-14T00:00:00Z");
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (days - index - 1));
    const pulse = Math.sin((index + (seed % 9)) * 1.77) + Math.cos((index + 3) * 0.61);
    const wet = ((seed >> (index % 16)) + index * 17) % 7 < 3;
    const value = wet ? Math.max(0, (pulse + 1.55) * (3.2 + (seed % 50) / 12)) : 0;
    return {
      date: date.toISOString().slice(0, 10),
      precipitationMm: Number((value * SOURCE_META[source].factor).toFixed(1)),
      qc: "screening",
      isObserved: false,
    };
  });
}
