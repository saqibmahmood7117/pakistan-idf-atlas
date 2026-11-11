import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPowerEquation, powerIntensityAtDuration } from '../lib/idf-design.ts';

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


test('duration calculator evaluates the selected power curve within its fitted range', () => {
  const rows = [10, 100].flatMap((period) => [5, 60, 1440].map((duration) => ({
    returnPeriodYears: period, durationMinutes: duration, intensityMmHr: period * 100 * duration ** -0.67,
  })));
  assert.ok(Math.abs(powerIntensityAtDuration(rows, 10, 25.5) - 1000 * 25.5 ** -0.67) < 1e-8);
  assert.ok(Math.abs(powerIntensityAtDuration(rows, 100, 60) - 10000 * 60 ** -0.67) < 1e-8);
  for (const duration of [0, -1, NaN, Infinity, 4.9, 1441]) {
    assert.equal(powerIntensityAtDuration(rows, 10, duration), null);
  }
  assert.equal(powerIntensityAtDuration([], 10, 60), null);
  assert.equal(powerIntensityAtDuration(rows.filter(row => row.durationMinutes === 1440), 10, 60), null);
});
