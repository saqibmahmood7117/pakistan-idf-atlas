import type { ResultRow } from "./observed-idf";

export type ShermanEquationFit = {
  a: number;
  m: number;
  b: 0;
  n: number;
  rSquared: number;
  sampleSize: number;
};

export type PowerEquationFit = {
  returnPeriodYears: number;
  coefficient: number;
  exponent: number;
  rSquared: number;
  sampleSize: number;
};

function solveThreeByThree(matrix: number[][], vector: number[]) {
  const augmented = matrix.map((row, index) => [...row, vector[index]]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1)
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column]))
        pivot = row;
    if (Math.abs(augmented[pivot][column]) < 1e-12) return null;
    [augmented[column], augmented[pivot]] = [
      augmented[pivot],
      augmented[column],
    ];
    const divisor = augmented[column][column];
    for (let index = column; index < 4; index += 1)
      augmented[column][index] /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let index = column; index < 4; index += 1)
        augmented[row][index] -= factor * augmented[column][index];
    }
  }
  return augmented.map((row) => row[3]);
}

/**
 * Fits the compact Sherman representation ln(i)=ln(a)+m ln(T)-n ln(t).
 * t is in minutes and i is in mm/hour. The active IDF rows remain the
 * authoritative fitted values; this equation is their chart representation.
 */
export function fitShermanEquation(rows: ResultRow[]): ShermanEquationFit | null {
  const points = rows.filter(
    (row) =>
      row.durationMinutes > 0 &&
      row.durationMinutes <= 1440 &&
      row.returnPeriodYears > 1 &&
      row.intensityMmHr > 0 &&
      Number.isFinite(row.intensityMmHr),
  );
  if (
    points.length < 6 ||
    new Set(points.map((row) => row.durationMinutes)).size < 2 ||
    new Set(points.map((row) => row.returnPeriodYears)).size < 2
  )
    return null;

  const predictors = points.map((row) => [
    1,
    Math.log(row.returnPeriodYears),
    -Math.log(row.durationMinutes),
  ]);
  const response = points.map((row) => Math.log(row.intensityMmHr));
  const matrix = Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 3 }, (_, column) =>
      predictors.reduce(
        (sum, values) => sum + values[row] * values[column],
        0,
      ),
    ),
  );
  const vector = Array.from({ length: 3 }, (_, row) =>
    predictors.reduce(
      (sum, values, index) => sum + values[row] * response[index],
      0,
    ),
  );
  const coefficients = solveThreeByThree(matrix, vector);
  if (!coefficients) return null;
  const [logA, m, n] = coefficients;
  const predicted = predictors.map(
    (values) => logA + m * values[1] + n * values[2],
  );
  const average = response.reduce((sum, value) => sum + value, 0) / response.length;
  const residual = response.reduce(
    (sum, value, index) => sum + (value - predicted[index]) ** 2,
    0,
  );
  const total = response.reduce((sum, value) => sum + (value - average) ** 2, 0);
  const a = Math.exp(logA);
  if (![a, m, n].every(Number.isFinite) || a <= 0 || n <= 0) return null;
  return {
    a,
    m,
    b: 0,
    n,
    rSquared: total > 0 ? Math.max(0, Math.min(1, 1 - residual / total)) : 1,
    sampleSize: points.length,
  };
}

/** Fits the chart form ln(i)=ln(c)+p ln(t) for one return period. */
export function fitPowerEquation(
  rows: ResultRow[],
  returnPeriodYears: number,
): PowerEquationFit | null {
  const points = rows
    .filter(
      (row) =>
        row.returnPeriodYears === returnPeriodYears &&
        row.durationMinutes > 0 &&
        row.durationMinutes <= 1440 &&
        row.intensityMmHr > 0 &&
        Number.isFinite(row.intensityMmHr),
    )
    .sort((a, b) => a.durationMinutes - b.durationMinutes);
  if (points.length < 2) return null;
  const x = points.map((row) => Math.log(row.durationMinutes)),
    y = points.map((row) => Math.log(row.intensityMmHr)),
    meanX = x.reduce((sum, value) => sum + value, 0) / x.length,
    meanY = y.reduce((sum, value) => sum + value, 0) / y.length,
    denominator = x.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
  if (denominator < 1e-12) return null;
  const exponent = x.reduce(
      (sum, value, index) => sum + (value - meanX) * (y[index] - meanY),
      0,
    ) / denominator,
    coefficient = Math.exp(meanY - exponent * meanX),
    predicted = x.map((value) => Math.log(coefficient) + exponent * value),
    residual = y.reduce(
      (sum, value, index) => sum + (value - predicted[index]) ** 2,
      0,
    ),
    total = y.reduce((sum, value) => sum + (value - meanY) ** 2, 0),
    rSquared = total > 0 ? Math.max(0, Math.min(1, 1 - residual / total)) : 1;
  if (![coefficient, exponent, rSquared].every(Number.isFinite)) return null;
  return {
    returnPeriodYears,
    coefficient,
    exponent,
    rSquared,
    sampleSize: points.length,
  };
}

export function formatPowerEquation(fit: PowerEquationFit | null) {
  if (!fit) return "Equation unavailable";
  return `i=${fit.coefficient.toFixed(3)}t^${fit.exponent.toFixed(3)}`;
}

export function shermanIntensity(
  fit: ShermanEquationFit | null,
  durationMinutes: number,
  returnPeriodYears: number,
) {
  if (
    !fit ||
    !(durationMinutes > 0) ||
    !(returnPeriodYears > 1) ||
    !Number.isFinite(durationMinutes) ||
    !Number.isFinite(returnPeriodYears)
  )
    return null;
  const intensity =
    (fit.a * returnPeriodYears ** fit.m) /
    (durationMinutes + fit.b) ** fit.n;
  return Number.isFinite(intensity) && intensity >= 0 ? intensity : null;
}

/** Metric Kirpich equation: L in metres, S in m/m, output in minutes. */
export function kirpichTimeOfConcentrationMinutes(
  flowLengthMetres: number,
  slopeMetresPerMetre: number,
) {
  if (
    !(flowLengthMetres > 0) ||
    !(slopeMetresPerMetre > 0) ||
    !Number.isFinite(flowLengthMetres) ||
    !Number.isFinite(slopeMetresPerMetre)
  )
    return null;
  const minutes =
    0.0195 * flowLengthMetres ** 0.77 * slopeMetresPerMetre ** -0.385;
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

export function formatShermanEquation(fit: ShermanEquationFit | null) {
  if (!fit) return "Equation unavailable — at least two durations are required";
  return `i(t,T)=${fit.a.toFixed(3)}T^${fit.m.toFixed(3)}/(t+0)^${fit.n.toFixed(3)}`;
}

/** Evaluate a per-period chart trendline only within its fitted duration range. */
export function powerIntensityAtDuration(
  rows: ResultRow[],
  returnPeriodYears: number,
  durationMinutes: number,
): number | null {
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  const fit = fitPowerEquation(rows, returnPeriodYears);
  if (!fit) return null;
  const durations = rows.filter((row) => row.returnPeriodYears === returnPeriodYears &&
    row.durationMinutes > 0 && row.durationMinutes <= 1440 &&
    row.intensityMmHr > 0 && Number.isFinite(row.intensityMmHr)).map((row) => row.durationMinutes);
  if (durationMinutes < Math.min(...durations) || durationMinutes > Math.max(...durations)) return null;
  const intensity = fit.coefficient * durationMinutes ** fit.exponent;
  return Number.isFinite(intensity) && intensity > 0 ? intensity : null;
}
