"use client";
import { useState } from "react";
import { fitPowerEquation, powerIntensityAtDuration } from "../../lib/idf-design";
import { PERIODS, type ResultRow } from "../../lib/observed-idf";

export default function PowerIntensityCalculator({ rows }: { rows: ResultRow[] }) {
  const [duration, setDuration] = useState("60");
  const [period, setPeriod] = useState(10);
  const fit = fitPowerEquation(rows, period);
  const validRows = rows.filter((row) => row.returnPeriodYears === period &&
    row.durationMinutes > 0 && row.durationMinutes <= 1440 &&
    row.intensityMmHr > 0 && Number.isFinite(row.intensityMmHr));
  const min = Math.min(...validRows.map((row) => row.durationMinutes));
  const max = Math.max(...validRows.map((row) => row.durationMinutes));
  const minutes = duration.trim() ? Number(duration) : NaN;
  const intensity = powerIntensityAtDuration(rows, period, minutes);
  const message = !fit
    ? "Load data with at least two supported durations to calculate intensity from a power equation."
    : !Number.isFinite(minutes) || minutes <= 0
      ? "Enter a positive duration in minutes."
      : intensity === null
        ? `Enter a duration between ${min} and ${max} minutes, the fitted range for this curve.`
        : null;
  return (
    <section className="tc-calculator power-calculator" aria-labelledby="power-calculator-title">
      <div className="tc-calculator-head">
        <div><span>Calculate directly from the chart equation</span><h3 id="power-calculator-title">Enter duration t → calculate intensity i</h3></div>
        <code>{fit ? <>i = {fit.coefficient.toFixed(3)} × t<sup>{fit.exponent.toFixed(3)}</sup></> : "i = c × tᵖ"}</code>
      </div>
      <div className="tc-input-grid">
        <label>Duration t (minutes)
          <input type="number" inputMode="decimal" step="any" min={fit ? min : 0} max={fit ? max : undefined}
            value={duration} onChange={(event) => setDuration(event.target.value)} aria-describedby="power-calculator-status" />
        </label>
        <label>Return period T (years)
          <select aria-label="Return period T (years)" value={period} onChange={(event) => setPeriod(Number(event.target.value))}>
            {PERIODS.map((value) => <option key={value} value={value}>{value}-year</option>)}
          </select>
        </label>
      </div>
      <div className="tc-result-grid" aria-live="polite" aria-atomic="true">
        <div><span>Rainfall intensity i</span><strong data-testid="power-intensity">{intensity === null ? "—" : `${intensity.toFixed(3)} mm/hour`}</strong><small>{period}-year power equation</small></div>
        <div><span>Rainfall depth</span><strong>{intensity === null ? "—" : `${(intensity * minutes / 60).toFixed(3)} mm`}</strong><small>i × t / 60</small></div>
        <div><span>Trendline R²</span><strong>{fit ? fit.rSquared.toFixed(4) : "—"}</strong><small>Log–log regression</small></div>
      </div>
      <p id="power-calculator-status" className="tc-caution" role="status">{message ?? `Calculated automatically for t = ${minutes} minutes using the full-precision coefficients of the ${period}-year chart equation. Supported range: ${min}–${max} minutes. This is a trendline estimate; check the fitted IDF table and duration assumptions before design use.`}</p>
    </section>
  );
}
