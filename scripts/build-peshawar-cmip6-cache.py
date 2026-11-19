#!/usr/bin/env python3
"""Rebuild the Peshawar ACCESS-CM2 recovery cache from NASA's public v2.0 archive.

Run from the repository with Node, Python, h5py, NumPy, requests and SciPy.
Annual source files are checked against NASA's MD5 index before subsetting.
The working directory retains only verified small subsets between runs.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import io
import json
from pathlib import Path
import subprocess
import time

import h5py
import numpy as np
import requests
from scipy.io import netcdf_file

ARCHIVE = "https://nex-gddp-cmip6.s3.us-west-2.amazonaws.com"
MODEL = "ACCESS-CM2"
MEMBER = "r1i1p1f1"
VERSION = "v2.0"
PERIODS = {"historical": (1985, 2014), "ssp245": (2041, 2070)}
REPO = Path(__file__).resolve().parents[1]
OUTPUT = REPO / "lib/data/peshawar-access-cm2-v2.json"


def district_identity():
    # Use the same JSON serialization and bounds calculation as the web route.
    script = """
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { cmip6GeometryBounds } from './lib/cmip6-online.ts';
const layer = JSON.parse(readFileSync('public/data/uploaded-districts.geojson','utf8'));
const peshawar = layer.features.find(feature => feature.properties.adm2_name === 'Peshawar');
console.log(JSON.stringify({
  boundaryCode: peshawar.properties.adm2_pcode,
  geometryHash: createHash('sha256').update(JSON.stringify(peshawar.geometry.coordinates)).digest('hex'),
  bounds: cmip6GeometryBounds(peshawar.geometry)
}));
"""
    return json.loads(subprocess.check_output(
        ["node", "--input-type=module", "-e", script], cwd=REPO, text=True,
    ))


def grid_slice(values, lower, upper):
    indices = np.flatnonzero((values >= lower) & (values <= upper))
    if not len(indices) or np.any(np.diff(indices) != 1):
        raise ValueError("Expected a contiguous, nonempty native grid slice")
    return slice(int(indices[0]), int(indices[-1]) + 1)


def copy_attributes(target, attributes, names):
    for name in names:
        if name in attributes:
            value = attributes[name]
            setattr(target, name, bytes(value) if isinstance(value, bytes) else value)


def subset_bytes(source_path, bounds):
    with h5py.File(source_path, "r") as source:
        time_data, lat_data, lon_data = (source[name][:] for name in ("time", "lat", "lon"))
        variable = source["pr"]
        if variable.shape != (len(time_data), len(lat_data), len(lon_data)):
            raise ValueError("Expected native pr dimensions (time, lat, lon)")
        lat_slice = grid_slice(lat_data, bounds["south"] - .13, bounds["north"] + .13)
        lon_slice = grid_slice(lon_data, bounds["west"] - .13, bounds["east"] + .13)
        output = io.BytesIO()
        with netcdf_file(output, "w") as subset:
            for name, values in zip(
                ("time", "lat", "lon"), (time_data, lat_data[lat_slice], lon_data[lon_slice]),
            ):
                subset.createDimension(name, len(values))
                coord = subset.createVariable(name, "d", (name,))
                coord[:] = values
                copy_attributes(coord, source[name].attrs, ("units", "calendar"))
            pr = subset.createVariable("pr", "f" if variable.dtype.itemsize == 4 else "d", ("time", "lat", "lon"))
            pr[:] = variable[:, lat_slice, lon_slice]
            copy_attributes(pr, variable.attrs, ("units", "_FillValue", "missing_value", "scale_factor", "add_offset"))
            subset.flush()
            return output.getvalue()


def file_md5(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "md5").hexdigest()


def prepare_year(directory, filename, archive_key, md5, district):
    subset_path = directory / f'{district["geometryHash"]}-{md5}.nc3'
    if subset_path.is_file():
        return filename, subset_path.read_bytes()
    raw_path = directory / filename
    try:
        if not raw_path.is_file() or file_md5(raw_path) != md5:
            for attempt in range(3):
                try:
                    with requests.get(f"{ARCHIVE}/{archive_key}", stream=True, timeout=(12, 45)) as response:
                        response.raise_for_status()
                        digest = hashlib.md5()
                        with raw_path.open("wb") as raw:
                            for chunk in response.iter_content(chunk_size=2**20):
                                digest.update(chunk)
                                raw.write(chunk)
                    if digest.hexdigest() != md5:
                        raise ValueError("NASA archive checksum did not match")
                    break
                except (requests.RequestException, ValueError):
                    if attempt == 2:
                        raise
                    time.sleep(2 ** attempt)
        data = subset_bytes(raw_path, district["bounds"])
        partial_path = subset_path.with_suffix(".part")
        partial_path.write_bytes(data)
        partial_path.replace(subset_path)
        return filename, data
    finally:
        raw_path.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("work_dir", type=Path, help="Directory for resumable processing")
    parser.add_argument("--workers", type=int, default=3)
    args = parser.parse_args()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    index_path = args.work_dir / "nasa-index.txt"
    if not index_path.is_file():
        response = requests.get(f"{ARCHIVE}/index_{VERSION}_md5.txt", timeout=(12, 45))
        response.raise_for_status()
        index_path.write_text(response.text)
    index = {key: md5 for md5, key in (line.split(maxsplit=1) for line in index_path.read_text().splitlines() if line)}
    district = district_identity()
    tasks = {}
    files = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for scenario, (start_year, end_year) in PERIODS.items():
            for year in range(start_year, end_year + 1):
                file_name = f"pr_day_{MODEL}_{scenario}_{MEMBER}_gn_{year}_{VERSION}.nc"
                key = f"NEX-GDDP-CMIP6/{MODEL}/{scenario}/{MEMBER}/pr/{file_name}"
                md5 = index[key]
                future = pool.submit(prepare_year, args.work_dir, file_name, key, md5, district)
                tasks[future] = (year, scenario, md5, key)
        for future in as_completed(tasks):
            year, scenario, md5, key = tasks[future]
            try:
                file_name, data = future.result()
            except Exception:
                for queued in tasks:
                    queued.cancel()
                raise
            files[file_name] = {
                "year": year, "scenario": scenario, "sourceMd5": md5,
                "sourceUrl": f"{ARCHIVE}/{key}",
                "netcdf": base64.b64encode(data).decode("ascii"),
            }
            print(f"Verified {scenario} {year}: {len(files)}/{len(tasks)}", flush=True)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    archive = {"model": MODEL, "member": MEMBER, "version": VERSION, **district, "files": dict(sorted(files.items()))}
    partial_path = OUTPUT.with_suffix(".part")
    partial_path.write_text(json.dumps(archive, indent=2) + "\n")
    partial_path.replace(OUTPUT)


if __name__ == "__main__":
    main()
