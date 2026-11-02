import type { DailyRecord, Method, ResultRow } from "./observed-idf.ts";

export type ModelReturnLevels = { model: string; rows: ResultRow[] };

export type MonthlyQdmSummary = {
  month: number;
  futureRecords: number;
  historicalGcmRecords: number;
  referenceRecords: number;
  medianFactor: number;
  p10Factor: number;
  p90Factor: number;
};

export type MonthlyQdmResult = {
  records: DailyRecord[];
  summaries: MonthlyQdmSummary[];
  method: "Monthly multiplicative quantile delta mapping (QDM)";
  wetDayThresholdMm: number;
};

const percentile = (values: number[], p: number) => {
  const sorted = [...values].filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return Number.NaN;
  const position = (sorted.length - 1) * p;
  const lo = Math.floor(position), hi = Math.ceil(position);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (position - lo);
};

const monthOf = (date: string) => Number(date.slice(5, 7));

function monthlyValues(records: DailyRecord[], month: number) {
  return records
    .filter(
      (record) =>
        monthOf(record.date) === month &&
        Number.isFinite(record.precipitationMm) &&
        record.precipitationMm >= 0,
    )
    .map((record) => record.precipitationMm)
    .sort((a, b) => a - b);
}

/**
 * Applies precipitation QDM independently by calendar month. The empirical
 * probability is taken from the future-model month, the historical reference
 * supplies the corrected climatological quantile, and the model future /
 * historical-model ratio preserves the simulated relative change.
 */
export function monthlyMultiplicativeQdm(
  future: DailyRecord[],
  historicalGcm: DailyRecord[],
  historicalReference: DailyRecord[],
  wetDayThresholdMm = 0.1,
): MonthlyQdmResult {
  const corrected: DailyRecord[] = [];
  const summaries: MonthlyQdmSummary[] = [];

  for (let month = 1; month <= 12; month += 1) {
    const futureMonth = future
      .filter(
        (record) =>
          monthOf(record.date) === month &&
          Number.isFinite(record.precipitationMm) &&
          record.precipitationMm >= 0,
      )
      .sort(
        (a, b) =>
          a.precipitationMm - b.precipitationMm ||
          a.date.localeCompare(b.date),
      );
    const modelMonth = monthlyValues(historicalGcm, month);
    const referenceMonth = monthlyValues(historicalReference, month);
    if (
      futureMonth.length < 3 ||
      modelMonth.length < 3 ||
      referenceMonth.length < 3
    )
      continue;

    const factors: number[] = [];
    futureMonth.forEach((record, index) => {
      const probability = (index + 0.5) / futureMonth.length;
      const historicalModelQuantile = percentile(modelMonth, probability);
      const historicalReferenceQuantile = percentile(
        referenceMonth,
        probability,
      );
      let value = 0;
      if (
        record.precipitationMm > wetDayThresholdMm &&
        historicalReferenceQuantile > wetDayThresholdMm
      ) {
        const denominator = Math.max(
          historicalModelQuantile,
          wetDayThresholdMm,
        );
        value =
          record.precipitationMm *
          (historicalReferenceQuantile / denominator);
      }
      const factor =
        record.precipitationMm > wetDayThresholdMm
          ? value / record.precipitationMm
          : 0;
      if (Number.isFinite(factor) && factor >= 0) factors.push(factor);
      corrected.push({
        ...record,
        precipitationMm: +Math.max(0, value).toFixed(6),
        qc: `${record.qc ? `${record.qc}; ` : ""}monthly multiplicative QDM`,
      });
    });
    summaries.push({
      month,
      futureRecords: futureMonth.length,
      historicalGcmRecords: modelMonth.length,
      referenceRecords: referenceMonth.length,
      medianFactor: +percentile(factors, 0.5).toFixed(4),
      p10Factor: +percentile(factors, 0.1).toFixed(4),
      p90Factor: +percentile(factors, 0.9).toFixed(4),
    });
  }

  return {
    records: corrected.sort((a, b) => a.date.localeCompare(b.date)),
    summaries,
    method: "Monthly multiplicative quantile delta mapping (QDM)",
    wetDayThresholdMm,
  };
}

export function extremeValueCorrectionFactors(
  gaugeRows: ResultRow[],
  historicalGcmRows: ResultRow[],
  method: Method,
) {
  const factors = new Map<number, number>();
  for (const gauge of gaugeRows.filter(r => r.method === method && r.durationMinutes === 1440)) {
    const model = historicalGcmRows.find(r =>
      r.method === method && r.durationMinutes === 1440 && r.returnPeriodYears === gauge.returnPeriodYears,
    );
    if (model && model.depthMm > 0) factors.set(gauge.returnPeriodYears, gauge.depthMm / model.depthMm);
  }
  return factors;
}

export function applyExtremeValueBiasCorrection(
  futureRows: ResultRow[],
  factors: Map<number, number>,
) {
  return futureRows
    .filter(row => row.durationMinutes === 1440 && factors.has(row.returnPeriodYears))
    .map(row => {
      const factor = factors.get(row.returnPeriodYears)!;
      return {
        ...row,
        depthMm: +(row.depthMm * factor).toFixed(3),
        intensityMmHr: +(row.intensityMmHr * factor).toFixed(3),
        ciLower: +(row.ciLower * factor).toFixed(3),
        ciUpper: +(row.ciUpper * factor).toFixed(3),
        derived: false,
      };
    });
}

export function observedDurationRatios(hourlyGaugeRows: ResultRow[], method: Method) {
  const ratios = new Map<string, number>();
  for (const row of hourlyGaugeRows.filter(r => r.method === method && r.durationMinutes <= 1440)) {
    const day = hourlyGaugeRows.find(r =>
      r.method === method && r.durationMinutes === 1440 && r.returnPeriodYears === row.returnPeriodYears,
    );
    if (day && day.depthMm > 0) ratios.set(`${row.returnPeriodYears}|${row.durationMinutes}`, row.depthMm / day.depthMm);
  }
  return ratios;
}

export function applyObservedDurationRatios(
  corrected24hRows: ResultRow[],
  ratios: Map<string, number>,
) {
  const durations = [5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
  return corrected24hRows.flatMap(day => durations.flatMap(durationMinutes => {
    const ratio = durationMinutes === 1440 ? 1 : ratios.get(`${day.returnPeriodYears}|${durationMinutes}`);
    if (!(ratio && ratio > 0)) return [];
    const depthMm = day.depthMm * ratio;
    return [{
      ...day,
      durationMinutes,
      depthMm: +depthMm.toFixed(3),
      intensityMmHr: +(depthMm / (durationMinutes / 60)).toFixed(3),
      ciLower: +((day.ciLower * ratio) / (durationMinutes / 60)).toFixed(3),
      ciUpper: +((day.ciUpper * ratio) / (durationMinutes / 60)).toFixed(3),
      derived: durationMinutes !== 1440,
    }];
  }));
}

export function multiModelEnvelope(models: ModelReturnLevels[]) {
  const keys = new Set(models.flatMap(model => model.rows.map(row => `${row.method}|${row.returnPeriodYears}|${row.durationMinutes}`)));
  const rows: ResultRow[] = [];
  for (const key of keys) {
    const [method, returnPeriod, duration] = key.split("|");
    const values = models.flatMap(model => {
      const row = model.rows.find(r => r.method === method && r.returnPeriodYears === Number(returnPeriod) && r.durationMinutes === Number(duration));
      return row ? [row] : [];
    });
    if (values.length < 3) continue;
    const depths = values.map(row => row.depthMm);
    const intensities = values.map(row => row.intensityMmHr);
    rows.push({
      ...values[0],
      method: method as Method,
      returnPeriodYears: Number(returnPeriod),
      durationMinutes: Number(duration),
      depthMm: +percentile(depths, .5).toFixed(3),
      intensityMmHr: +percentile(intensities, .5).toFixed(3),
      ciLower: +percentile(intensities, .1).toFixed(3),
      ciUpper: +percentile(intensities, .9).toFixed(3),
      derived: values.some(row => row.derived),
    });
  }
  return rows;
}

export function projectionEvidenceStatus(years: number, returnPeriodYears: number) {
  if (years < 30) return "Provisional — fewer than 30 annual maxima";
  if (returnPeriodYears > Math.max(100, years * 3)) return "Provisional — extreme extrapolation beyond the record";
  return "Supported within the fitted record and stated uncertainty";
}
