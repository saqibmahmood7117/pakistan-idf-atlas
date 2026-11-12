"use client";
import { mmHrToInchHr } from "../../lib/rainfall-units";
import { useState } from "react";
import { fitPowerEquation, powerIntensityAtDuration, formatShermanEquation, shermanIntensity, shermanCalibrationNote, type ShermanEquationFit } from "../../lib/idf-design";
import { PERIODS, type ResultRow } from "../../lib/observed-idf";

export default function PowerIntensityCalculator({ rows, globalFit, defaultDurationMinutes = 60, defaultEquationMode = "sherman" }: { rows: ResultRow[]; globalFit: ShermanEquationFit | null; defaultDurationMinutes?: number; defaultEquationMode?: "sherman" | "power" }) {
  const [equationMode, setEquationMode] = useState<"sherman" | "power">(defaultEquationMode);
  const [duration, setDuration] = useState(String(defaultDurationMinutes));
  const [period, setPeriod] = useState(10);
  const fit = fitPowerEquation(rows, period);
  const validRows = rows.filter((row) => row.returnPeriodYears === period &&
    row.durationMinutes > 0 && row.durationMinutes <= 1440 &&
    row.intensityMmHr > 0 && Number.isFinite(row.intensityMmHr));
  const powerMin = Math.min(...validRows.map((row) => row.durationMinutes));
  const powerMax = Math.max(...validRows.map((row) => row.durationMinutes));
  const minutes = duration.trim() ? Number(duration) : NaN;
  const min = equationMode === "sherman" ? globalFit?.minDuration ?? NaN : powerMin;
  const max = equationMode === "sherman" ? globalFit?.maxDuration ?? NaN : powerMax;
  const available = equationMode === "sherman" ? globalFit : fit;
  const intensity = equationMode === "sherman" ? shermanIntensity(globalFit, minutes, period) : powerIntensityAtDuration(rows, period, minutes);
  const message = !available
    ? "Load data with at least two supported durations to calculate intensity from an equation."
    : !Number.isFinite(minutes) || minutes <= 0
      ? "Enter a positive duration in minutes."
      : intensity === null
        ? `Enter a duration between ${min} and ${max} minutes, the fitted range for this curve.`
        : null;
  const singleDurations = new Set(rows.filter(row=>row.durationMinutes>0&&Number.isFinite(row.intensityMmHr)).map(row=>row.durationMinutes));
  if (singleDurations.size === 1 && rows.length) {
    const supportedDuration = [...singleDurations][0];
    const selected = rows.find(row=>row.returnPeriodYears===period) ?? rows[0];
    const options = [...new Set(rows.map(row=>row.returnPeriodYears))].sort((a,b)=>a-b);
    return <section className="tc-calculator power-calculator" aria-labelledby="power-calculator-title" data-testid="single-duration-lookup">
      <div className="tc-calculator-head"><div><span>Supported duration result</span><h3 id="power-calculator-title">{supportedDuration===1440?"24-hour":`${supportedDuration}-minute`} rainfall lookup</h3></div><code>Tabulated fitted return level</code></div>
      <div className="tc-input-grid"><label>Supported duration t (minutes)<input type="number" value={supportedDuration} readOnly /></label><label>Return period T (years)<select aria-label="Return period T (years)" value={selected.returnPeriodYears} onChange={event=>setPeriod(Number(event.target.value))}>{options.map(value=><option key={value} value={value}>{value}-year</option>)}</select></label></div>
      <div className="tc-result-grid" aria-live="polite"><div><span>Rainfall intensity i</span><strong data-testid="power-intensity">{selected.intensityMmHr.toFixed(3)} mm/hour</strong><small>{mmHrToInchHr(selected.intensityMmHr).toFixed(4)} inch/hr · {selected.returnPeriodYears}-year tabulated estimate</small></div><div><span>Rainfall depth</span><strong>{selected.depthMm.toFixed(3)} mm</strong><small>Over {supportedDuration} minutes</small></div></div>
      <p className="tc-caution">This analysis contains only one storm duration. The chart compares its return periods. A duration equation cannot be fitted from one duration. For a complete IDF family, use native duration-specific data. Daily duration scaling can generate derived curves where that option is available.</p>
    </section>;
  }
  return (
    <section className="tc-calculator power-calculator" aria-labelledby="power-calculator-title">
      <div className="tc-calculator-head">
        <div><span>Calculate directly from the chart equation</span><h3 id="power-calculator-title">Enter duration t → calculate intensity i</h3></div>
        <code>{equationMode === "sherman" ? formatShermanEquation(globalFit) : fit ? <>i = {fit.coefficient.toFixed(3)} × t<sup>{fit.exponent.toFixed(3)}</sup></> : "i = c × tᵖ"}</code>
      </div>
      <div className="tc-input-grid">
        <label>Equation method
          <select aria-label="Equation method" value={equationMode} onChange={(event) => setEquationMode(event.target.value as "sherman" | "power")}>
            <option value="sherman">Sherman · calibrated duration offset</option>
            <option value="power">Power · Excel-style trendline</option>
          </select>
        </label>
        <label>Duration t (minutes)
          <input type="number" inputMode="decimal" step="any" min={available ? min : 0} max={available ? max : undefined}
            value={duration} onChange={(event) => setDuration(event.target.value)} aria-describedby="power-calculator-status" />
        </label>
        <label>Return period T (years)
          <select aria-label="Return period T (years)" value={period} onChange={(event) => setPeriod(Number(event.target.value))}>
            {PERIODS.map((value) => <option key={value} value={value}>{value}-year</option>)}
          </select>
        </label>
      </div>
      <div className="tc-result-grid" aria-live="polite" aria-atomic="true">
        <div><span>Rainfall intensity i</span><strong data-testid="power-intensity">{intensity === null ? "—" : `${intensity.toFixed(3)} mm/hour`}</strong><small>{intensity === null ? "—" : `${mmHrToInchHr(intensity).toFixed(4)} inch/hr`} · {period}-year {equationMode === "sherman" ? "Sherman equation" : "power equation"}</small></div>
        <div><span>Rainfall depth</span><strong>{intensity === null ? "—" : `${(intensity * minutes / 60).toFixed(3)} mm`}</strong><small>i × t / 60</small></div>
        <div><span>Trendline R²</span><strong>{available ? available.rSquared.toFixed(4) : "—"}</strong><small>Log–log regression</small></div>
      </div>
      {equationMode === "sherman" && <p className="tc-caution" data-testid="sherman-calibration">{shermanCalibrationNote(globalFit)}</p>}
      <details className="equation-help">
        <summary>What do the equation and constants mean?</summary>
        <p><strong>Units:</strong> Both mm/hr and inch/hr are displayed. Divide mm/hr by exactly 25.4 to obtain inch/hr. To use a displayed equation directly in inch/hr, divide its scale coefficient (a or c) by 25.4; keep all exponents, duration and offset unchanged.</p>
        <p><strong>i</strong> is rainfall intensity in mm/hour. <strong>t</strong> is your entered storm duration in minutes. <strong>T</strong> is the selected return period in years; each T has its own equation.</p>
        <p><strong>Sherman:</strong> i=aTᵐ/(t+b)ⁿ. a is the scale, m the return-period exponent, n the duration exponent and b the offset in minutes. The website profiles b≥0 and fits a, m and n in log space. b is calibrated only with at least three independently supported durations. Derived daily-to-duration values do not provide independent evidence for b. Boundary solutions and the calibration range are reported explicitly. This is a literature-supported equation family, not local design validation.</p>
        <p><strong>Power:</strong> the Excel-style alternative uses c and p for one return period.</p>
        <p><strong>c</strong> is the fitted scale coefficient{fit ? ` (${fit.coefficient.toPrecision(8)} for this curve)` : ""}. <strong>p</strong> is the dimensionless duration exponent{fit ? ` (${fit.exponent.toPrecision(8)})` : ""}. A negative p means intensity decreases as duration increases. c depends on the chosen units; it is not a universal rainfall constant.</p>
        <p><strong>How c and p are obtained:</strong> the website takes the positive duration/intensity points for this return period, transforms both using natural logarithms, and fits a straight line: ln(i)=ln(c)+p ln(t). The slope gives p and the exponential of the intercept gives c. The coefficients summarize the active fitted IDF values, not the raw rainfall directly.</p>
        <p><strong>Why R² can equal 1:</strong> when shorter durations were created with a pure scaling law, their power relationship is built into the calculation. R² describes the log-space trendline fit; it does not prove that derived rainfall is correct.</p>
        <p><strong>Depth:</strong> P=i×t/60, where P is mm and 60 converts minutes to hours. The calculator uses full-precision coefficients. See the report’s Appendix A for coefficient tables, equation definitions and a worked example.</p>
      </details>
      <p id="power-calculator-status" className="tc-caution" role="status">{message ?? `Calculated automatically for t = ${minutes} minutes using full-precision coefficients of the ${period}-year ${equationMode} equation. Supported range: ${min}–${max} minutes. This is a trendline estimate; check the fitted IDF table and duration assumptions before design use.`}</p>
    </section>
  );
}
