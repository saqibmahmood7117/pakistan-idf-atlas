# Pakistan IDF Atlas

An interactive, source-backed rainfall intensity–duration–frequency (IDF)
analysis workspace for Pakistan. The Atlas can ingest gauge workbooks, retrieve
live gridded precipitation, fit stationary and nonstationary extreme-value
models, and integrate model-specific bias-corrected CMIP6 projection results.

## What it does

- Reads daily, hourly, and sub-hourly gauge workbooks with automated schema and
  completeness checks.
- Retrieves live ERA5 precipitation through Open-Meteo and CHIRPS precipitation
  through ClimateSERV, with documented provider metadata and browser fallbacks.
- Retrieves model-specific NASA NEX-GDDP-CMIP6 daily precipitation where the
  NASA subset service is reachable.
- Applies monthly multiplicative quantile delta mapping (QDM) against a gauge
  record or clearly labelled ERA5 reference before fitting future extremes.
- Keeps models separate and summarizes corrected return levels as the
  multi-model median with P10–P90 inter-model spread.
- Imports validated, precomputed bias-corrected CMIP6 workbooks when daily NASA
  retrieval is unavailable.
- Exports traceable Excel workbooks, charts, and a technical report.

The application is a screening and analytical aid. It does not replace local
gauge validation, governing design criteria, or independent hydrologic and
engineering review.

## Reports and user manual

The report is generated from the active data, source, model and method. Revision
4.0 adds equation-by-equation definitions, constant provenance, current coefficient
tables, a worked calculation, a source-aware step-by-step workflow and an acronym
list. It builds on an assessment-at-a-glance panel, a 24-hour decision table with intensity,
depth and annual exceedance probability, and improved A4 typography and tables.
Download controls are available immediately above the report and at its end.

The IDF chart shows colour-matched Excel-style power equations for every return
period, with superscript exponents and log-space R². Each equation fits
`i = c × t^p`, where `t` is minutes and `i` is mm/hour. Equations remain in
the downloaded image, HTML, PDF and Word report. The Excel **IDF Equations**
sheet retains coefficients, exponents and formula-driven values. A curve with
fewer than two supported durations has no duration equation.

Use **Enter duration t → calculate intensity i** above the chart to enter any
duration in minutes within the fitted curve’s range. Select a return period;
intensity (mm/hour) and rainfall depth (mm) update immediately. The default
Sherman mode uses `i=a*T^m/(t+b)^n`; the selectable Excel-style power mode uses
that return period’s full-precision power equation. Invalid or unsupported durations
do not produce an estimate.

- **Print / Save PDF** opens the browser print dialog. Select A4, 100% scale and
  background graphics; inspect the preview before saving.
- **Word report (.docx)** creates a genuine editable Office Open XML document,
  with headings, tables, an embedded chart and page numbers. It replaces the
  previous HTML document saved with a `.doc` extension.
- **Editable HTML** includes the report styles and chart for offline viewing.
- [User manual (PDF)](public/downloads/Pakistan-IDF-Atlas-User-Manual.pdf)
  and [browser-readable manual](public/downloads/Pakistan-IDF-Atlas-User-Manual.html)
  cover source preparation, QC, fitting, CMIP6, interpretation and export.

A complete example is available as [PDF](public/downloads/Pakistan-IDF-Atlas-Sample-Report.pdf),
[Word](public/downloads/Pakistan-IDF-Atlas-Sample-Report.docx) and
[HTML](public/downloads/Pakistan-IDF-Atlas-Sample-Report.html).
**The example uses reproducible synthetic daily rainfall for 1985–2019. It is
for demonstrating the report format, not a location-specific rainfall assessment.**
No real gauge data were supplied for this example. Generate an actual assessment
by loading the required data and exporting the active analysis.

The report module is `lib/report-export.ts`; browser layout and content are in
`app/page.tsx`. The static manual HTML is the editable source for its PDF.
Whenever the manual or report styling changes, reprint the manual/sample in
Chromium and inspect the A4 pages and DOCX chart before committing the artifacts.

## Literature-supported Sherman calibration

The equation family `i=a*T^m/(t+b)^n` is supported by the published literature
listed in `lib/idf-literature.ts` and in the generated report. No coefficients
are borrowed from another region. This implementation is not the 2025 paper’s
IDF-GtzLo algorithm, and literature support does not establish local validation.

The Atlas fits a, m and n in log space for each candidate nonnegative b and
profiles b over `[0, maximum calibrated duration]`. This search bound and objective
are disclosed implementation choices. At least three independently supported
native durations are required to fit b. Derived short-duration rows are excluded
when multiple native durations are available. With insufficient native durations,
b=0 remains an explicitly labelled descriptive simplification; it must not be
presented as an independently calibrated offset. Zero and upper-bound solutions
are identified for review. Calculators reject evaluation outside the calibration
ranges in duration and return period. Log-space R² measures representation fit,
not rainfall accuracy. Independently validate local gauge extremes before design.

## Data sources

| Source | Connection | Native support in the Atlas |
| --- | --- | --- |
| ERA5 | Open-Meteo Historical Weather API | Daily or hourly point/grid-cell data; district sampling where supported |
| ECMWF IFS | Open-Meteo explicit `ecmwf_ifs` archive | Hourly or daily from 2017; point or sampled district mean |
| CHIRPS | SERVIR ClimateSERV | Daily point or polygon statistics |
| NASA NEX-GDDP-CMIP6 v2 | NASA NCCS THREDDS/NCSS | Daily `pr`, one model/member/scenario at a time |
| Gauge workbooks | Local Excel/CSV import | Daily, hourly, or sub-hourly observations |
| Corrected CMIP6 results | Local Excel import | Model-specific 24-hour GEV return levels and ensemble spread |

ECMWF IFS is an operational model-analysis archive, not a homogeneous long-term
reanalysis. Its shorter record and model upgrades limit rare-event inference.
The product shares Open-Meteo quotas with ERA5; it is not an independent
retrieval-service fallback. District extraction maps a representative 0.1°
request mesh to nearest model cells and is explicitly approximate.

No OpenAI API key is required. Provider requests use public data services and
the imported files remain in the browser workflow.

## District spatial bias correction

Select **CMIP6 projections**, an individual model and **District spatial series**.
Load the verified polygon, retrieve the future GCM series, then choose **Automatic**
or **ERA5 reanalysis** and click **Retrieve historical GCM & bias-correction
reference**. The 1985–2014 historical GCM uses the same polygon/cell-weighting
rule as the future extraction. ERA5 uses the documented representative-cell
approximation over that polygon. At least 20 common eligible baseline years are
required. Monthly QDM is applied after spatial aggregation and before extracting
corrected annual maxima; this is a district-series correction, not cell-wise QDM.

A single uploaded gauge is not treated as a district reference. District correction
directly supports 24-hour return levels; point gauge duration ratios are not extended
to district rainfall. Metadata and the **Bias Spatial Audit** workbook sheet retain
the spatial mode, polygon identity/version, model member, grid-cell counts,
reference sampling method and matched baseline years. Changing district, polygon,
mode or model member invalidates the corresponding calibration. Point and district
ensembles are kept separate. A nearest-cell fallback cannot be passed off as a
historical district-average series. ERA5 correction remains reanalysis-corrected,
not gauge-validated.

When only 24-hour results are available, the chart plots **intensity against
return period** and the calculator provides a fixed-duration result lookup.
It does not display an empty duration axis or attempt to fit a duration equation.
For district QDM results, **Show derived sub-daily curves (assumed scaling)**
optionally applies `P(t)=P24*(t/1440)^alpha` after daily correction. It is off by
default; the exponent, derived status and distinction from independently corrected
sub-daily rainfall are recorded in the interface and exports. These assumptions
must be checked against local duration evidence before design use.

## Bias-corrected CMIP6 workbook format

Use **Import bias-corrected results workbook** in the CMIP6 workspace. The
importer requires these sheets:

- `Read Me`: `Location`, `Reference`, and `Historical overlap` rows.
- `Validation`: a validation title and a check table with result, evidence,
  severity, impact, and required action.
- `Model IDF`: model, member, scenario, period, return period,
  `Primary_Corrected_24h_Depth_mm`, and
  `Primary_Corrected_Intensity_mm_hr`.

An `Ensemble IDF` sheet is optional. When present, the Atlas cross-checks its
P10, median, and P90 summaries against the model-specific rows. Imports are
rejected if coordinates or scenario labels are invalid, depth and intensity do
not reconcile, curves are non-monotonic, return periods differ across models,
or fewer than three models are available.

Summary workbooks do not contain enough information to reconstruct daily
precipitation, stationarity diagnostics, alternative-distribution fits, or
sub-daily IDF. The Atlas therefore reports imported results at 24 hours only.

## Development

Requirements:

- Node.js 22.13 or newer
- npm

```bash
npm ci
npm run dev
```

The development server is normally available at `http://localhost:3000` or at
the URL reported by Vite.

Useful commands:

```bash
npm test
npm run lint
npm run build
npm run validate:artifact
```

`npm test` builds the Vinext/Cloudflare artifact and runs the data-processing,
provider-validation, workbook-import, boundary, CMIP6, and rendered-output test
suite.

## Windows standalone automation app

The `standalone/` folder contains a graphical Windows controller that uses
Selenium to automate the live Atlas. It supports ERA5 daily/hourly, CHIRPS
daily, point or district extraction, and corrected CMIP6 workbook import. Every
run can download the Excel output and chart, save a diagnostic screenshot, run
automatic IDF QA, and append results to a persistent Excel log.

Download the prepared ZIP from the Atlas home page and double-click
`RUN_PAKISTAN_IDF_ATLAS.bat`. The first launch creates its own Python
environment from included offline wheels and repairs incomplete Selenium
installations without contacting PyPI. `BUILD_WINDOWS_EXE.bat`
produces a single windowed executable on a Windows computer and runs a packaging
self-test for Chrome WebDriver and Selenium Manager; the GitHub workflow applies
the same test automatically when the repository is connected.

The installer/build process can work during a PyPI outage. Live Atlas, ERA5,
CHIRPS and CMIP6 retrieval still requires internet access.

## Project layout

```text
app/page.tsx                         Interactive dashboard and report
app/api/online-precipitation/        Live ERA5/CHIRPS/POWER/IMERG gateway
app/api/cmip6-precipitation/         NASA CMIP6 catalogue and annual subsets
lib/observed-idf.ts                  QC, extremes, distributions, uncertainty
lib/cmip6-extremes.ts                QDM and multi-model ensemble calculations
lib/cmip6-workbook.ts                Corrected-results workbook validation
lib/online-precipitation.ts          Provider requests and precipitation plots
tests/rendered-html.test.mjs         Build and analytical regression tests
```

## Method notes

- Annual maxima require at least 90% coverage in each retained year.
- Daily sources directly support 24-hour totals. Shorter durations are shown
  only from native hourly data or explicitly documented observed duration
  ratios.
- Monthly multiplicative QDM preserves the GCM-simulated relative change at
  each quantile while mapping the historical distribution to the selected
  reference.
- Multi-model statistics are calculated across model-specific return levels;
  model-years are never pooled as independent observations.
- P10–P90 model spread is not a 95% sampling-confidence interval.
- The 250- and 500-year levels are extreme extrapolations from short climate
  records and require regional evidence and independent review.

## Deployment

The repository includes the OpenAI Sites/Vinext configuration used by the live
Atlas. The build produces a Cloudflare-compatible worker artifact validated by
`scripts/validate-artifact.sh`.

## Citation and licensing

Provider and methodological references are listed in the generated technical
report inside the application. No open-source license has yet been declared;
add the project owner's chosen license before inviting external reuse or
contributions.
