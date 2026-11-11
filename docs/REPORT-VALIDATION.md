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
