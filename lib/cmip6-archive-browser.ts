import type { Cmip6ArchiveJob, Cmip6ArchiveMessage, Cmip6ArchiveResult } from "./cmip6-archive.worker.ts";

let archiveWorker: Worker | undefined;
let queue: Promise<unknown> = Promise.resolve();

export function processCmip6ArchiveInBrowser(
  job: Cmip6ArchiveJob,
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
) {
  const result = queue.then(() => {
    signal?.throwIfAborted();
    archiveWorker ??= new Worker(new URL("./cmip6-archive.worker.ts", import.meta.url), {type: "module"});
    const worker = archiveWorker;
    return new Promise<Cmip6ArchiveResult>((resolve, reject) => {
      function cleanup() {
        signal?.removeEventListener("abort", abort);
        worker.onmessage = null;
        worker.onerror = null;
      }
      function abort() {
        cleanup();
        worker.terminate();
        archiveWorker = undefined;
        reject(signal?.reason ?? new DOMException("Retrieval cancelled", "AbortError"));
      }
      signal?.addEventListener("abort", abort, {once: true});
      worker.onmessage = ({data}: MessageEvent<Cmip6ArchiveMessage>) => {
        if (data.type === "progress") {
          onProgress?.(data.message);
          return;
        }
        cleanup();
        if (data.type === "error") reject(new Error(`NASA archive ${job.year}: ${data.message}`));
        else resolve(data.result);
      };
      worker.onerror = () => {
        cleanup();
        worker.terminate();
        archiveWorker = undefined;
        reject(new Error(`The browser could not process NASA archive ${job.year}.`));
      };
      worker.postMessage(job);
    });
  });
  queue = result.catch(() => undefined);
  return result;
}
