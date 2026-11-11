# Report revision 3.0 validation

Browser validation used Chromium with a 1440 px desktop viewport and a 390 px
mobile viewport. Both the initial empty state and a populated observed-data
workflow were checked. The populated example uses 35 complete synthetic years
(1985–2019), generated with `node scripts/generate-sample-gauge.mjs`.
Upload that file and label the source “SYNTHETIC DEMONSTRATION — not measured
rainfall” to reproduce the example. Defaults: daily observations, stationary
GEV, L-moments. The resulting 10-year / 24-hour intensity is approximately
3.18 mm/hour. These values must not be used as local rainfall estimates.

Checks completed:

- Successful HTML and genuine DOCX downloads from the browser.
- DOCX ZIP structure and document XML parsed; chart media embedded.
- Self-contained HTML contains the synthetic label, decision summary and SVG.
- A4 report cover and executive-summary pages inspected visually.
- Mobile summary checked at 390 px; wide technical tables retain scrolling.
- Expanded manual printed to eight A4 pages; text extracted from every page.
- Empty input clearly states that no fitted result is available.
- Application type-check: `npx tsc --noEmit -p tsconfig.vercel.json`.
- Lint and build completed successfully.
- New report metadata/filename and downloadable artifact regression tests passed.

The full repository test suite has two unrelated existing blockers: the
untracked `standalone/wheels` installer dependency folder is absent from a clean
clone, and the rendered-page test expects a `codex-preview` development meta tag
that `app/layout.tsx` does not emit. The report changes do not add that tag or
modify installer packaging. The default root TypeScript configuration also lacks
Cloudflare worker types and `.ts` import support; use the existing application
configuration above for the report/application scope.

Generated samples and manuals are in `public/downloads/`. Regenerate their PDFs
from Chromium with A4, print backgrounds and CSS page size enabled when updating
the source HTML or report layout. A real assessment must be exported from the
user's actual source data and analysis selection.

Revision 3.0 checks also covered the active coefficient table, a worked example
matching the direct calculator at 60 minutes, the expandable constant explanation,
source-aware calculation steps, acronym navigation and exported equation text.
The empty state was checked to ensure it does not invent coefficients or a worked
example. DOCX XML was checked for equation explanations and acronym content, and
its embedded chart was verified. PDF coefficient and acronym pages were inspected.
The expanded sample is still synthetic and is not a local rainfall assessment.

## Literature calibration update

- Sherman duration offset is profiled over a disclosed nonnegative range when
  at least three independently supported native durations are present.
- Regression tests recover a known four-parameter synthetic surface, exclude
  derived points from native calibration, flag non-identifiable/zero/upper-bound
  offsets, and reject duration/return-period extrapolation.
- Browser checks cover daily-derived fallback, native hourly calibration,
  sub-hour rejection for the hourly calibration, direct calculator alternatives,
  Excel `(t+b)` formulas, range metadata, and responsive layout.
- Paper abstracts/metadata were checked through Consensus; its full-text tool
  was unavailable. This implements the Sherman family with a disclosed numerical
  procedure, not a claimed reproduction of the 2025 IDF-GtzLo algorithm.
- The source references appear in the on-page report and Excel workbook.
- GitHub checkout test results: 51 passed and the same two existing failures
  (missing offline installer assets and stale preview-meta expectation).

## ECMWF IFS source update

Added explicit `ecmwf_ifs` retrieval through Open-Meteo's archive API, checked
against the provider documentation and live precipitation responses at 34°N,
72°E. Daily and hourly point retrieval and workbook downloads passed in Chromium.
A complete daily 2017–2025 request produced nine eligible annual maxima and fitted
IDF curves. Source metadata, record start, UTC interval, returned coordinates and
the short-record/model-upgrade caveat are retained in reports and spreadsheets.
District means are explicitly approximate request-mesh samples, not native-grid
area integrals. Unit tests verify model selection, millimetre units, null handling,
date bounds and district metadata. IFS shares Open-Meteo quotas with ERA5.

## District spatial QDM update

- District historical GCM requests now use the selected polygon; ERA5 reference
  requests use district mode and retain their approximate representative sampling.
- Automatic district correction uses ERA5; a point gauge is not relabelled as a
  district reference and point hourly ratios are not applied to district output.
- At least 20 common eligible years within 1985–2014 are required. QDM is applied
  after district aggregation and before corrected annual-maxima fitting.
- Calibration identities include spatial mode, boundary code/version and polygon
  content; changing district/geometry or realization invalidates stale correction.
  Stored ensembles keep their corresponding spatial audit.
- Unit tests check spatial identities, reference selection, matched year coverage
  and the district-series QDM calculation.
- A Chromium end-to-end test with controlled provider responses verified district
  polygon requests for all 30 historical years, ERA5 district sampling, corrected
  24-hour results, Bias Spatial Audit export, invalidation after district change and
  continued point-mode correction.
  This test does not establish live NASA availability or local gauge accuracy.
