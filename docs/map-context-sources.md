# Permanent default map: user-supplied Districts.zip

The active map loads `/data/uploaded-districts.geojson` automatically on initial
page load and when the default district layer is reloaded. The original archive
is retained unchanged at `/data/Districts.zip`. This replaces the previous
OCHA/geoBoundaries combination as the active default; earlier data files are
retained only as historical assets, not mixed into this map.

## Source inspection

The archive supplied on 12 November 2026 contains Districts.shp, .shx, .dbf and
.prj. It has 161 named records and nine PROVINCE/source groups. Properties include
OBJECTID, PROVINCE, DISTRICT, ADMIN_UNIT and source shape metrics. Dataset year,
author and license were not supplied; ZIP timestamps are not treated as a
boundary-validity date. The source is not described as an official current map.

The PRJ declares WGS 84 geographic horizontal coordinates (EPSG:4326), plus
vertical metadata. Only its horizontal coordinates are used for this 2D map.
No horizontal reprojection, coordinate rounding, clipping or simplification
is applied. The source contains historical FATA/agency groupings, cantonments,
and one combined Kashmir unit. They are retained as source units rather than
replaced by newer administrative subdivisions. Raw PROVINCE, DISTRICT and
ADMIN_UNIT fields are preserved. Human-readable capitalization and neutral
Kashmir display labels do not change the original attributes or geometry.

## Conversion and repairs

Conversion used pyshp and Shapely; pyproj verified the horizontal CRS.
Barkhan (record 12) and Batagram (record 64) contain self-intersecting rings.
GEOS `make_valid` repairs their topology without simplification or clipping.
Both remain polygons; relative planar-area changes are less than 1e-12.
The source archive remains unchanged. The exact repair reasons and areas are
recorded in `/data/uploaded-districts-manifest.json`.

An independent JavaScript shapefile decoder (`shpjs`, already used by the app)
verified all original records and the coordinate arrays for the other 159
units. Decoder numerical differences are below 1e-9 degrees; conversion itself
copies the original horizontal coordinate values. Node tests verify this
comparison against the retained ZIP.

The original OBJECTID repeats for several records. Analysis identifiers therefore
combine the archive checksum and record number, not OBJECTID alone. The complete
SHA-256 is in the manifest, feature attributes and `lib/default-boundary.ts`.
Changing the archive changes the boundary identity and invalidates corresponding
spatial calibration keys. Reports and exports state `User-supplied Districts.zip`,
the checksum-based version and that a represented year was not supplied.

## Application integration

- `lib/district-catalogue.ts` contains exactly the archive's 161 names, grouped
  by its nine province/source classifications. Map clicks and the linked selectors
  reconcile against these names.
- The same polygons supply representative points, coordinate coverage checks,
  district rainfall aggregation, historical/future extraction and bias-correction
  identities. Provider coverage and existing minimum-data checks still apply.
- The supplied combined Kashmir polygon is selectable as one source unit;
  Srinagar and other subdivisions from the previous default are not invented.
- The full vertex count is supported without argument-spread stack limits, and
  SVG paths are cached between pan/zoom updates.
- The optional 2017 tehsil layer is separate. Temporarily uploading another
  boundary does not overwrite this bundled permanent default.

Source classifications and disputed extents do not determine current
administrative status, sovereignty or actual control. Inclusion of a polygon
also does not establish gauge validation or local calibration of rainfall.
