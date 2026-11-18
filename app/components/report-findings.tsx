import type { annualRainfallSummary } from "../../lib/annual-rainfall";
import type { ObservedWorkbookResult } from "../../lib/observed-workbook";
import type { ResultRow } from "../../lib/observed-idf";
import { mmHrToInchHr } from "../../lib/rainfall-units";

const number = (value: number, digits = 2) => Number.isFinite(value)
  ? value.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits })
  : "Unavailable";

export function ReportFindings({ rows, source, period, method, sample, status, condition, step, durationBasis, ensemble }: {
  rows: ResultRow[];
  source: string;
  period: string;
  method: string;
  sample: string;
  status: string;
  condition: string;
  step: string;
  durationBasis: string;
  ensemble: boolean;
}) {
  const daily = rows.filter(row => row.durationMinutes === 1440 && Number.isFinite(row.depthMm) && Number.isFinite(row.intensityMmHr));
  const example = daily.find(row => row.returnPeriodYears === 10) ?? daily[0];
  const intervalLabel = ensemble ? "P10–P90 model spread" : "95% bootstrap interval";

  return <>
    <h3>What the assessment tells you</h3>
    <p className="report-summary">{example
      ? `The ${example.returnPeriodYears}-year, 24-hour rainfall depth is estimated at ${number(example.depthMm)} mm (${number(mmHrToInchHr(example.depthMm), 3)} inches). Over 24 hours this is an average intensity of ${number(example.intensityMmHr)} mm/h (${number(mmHrToInchHr(example.intensityMmHr), 3)} in/h).`
      : status}</p>
    <dl className="report-findings-facts">
      <div><dt>Rainfall source</dt><dd>{source}</dd></div>
      <div><dt>Analysis period</dt><dd>{period}</dd></div>
      <div><dt>Frequency method</dt><dd>{method}{condition && `. ${condition}`}</dd></div>
      <div><dt>Evidence used</dt><dd>{sample}</dd></div>
    </dl>
    {example && <>
      <p><strong>Result status.</strong> {status}</p>
      <div className="report-table-wrap">
        <table className="report-key-results">
          <caption>24-hour design rainfall estimates</caption>
          <thead><tr><th scope="col">Return period (years)</th><th scope="col">Annual chance (%)</th><th scope="col">Depth (mm)</th><th scope="col">Intensity (mm/h)</th><th scope="col">Intensity (in/h)</th><th scope="col">{intervalLabel} (mm/h)</th></tr></thead>
          <tbody>{daily.map(row => <tr key={row.returnPeriodYears}>
            <th scope="row">{row.returnPeriodYears}</th>
            <td>{number(100 / row.returnPeriodYears, 1)}</td>
            <td>{number(row.depthMm)}</td>
            <td>{number(row.intensityMmHr)}</td>
            <td>{number(mmHrToInchHr(row.intensityMmHr), 3)}</td>
            <td>{Number.isFinite(row.ciLower) && Number.isFinite(row.ciUpper) ? `${number(row.ciLower)}–${number(row.ciUpper)}` : "Unavailable"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <p><strong>Reading a row.</strong> The {example.returnPeriodYears}-year depth has a {number(100 / example.returnPeriodYears, 1)}% chance of being exceeded by the annual 24-hour maximum{condition ? " under the stated evaluation conditions" : " in any given year"}. The intensity averages that depth over 24 hours. Rounded depth and intensity values can differ slightly when converted back.</p>
      <p><strong>Reading the bounds.</strong> {ensemble
        ? "P10 and P90 are the 10th and 90th percentiles of the model intensities. They describe the spread across the included models for the selected scenario."
        : "The interval estimates sampling uncertainty in the fitted intensity by repeatedly resampling the annual-maxima record. Source errors and duration-scaling uncertainty fall outside these bounds."} The estimates at 250 and 500 years depend strongly on the fitted upper tail.</p>
      <p><strong>Duration evidence.</strong> {durationBasis}</p>
    </>}
    <p><strong>{example ? "Review priorities." : "Next step."}</strong> {step}</p>
  </>;
}

type ObservedImportAudit = Pick<ObservedWorkbookResult, "sheets" | "invalidRows" | "duplicateRows" | "otherResolutionRows"> & { fileName: string; importedDays: number };

export function ReportDailyRecord({ rainfall, maxima, upload }: {
  rainfall: ReturnType<typeof annualRainfallSummary>;
  maxima: { year: number; depthMm: number }[];
  upload: ObservedImportAudit | null;
}) {
  const maximumByYear = new Map(maxima.map(item => [item.year, item.depthMm]));
  return <section className="report-record-audit">
    <h3>Daily gauge record and annual coverage</h3>
    {upload && <p><strong>Workbook import.</strong> {upload.fileName} supplied {upload.importedDays.toLocaleString("en-GB")} unique daily readings from {upload.sheets.join(", ")}. The importer skipped {upload.invalidRows.toLocaleString("en-GB")} rows with unusable dates or rainfall and merged {upload.duplicateRows.toLocaleString("en-GB")} duplicate dates. {upload.otherResolutionRows > 0 && `It set aside ${upload.otherResolutionRows.toLocaleString("en-GB")} readings from the other time resolution.`} These are counts before the report’s date filter and any edits.</p>}
    {rainfall.years.length ? <>
      <p><strong>Rainfall over the selected record.</strong> The available daily readings from {rainfall.start} to {rainfall.end} total {number(rainfall.totalMm)} mm. {rainfall.meanMm === null
        ? "A complete calendar year is needed to calculate mean annual rainfall."
        : `Mean annual rainfall is ${number(rainfall.meanMm)} mm/year (${number(mmHrToInchHr(rainfall.meanMm), 3)} in/year) across ${rainfall.completeYears.length} complete calendar ${rainfall.completeYears.length === 1 ? "year" : "years"}.`}</p>
      <p><strong>Two coverage rules apply.</strong> A year with at least 90% of its daily readings can contribute an annual maximum to the IDF analysis. The mean annual rainfall uses only years with every daily reading, because missing rainfall would reduce the annual total. Partial totals are shown as the sum of available readings.</p>
      <div className="report-table-wrap"><table className="report-key-results">
        <caption>Recorded annual totals and maxima used to build the frequency sample</caption>
        <thead><tr><th scope="col">Year</th><th scope="col">Days recorded / expected</th><th scope="col">Coverage (%)</th><th scope="col">Recorded total (mm)</th><th scope="col">Eligible daily maximum (mm)</th><th scope="col">Included in annual mean</th></tr></thead>
        <tbody>{rainfall.years.map(row => {
          const maximum = maximumByYear.get(row.year);
          return <tr key={row.year}>
            <th scope="row">{row.year}</th><td>{row.validIntervals} / {row.expectedIntervals}</td><td>{number(row.coverage * 100, 1)}</td>
            <td>{row.totalMm === null ? "No readings" : number(row.totalMm)}</td>
            <td>{maximum === undefined ? "Excluded" : number(maximum)}</td><td>{row.complete ? "Yes" : "No"}</td>
          </tr>;
        })}</tbody>
      </table></div>
    </> : <p>The selected date range contains no valid daily readings.</p>}
  </section>;
}
