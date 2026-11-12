import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PAKISTAN_DISTRICT_GROUPS} from '../lib/district-catalogue.ts';
import {normalizeBoundaryName} from '../lib/district-boundaries.ts';
test('province groups cover each of the 160 verified district boundaries exactly once',()=>{
 const districts=Object.values(PAKISTAN_DISTRICT_GROUPS).flat();const boundaries=JSON.parse(readFileSync(new URL('../public/data/pakistan-districts-ocha-2024.geojson',import.meta.url)));
 assert.equal(Object.keys(PAKISTAN_DISTRICT_GROUPS).length,7);assert.equal(districts.length,160);assert.equal(new Set(districts.map(normalizeBoundaryName)).size,160);
 const names=new Set(boundaries.features.map(f=>normalizeBoundaryName(f.properties.adm2_name)));
 assert.ok(districts.every(d=>names.has(normalizeBoundaryName(d))));
 assert.ok(PAKISTAN_DISTRICT_GROUPS['Khyber Pakhtunkhwa'].includes('Peshawar'));assert.ok(PAKISTAN_DISTRICT_GROUPS.Punjab.includes('Lahore'));assert.ok(!PAKISTAN_DISTRICT_GROUPS.Punjab.includes('Peshawar'));
});
test('Kashmir contextual polygons retain attribution and are excluded from analytical district options',()=>{
 const context=JSON.parse(readFileSync(new URL('../public/data/kashmir-context.geojson',import.meta.url)));
 assert.deepEqual(context.features.map(f=>f.properties.name).sort(),['Jammu and Kashmir','Ladakh']);
 for(const f of context.features){assert.equal(f.properties.analysis_selectable,false);assert.match(f.properties.status,/Disputed/);assert.match(f.properties.source,/geoBoundaries/);assert.ok(['Polygon','MultiPolygon'].includes(f.geometry.type));}
 assert.ok(!Object.values(PAKISTAN_DISTRICT_GROUPS).flat().includes('Ladakh'));
});
