# Province catalogue and Kashmir context

## Analytical district catalogue

`lib/district-catalogue.ts` is generated from the 160 features in
`public/data/pakistan-districts-ocha-2024.geojson`, using `adm1_name` to group
and `adm2_name` to identify each district. Existing display aliases are preserved
using `normalizeBoundaryName`. All displayed names reconcile one-to-one to the
actual OCHA polygons. Seven province/territory groups are available.

The catalogue is versioned OCHA COD-AB PAK ADM2 v01, with represented/valid dates
2022–2024. It is not a claim to include later administrative changes lacking
matching polygons. Changing province chooses its alphabetically first district.
Map selections derive the displayed province from the same catalogue.

## Context overlay, prepared 12 November 2026

`public/data/kashmir-context.geojson` contains two **non-analytical** features:
Jammu and Kashmir and Ladakh, labelled Indian-administered and disputed. The
wording describes the map's generalized administration context; it does not
make a determination of sovereignty or depict all territorial claims.

Sources:

1. geoBoundaries gbOpen IND ADM1, boundary ID `IND-ADM1-1811400`.
   https://www.geoboundaries.org/api/current/gbOpen/IND/ADM1/
   Retrieved simplified geometry from the API's pinned release URL:
   https://github.com/wmgeolab/geoBoundaries/raw/9469f09/releaseData/gbOpen/IND/ADM1/geoBoundaries-IND-ADM1_simplified.geojson
   Attribution: DataMeet India community; Election Commission of India.
   License: Creative Commons Attribution 2.5 India (CC BY 2.5 IN).
   The API reports represented year 2011 although its feature names include
   later union territories; therefore this is not presented as a current survey.
2. Natural Earth 1:50m admin-0 countries, India reference footprint:
   https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
   Natural Earth data are public domain. This is generalized cartographic data.
   https://www.naturalearthdata.com/about/disputed-boundaries-policy/
3. Existing OCHA PAK ADM2 polygons, CC BY-IGO, excluded from the context overlay.

Processing: select geoBoundaries `shapeISO` IN-JK and IN-LA; intersect them with
the Natural Earth India footprint; exclude the union of all existing OCHA PAK
ADM2 polygons; simplify by 0.003 degrees while preserving topology; exclude the
OCHA polygons again to remove simplification-induced slivers. Retain polygons,
names, attribution and a non-selectable analysis flag. The final intersections
with the OCHA polygon union have negligible floating-point area (<1e-12 degree²).

The raw geoBoundaries Ladakh feature extends over claimed areas. Displaying it
unchanged would overlap existing Pakistan-administered map polygons; the
reference clipping avoids treating that source's claimed extent as actual
administration. Differing source scales introduce positional uncertainty.

The overlay uses the same display projection as the boundary map and is included
in full-map extent calculation. It can be toggled off. It is kept separate from
`geo`, `matchedBoundaryFeature`, the district dropdown and rainfall geometry;
it does not create rainfall extraction coverage or bias-correction baselines.
It is not suitable for legal, cadastral, navigation or precise boundary use.
