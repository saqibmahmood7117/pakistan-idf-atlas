# Native sub-daily correction

The **Native 3-hour projections** tab retrieves ACCESS-CM2 r1i1p1f1 native
CMIP6 `3hr pr` files from ESGF/CEDA. It is separate from daily NEX-GDDP.
Historical years are 1985–2014; future years follow the selected SSP and period.
ERA5 hourly reanalysis supplies the matching spatial reference. Model grid
spacing is 1.25° latitude × 1.875° longitude.

## Calculation

1. Convert native precipitation flux to 3-hour rainfall depth: kg m⁻² s⁻¹ ×
   10800 seconds = mm. Convert verified CF interval midpoints to interval starts.
2. For districts, aggregate model cells using polygon/cell overlap weights;
   missing intersecting cells invalidate that interval. ERA5 district reference
   sampling is approximate. Point extraction uses the provider's native cell.
3. Independently form rolling 3-, 6-, 12- and 24-hour totals from consecutive
   native intervals. Do not bridge gaps or derive shorter durations. Require
   90% coverage of native intervals and valid duration windows in each year.
4. Fit stationary GEV distributions by L-moments separately to historical model,
   future model and historical reference annual maxima at **each duration**.
   Require at least 20 common eligible baseline years and eight future years.
5. At each return period T and duration d, calculate
   `Qcorr(T,d) = Qref,h(T,d) × Qmodel,f(T,d) / Qmodel,h(T,d)`.
   Divide depth by `d/60` to obtain intensity in mm/hour.
6. Estimate percentile intervals using 100 year-bootstrap refits, pairing
   historical model/reference years and independently resampling future years.
   Report duration ordering problems instead of imposing a scaling exponent.

This is multiplicative quantile-change correction **of fitted return levels**.
It is not monthly daily QDM, a corrected continuous rainfall series, or a
storm-sequence coherence method. Literature on quantile-change preservation
(e.g. Cannon, Sobie & Murdock, 2015, Journal of Climate 28, 6938–6959) motivates
this distinction; it does not validate these local projections. GEV estimation
uses the Atlas's existing L-moment implementation.

The chart power equations summarize corrected duration points independently
for each T. They use fitted coefficients, not a prescribed −0.670 exponent.
The duration calculator is limited to 180–1440 minutes. No native 1-hour or
shorter climate projection is claimed. Reanalysis correction is not gauge
validation. Rare return levels, especially 250–500 years, remain extrapolations.

## Verification record

- Actual ESGF/CEDA catalogues checked for historical and SSP245 coverage.
- Actual NCSS three-day netCDF point subset parsed and retained as a test fixture.
- Actual 1985 point subset retrieved in the browser: 2,920 native intervals.
- Actual three-day district grid parsed; actual full-year 1985 district NCSS
  subset retrieved (203,728 bytes) and parsed into 2,920 intervals from two
  intersecting cells, supporting all four rolling duration maxima.
- Unit checks cover flux/time conversion, district overlap and holes, native
  duration support, incomplete years, independent quantile correction,
  bootstrap intervals, catalogue selection and source URL validation.
- Browser integration with controlled district model/reference inputs covers
  60 yearly model requests, seven ERA5 reference requests, four durations,
  32 return levels, chart, Excel and standalone HTML downloads, with no page errors.
- A complete multi-decade calculation against all live model and reference
  sources has **not** been validated. Provider availability/rate limits can
  interrupt retrieval; completed yearly model subsets are cached in the tab.
- The local Worker cannot always reach the upstream archive. The browser
  retries the identical validated archive through CORS; it never substitutes
  daily rainfall. A failure in both transports stops the calculation.

Source discovery: https://esgf-data.dkrz.de/esg-search/search

Archive: https://esgf.ceda.ac.uk/thredds/catalog/esg_cmip6/catalog.html

Reference: https://archive-api.open-meteo.com/v1/archive (`models=era5`).
