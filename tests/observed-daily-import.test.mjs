import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import {readObservedWorkbook} from '../lib/observed-workbook.ts';
import {assess, calculate} from '../lib/observed-idf.ts';

const csvBytes = (text) => new TextEncoder().encode(text).buffer;
const dailyBytes = (bytes) => readObservedWorkbook(XLSX, bytes, {preferredResolution: 'daily'});

function workbookBytes(sheets, date1904 = false) {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  }
  if (date1904) book.Workbook = {WBProps: {date1904: true}};
  return XLSX.write(book, {type: 'array', bookType: 'xlsx'});
}

test('daily timestamped Excel data stay daily and produce stationary IDF curves', () => {
  const rows = [['Timestamp', 'Rainfall (mm)']];
  for (let year = 2012; year < 2020; year++) {
    for (let day = Date.UTC(year, 0, 1); day < Date.UTC(year + 1, 0, 1); day += 86400000) {
      // Excel stores this as a serial date with an 08:00 observation clock.
      const serial = day / 86400000 + 25569 + 8 / 24;
      const depth = day === Date.UTC(year, 5, 1) ? 20 + (year - 2012) ** 1.4 : 0;
      rows.push([serial, depth]);
    }
  }
  const parsed = dailyBytes(workbookBytes([['Station readings', rows]]));
  assert.equal(parsed.resolution, 'daily');
  assert.equal(parsed.dailyRecords.length, 2922);
  assert.equal(parsed.dailyRecords[0].date, '2012-01-01');
  const qc = assess(parsed.dailyRecords);
  assert.equal(qc.eligibleYears, 8);
  const result = calculate(qc.records).find(row => row.method === 'gev' && row.durationMinutes === 1440 && row.returnPeriodYears === 10);
  assert.ok(result?.intensityMmHr > 0);
});

test('CSV infers day/month order before coercion and leaves missing rain and dates out', () => {
  const parsed = dailyBytes(csvBytes('Date,Rainfall (mm)\n01/02/2010,3\n13/02/2010,0\n14/02/2010,\n,12\n15/02/2010,trace\n'));
  assert.deepEqual(parsed.dailyRecords.map(row => [row.date, row.precipitationMm]), [
    ['2010-02-01', 3], ['2010-02-13', 0], ['2010-02-15', 0],
  ]);
  assert.equal(parsed.invalidRows, 2);
});

test('Excel serial dates respect the workbook epoch and compact Excel dates remain calendar dates', () => {
  const parsed = dailyBytes(workbookBytes([['Rainfall', [['Date', 'RF (mm)'], [1, 2], [2, 0], [19040104, 3]]]], true));
  assert.deepEqual(parsed.dailyRecords.map(row => row.date), ['1904-01-02', '1904-01-03', '1904-01-04']);
});

test('daily uploads prefer daily totals from mixed workbooks and genuine hourly tables remain hourly', () => {
  const hourly = ['2020-01-01T00:00', '2020-01-01T01:00', '2020-01-01T02:00'].map(timestamp => [timestamp, 1]);
  const hourlySheet = ['Hourly', [['Timestamp', 'Rainfall (mm)'], ...hourly]];
  const parsed = dailyBytes(workbookBytes([hourlySheet, ['Daily', [['Date', 'Rainfall (mm)'], ['2020-01-01', 7]]]]));
  assert.equal(parsed.resolution, 'daily');
  assert.equal(parsed.dailyRecords[0].precipitationMm, 7);
  assert.equal(parsed.otherResolutionRows, 3);
  assert.equal(dailyBytes(workbookBytes([hourlySheet])).hourlyRecords.length, 3);
});
