import { CMIP6_PUBLIC_ARCHIVE, CMIP6_PUBLIC_ARCHIVE_SERVICE } from "./cmip6-online.ts";
import {
  cmip6ArchiveBounds,
  readCmip6ArchiveGrid,
  summarizeCmip6ArchiveGrid,
  type Cmip6ArchiveGrid,
} from "./cmip6-archive-netcdf.ts";
import type { Cmip6GridLocation } from "./cmip6-netcdf.ts";

export type Cmip6ArchiveJob = {
  year: number;
  sourceFileUrl: string;
  location: Cmip6GridLocation;
  spatialDate?: string;
};

export type Cmip6ArchiveResult = ReturnType<typeof summarizeCmip6ArchiveGrid> & {
  year: number;
  retrievalService: string;
  providerSubsetUrl?: string;
};

export type Cmip6ArchiveMessage =
  | { type: "progress"; message: string }
  | { type: "error"; message: string }
  | { type: "complete"; result: Cmip6ArchiveResult };

const scope = self as unknown as {
  onmessage: (event: MessageEvent<Cmip6ArchiveJob>) => void;
  postMessage: (message: Cmip6ArchiveMessage) => void;
};

type StoredGrid = Omit<Cmip6ArchiveGrid, "rates"> & {
  packedRates: Blob;
  float64: boolean;
  savedAt: number;
};

function idbResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function openCache() {
  const request = indexedDB.open("atlas-nasa-daily-subsets", 1);
  request.onupgradeneeded = () => {
    const store = request.result.createObjectStore("annual");
    store.createIndex("savedAt", "savedAt");
  };
  return idbResult(request);
}

async function readCachedGrid(key: string): Promise<Cmip6ArchiveGrid | undefined> {
  let db: IDBDatabase | undefined;
  try {
    db = await openCache();
    const entry = await idbResult(db.transaction("annual", "readonly").objectStore("annual").get(key)) as StoredGrid | undefined;
    if (!entry) return;
    const {packedRates, float64, ...metadata} = entry;
    const raw = await new Response(packedRates.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
    const rates = float64 ? new Float64Array(raw) : new Float32Array(raw);
    if (rates.length === metadata.timeValues.length * metadata.latitudes.length * metadata.longitudes.length)
      return {...metadata, rates};
  } catch {
    // Some browsers disable database storage in private browsing.
  } finally {
    db?.close();
  }
}

async function cacheGrid(key: string, grid: Cmip6ArchiveGrid) {
  let db: IDBDatabase | undefined;
  try {
    const {rates, ...metadata} = grid;
    const bytes = new Uint8Array(rates.buffer as ArrayBuffer, rates.byteOffset, rates.byteLength);
    const packedRates = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
    const entry: StoredGrid = {...metadata, packedRates, float64: rates instanceof Float64Array, savedAt: Date.now()};
    db = await openCache();
    await new Promise<void>((resolve, reject) => {
      const transaction = db!.transaction("annual", "readwrite");
      const store = transaction.objectStore("annual");
      const oldest = store.index("savedAt").getAllKeys();
      oldest.onsuccess = () => {
        const existing = oldest.result.filter(existingKey => existingKey !== key);
        for (const oldKey of existing.slice(0, Math.max(0, existing.length - 79))) store.delete(oldKey);
        store.put(entry, key);
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
  } catch {
    // The current extraction remains available when the cache is full or disabled.
  } finally {
    db?.close();
  }
}

function report(message: string) {
  scope.postMessage({type: "progress", message});
}

async function getGrid(job: Cmip6ArchiveJob) {
  const url = new URL(job.sourceFileUrl);
  if (url.origin !== CMIP6_PUBLIC_ARCHIVE || !url.pathname.startsWith("/NEX-GDDP-CMIP6/") || !url.pathname.endsWith(".nc")) {
    throw new Error("The NASA archive URL is invalid.");
  }
  const bounds = cmip6ArchiveBounds(job.location);
  const key = `v1|${url.pathname}|${bounds.west},${bounds.east},${bounds.south},${bounds.north}`;
  const cached = await readCachedGrid(key);
  if (cached) {
    report(`Reading the saved NASA archive subset for ${job.year}…`);
    return cached;
  }
  report(`Opening the original NASA archive file for ${job.year}…`);
  const response = await fetch(url, {cache: "no-store", signal: AbortSignal.timeout(15 * 60_000)});
  if (!response.ok || !response.body) {
    throw new Error(`NASA Open Data returned HTTP ${response.status} for the exact ${job.year} file.`);
  }
  const totalMb = Math.round(Number(response.headers.get("content-length")) / 1_000_000);
  let bytes = 0;
  let lastReported = -1;
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk: Uint8Array, controller) {
      bytes += chunk.byteLength;
      const mb = Math.floor(bytes / 1_000_000);
      if (lastReported < 0 || mb >= lastReported + 5) {
        report(`Downloading NASA archive ${job.year} · ${mb}${totalMb ? ` / ${totalMb}` : ""} MB…`);
        lastReported = mb;
      }
      controller.enqueue(chunk);
    },
  }));
  const blob = await new Response(stream).blob();
  report(`Extracting the native NASA grid for ${job.year}…`);
  const {default: h5wasm} = await import("h5wasm");
  const {FS} = await h5wasm.ready;
  const directory = "/atlas-nasa";
  if (!FS.analyzePath(directory).exists) FS.mkdir(directory);
  // WORKERFS reads the necessary hyperslab from the Blob without copying the
  // complete annual file into the HDF5 WebAssembly heap.
  FS.mount(FS.filesystems.WORKERFS, {blobs: [{name: "year.nc", data: blob}]}, directory);
  try {
    const file = new h5wasm.File(`${directory}/year.nc`, "r");
    try {
      const grid = readCmip6ArchiveGrid(file, bounds);
      await cacheGrid(key, grid);
      return grid;
    } finally {
      file.close();
    }
  } finally {
    FS.unmount(directory);
  }
}

scope.onmessage = async ({data: job}) => {
  try {
    const grid = await getGrid(job);
    const result = summarizeCmip6ArchiveGrid(grid, job.location, job.spatialDate);
    if (result.records.some(row => Number(row.date.slice(0, 4)) !== job.year)) {
      throw new Error(`The NASA archive returned dates outside the requested year ${job.year}.`);
    }
    scope.postMessage({type: "complete", result: {
      ...result,
      records: job.spatialDate ? result.records.filter(row => row.date === job.spatialDate) : result.records,
      year: job.year,
      retrievalService: CMIP6_PUBLIC_ARCHIVE_SERVICE,
      providerSubsetUrl: job.spatialDate ? job.sourceFileUrl : undefined,
    }});
  } catch (error) {
    scope.postMessage({type: "error", message: error instanceof Error ? error.message : "NASA archive processing failed."});
  }
};
