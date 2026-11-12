# Selectable project districts: Pakistan and disputed Kashmir region

The active map now loads `public/data/project-districts.geojson`: 182 selectable
features in one layer. It replaces the former generalized, non-selectable
Kashmir overlay. Click a district on this map or choose its region and district
in the same selectors used for the original Pakistan districts.

## Existing 160 districts

The original OCHA COD-AB PAK ADM2 v01 (2022–2024) features are preserved exactly,
including their geometry and identifiers. License: CC BY-IGO. Existing display
aliases reconcile to their original district names. The combined catalogue
retains all seven original province/territory groups.

## Added 22 source districts

Source: geoBoundaries gbOpen IND ADM2, `IND-ADM2-76128533`, represented year 2021,
release `9469f09`, retrieved 12 November 2026.

- API: https://www.geoboundaries.org/api/current/gbOpen/IND/ADM2/
- Full-resolution source (not the simplified download):
  https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND/ADM2/geoBoundaries-IND-ADM2.geojson
- Attribution: Pathways Data Pvt. Ltd.; lgdirectory.gov.in.
- License: Open Data Commons Open Database License 1.0 (ODbL-1.0).
- Groups: Jammu and Kashmir (disputed), 20 districts; Ladakh (disputed), 2 districts.

Geometry is copied **without simplification, clipping, intersection with Natural
Earth, or manual redrawing**. Source `shapeID`, `shapeName`, source release,
license and represented year are retained. Source/display spelling aliases
include Badgam/Budgam, Baramula/Baramulla, Shupiyan/Shopian, Bandipore/Bandipora,
and Punch/Poonch. `Poonch (Jammu and Kashmir)` is explicitly distinguished from
the existing Azad Jammu & Kashmir Poonch district. These are display aliases,
not geometry changes.

The source's large `DATA NOT AVAILABLE` area is not a named district and is
excluded. No new districts or later administrative splits are invented. Some
source extents, particularly Leh, relate to disputed claims rather than a
precise depiction of actual control. The map labels the regions as disputed;
it does not determine sovereignty or resolve competing claims. Full source
resolution does not mean survey-grade positional accuracy or current validity.

## Analysis integration

Added polygons are passed to the same district rainfall aggregation, historical
and future CMIP6 extraction, ERA5 reference and district QDM paths. Coordinate
coverage and the outlet reference extent include the added districts. Boundary
identifiers and source versions enter spatial calibration keys and exports;
new districts are not falsely attributed to OCHA. Retrieval remains subject to
provider coverage, quotas and existing minimum-year/quality checks. Inclusion
of a selectable boundary does not establish gauge validation of rainfall.

The Pakistan-study IMD preset remains a published empirical duration method;
its transfer to the additional districts is not a newly calibrated local model.
The optional 2017 Pakistan tehsil layer has not been expanded to Kashmir.

## Integrity checks

All 22 added geometries were compared directly with the downloaded original
source: serialized coordinate arrays are identical. The committed source
fingerprints in `public/data/kashmir-district-source-fingerprints.json` retain
SHA-256 geometry hashes. Tests check those fingerprints, unique catalogue/map
matching for all 182 districts, preservation of the original 160 features, and
source-aware provenance for every additional district.

The combined collection preserves each component's separate attribution and
license. The complete derived collection is distributed with the website and
repository; no claim is made to relicense the original source components.
