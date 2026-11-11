// Demonstration data only. These values are not measured rainfall.
import { mkdir, writeFile } from 'node:fs/promises';
let seed = 7117;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return (seed + 1) / 4294967297;
};
let csv = 'Date,Precipitation_mm\n';
for (const date = new Date('1985-01-01T00:00:00Z'); date < new Date('2020-01-01T00:00:00Z'); date.setUTCDate(date.getUTCDate() + 1)) {
  const wet = random() < 0.2;
  const rain = wet ? -Math.log(random()) * 12 : 0;
  csv += `${date.toISOString().slice(0, 10)},${rain.toFixed(2)}\n`;
}
await mkdir('work', { recursive: true });
await writeFile('work/SYNTHETIC-DEMONSTRATION-ONLY.csv', csv);
console.log('Created work/SYNTHETIC-DEMONSTRATION-ONLY.csv. Not measured rainfall.');
