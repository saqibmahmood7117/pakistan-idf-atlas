import type { OnlineGeometry } from "./online-precipitation.ts";

function clippedRingArea(
  ring: number[][],
  west: number,
  east: number,
  south: number,
  north: number,
) {
  let points = ring;
  const boundaries: [number, number, boolean][] = [
    [0, west, true], [0, east, false], [1, south, true], [1, north, false],
  ];
  for (const [axis, edge, greater] of boundaries) {
    const clipped: number[][] = [];
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      const aInside = greater ? a[axis] >= edge : a[axis] <= edge;
      const bInside = greater ? b[axis] >= edge : b[axis] <= edge;
      if (aInside) clipped.push(a);
      if (aInside !== bInside) {
        const t = (edge - a[axis]) / (b[axis] - a[axis]);
        clipped.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
      }
    }
    points = clipped;
    if (points.length < 3) return 0;
  }
  return Math.abs(points.reduce((sum, a, index) => {
    const b = points[(index + 1) % points.length];
    return sum + (a[0] - west) * (b[1] - south) - (b[0] - west) * (a[1] - south);
  }, 0)) / 2;
}

/** Overlap area in square degrees adjusted for latitude. Only relative weights are used. */
export function gridCellOverlap(
  geometry: OnlineGeometry,
  latitude: number,
  longitude: number,
  latitudeSize: number,
  longitudeSize: number,
) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const west = longitude - longitudeSize / 2;
  const east = longitude + longitudeSize / 2;
  const south = latitude - latitudeSize / 2;
  const north = latitude + latitudeSize / 2;
  const area = polygons.reduce((sum, polygon) => sum + Math.max(0,
    polygon.reduce((total, ring, index) =>
      total + (index === 0 ? 1 : -1) * clippedRingArea(ring, west, east, south, north), 0),
  ), 0);
  return area * Math.cos(latitude * Math.PI / 180);
}
