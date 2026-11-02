import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";
import * as XLSX from "xlsx";
import { DISTRICTS, PAKISTAN_IDF_ENSEMBLE_MODELS, buildIdfRows } from "../lib/idf-data.ts";
import { ERA5_DISTRICT_CELL_LIMIT, ERA5_MULTI_LOCATION_BATCH_SIZE, LIVE_SOURCE_CONFIG, aggregatePrecipitationForPlot, climateServRecords, era5DistrictGrid, mergeHourlyRecords, nasaPowerRecords, peakPreservingPrecipitationPlot, pointBufferGeometry, powerDistrictGrid, reanalysisDistrictGrid, splitDateRange } from "../lib/online-precipitation.ts";
import { OCHA_ADM2_CATALOGUE_COUNT, boundaryFeatureName, normalizeBoundaryName } from "../lib/district-boundaries.ts";
import { parseObservedWorkbook } from "../lib/observed-workbook.ts";
import { parseCovariateWorkbook } from "../lib/covariate-workbook.ts";
import { annualMeanFromDatedValues, parseCpcNino34Annual, parseNoaaNino34Annual, parseWorldBankUrbanAnnual, validateOnlineCovariateRequest } from "../lib/online-covariates.ts";
import { ALL_METHODS, DISTRIBUTION_METHODS, calculateReferenceYear, compareCovariateModels, frequencyQuantile } from "../lib/observed-idf.ts";
import { cmip6ModelFolder, parseCmip6Members, parseCmip6NcssCsv, parseCmip6YearFiles } from "../lib/cmip6-online.ts";
import { cmip6NetcdfTimeDates, parseCmip6NcssNetcdf } from "../lib/cmip6-netcdf.ts";
import { applyExtremeValueBiasCorrection, applyObservedDurationRatios, extremeValueCorrectionFactors, monthlyMultiplicativeQdm, multiModelEnvelope, observedDurationRatios, projectionEvidenceStatus } from "../lib/cmip6-extremes.ts";
import { parseBiasCorrectedCmipWorkbook } from "../lib/cmip6-workbook.ts";

test("Pakistan CMIP6 workflow applies monthly multiplicative QDM before extremes", () => {
  const records = (value) => Array.from({ length: 3 }, (_, yearIndex) =>
    Array.from({ length: 12 }, (_, monthIndex) => ({
      date: `${2000 + yearIndex}-${String(monthIndex + 1).padStart(2, "0")}-15`,
      precipitationMm: value,
    })),
  ).flat();
  const corrected = monthlyMultiplicativeQdm(
    records(3),
    records(1),
    records(2),
  );
  assert.equal(corrected.summaries.length, 12);
  assert.equal(corrected.records.length, 36);
  assert.ok(corrected.records.every((record) => record.precipitationMm === 6));
  assert.ok(corrected.summaries.every((summary) => summary.medianFactor === 2));
  assert.equal(PAKISTAN_IDF_ENSEMBLE_MODELS.length, 10);
});

test("CMIP6 engineering workflow corrects extremes, uses observed ratios and reports ensemble bounds", () => {
  const row = (depthMm, returnPeriodYears = 10, durationMinutes = 1440) => ({ method: "gev", durationMinutes, returnPeriodYears, depthMm, intensityMmHr: depthMm / (durationMinutes / 60), ciLower: depthMm * .8 / (durationMinutes / 60), ciUpper: depthMm * 1.2 / (durationMinutes / 60), derived: durationMinutes !== 1440 });
  const factors = extremeValueCorrectionFactors([row(100)], [row(50)], "gev");
  const corrected = applyExtremeValueBiasCorrection([row(60)], factors);
  assert.equal(corrected[0].depthMm, 120);
  const ratios = observedDurationRatios([row(100), row(50, 10, 60)], "gev");
  const durations = applyObservedDurationRatios(corrected, ratios);
  assert.equal(durations.find(value => value.durationMinutes === 60).depthMm, 60);
  const envelope = multiModelEnvelope([
    { model: "A", rows: corrected },
    { model: "B", rows: [row(140)] },
    { model: "C", rows: [row(100)] },
  ]);
  assert.equal(envelope[0].depthMm, 120);
  assert.ok(envelope[0].ciLower < envelope[0].ciUpper);
  assert.match(projectionEvidenceStatus(20, 500), /Provisional/);
  assert.match(projectionEvidenceStatus(30, 500), /extreme extrapolation/);
});

test("bias-corrected CMIP6 result workbooks import model-specific 24-hour curves with caveats", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Location", "Saidu Sharif · 34.6445°N, 72.0264°E"],
      ["Reference", "ERA5 historical reference"],
      ["Historical overlap", "1985–2014"],
    ]),
    "Read Me",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Validation report · Share with caveats"],
      [], [], [],
      ["Check", "Result", "Evidence", "Severity", "Impact", "Required action"],
      ["Reference extreme", "Caveat", "Large historical value", "High", "Tail sensitive", "Verify with gauge"],
    ]),
    "Validation",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(
      ["A", "B", "C"].flatMap((model, modelIndex) =>
        [2, 10, 100].map((returnPeriod, returnIndex) => {
          const depth = 50 + modelIndex * 5 + returnIndex * 40;
          return {
            Model: model,
            Member: "r1i1p1f1",
            Scenario: "SSP245",
            Period: "2041-2070",
            Return_Period_years: returnPeriod,
            Primary_Corrected_24h_Depth_mm: depth,
            Primary_Corrected_Intensity_mm_hr: depth / 24,
          };
        }),
      ),
    ),
    "Model IDF",
  );
  const parsed = parseBiasCorrectedCmipWorkbook(XLSX, workbook);
  assert.equal(parsed.locationName, "Saidu Sharif");
  assert.equal(parsed.models.length, 3);
  assert.equal(parsed.profiles[0].modelCount, 3);
  assert.equal(parsed.modelRows, 9);
  assert.match(parsed.validationCaveats[0], /Verify with gauge/);
  const envelope = multiModelEnvelope(parsed.models);
  assert.equal(envelope.find((row) => row.returnPeriodYears === 10)?.depthMm, 95);
  assert.match(parsed.warnings[0], /Ensemble IDF/);
});

test("live-source dates are independent from uploaded-observation filters", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /\[onlineStart, setOnlineStart\]/);
  assert.match(source, /\[onlineEnd, setOnlineEnd\]/);
  assert.match(source, /onlineRequestedStart\s*=\s*onlineStart/);
  assert.match(source, /value=\{onlineStart\}/);
  assert.match(source, /value=\{onlineEnd\}/);
  assert.doesNotMatch(source, /onlineRequestedStart\s*=\s*start/);
});

test("Windows Selenium automation kit is downloadable and performs analysis QA", async () => {
  const automation = await readFile(new URL("../standalone/atlas_automation.py", import.meta.url), "utf8");
  const desktop = await readFile(new URL("../standalone/Pakistan_IDF_Atlas_Automator.pyw", import.meta.url), "utf8");
  const launcher = await readFile(new URL("../standalone/RUN_PAKISTAN_IDF_ATLAS.bat", import.meta.url), "utf8");
  const builder = await readFile(new URL("../standalone/BUILD_WINDOWS_EXE.bat", import.meta.url), "utf8");
  const buildRequirements = await readFile(new URL("../standalone/requirements-build.txt", import.meta.url), "utf8");
  const bundledWheels = await readdir(new URL("../standalone/wheels", import.meta.url));
  const spec = await readFile(new URL("../standalone/Pakistan_IDF_Atlas_Automator.spec", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  const archive = await stat(new URL("../public/downloads/Pakistan_IDF_Atlas_Standalone_Windows_OfflineInstaller_2026-08-20.zip", import.meta.url));
  assert.match(automation, /WebDriver as ChromeWebDriver/);
  assert.match(automation, /ChromeWebDriver\(options=options\)/);
  assert.match(automation, /Retrieved source data ready/);
  assert.match(automation, /analyze_export/);
  assert.match(automation, /Curve monotonicity/);
  assert.match(automation, /Pakistan_IDF_Atlas_Automation_Log\.xlsx/);
  assert.match(automation, /ERR_INTERNET_DISCONNECTED/);
  assert.match(automation, /Live ERA5\/CHIRPS retrieval/);
  assert.match(desktop, /Run automated IDF analysis/);
  assert.match(desktop, /run_packaging_self_test/);
  assert.match(desktop, /SeleniumManager\._get_binary/);
  assert.match(launcher, /pythonw\.exe/);
  assert.match(launcher, /force-reinstall/);
  assert.match(launcher, /--no-index/);
  assert.match(launcher, /--find-links/);
  assert.match(launcher, /cffi-\*\.whl/);
  assert.match(launcher, /pycparser-\*\.whl/);
  assert.match(launcher, /import cffi, openpyxl, pycparser/);
  assert.match(launcher, /struct\.calcsize\('P'\) \* 8 == 64/);
  assert.match(builder, /packaging-self-test/);
  assert.match(builder, /pefile-\*\.whl/);
  assert.match(builder, /pywin32_ctypes-\*\.whl/);
  assert.match(builder, /cffi-\*\.whl/);
  assert.match(builder, /pycparser-\*\.whl/);
  assert.match(builder, /import cffi, openpyxl, pefile, pycparser, win32ctypes/);
  assert.match(builder, /struct\.calcsize\('P'\) \* 8 == 64/);
  assert.match(buildRequirements, /pefile>=2022\.5\.30/);
  assert.match(buildRequirements, /pywin32-ctypes>=0\.2\.1/);
  assert.match(buildRequirements, /cffi>=1\.14/);
  assert.match(buildRequirements, /pycparser>=2\.20/);
  assert.ok(bundledWheels.some((name) => /^pefile-.*\.whl$/i.test(name)));
  assert.ok(bundledWheels.some((name) => /^pywin32_ctypes-.*\.whl$/i.test(name)));
  for (const pythonTag of ["cp311", "cp312", "cp313", "cp314"]) {
    assert.ok(bundledWheels.some((name) => new RegExp(`^cffi-.*-${pythonTag}-${pythonTag}-win_amd64\\.whl$`, "i").test(name)));
  }
  assert.ok(bundledWheels.some((name) => /^pycparser-.*\.whl$/i.test(name)));
  assert.match(spec, /collect_all\("selenium"\)/);
  assert.match(spec, /selenium\.webdriver\.chrome\.webdriver/);
  assert.match(page, /Pakistan_IDF_Atlas_Standalone_Windows_OfflineInstaller_2026-08-20\.zip\?v=2026\.08\.20\.4\.1/);
  assert.ok(archive.size > 10_000_000);
});

test("CMIP6 workflow offers an explicit ERA5 bias-correction fallback", async () => {
  const source = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");
  assert.match(source, /Automatic · gauge first, ERA5 if unavailable/);
  assert.match(source, /Observed gauge only/);
  assert.match(source, /ERA5 reanalysis/);
  assert.match(source, /reanalysis-corrected, not gauge-corrected/);
  assert.match(source, /Retrieve historical GCM & bias-correction reference/);
  assert.match(source, /era5\.records \?\? \[\]/);
  assert.doesNotMatch(source, /era5\.dailyRecords/);
  assert.match(source, /Refreshing ERA5 bias-correction reference/);
  assert.match(source, /Excluded years \(<90% complete\)/);
});

test("CMIP6 daily QDM correction feeds the active future fit and is exported transparently", async () => {
  const source = await readFile("app/page.tsx", "utf8");
  assert.match(source, /cmipFutureUncorrectedRows = modelTab === "nonstationary"/);
  assert.match(source, /monthlyMultiplicativeQdm\(/);
  assert.match(source, /Daily QDM Corrected/);
  assert.match(source, /Raw versus daily-QDM-corrected future 24-hour fit/);
  assert.match(source, /GCM Bias Correction/);
  assert.match(source, /future_corrected_24h_depth_mm/);
  assert.match(source, /Use representative point inside/);
  assert.match(source, /Stored models are isolated by coordinates, SSP/);
});

const developmentPreviewMeta =
  /<meta(?=[^>]*\bname=["']codex-preview["'])(?=[^>]*\bcontent=["']development["'])[^>]*>/i;

test("renders development preview metadata", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, developmentPreviewMeta);
  assert.match(html, /Professional technical report/);
  assert.match(html, /Executive summary/);
  assert.match(html, /Literature and implementation alignment/);
  assert.match(html, /Infrastructure design-return-period guide/);
  assert.match(html, /Beyond 500 years \/ PMF/);
  assert.match(html, /How to read these results/);
  assert.match(html, /Result status and appropriate use/);
  assert.match(html, /Stationary, nonstationary and reference-year interpretation/);
  assert.match(html, /Essential terms/);
  assert.match(html, /Return period and AEP/);
  assert.match(html, /Download selected daily data/);
  assert.match(html, /District spatial series/);
  assert.match(html, /Point\/grid-cell series/);
  assert.match(html, /Spatial extraction/);
  assert.match(html, /CMIP6 projections/);
  assert.match(html, /Data sources and quality/);
  assert.match(html, /Methodology/);
  assert.match(html, /Results and diagnostics/);
  assert.match(html, /Conclusions and recommendations/);
  assert.match(html, /Appendix A/);
  assert.match(html, /Appendix B/);
  assert.match(html, /Download Word-compatible report/);

  const source = `${await readFile(new URL("../app/page.tsx", import.meta.url), "utf8")}${await readFile(new URL("../lib/idf-data.ts", import.meta.url), "utf8")}${await readFile(new URL("../lib/district-boundaries.ts", import.meta.url), "utf8")}${await readFile(new URL("../lib/observed-idf.ts", import.meta.url), "utf8")}${await readFile(new URL("../lib/observed-workbook.ts", import.meta.url), "utf8")}${await readFile(new URL("../lib/covariate-workbook.ts", import.meta.url), "utf8")}${await readFile(new URL("../lib/online-covariates.ts", import.meta.url), "utf8")}${await readFile(new URL("../lib/online-precipitation.ts", import.meta.url), "utf8")}${await readFile(new URL("../lib/cmip6-online.ts", import.meta.url), "utf8")}${await readFile(new URL("../app/api/online-covariates/route.ts", import.meta.url), "utf8")}${await readFile(new URL("../app/api/online-precipitation/route.ts", import.meta.url), "utf8")}${await readFile(new URL("../app/api/cmip6-precipitation/route.ts", import.meta.url), "utf8")}`;
  assert.match(source, /NASA NEX-GDDP-CMIP6/);
  assert.match(source, /SSP5-8.5/);
  assert.match(source, /2081–2100/);
  assert.match(source, /CMIP6 projection workflow/);
  assert.match(source, /GCM selection mode/);
  assert.match(source, /Individual GCM model/);
  assert.match(source, /ACCESS-CM2/);
  assert.match(source, /NorESM2-MM/);
  assert.match(source, /ACCESS-ESM1-5/);
  assert.match(source, /UKESM1-0-LL/);
  assert.match(source, /35 model\/grid entries/);
  assert.match(source, /ENSO and physical covariates · retrieve or upload data/);
  assert.match(source, /Retrieve selected online/);
  assert.match(source, /Retrieve all & compare IDF/);
  assert.match(source, /Retrieve → match years → compare models → develop IDF/);
  assert.match(source, /Generate the supported IDF, or retain stationary GEV/);
  assert.match(source, /developIdfFromRetrievedCovariates\(updatedCovariates\)/);
  assert.match(source, /selectedModelId === "stationary"/);
  assert.match(source, /getElementById\("idf-results"\)/);
  assert.match(source, /nina34\.anom\.data/);
  assert.match(source, /temperature_2m_max,temperature_2m_min/);
  assert.match(source, /LIS-modeled soil moisture, 0–10 cm/);
  assert.match(source, /SP\.URB\.TOTL\.IN\.ZS/);
  assert.match(source, /Online Covariate Sources/);
  assert.match(source, /Time · fitted GEV location/);
  assert.match(source, /compareCovariateModels/);
  assert.match(source, /chronologically held-out final 25%/);
  assert.match(source, /Correlation is not a selection criterion/);
  assert.match(source, /Covariate Comparison/);
  assert.match(source, /250-year/);
  assert.match(source, /500-year/);
  assert.match(source, /Lognormal · 2-parameter/);
  assert.match(source, /Gamma · 2-parameter/);
  assert.match(source, /Weibull · 2-parameter/);
  assert.match(source, /six fitted probability distributions/);
  assert.match(source, /Sherman IDF equation/);
  assert.match(source, /calculateNonstationaryTime/);
  assert.match(source, /nonstationaryAicc/);
  assert.match(source, /const activeFrequencyMethodLabel/);
  assert.match(source, /GEV · maximum likelihood/);
  assert.match(source, /aria-label="Nonstationary frequency fitting method"/);
  assert.match(source, /Selected_frequency_method: activeFrequencyMethodLabel/);
  assert.match(source, /modelTab === "nonstationary"[\s\S]*activeFrequencyMethodLabel[\s\S]*METHOD_LABEL\[r\.method\]/);
  assert.match(source, /Hourly observations/);
  assert.match(source, /calculateHourly/);
  assert.match(source, /hourlyAnnualMaxima/);
  assert.match(source, /Direct support from 1 to 24 hours/);
  assert.match(source, /manualObservedLoaded/);
  assert.match(source, /Disabled for uploaded observations/);
  assert.match(source, /District selection and district-boundary averaging are disabled/);
  assert.match(source, /disabled=\{manualObservedLoaded\}/);
  assert.match(source, /if\s*\(manualObservedLoaded\)\s*return/);
  assert.match(source, /selectionDisabled=\{manualObservedLoaded\}/);
  assert.match(source, /districtLocked/);
  assert.match(source, /setDistrictLocked\(true\)/);
  assert.match(source, /if\s*\(manualObservedLoaded\s*\|\|\s*districtLocked\)\s*return/);
  assert.match(source, /Locked district/);
  assert.match(source, /Unlock district/);
  assert.match(source, /Fitting uses only the uploaded, quality-controlled time series/);
  assert.match(source, /not used for uploaded gauge analysis/);
  assert.match(source, /District boundaries do not enter quality control, annual-maxima extraction, distribution fitting, uncertainty, or IDF calculations/);
  assert.match(source, /uploadObservedWorkbook/);
  assert.match(source, /parseObservedWorkbook/);
  assert.match(source, /for\(const sheetName of workbook\.SheetNames\)/);
  assert.match(source, /Year \+ Month \+ Day \+ Hour/);
  assert.match(source, /no timezone shift/);
  assert.match(source, /Recovered.*consecutive hourly timestamps/);
  assert.doesNotMatch(source, /wb\.Sheets\[wb\.SheetNames\[0\]\]/);
  assert.match(source, /Agilan, V\., & Umamahesh/);
  assert.match(source, /Masood, M\. U\./);
  assert.match(source, /Reference-year rule/);
  assert.match(source, /Automatic · mean eligible AMS year/);
  assert.match(source, /Latest eligible AMS year/);
  assert.match(source, /Custom evaluation year/);
  assert.match(source, /ȳ = Σ eligible annual-maxima years \/ n/);
  assert.match(source, /calculateReferenceYear/);
  assert.match(source, /μ\(x\)=μ₀\+μ₁/);
  assert.match(source, /Copernicus Climate Change Service/);
  assert.match(source, /NASA GPM/);
  assert.match(source, /UCSB Climate Hazards Center/);
  assert.match(source, /Retrieve directly from source/);
  assert.match(source, /Download retrieved precipitation/);
  assert.match(source, /Plot retrieved precipitation/);
  assert.match(source, /Precipitation through time/);
  assert.match(source, /Hourly values · native/);
  assert.match(source, /Daily totals/);
  assert.match(source, /Monthly totals/);
  assert.match(source, /Annual totals/);
  assert.match(source, /Download plot PNG/);
  assert.match(source, /peak-preserving bars/);
  assert.match(source, /aggregatePrecipitationForPlot/);
  assert.match(source, /peakPreservingPrecipitationPlot/);
  assert.match(source, /Direct source retrieval/);
  assert.match(source, /After retrieval succeeds/);
  assert.match(source, /Quality control, duration-specific annual maxima and distribution fitting now use this provider series/);
  assert.match(source, /Hourly series · ERA5/);
  assert.match(source, /ERA5-Land · rainfall unavailable through this API/);
  assert.match(source, /explicit ERA5-Land model does not provide precipitation values/);
  assert.match(source, /hourlyRecords/);
  assert.match(source, /url\.searchParams\.set\("hourly", "precipitation"\)/);
  assert.match(source, /new Set\(\[429, 502, 503, 504\]\)/);
  assert.match(source, /extractEra5InBrowser/);
  assert.match(source, /quota-bounded/);
  assert.match(source, /pakistan-idf-open-meteo-v1/);
  assert.match(source, /Select NASA POWER alternative/);
  assert.match(source, /the report will identify the changed dataset/);
  assert.match(source, /climateServInBrowser/);
  assert.match(source, /direct browser fallback after shared-route failure/);
  assert.match(source, /extractEra5TemperatureInBrowser/);
  assert.match(source, /payload\.source === "temperature"/);
  assert.match(source, /shared ERA5 route is temporarily throttled/i);
  assert.match(source, /temperature_2m_max,temperature_2m_min/);
  assert.match(source, /direct browser fallback after shared-server throttle/);
  assert.match(source, /rolling 1-, 2-, 3-, 6-, 12- and 24-hour annual maxima/);
  assert.match(source, /CHIRPS is a daily product and has no hourly series/);
  assert.match(source, /Native 30-minute IMERG requires authenticated NASA archive access/);
  assert.match(source, /SERVIR ClimateSERV API/);
  assert.match(source, /Open-Meteo Historical Weather API/);
  assert.match(source, /datatype 226/);
  assert.match(source, /datatype 227/);
  assert.match(source, /NASA POWER Daily API/);
  assert.match(source, /PRECTOTCORR/);
  assert.match(source, /ERA5-Land reanalysis/);
  assert.match(source, /NASA IMERG V07 Early daily/);
  assert.match(source, /NASA POWER MERRA-2 corrected daily/);
  assert.match(source, /current < nextFirstDate/);
  assert.match(source, /provider-computed daily means/);
  assert.match(source, /era5DistrictGrid/);
  assert.match(source, /All \{OCHA_ADM2_CATALOGUE_COUNT\} verified OCHA ADM2 polygons/);
  assert.match(source, /one selected district at a/);
  assert.match(source, /districtCode/);
  assert.match(source, /boundaryValidOn/);
  assert.match(source, /splitDateRange/);
  assert.match(source, /onlineReady/);
  assert.match(source, /onlineRaw/);
  assert.match(source, /pointInOnlineGeometry/);
  assert.match(source, /Coordinates fall inside the selected/);
  assert.match(source, /Hover preview on/);
  assert.match(source, /onWheel/);
  assert.match(source, /drag to move/);
  assert.match(source, /click a district to select and lock/);
  assert.match(source, /RETURN PERIOD/);
  assert.match(source, /strokeDasharray/);
  assert.match(source, /IDF · intensity, not rainfall depth/);
  assert.match(source, />\s*Duration \(minutes\)\s*<\/text>/);
  assert.match(source, />\s*Rainfall intensity \(mm\/hour\)\s*<\/text>/);
  assert.doesNotMatch(source, /Duration \(minutes; logarithmic scale\)/);
});

test("retrieved precipitation plotting preserves totals and rainfall peaks", () => {
  const records = [
    { timestamp: "2025-01-01T00:00", precipitationMm: 1 },
    { timestamp: "2025-01-01T01:00", precipitationMm: 4 },
    { timestamp: "2025-01-02T00:00", precipitationMm: 2.5 },
    { timestamp: "2025-02-01T00:00", precipitationMm: 3.5 },
  ];
  const native = aggregatePrecipitationForPlot(records, "native"),
    daily = aggregatePrecipitationForPlot(records, "daily"),
    monthly = aggregatePrecipitationForPlot(records, "monthly"),
    annual = aggregatePrecipitationForPlot(records, "annual");
  assert.equal(native.length, 4);
  assert.deepEqual(
    daily.map((point) => [
      point.timestamp.slice(0, 10),
      point.precipitationMm,
      point.sourceIntervals,
    ]),
    [
      ["2025-01-01", 5, 2],
      ["2025-01-02", 2.5, 1],
      ["2025-02-01", 3.5, 1],
    ],
  );
  assert.deepEqual(
    monthly.map((point) => [
      point.timestamp.slice(0, 7),
      point.precipitationMm,
    ]),
    [
      ["2025-01", 7.5],
      ["2025-02", 3.5],
    ],
  );
  assert.equal(annual[0].precipitationMm, 11);
  const reduced = peakPreservingPrecipitationPlot(
    [
      { timestamp: "1", precipitationMm: 1, sourceIntervals: 1 },
      { timestamp: "2", precipitationMm: 8, sourceIntervals: 1 },
      { timestamp: "3", precipitationMm: 2, sourceIntervals: 1 },
      { timestamp: "4", precipitationMm: 3, sourceIntervals: 1 },
      { timestamp: "5", precipitationMm: 9, sourceIntervals: 1 },
      { timestamp: "6", precipitationMm: 4, sourceIntervals: 1 },
    ],
    2,
  );
  assert.deepEqual(
    reduced.map((point) => point.precipitationMm),
    [8, 9],
  );
});

test("CMIP6 workspace directly retrieves, fits and plots actual GCM precipitation", async () => {
  const source = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /Retrieve GCM data & develop IDF/);
  assert.match(source, /\/api\/cmip6-precipitation/);
  assert.match(source, /NCCS THREDDS NetCDF Subset Service/);
  assert.match(source, /kg m⁻² s⁻¹ to mm\/day/);
  assert.match(source, /Download retrieved GCM data/);
  assert.match(source, /Upload GCM data instead/);
  assert.match(source, /Plot GCM precipitation/);
  assert.match(source, /GCM precipitation through time/);
  assert.match(source, /cmipDataReady/);
  assert.match(source, /currentCmipDataKey/);
  assert.match(source, /No sample multiplier/);
  assert.match(source, /IDF remains blank until data are retrieved/);
  assert.doesNotMatch(
    source,
    /Retrying NCCS THREDDS directly through this browser/,
  );
});

test("CMIP6 district retrieval uses supported NetCDF grid subsets and resumable annual caching", async () => {
  const route = await readFile(
    new URL("../app/api/cmip6-precipitation/route.ts", import.meta.url),
    "utf8",
  );
  const source = await readFile(
    new URL("../app/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(route, /url\.searchParams\.set\("accept", "netCDF"\)/);
  assert.match(route, /parseCmip6NcssNetcdf/);
  assert.match(route, /body\.mode === "point"/);
  assert.match(source, /cmip6AnnualResponseCache/);
  assert.match(source, /completed annual subsets remain cached/);
});

test("GCM plot can isolate one maximum daily precipitation value per year", () => {
  const peaks = aggregatePrecipitationForPlot(
    [
      { timestamp: "2041-01-01", precipitationMm: 3 },
      { timestamp: "2041-07-14", precipitationMm: 42 },
      { timestamp: "2041-08-01", precipitationMm: 18 },
      { timestamp: "2042-03-02", precipitationMm: 11 },
      { timestamp: "2042-07-20", precipitationMm: 37 },
    ],
    "annual-maxima",
  );
  assert.deepEqual(
    peaks.map((row) => [row.timestamp, row.precipitationMm]),
    [
      ["2041-07-14", 42],
      ["2042-07-20", 37],
    ],
  );
});

test("CMIP6 NetCDF district parser clips native cells and converts precipitation rates", () => {
  const fixture = Buffer.from(
    "Q0RGAQAAAAIAAAAKAAAAAwAAAAR0aW1lAAAAAAAAAANsYXQAAAAAAgAAAANsb24AAAAAAgAAAAAAAAAAAAAACwAAAAQAAAADbGF0AAAAAAEAAAABAAAADAAAAAEAAAAFdW5pdHMAAAAAAAACAAAADWRlZ3JlZXNfbm9ydGgAAAAAAAAFAAAACAAAAawAAAADbG9uAAAAAAEAAAACAAAADAAAAAEAAAAFdW5pdHMAAAAAAAACAAAADGRlZ3JlZXNfZWFzdAAAAAUAAAAIAAABtAAAAAR0aW1lAAAAAQAAAAAAAAAMAAAAAgAAAAV1bml0cwAAAAAAAAIAAAAeZGF5cyBzaW5jZSAyMDQxLTAxLTAxIDAwOjAwOjAwAAAAAAAIY2FsZW5kYXIAAAACAAAACHN0YW5kYXJkAAAABgAAAAgAAAG8AAAAAnByAAAAAAADAAAAAAAAAAEAAAACAAAADAAAAAIAAAAFdW5pdHMAAAAAAAACAAAACmtnIG0tMiBzLTEAAAAAAApfRmlsbFZhbHVlAAAAAAAFAAAAAXzwAAAAAAAFAAAAEAAAAcRCCAAAQgkAAEKPAABCj4AAP+AAAAAAAAA40bcXOVG3FzmdSVI50bcXP/gAAAAAAAA6AxJvOh1JUjo3gDQ6UbcX",
    "base64",
  );
  const geometry = {
    type: "Polygon",
    coordinates: [
      [
        [71.7, 34.2],
        [71.8, 34.2],
        [71.8, 34.3],
        [71.7, 34.3],
        [71.7, 34.2],
      ],
    ],
  };
  const parsed = parseCmip6NcssNetcdf(fixture, "district", geometry);
  assert.equal(parsed.extractedGridCells, 1);
  assert.deepEqual(
    parsed.records.map((record) => record.date),
    ["2041-01-01", "2041-01-02"],
  );
  assert.deepEqual(
    parsed.records.map((record) => record.precipitationMm),
    [34.56, 69.12],
  );
  const noLeapFixture = Buffer.from(fixture);
  const calendarOffset = noLeapFixture.indexOf(Buffer.from("standard"));
  assert.notEqual(calendarOffset, -1);
  Buffer.from("365_day\0").copy(noLeapFixture, calendarOffset);
  const noLeap = parseCmip6NcssNetcdf(
    noLeapFixture,
    "district",
    geometry,
  );
  assert.equal(noLeap.sourceCalendar, "365_day");
  assert.deepEqual(
    noLeap.records.map((record) => record.date),
    ["2041-01-01", "2041-01-02"],
  );
  assert.match(noLeap.calendarConversion, /all 365 model-day precipitation values were retained/i);
});

test("CMIP6 365-day conversion preserves model years and skips Gregorian leap day", () => {
  const converted = cmip6NetcdfTimeDates(
    [58, 59, 364, 365],
    "days since 2040-01-01 00:00:00",
    "365_day",
  );
  assert.deepEqual(converted.dates, [
    "2040-02-28",
    "2040-03-01",
    "2040-12-31",
    "2041-01-01",
  ]);
  assert.equal(new Set(converted.dates).size, converted.dates.length);
  assert.match(converted.calendarConversion, /No 29 February was inserted/);
});

test("CMIP6 CF time parser accepts NASA non-zero-padded reference dates", () => {
  const converted = cmip6NetcdfTimeDates(
    [69715, 69716],
    "days since 1850-1-1",
    "365_day",
  );
  assert.deepEqual(converted.dates, ["2041-01-01", "2041-01-02"]);
  assert.equal(converted.sourceCalendar, "365_day");
});

test("CMIP6 catalogue and NCSS parsers preserve member, annual files and precipitation units", () => {
  const members = parseCmip6Members(`
    <catalog>
      <catalogRef xlink:href="r1i1p1f1/catalog.xml" xlink:title="r1i1p1f1" />
      <catalogRef xlink:title="r2i1p1f1" xlink:href="r2i1p1f1/catalog.xml" />
    </catalog>
  `);
  assert.deepEqual(members, ["r1i1p1f1", "r2i1p1f1"]);
  const files = parseCmip6YearFiles(`
    <dataset name="pr_day_ACCESS-CM2_ssp245_r1i1p1f1_gn_2041_v2.0.nc"
      urlPath="AMES/NEX/GDDP-CMIP6/ACCESS-CM2/ssp245/r1i1p1f1/pr/pr_day_ACCESS-CM2_ssp245_r1i1p1f1_gn_2041_v2.0.nc" />
    <dataset name="pr_day_ACCESS-CM2_ssp245_r1i1p1f1_gn_2042.nc"
      urlPath="AMES/NEX/GDDP-CMIP6/ACCESS-CM2/ssp245/r1i1p1f1/pr/pr_day_ACCESS-CM2_ssp245_r1i1p1f1_gn_2042.nc" />
  `);
  assert.deepEqual(files.map((file) => file.year), [2041, 2042]);
  const parsed = parseCmip6NcssCsv(
    [
      "time,lat,lon,pr[kg m-2 s-1]",
      "2041-01-01T12:00:00Z,34.125,72.125,0.0001",
      "2041-01-02T12:00:00Z,34.125,72.125,0.0002",
    ].join("\n"),
    "point",
  );
  assert.deepEqual(
    parsed.records.map((record) => record.precipitationMm),
    [8.64, 17.28],
  );
  assert.equal(parsed.extractedGridCells, 1);
  assert.equal(cmip6ModelFolder("GFDL-CM4 (gr2)"), "GFDL-CM4_gr2");
});

test("every listed district resolves to one verified OCHA ADM2 polygon", async () => {
  const collection = JSON.parse(
    await readFile(
      new URL("../public/data/pakistan-districts-ocha-2024.geojson", import.meta.url),
      "utf8",
    ),
  );
  const featureNames = collection.features.map((feature) =>
    boundaryFeatureName(feature.properties),
  );
  const featureKeys = new Set(featureNames.map(normalizeBoundaryName));
  const districtKeys = DISTRICTS.map((district) => normalizeBoundaryName(district.name));
  assert.equal(collection.features.length, OCHA_ADM2_CATALOGUE_COUNT);
  assert.equal(DISTRICTS.length, OCHA_ADM2_CATALOGUE_COUNT);
  assert.equal(new Set(districtKeys).size, OCHA_ADM2_CATALOGUE_COUNT);
  assert.deepEqual([...featureKeys].sort(), [...new Set(districtKeys)].sort());
  assert.deepEqual(
    DISTRICTS.filter((district) => !featureKeys.has(normalizeBoundaryName(district.name))),
    [],
  );
  for (const feature of collection.features) {
    for (const maximumCells of [12, 48]) {
      const grid = era5DistrictGrid(feature.geometry, maximumCells);
      assert.ok(grid.points.length > 0);
      assert.ok(grid.points.length <= maximumCells);
      assert.ok(grid.points.every((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude) && point.weight > 0));
      assert.ok(Math.abs(grid.points.reduce((sum, point) => sum + point.weight, 0) - 1) < 1e-9);
    }
  }
  assert.equal(ERA5_MULTI_LOCATION_BATCH_SIZE.daily, 16);
  assert.equal(ERA5_MULTI_LOCATION_BATCH_SIZE.hourly, 4);
});

test("legacy CMIP screening profiles still respond to district and point request modes", () => {
  const district = buildIdfRows("Peshawar", "era5", "stationary", 2025, { mode: "district" });
  const point = buildIdfRows("Peshawar", "era5", "stationary", 2025, {
    mode: "point",
    latitude: 34.015,
    longitude: 71.525,
  });
  const otherPoint = buildIdfRows("Peshawar", "era5", "stationary", 2025, {
    mode: "point",
    latitude: 33.6844,
    longitude: 73.0479,
  });

  assert.equal(district[0].spatialMode, "district");
  assert.equal(district[0].latitude, null);
  assert.match(district[0].spatialSelection, /District area-weighted request/);
  assert.equal(point[0].spatialMode, "point");
  assert.equal(point[0].latitude, 34.015);
  assert.equal(point[0].longitude, 71.525);
  assert.match(point[0].spatialSelection, /Point\/grid-cell request/);
  assert.notEqual(point[0].intensityMmHr, district[0].intensityMmHr);
  assert.notEqual(point[0].intensityMmHr, otherPoint[0].intensityMmHr);
});

test("online provider requests split safely and preserve point geometry", () => {
  assert.deepEqual(splitDateRange("1981-01-01", "2025-12-31", 20), [
    { start: "1981-01-01", end: "2000-12-31" },
    { start: "2001-01-01", end: "2020-12-31" },
    { start: "2021-01-01", end: "2025-12-31" },
  ]);
  const geometry = pointBufferGeometry(71.525, 34.015);
  assert.equal(geometry.type, "Polygon");
  assert.deepEqual(geometry.coordinates[0][0], geometry.coordinates[0].at(-1));
  assert.equal(geometry.coordinates[0].length, 5);
});

test("online source catalogue exposes native hourly and alternative daily sources accurately", () => {
  assert.deepEqual(LIVE_SOURCE_CONFIG.era5.supportedResolutions, ["daily", "hourly"]);
  assert.deepEqual(LIVE_SOURCE_CONFIG.era5land.supportedResolutions, ["daily", "hourly"]);
  assert.deepEqual(LIVE_SOURCE_CONFIG.chirps.supportedResolutions, ["daily"]);
  assert.deepEqual(LIVE_SOURCE_CONFIG.imerg.supportedResolutions, ["daily"]);
  assert.deepEqual(LIVE_SOURCE_CONFIG.imergEarly.supportedResolutions, ["daily"]);
  assert.deepEqual(LIVE_SOURCE_CONFIG.power.supportedResolutions, ["daily"]);
  const merged = mergeHourlyRecords([
    [{ timestamp: "2020-01-01T01:00", precipitationMm: 2, qc: "provider" }],
    [
      { timestamp: "2020-01-01T00:00", precipitationMm: 1, qc: "provider" },
      { timestamp: "2020-01-01T01:00", precipitationMm: 3, qc: "provider revised" },
    ],
  ]);
  assert.deepEqual(merged.map((record) => [record.timestamp, record.precipitationMm]), [
    ["2020-01-01T00:00", 1],
    ["2020-01-01T01:00", 3],
  ]);
});

test("ERA5 district grid produces normalized overlap weights", () => {
  const geometry = {
    type: "Polygon",
    coordinates: [[[71.35, 33.85], [71.75, 33.85], [71.75, 34.2], [71.35, 34.2], [71.35, 33.85]]],
  };
  const grid = era5DistrictGrid(geometry, 8);
  assert.ok(grid.candidateCount > 0);
  assert.ok(grid.points.length > 0 && grid.points.length <= 8);
  assert.ok(Math.abs(grid.points.reduce((sum, point) => sum + point.weight, 0) - 1) < 1e-12);
  assert.ok(grid.points.every((point) => point.weight > 0));
});

test("ERA5-Land and NASA POWER district grids use normalized source-specific cells", () => {
  const geometry = {
    type: "Polygon",
    coordinates: [[[71.35, 33.85], [71.75, 33.85], [71.75, 34.2], [71.35, 34.2], [71.35, 33.85]]],
  };
  const era5Land = reanalysisDistrictGrid("era5land", geometry, 12);
  const power = powerDistrictGrid(geometry, 8);
  for (const grid of [era5Land, power]) {
    assert.ok(grid.candidateCount > 0);
    assert.ok(grid.points.length > 0);
    assert.ok(Math.abs(grid.points.reduce((sum, point) => sum + point.weight, 0) - 1) < 1e-12);
  }
  assert.ok(era5Land.points.length <= 12);
  assert.ok(power.points.length <= 8);
});

test("ERA5 free-tier district sampling stays within the documented request budget", () => {
  const geometry = {
    type: "Polygon",
    coordinates: [[[70.5, 33.2], [72.2, 33.2], [72.2, 35.2], [70.5, 35.2], [70.5, 33.2]]],
  };
  assert.deepEqual(ERA5_DISTRICT_CELL_LIMIT, { daily: 4, hourly: 2 });
  const daily = reanalysisDistrictGrid(
    "era5land",
    geometry,
    ERA5_DISTRICT_CELL_LIMIT.daily,
  );
  const hourly = reanalysisDistrictGrid(
    "era5land",
    geometry,
    ERA5_DISTRICT_CELL_LIMIT.hourly,
  );
  assert.ok(daily.candidateCount > ERA5_DISTRICT_CELL_LIMIT.daily);
  assert.ok(daily.points.length <= ERA5_DISTRICT_CELL_LIMIT.daily);
  assert.ok(hourly.points.length <= ERA5_DISTRICT_CELL_LIMIT.hourly);
  assert.ok(
    Math.abs(daily.points.reduce((sum, point) => sum + point.weight, 0) - 1) <
      1e-12,
  );
});

test("ClimateSERV polygon statistics become valid daily precipitation records", () => {
  const records = climateServRecords({ data: [
    { year: 2020, month: 1, day: 2, value: { avg: 4.25 } },
    { year: 2020, month: 1, day: 1, value: { avg: 1.5 } },
    { year: 2020, month: 1, day: 3, value: { avg: -9999 } },
  ] });
  assert.deepEqual(records.map((record) => [record.date, record.precipitationMm]), [
    ["2020-01-02", 4.25],
    ["2020-01-01", 1.5],
  ]);
});

test("NASA POWER corrected precipitation becomes valid daily records", () => {
  const records = nasaPowerRecords({
    properties: {
      parameter: {
        PRECTOTCORR: {
          20200101: 1.25,
          20200102: 0,
          20200103: -999,
        },
      },
    },
  });
  assert.deepEqual(records.map((record) => [record.date, record.precipitationMm]), [
    ["2020-01-01", 1.25],
    ["2020-01-02", 0],
  ]);
});

test("expanded probability-distribution suite is complete and monotonic", () => {
  const annualMaxima = [31, 36, 39, 42, 44, 47, 49, 52, 54, 57, 60, 63, 67, 71, 76, 82, 89, 97, 108, 122, 139, 161];
  assert.deepEqual(DISTRIBUTION_METHODS, ["gev", "gumbel", "lp3", "lognormal", "gamma", "weibull"]);
  assert.equal(ALL_METHODS.length, 7);
  assert.equal(ALL_METHODS.at(-1), "sherman");

  for (const method of DISTRIBUTION_METHODS) {
    const levels = [2, 5, 10, 25, 50, 100, 250, 500].map((period) =>
      frequencyQuantile(annualMaxima, period, method),
    );
    assert.ok(levels.every((value) => Number.isFinite(value) && value > 0), `${method} returns finite positive levels`);
    for (let index = 1; index < levels.length; index++) {
      assert.ok(levels[index] >= levels[index - 1], `${method} return levels increase with return period`);
    }
  }
});

test("literature-aligned reference year uses the mean of eligible AMS years", () => {
  const complete = Array.from({ length: 41 }, (_, index) => ({ year: 1985 + index }));
  const centered = calculateReferenceYear(complete, "record-center", 2030);
  assert.equal(centered.referenceYear, 2005);
  assert.equal(centered.centerYear, 2005);
  assert.equal(centered.eligibleYearCount, 41);
  assert.equal(centered.isExtrapolation, false);
  assert.match(centered.formula, /82205 \/ 41 = 2005\.00/);

  const latest = calculateReferenceYear(complete, "latest-eligible", 2030);
  assert.equal(latest.referenceYear, 2025);
  assert.equal(latest.isExtrapolation, false);

  const future = calculateReferenceYear(complete, "custom", 2030);
  assert.equal(future.referenceYear, 2030);
  assert.equal(future.isExtrapolation, true);
});

test("annual covariate workbook imports physical metadata and annual values", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Year", "ENSO_Nino3.4_C", "Annual_Temperature_C", "Custom circulation"],
      ...Array.from({ length: 25 }, (_, index) => [
        1985 + index,
        Math.sin(index / 2),
        19 + index * 0.03,
        Math.cos(index / 3),
      ]),
    ]),
    "Annual Covariates",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Variable", "Units", "Physical rationale", "Source"],
      ["Custom circulation", "index", "Regional circulation changes moisture convergence during extreme storms.", "Reviewed climate-index archive"],
    ]),
    "Metadata",
  );
  const parsed = parseCovariateWorkbook(XLSX, workbook);
  assert.equal(parsed.covariates.length, 3);
  assert.equal(parsed.covariates.find((row) => row.kind === "enso")?.values.length, 25);
  assert.equal(parsed.covariates.find((row) => row.label === "Custom circulation")?.physicallyPlausible, true);
  assert.match(parsed.covariates.find((row) => row.label === "Custom circulation")?.source ?? "", /Reviewed climate-index archive/);
});

test("covariate models use common years, AICc, residuals, uncertainty and chronological holdout", () => {
  const maxima = Array.from({ length: 40 }, (_, index) => {
    const year = 1981 + index;
    const driver = Math.sin(index * 0.73);
    return { year, depthMm: 70 + 11 * driver + 0.15 * index + 4 * Math.sin(index * 2.17) };
  });
  const covariates = [
    {
      id: "enso",
      label: "Niño 3.4",
      kind: "enso",
      units: "°C anomaly",
      physicalRationale: "Tropical Pacific variability can alter regional moisture transport.",
      source: "Synthetic test index",
      physicallyPlausible: true,
      values: maxima.map((row, index) => ({ year: row.year, value: Math.sin(index * 0.73) })),
    },
    {
      id: "arbitrary",
      label: "Arbitrary code",
      kind: "other",
      units: "code",
      physicalRationale: "",
      source: "Unknown",
      physicallyPlausible: false,
      values: maxima.map((row, index) => ({ year: row.year, value: index % 5 })),
    },
  ];
  const comparison = compareCovariateModels(maxima, covariates);
  assert.equal(comparison.status, "Compared");
  assert.equal(comparison.commonYears.length, 40);
  assert.deepEqual(comparison.rows.map((row) => row.modelId), ["stationary", "time", "enso"]);
  assert.ok(comparison.rows.every((row) => row.n === 40 && Number.isFinite(row.aicc)));
  assert.ok(comparison.rows.every((row) => row.holdoutN >= 5 && Number.isFinite(row.holdoutMeanNll)));
  assert.ok(Number.isFinite(comparison.rows.find((row) => row.modelId === "enso")?.slopeCiLower));
  assert.match(comparison.excluded.find((row) => row.modelId === "arbitrary")?.reason ?? "", /physical rationale/);
  assert.match(comparison.selectionRule, /ΔAICc/);
  assert.doesNotMatch(comparison.selectionRule, /correlation/i);
});

test("online annual covariate parsers preserve years and enforce completeness", () => {
  const noaa = [
    "1950 1952",
    "1950 -99.99 -99.99 -99.99 -99.99 -99.99 -99.99 -99.99 -99.99 -99.99 -99.99 -99.99 -99.99",
    "1951 0.1 0.2 0.3 0.4 0.5 0.6 0.7 0.8 0.9 1.0 1.1 1.2",
    "1952 -0.1 -0.2 -0.3 -0.4 -0.5 -0.6 -0.7 -0.8 -0.9 -1.0 -99.99 -99.99",
    "Nino Anom 3.4 Index",
  ].join("\n");
  const enso = parseNoaaNino34Annual(noaa, 1950, 1952);
  assert.deepEqual(enso.map((row) => row.year), [1951, 1952]);
  assert.ok(Math.abs(enso[0].value - 0.65) < 1e-12);

  const cpc = [
    "YR MON NINO1+2 ANOM NINO3 ANOM NINO4 ANOM NINO3.4 ANOM",
    ...Array.from({ length: 12 }, (_, index) =>
      `2000 ${index + 1} 24 0 25 0 27 0 26 ${((index - 5) / 10).toFixed(2)}`,
    ),
    ...Array.from({ length: 9 }, (_, index) =>
      `2001 ${index + 1} 24 0 25 0 27 0 26 0.50`,
    ),
  ].join("\n");
  const cpcEnso = parseCpcNino34Annual(cpc, 2000, 2001);
  assert.deepEqual(cpcEnso.map((row) => row.year), [2000]);
  assert.ok(Math.abs(cpcEnso[0].value - 0.05) < 1e-12);

  const urban = parseWorldBankUrbanAnnual([
    {},
    [
      { date: "2001", value: 34.2 },
      { date: "2000", value: 33.8 },
      { date: "1999", value: null },
    ],
  ], 2000, 2001);
  assert.deepEqual(urban, [
    { year: 2000, value: 33.8 },
    { year: 2001, value: 34.2 },
  ]);

  const daily = [];
  for (let day = 0; day < 366; day += 1) {
    const date = new Date(Date.UTC(2000, 0, 1 + day)).toISOString().slice(0, 10);
    daily.push({ date, value: 0.25 });
  }
  for (let day = 0; day < 200; day += 1) {
    const date = new Date(Date.UTC(2001, 0, 1 + day)).toISOString().slice(0, 10);
    daily.push({ date, value: 0.5 });
  }
  assert.deepEqual(annualMeanFromDatedValues(daily), [{ year: 2000, value: 0.25 }]);
});

test("online covariate endpoint rejects spatial requests before provider access", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("online-covariate-validation", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const call = (body) => worker.fetch(new Request("http://localhost/api/online-covariates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, ctx);

  const missingPoint = await call({ action: "start", source: "temperature", mode: "point", startYear: 1985, endYear: 2025 });
  assert.equal(missingPoint.status, 400);
  assert.match((await missingPoint.json()).error, /latitude and longitude/);

  const missingPolygon = await call({ action: "start", source: "moisture", mode: "district", startYear: 2000, endYear: 2025 });
  assert.equal(missingPolygon.status, 400);
  assert.match((await missingPolygon.json()).error, /district polygon/);

  const beforeMoisture = await call({ action: "start", source: "moisture", mode: "point", startYear: 1985, endYear: 1999, latitude: 34.015, longitude: 71.525 });
  assert.equal(beforeMoisture.status, 400);
  assert.match((await beforeMoisture.json()).error, /begins in 2000/);

  assert.doesNotThrow(() =>
    validateOnlineCovariateRequest({
      action: "poll",
      source: "moisture",
      mode: "district",
      startYear: 2000,
      endYear: 2025,
      jobs: [{ id: "00000000-0000-0000-0000-000000000000", start: "2000-01-01", end: "2025-12-31" }],
    }),
  );
});

test("hourly workbook parser supports Year Month Day Hour layouts without timezone shifts", () => {
  const workbook = XLSX.utils.book_new();
  const rows = [
    ["NASA POWER-style hourly table"],
    ["Metadata", "Hourly precipitation"],
    ["YEAR", "MO", "DY", "HR", "PRECTOTCORR"],
  ];
  for (let hour = 0; hour < 48; hour++) {
    rows.push([1985, 1, 1 + Math.floor(hour / 24), hour % 24, hour / 10]);
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Hourly Data");
  const parsed = parseObservedWorkbook(XLSX, workbook);
  assert.equal(parsed.resolution, "hourly");
  assert.equal(parsed.hourlyRecords.length, 48);
  assert.equal(parsed.hourlyRecords[0].timestamp, "1985-01-01T00:00");
  assert.equal(parsed.hourlyRecords.at(-1).timestamp, "1985-01-02T23:00");
  assert.equal(parsed.invalidRows, 0);
});

test("schema detection prefers changing single-letter date-time fields over a misleading metadata row", () => {
  const workbook = XLSX.utils.book_new();
  const rows = [
    ["Date", "Time", "Minute", "Rainfall"],
    ["Y", "M", "D", "H", "MIN", "P"],
  ];
  let time = Date.UTC(1985, 0, 1);
  for (let index = 0; index < 600; index++, time += 3_600_000) {
    const date = new Date(time);
    rows.push([date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), index % 19 === 0 ? 1.2 : 0]);
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Ambiguous Hourly Data");
  const parsed = parseObservedWorkbook(XLSX, workbook);
  assert.equal(parsed.hourlyRecords.length, 600);
  assert.equal(parsed.hourlyRecords[0].timestamp, "1985-01-01T00:00");
  assert.equal(parsed.hourlyRecords.at(-1).timestamp, "1985-01-25T23:00");
});

test("numeric HHMM time fields retain minutes and aggregate interval depths by hour", () => {
  const workbook = XLSX.utils.book_new();
  const rows = [
    ["Date", "Time", "Rainfall (mm)"],
    ["1985-01-01", 0, 1],
    ["1985-01-01", 1, 1],
    ["1985-01-01", 59, 1],
    ["1985-01-01", 100, 2],
    ["1985-01-01", 2359, 3],
  ];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "HHMM Data");
  const parsed = parseObservedWorkbook(XLSX, workbook);
  assert.equal(parsed.hourlyRecords.length, 3);
  assert.equal(parsed.hourlyRecords[0].timestamp, "1985-01-01T00:00");
  assert.equal(parsed.hourlyRecords[0].precipitationMm, 3);
  assert.equal(parsed.hourlyRecords.at(-1).timestamp, "1985-01-01T23:00");
});

test("hourly mode safely recovers a verified cumulative counter stored in the minute field", () => {
  const workbook = XLSX.utils.book_new();
  const rows = [["Date", "Precipitation (mm)"]];
  for (let counter = 0; counter < 72; counter++) rows.push([`1985-01-01T00:${counter}`, counter % 11 === 0 ? 1.5 : 0]);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Counter Data");
  const parsed = parseObservedWorkbook(XLSX, workbook, { preferredResolution: "hourly" });
  assert.equal(parsed.hourlyRecords.length, 72);
  assert.equal(parsed.hourlyRecords[0].timestamp, "1985-01-01T00:00");
  assert.equal(parsed.hourlyRecords.at(-1).timestamp, "1985-01-03T23:00");
  assert.equal(parsed.recoveredCounterRows, 72);
  assert.equal(parsed.invalidRows, 0);
});

test("sub-hourly rows are summed into hourly interval depths", () => {
  const workbook = XLSX.utils.book_new();
  const rows = [["Date", "Hour", "Minute", "Rainfall (mm)"]];
  for (let hour = 0; hour < 2; hour++) {
    for (let minute = 0; minute < 60; minute++) rows.push(["01/01/1985", hour, minute, 0.1]);
  }
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Minute Data");
  const parsed = parseObservedWorkbook(XLSX, workbook);
  assert.equal(parsed.resolution, "hourly");
  assert.equal(parsed.hourlyRecords.length, 2);
  assert.equal(parsed.hourlyRecords[0].timestamp, "1985-01-01T00:00");
  assert.ok(Math.abs(parsed.hourlyRecords[0].precipitationMm - 6) < 1e-10);
  assert.equal(parsed.aggregatedSubhourlyRows, 118);
});

test("large hourly imports do not exceed the JavaScript call stack", () => {
  const recordCount = 160_000;
  const rows = [["Timestamp", "Precipitation (mm)"]];
  let time = Date.UTC(1985, 0, 1);
  for (let index = 0; index < recordCount; index++, time += 3_600_000) {
    rows.push([new Date(time).toISOString().slice(0, 16), index % 97 === 0 ? 2.5 : 0]);
  }
  const fakeXlsx = { SSF: XLSX.SSF, utils: { sheet_to_json: () => rows } };
  const workbook = { SheetNames: ["Hourly Data"], Sheets: { "Hourly Data": {} } };
  const parsed = parseObservedWorkbook(fakeXlsx, workbook);
  assert.equal(parsed.resolution, "hourly");
  assert.equal(parsed.hourlyRecords.length, recordCount);
  assert.equal(parsed.hourlyRecords[0].timestamp, "1985-01-01T00:00");
});

test("severely collapsed timestamps are rejected instead of producing a false IDF curve", () => {
  const rows = [["Date", "Hour", "Minute", "Rainfall (mm)"]];
  for (let index = 0; index < 70_000; index++) rows.push(["1985-01-01", 0, index % 60, 0.1]);
  const fakeXlsx = { SSF: XLSX.SSF, utils: { sheet_to_json: () => rows } };
  const workbook = { SheetNames: ["Collapsed"], Sheets: { Collapsed: {} } };
  assert.throws(() => parseObservedWorkbook(fakeXlsx, workbook), /collapsed 70,000 source rows to only 60 timestamps/);
});

test("individual CMIP6 GCM selection changes screening results", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("cmip6-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const base = "http://localhost/api/idf?district=Peshawar&source=cmip6&model=nonstationary&scenario=ssp585&period=2081-2100&gcmMode=individual&gcmModel=";
  const accessResponse = await worker.fetch(new Request(`${base}ACCESS-CM2`), env, ctx);
  const ukesmResponse = await worker.fetch(new Request(`${base}UKESM1-0-LL`), env, ctx);
  assert.equal(accessResponse.status, 200);
  assert.equal(ukesmResponse.status, 200);
  const access = await accessResponse.json();
  const ukesm = await ukesmResponse.json();
  assert.equal(access.projection.catalogueModelGridEntries, 35);
  assert.notEqual(access.projection.modelScreeningFingerprint, ukesm.projection.modelScreeningFingerprint);
  assert.notEqual(access.projection.combinedScreeningFactor, ukesm.projection.combinedScreeningFactor);
  assert.notEqual(access.rows[0].intensityMmHr, ukesm.rows[0].intensityMmHr);
});

test("IDF endpoint validates and reports point extraction coordinates", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("point-idf-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };

  const missing = await worker.fetch(
    new Request("http://localhost/api/idf?district=Peshawar&source=era5&spatialMode=point"),
    env,
    ctx,
  );
  assert.equal(missing.status, 400);

  const valid = await worker.fetch(
    new Request("http://localhost/api/idf?district=Peshawar&source=era5&spatialMode=point&latitude=34.015&longitude=71.525"),
    env,
    ctx,
  );
  assert.equal(valid.status, 200);
  const body = await valid.json();
  assert.equal(body.spatialExtraction.mode, "point");
  assert.equal(body.spatialExtraction.latitude, 34.015);
  assert.equal(body.rows[0].spatialMode, "point");
  assert.equal(body.rows[0].longitude, 71.525);
});

test("live online extraction endpoint validates source dates and point coordinates before provider access", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("online-validation-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const call = (body) => worker.fetch(new Request("http://localhost/api/online-precipitation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, ctx);

  const missingPoint = await call({ action: "start", source: "era5", mode: "point", start: "2010-01-01", end: "2019-12-31" });
  assert.equal(missingPoint.status, 400);
  assert.match((await missingPoint.json()).error, /latitude and longitude/);

  const beforeProduct = await call({ action: "start", source: "imerg", mode: "point", start: "1999-01-01", end: "2001-12-31", latitude: 34.015, longitude: 71.525 });
  assert.equal(beforeProduct.status, 400);
  assert.match((await beforeProduct.json()).error, /begins on 2000-06-01/);

  const chirpsHourly = await call({ action: "start", source: "chirps", resolution: "hourly", mode: "point", start: "2010-01-01", end: "2019-12-31", latitude: 34.015, longitude: 71.525 });
  assert.equal(chirpsHourly.status, 400);
  assert.match((await chirpsHourly.json()).error, /no hourly series/);

  const imergHourly = await call({ action: "start", source: "imerg", resolution: "hourly", mode: "point", start: "2010-01-01", end: "2019-12-31", latitude: 34.015, longitude: 71.525 });
  assert.equal(imergHourly.status, 400);
  assert.match((await imergHourly.json()).error, /authenticated NASA archive access/);

  const powerHourly = await call({ action: "start", source: "power", resolution: "hourly", mode: "point", start: "2010-01-01", end: "2019-12-31", latitude: 34.015, longitude: 71.525 });
  assert.equal(powerHourly.status, 400);
  assert.match((await powerHourly.json()).error, /corrected daily precipitation/);

  const era5LandPrecipitation = await call({ action: "start", source: "era5land", resolution: "daily", mode: "point", start: "2010-01-01", end: "2019-12-31", latitude: 34.015, longitude: 71.525 });
  assert.equal(era5LandPrecipitation.status, 400);
  assert.match((await era5LandPrecipitation.json()).error, /does not provide precipitation values/);

  const tooLongHourly = await call({ action: "start", source: "era5", resolution: "hourly", mode: "point", start: "1980-01-01", end: "2025-12-31", latitude: 34.015, longitude: 71.525 });
  assert.equal(tooLongHourly.status, 400);
  assert.match((await tooLongHourly.json()).error, /limited to 45 calendar years/);
});

test("daily source endpoint never presents screening values as precipitation data", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("daily-source-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/daily?district=Peshawar&source=era5"),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 501);
  const body = await response.json();
  assert.equal(body.dataStatus, "not_ingested");
  assert.equal(body.rows, undefined);
  assert.match(body.officialDownloadUrl, /cds\.climate\.copernicus\.eu/);
});
