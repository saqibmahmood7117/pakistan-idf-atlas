# Selected-district precipitation map

The boundary workspace includes a dedicated precipitation map for the currently
selected district/source unit. It uses the permanent uploaded geometry. A daily
or hourly series must match both its boundary code and version, and have been
retrieved in district mode. Point series, gauge observations and IDF return levels
are not painted as district rainfall fields. Changing boundary/source selection
invalidates the displayed series/snapshot.

## Retrieved district-series view

The native date/hour and slider select an existing QC-retained record. The polygon
is coloured by that record's precipitation depth. Its scale is fixed to the maximum
of the retrieved series, so date changes are comparable. One polygon-wide value
is an aggregate or representative district series, not a claim of uniform rain.
CMIP6 uses the daily QDM-corrected series when correction is available, otherwise
raw daily values. A nearest-cell representative fallback is explicitly labelled.
No monthly/annual aggregation, IDF return period or duration scaling is silently
substituted for this native time series. Missing dates are not filled.

## Optional raw source samples/grid

- ERA5/IFS: re-request the selected interval from Open-Meteo using the same
  representative request mesh, cell cap and sampling weights as the district
  extraction. Require mm units, exact timestamps and actual returned coordinates.
  Preserve nulls as missing. Merge duplicate returned cells with identical values;
  never invent separate locations from repeated requests. ERA5 0.25° footprints
  are clipped to the selected polygon for display; IFS displays locations only,
  because its exact native footprint is not returned. This is representative
  sampling, not a complete raster or interpolated rainfall field.
- CMIP6: the existing validated model/scenario/member/file route accepts a
  `spatialDate` within the selected year and asks NASA NCSS for that day's native
  grid. Parsing applies the same mask, missing/scale/offset/unit rules and
  latitude weights as the district extractor. Only accepted valid cells from the
  requested native date are returned. Footprints use returned coordinate spacing;
  display clipping does not change values. Calendar gaps produce no spatial
  values, rather than synthetic rainfall. Nearest-cell fallback remains flagged.
- Other providers: the district-series value is shown; unavailable cell fields
  are not reconstructed from an aggregate.

Raw snapshots have their own date-specific colour scale and retrieval time.
They may differ from earlier cached series if the provider revises data. Snapshots
are keyed by timestamp, and the component is scoped to source/boundary/retrieval
identity. A late response cannot populate another district or date's map.

District-level monthly QDM is not independent correction of every source cell.
The map never rescales a raw field to make it appear cell-wise bias-corrected.
Changing to raw view clearly labels the difference from a corrected district series.

## Units, interaction and export

Precipitation is depth per native interval: mm and inches (divide by 25.4).
It is not an IDF intensity in mm/hr. Date/hour controls use source UTC timestamps.
Missing values are grey and distinct from zero precipitation. Hover, focus or
select a location to read its value. CSV preserves coordinates, missing values,
source/retrieval information and boundary code/version; SVG includes source and
boundary descriptions. No-grid exports are disabled until a snapshot exists.

## Verification

- Source tests check exact requested timestamp/model/units, actual returned
  coordinates, missing-data handling and distinct zero/missing colours.
- A synthetic NetCDF fixture verifies spatial values and ensures original
  daily district aggregation is unchanged.
- Compiled Worker API tests verify single-day NCSS parameters, rejection of invalid
  dates, raw cell output and exclusion of other timestamps.
- Live ERA5 retrieval checked for 2020-01-01 over the permanent Peshawar polygon:
  four returned locations (34,71.5), (33.75,71.75), (34,71.75), (34.25,71.5),
  with depths 0, 0.2, 0, 0.1 mm respectively at verification time (12 November 2026).
  This checks live source retrieval, not gauge accuracy or all source/date combinations.
- Complete live CMIP6 snapshot retrieval and browser interaction remain unverified;
  mocked provider API integration and production compilation are checked.

## Annual rainfall summary

The panel and report also show mean annual rainfall for the retrieved district
series (using the active corrected CMIP6 series when applicable):

`A_y = sum of valid native rainfall depths in calendar year y`

`mean annual rainfall = sum(A_y for complete years) / number of complete years`

Completeness for this total-rainfall metric is 100% of source-calendar daily or
hourly intervals, stricter than the existing 90% IDF maxima eligibility rule.
A total cannot treat unknown rainfall as zero. Entirely missing years between
returned dates are retained as missing in the coverage audit, not skipped.
Partially observed annual totals are reported but excluded from the mean.
Available data from these years remain included in the separately labelled
full-period retrieved total. No annualization, gap filling or duration-scaling
formula is used. Zero precipitation remains valid; duplicate timestamps are
not double-counted. Unknown calendars do not produce a claimed annual mean.

Standard/Gregorian leap years and 365-day/noleap model years have separate
expected counts. Open-Meteo hourly totals describe the preceding hour; their
source timestamps are shifted to interval start only for annual assignment.
Completing the final annual total can therefore require the following
1 January midnight record. The UI states this and lists excluded boundary years.

When the whole period is complete, the result is the full-period mean annual
rainfall. Otherwise it is explicitly labelled as the complete-year subset.
The source UTC date span, used/excluded years, annual coverage and full-period
total are visible. Mean annual map mode disables date controls, displays the
single district-series mean in mm/year, and does not infer a cell-wise annual
field. CSV/Excel exports retain all annual totals and the same coverage basis.

Numerical checks cover unequal leap-year totals, missing entire years, partial
years, zero rainfall, duplicates, invalid dates, noleap models and hourly
interval-ending assignment. No annual statistic is inferred from imported IDF
return-level summaries without a matching continuous district rainfall series.
