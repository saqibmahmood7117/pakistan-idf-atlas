import type { OnlineGeometry } from "./online-precipitation";

type ArchiveYear = {
  year: number;
  scenario: string;
  sourceUrl: string;
  netcdf: string;
};

type Archive = {
  model: string;
  member: string;
  geometryHash: string;
  files: Record<string, ArchiveYear>;
};

export async function peshawarCmip6Archive(request: {
  model?: unknown;
  scenario?: unknown;
  member?: unknown;
  mode?: unknown;
  geometry?: OnlineGeometry;
}) {
  if (
    request.model !== "ACCESS-CM2" ||
    (request.scenario !== "historical" && request.scenario !== "ssp245") ||
    (request.member !== "auto" && request.member !== "r1i1p1f1" && request.member !== undefined) ||
    request.mode !== "district" ||
    request.geometry?.type !== "Polygon"
  ) return null;

  const { default: archive }: { default: Archive } = await import("./data/peshawar-access-cm2-v2.json");
  const coordinates = new TextEncoder().encode(JSON.stringify(request.geometry.coordinates));
  const fingerprint = new Uint8Array(await crypto.subtle.digest("SHA-256", coordinates));
  const geometryHash = Array.from(fingerprint, byte => byte.toString(16).padStart(2, "0")).join("");
  return geometryHash === archive.geometryHash ? archive : null;
}
