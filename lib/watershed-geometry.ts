export type Position = [number, number];

export type GeoJsonGeometry = {
  type: string;
  coordinates?: unknown;
};

export type GeoJsonFeature = {
  type: "Feature";
  properties?: Record<string, unknown> | null;
  geometry: GeoJsonGeometry | null;
};

export type GeoJsonFeatureCollection = {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
};

export type FlowPathProfile = {
  lengthMetres: number;
  endpointSlopeMPerM: number;
  slope10To85MPerM: number;
  outletElevationMetres: number;
  upstreamElevationMetres: number;
  elevation10Metres: number;
  elevation85Metres: number;
  coordinates: Position[];
};

export type WatershedGeometryResult = FlowPathProfile & {
  source: "mghydro" | "uploaded-flow-path";
  precision: "low" | "high" | "uploaded";
  outletLatitude: number;
  outletLongitude: number;
  watershed: GeoJsonFeatureCollection | null;
  pathSource: string;
  elevationSource: string;
  retrievedAt: string;
  limitations: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function isPosition(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  );
}

export function normalizeFeatureCollection(
  value: unknown,
): GeoJsonFeatureCollection | null {
  if (
    isRecord(value) &&
    value.type === "FeatureCollection" &&
    Array.isArray(value.features)
  )
    return {
      type: "FeatureCollection",
      features: value.features.filter(
        (feature): feature is GeoJsonFeature =>
          isRecord(feature) &&
          feature.type === "Feature" &&
          (feature.geometry === null || isRecord(feature.geometry)),
      ),
    };
  if (isRecord(value) && value.type === "Feature" && isRecord(value.geometry))
    return {
      type: "FeatureCollection",
      features: [value as GeoJsonFeature],
    };
  if (Array.isArray(value)) {
    const collections = value
      .map(normalizeFeatureCollection)
      .filter((collection): collection is GeoJsonFeatureCollection =>
        Boolean(collection),
      );
    if (collections.length)
      return {
        type: "FeatureCollection",
        features: collections.flatMap((collection) => collection.features),
      };
  }
  return null;
}

function lineCoordinates(geometry: GeoJsonGeometry | null): Position[][] {
  if (!geometry || !geometry.coordinates) return [];
  if (geometry.type === "LineString" && Array.isArray(geometry.coordinates)) {
    const line = geometry.coordinates.filter(isPosition).map(
      (point) => [Number(point[0]), Number(point[1])] as Position,
    );
    return line.length >= 2 ? [line] : [];
  }
  if (
    geometry.type === "MultiLineString" &&
    Array.isArray(geometry.coordinates)
  )
    return geometry.coordinates.flatMap((part) =>
      Array.isArray(part)
        ? lineCoordinates({ type: "LineString", coordinates: part })
        : [],
    );
  return [];
}

export function extractLineStrings(value: unknown) {
  const collection = normalizeFeatureCollection(value);
  if (collection)
    return collection.features.flatMap((feature) =>
      lineCoordinates(feature.geometry),
    );
  if (isRecord(value) && typeof value.type === "string")
    return lineCoordinates(value as GeoJsonGeometry);
  return [];
}

export function haversineMetres(a: Position, b: Position) {
  const radius = 6_371_008.8,
    toRadians = Math.PI / 180,
    latitude1 = a[1] * toRadians,
    latitude2 = b[1] * toRadians,
    deltaLatitude = (b[1] - a[1]) * toRadians,
    deltaLongitude = (b[0] - a[0]) * toRadians,
    h =
      Math.sin(deltaLatitude / 2) ** 2 +
      Math.cos(latitude1) *
        Math.cos(latitude2) *
        Math.sin(deltaLongitude / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function flowPathLengthMetres(coordinates: Position[]) {
  return coordinates
    .slice(1)
    .reduce(
      (sum, point, index) => sum + haversineMetres(coordinates[index], point),
      0,
    );
}

type Edge = { target: string; weight: number };

class MinHeap {
  private values: Array<{ key: string; distance: number }> = [];

  push(value: { key: string; distance: number }) {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.values[parent].distance <= value.distance) break;
      this.values[index] = this.values[parent];
      index = parent;
    }
    this.values[index] = value;
  }

  pop() {
    if (!this.values.length) return null;
    const root = this.values[0],
      tail = this.values.pop()!;
    if (!this.values.length) return root;
    let index = 0;
    while (true) {
      const left = index * 2 + 1,
        right = left + 1;
      if (left >= this.values.length) break;
      const child =
        right < this.values.length &&
        this.values[right].distance < this.values[left].distance
          ? right
          : left;
      if (this.values[child].distance >= tail.distance) break;
      this.values[index] = this.values[child];
      index = child;
    }
    this.values[index] = tail;
    return root;
  }
}

const pointKey = (point: Position) =>
  `${point[0].toFixed(5)},${point[1].toFixed(5)}`;

/** Finds the farthest connected network point from the requested outlet. */
export function longestConnectedFlowPath(
  lines: Position[][],
  outlet: Position,
) {
  const graph = new Map<string, Edge[]>(),
    positions = new Map<string, Position>();
  const addEdge = (source: Position, target: Position) => {
    const sourceKey = pointKey(source),
      targetKey = pointKey(target),
      weight = haversineMetres(source, target);
    if (!(weight > 0)) return;
    positions.set(sourceKey, source);
    positions.set(targetKey, target);
    graph.set(sourceKey, [
      ...(graph.get(sourceKey) ?? []),
      { target: targetKey, weight },
    ]);
    graph.set(targetKey, [
      ...(graph.get(targetKey) ?? []),
      { target: sourceKey, weight },
    ]);
  };
  lines.forEach((line) =>
    line.slice(1).forEach((point, index) => addEdge(line[index], point)),
  );
  if (!graph.size) return null;
  let outletKey = "",
    nearest = Number.POSITIVE_INFINITY;
  for (const [key, point] of positions) {
    const distance = haversineMetres(outlet, point);
    if (distance < nearest) {
      nearest = distance;
      outletKey = key;
    }
  }
  const distances = new Map<string, number>([[outletKey, 0]]),
    previous = new Map<string, string>(),
    heap = new MinHeap();
  heap.push({ key: outletKey, distance: 0 });
  while (true) {
    const current = heap.pop();
    if (!current) break;
    if (current.distance !== distances.get(current.key)) continue;
    for (const edge of graph.get(current.key) ?? []) {
      const candidate = current.distance + edge.weight;
      if (candidate >= (distances.get(edge.target) ?? Number.POSITIVE_INFINITY))
        continue;
      distances.set(edge.target, candidate);
      previous.set(edge.target, current.key);
      heap.push({ key: edge.target, distance: candidate });
    }
  }
  let farthestKey = outletKey,
    farthestDistance = 0;
  for (const [key, distance] of distances)
    if (distance > farthestDistance) {
      farthestKey = key;
      farthestDistance = distance;
    }
  const upstreamToOutlet: Position[] = [];
  let currentKey: string | undefined = farthestKey;
  while (currentKey) {
    const point = positions.get(currentKey);
    if (point) upstreamToOutlet.push(point);
    if (currentKey === outletKey) break;
    currentKey = previous.get(currentKey);
  }
  const coordinates = upstreamToOutlet.reverse();
  return coordinates.length >= 2
    ? { coordinates, lengthMetres: flowPathLengthMetres(coordinates), outletSnapMetres: nearest }
    : null;
}

export function coordinateAtFlowFraction(
  coordinates: Position[],
  fraction: number,
) {
  if (!coordinates.length) return null;
  if (coordinates.length === 1) return coordinates[0];
  const lengths = coordinates
      .slice(1)
      .map((point, index) => haversineMetres(coordinates[index], point)),
    total = lengths.reduce((sum, value) => sum + value, 0),
    target = Math.max(0, Math.min(1, fraction)) * total;
  let traversed = 0;
  for (let index = 0; index < lengths.length; index += 1) {
    const next = traversed + lengths[index];
    if (target <= next || index === lengths.length - 1) {
      const ratio = lengths[index] ? (target - traversed) / lengths[index] : 0,
        a = coordinates[index],
        b = coordinates[index + 1];
      return [
        a[0] + (b[0] - a[0]) * ratio,
        a[1] + (b[1] - a[1]) * ratio,
      ] as Position;
    }
    traversed = next;
  }
  return coordinates.at(-1)!;
}
