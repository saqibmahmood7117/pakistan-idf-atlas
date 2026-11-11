import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPowerEquation } from '../lib/idf-design.ts';

test('Excel-style power regression recovers independent equations for each return period', () => {
  const periods = [2, 5, 10, 25, 50, 100, 250, 500];
  const rows = periods.flatMap((period) => [5, 10, 30, 60, 360, 1440].map((duration) => ({
    returnPeriodYears: period, durationMinutes: duration,
    intensityMmHr: (100 + period) * duration ** (-2 / 3),
  })));
  for (const period of periods) {
    const fit = fitPowerEquation(rows, period);
    assert.ok(Math.abs(fit.coefficient - (100 + period)) < 1e-8);
    assert.ok(Math.abs(fit.exponent + 2 / 3) < 1e-10);
    assert.ok(Math.abs(fit.rSquared - 1) < 1e-10);
  }
});

test('a single 24-hour result does not imply a duration equation', () => {
  assert.equal(fitPowerEquation([{returnPeriodYears: 10, durationMinutes: 1440, intensityMmHr: 4}], 10), null);
});

test('power trendline reports a non-perfect fit for non-power data', () => {
  const rows = [5, 10, 30, 60, 360].map((duration, i) => ({
    returnPeriodYears: 10, durationMinutes: duration, intensityMmHr: [80, 75, 12, 10, 3][i],
  }));
  const fit = fitPowerEquation(rows, 10);
  assert.ok(fit.rSquared > 0 && fit.rSquared < 0.99);
});
