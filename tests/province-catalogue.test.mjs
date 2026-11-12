import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {PAKISTAN_DISTRICT_GROUPS} from '../lib/district-catalogue.ts';
import {normalizeBoundaryName,boundaryFeatureIdentity} from '../lib/district-boundaries.ts';
const read=name=>JSON.parse(readFileSync(new URL(`../public/data/${name}`,import.meta.url)));
const project=read('project-districts.geojson'),original=read('pakistan-districts-ocha-2024.geojson');
test('province/region groups reconcile uniquely to all 182 selectable polygons',()=>{
 const names=Object.values(PAKISTAN_DISTRICT_GROUPS).flat();assert.equal(names.length,182);assert.equal(new Set(names.map(normalizeBoundaryName)).size,182);
 const shapes=new Set(project.features.map(f=>normalizeBoundaryName(f.properties.adm2_name)));
 assert.ok(names.every(name=>shapes.has(normalizeBoundaryName(name))));
 assert.equal(PAKISTAN_DISTRICT_GROUPS['Jammu and Kashmir (disputed)'].length,20);assert.equal(PAKISTAN_DISTRICT_GROUPS['Ladakh (disputed)'].length,2);
 assert.ok(PAKISTAN_DISTRICT_GROUPS['Jammu and Kashmir (disputed)'].includes('Srinagar'));
 assert.ok(PAKISTAN_DISTRICT_GROUPS['Azad Jammu & Kashmir'].includes('Poonch'));assert.ok(PAKISTAN_DISTRICT_GROUPS['Jammu and Kashmir (disputed)'].includes('Poonch (Jammu and Kashmir)'));
});
test('the 160 existing district geometries are preserved exactly',()=>{
 for(const feature of original.features){const corresponding=project.features.find(f=>f.properties.adm2_pcode===feature.properties.adm2_pcode);assert.deepEqual(corresponding,feature);}
});
test('all 22 Kashmir source geometries match retained full-resolution fingerprints and keep source-aware provenance',()=>{
 const manifest=read('kashmir-district-source-fingerprints.json');assert.equal(manifest.geometryModified,false);
 const extra=project.features.filter(f=>f.properties.disputed);assert.equal(extra.length,22);
 for(const feature of extra){const entry=manifest.features.find(f=>f.id===feature.properties.shapeID);assert.ok(entry);assert.equal(createHash('sha256').update(JSON.stringify(feature.geometry)).digest('hex'),entry.geometrySha256);
 const identity=boundaryFeatureIdentity(feature.properties);assert.match(identity.source,/geoBoundaries.*IND ADM2/);assert.equal(identity.code,feature.properties.shapeID);assert.match(identity.version,/76128533/);assert.equal(feature.properties.analysis_selectable,true);}
 assert.ok(!project.features.some(f=>f.properties.adm2_name==='DATA NOT AVAILABLE'));
});
