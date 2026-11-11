`native-3h-point.nc` is a real CEDA NCSS point subset of ACCESS-CM2,
ssp245, r1i1p1f1, `pr`, native `3hr`, gn, v20191108, 2020-01-01 to
2020-01-03, requested at 34°N 72°E (returned cell 34.375°N 72.1875°E).
Source: https://esgf.ceda.ac.uk/thredds/fileServer/esg_cmip6/CMIP6/ScenarioMIP/CSIRO-ARCCSS/ACCESS-CM2/ssp245/r1i1p1f1/3hr/pr/gn/v20191108/pr_3hr_ACCESS-CM2_ssp245_r1i1p1f1_gn_201501010130-202412312230.nc
Subset via `/thredds/ncss/grid/`, var=pr, latitude=34, longitude=72,
time_start=2020-01-01T00:00:00Z, time_end=2020-01-03T23:59:59Z,
accept=netCDF, addLatLon=true. CF interval midpoint units are days since
1850-01-01; rainfall flux kg m-2 s-1. No source values were synthesized.

`native-3h-grid.nc` is the same actual three-day source queried with
north=36.5, south=31.5, east=74.5, west=69.5 and horizStride=1 instead of
point coordinates. The district test clips a 71.5–72.5°E, 33.5–34.5°N polygon,
which intersects two returned native grid cells.
