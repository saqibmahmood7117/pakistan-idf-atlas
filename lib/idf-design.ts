import type { ResultRow } from "./observed-idf";

export type ShermanEquationFit = {
  a: number;
  m: number;
  b: number;
  offsetStatus: "fitted" | "zero-boundary" | "upper-boundary" | "not-identifiable";
  calibrationBasis: "native-duration" | "derived-duration";
  minDuration: number;
  maxDuration: number;
  minReturnPeriod: number;
  maxReturnPeriod: number;
  maxOffset: number;
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
 * Sherman family i=a*T^m/(t+b)^n. Profile nonnegative b over [0,max(t)]
 * and solve the three log-linear coefficients at each b. This bounded,
 * log-space calibration is our implementation choice, not a reproduction of
 * the 2025 IDF-GtzLo algorithm. Derived points cannot identify a physical b.
 */
export function fitShermanEquation(rows: ResultRow[]): ShermanEquationFit | null {
  const unique = new Map<string, ResultRow>();
  for (const row of rows) {
    if (!(row.durationMinutes > 0 && row.durationMinutes <= 1440 &&
      row.returnPeriodYears > 1 && row.intensityMmHr > 0 &&
      Number.isFinite(row.intensityMmHr) && Number.isFinite(row.returnPeriodYears))) continue;
    const key = `${row.returnPeriodYears}:${row.durationMinutes}`;
    if (!unique.has(key) || (unique.get(key)!.derived && !row.derived)) unique.set(key, row);
  }
  const all = [...unique.values()];
  const native = all.filter((row) => row.derived === false);
  const nativeDurations = new Set(native.map((row) => row.durationMinutes)).size;
  const points = nativeDurations >= 2 ? native : all;
  const durations = new Set(points.map((row) => row.durationMinutes));
  const periods = new Set(points.map((row) => row.returnPeriodYears));
  if (points.length < 6 || durations.size < 2 || periods.size < 2) return null;
  const fitOffset = nativeDurations >= 3;
  const maxOffset = Math.max(...durations);
  const response = points.map((row) => Math.log(row.intensityMmHr));
  const average = response.reduce((sum, value) => sum + value, 0) / response.length;
  const total = response.reduce((sum, value) => sum + (value-average)**2, 0);
  function atOffset(b: number) {
    const predictors = points.map((row) => [1, Math.log(row.returnPeriodYears), -Math.log(row.durationMinutes + b)]);
    const matrix = Array.from({length:3}, (_, i) => Array.from({length:3}, (_, j) =>
      predictors.reduce((sum, values) => sum + values[i]*values[j], 0)));
    const vector = Array.from({length:3}, (_, i) => predictors.reduce((sum, values, j) => sum + values[i]*response[j], 0));
    const coefficients = solveThreeByThree(matrix, vector);
    if (!coefficients) return null;
    const [logA, m, n] = coefficients;
    const a = Math.exp(logA);
    if (![a,m,n].every(Number.isFinite) || a <= 0 || m < 0 || n <= 0) return null;
    const residual = response.reduce((sum, value, index) => {
      const predicted = logA + m*predictors[index][1] + n*predictors[index][2];
      return sum + (value-predicted)**2;
    }, 0);
    return {a,m,n,b,residual};
  }
  const zero = atOffset(0);
  let best = zero;
  if (fitOffset) {
    // Coarse global profile, followed by a local golden-section refinement.
    const grid = Array.from({length:65}, (_, index) => Math.expm1(Math.log1p(maxOffset)*index/64));
    let bestIndex = 0;
    for (let i=0; i<grid.length; i++) {
      const fit = atOffset(grid[i]);
      if (fit && (!best || fit.residual < best.residual)) { best = fit; bestIndex = i; }
    }
    let left = grid[Math.max(0,bestIndex-1)], right = grid[Math.min(grid.length-1,bestIndex+1)];
    const ratio = (Math.sqrt(5)-1)/2;
    for (let iteration=0;iteration<48;iteration++) {
      const x1=right-ratio*(right-left), x2=left+ratio*(right-left);
      const first=atOffset(x1), second=atOffset(x2);
      if (first && (!best || first.residual < best.residual)) best=first;
      if (second && (!best || second.residual < best.residual)) best=second;
      if ((first?.residual ?? Infinity) < (second?.residual ?? Infinity)) right=x2; else left=x1;
    }
    // Do not turn numerical noise in a pure power law into evidence for b>0.
    if (zero && best && zero.residual-best.residual <= 1e-10*Math.max(1,total)) best=zero;
  }
  if (!best) return null;
  const offsetStatus = !fitOffset ? "not-identifiable" : best.b < 1e-6 ? "zero-boundary" : best.b >= maxOffset*(1-1e-6) ? "upper-boundary" : "fitted";
  return {
    a:best.a, m:best.m, b:best.b, n:best.n,
    rSquared: total > 0 ? Math.max(0,Math.min(1,1-best.residual/total)) : 1,
    sampleSize:points.length, offsetStatus,
    calibrationBasis:nativeDurations >= 2 ? "native-duration" : "derived-duration",
    minDuration:Math.min(...durations), maxDuration:Math.max(...durations),
    minReturnPeriod:Math.min(...periods), maxReturnPeriod:Math.max(...periods), maxOffset,
  };
}

export function shermanCalibrationNote(fit: ShermanEquationFit | null) {
  if (!fit) return "Sherman equation unavailable: multiple durations and return periods are required.";
  const basis = fit.calibrationBasis === "native-duration" ? "Calibrated to independently supported duration return levels." : "Descriptive fit to derived duration values; not an independent short-duration calibration.";
  const status = fit.offsetStatus === "not-identifiable" ? "The offset b is not identifiable from at least three independently supported durations; b=0 is retained only as a labelled simplification."
    : fit.offsetStatus === "zero-boundary" ? "The fitted offset reaches b=0; do not extrapolate toward zero duration."
    : fit.offsetStatus === "upper-boundary" ? "The offset reaches the search upper bound; review parameter identifiability and calibration range."
    : `The duration offset b=${fit.b.toFixed(3)} minutes is calibrated, not a universal constant.`;
  return `${basis} ${status} Valid evaluation range: ${fit.minDuration}–${fit.maxDuration} minutes and ${fit.minReturnPeriod}–${fit.maxReturnPeriod} years. Local gauge validation remains required.`;
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
    !Number.isFinite(returnPeriodYears) ||
    durationMinutes < fit.minDuration || durationMinutes > fit.maxDuration ||
    returnPeriodYears < fit.minReturnPeriod || returnPeriodYears > fit.maxReturnPeriod
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
  return `i(t,T)=${fit.a.toFixed(3)}T^${fit.m.toFixed(3)}/(t+${fit.b.toFixed(3)})^${fit.n.toFixed(3)}`;
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

/** Daily duration scaling of fitted daily depths; not independent sub-daily correction. */
export function scaleDailyDurations(rows: ResultRow[], alpha: number, durations: readonly number[] = [5,10,15,30,60,120,180,360,720,1440]): ResultRow[] {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) return [];
  return rows.filter(row => row.durationMinutes === 1440).flatMap(row =>
    [...new Set(durations)].filter(duration=>Number.isFinite(duration) && duration>0 && duration<=1440).sort((a,b)=>a-b).map(durationMinutes => {
      if (durationMinutes === 1440) return {...row};
      const intensityFactor = (durationMinutes / 1440) ** (alpha - 1);
      const depthMm = row.depthMm * (durationMinutes / 1440) ** alpha;
      return {...row,durationMinutes,depthMm,intensityMmHr:depthMm * 60 / durationMinutes,
        ciLower:row.ciLower * intensityFactor,ciUpper:row.ciUpper * intensityFactor,derived:true};
    }));
}
