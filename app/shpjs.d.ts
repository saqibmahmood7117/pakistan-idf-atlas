declare module "shpjs" {
  export default function parseShapefile(
    input: ArrayBuffer | Uint8Array | string,
  ): Promise<unknown>;
}
