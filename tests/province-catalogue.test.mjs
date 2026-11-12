import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import shp from 'shpjs';
import {PAKISTAN_DISTRICT_GROUPS} from '../lib/district-catalogue.ts';
import {DEFAULT_DISTRICT_BOUNDARY} from '../lib/default-boundary.ts';
import {normalizeBoundaryName,boundaryFeatureIdentity} from '../lib/district-boundaries.ts';
const read=name=>JSON.parse(readFileSync(new URL(`../public/data/${name}`,import.meta.url)));
const map=read('uploaded-districts.geojson'),manifest=read('uploaded-districts-manifest.json');
const archive=readFileSync(new URL('../public/data/Districts.zip',import.meta.url));
const original=await shp(archive.buffer.slice(archive.byteOffset,archive.byteOffset+archive.byteLength));
const flat=c=>typeof c[0]==='number'?[c]:c.flatMap(flat);
test('the permanent uploaded map and catalogue contain the same 161 unique source units',()=>{
 const names=Object.values(PAKISTAN_DISTRICT_GROUPS).flat();assert.equal(names.length,161);assert.equal(map.features.length,161);assert.equal(new Set(names.map(normalizeBoundaryName)).size,161);
 const shapes=new Set(map.features.map(f=>normalizeBoundaryName(f.properties.adm2_name)));assert.ok(names.every(n=>shapes.has(normalizeBoundaryName(n))));
 assert.ok(PAKISTAN_DISTRICT_GROUPS['Khyber Pakhtunkhwa'].includes('Peshawar'));assert.equal(PAKISTAN_DISTRICT_GROUPS['Kashmir (disputed; source unit)'].length,1);assert.equal(PAKISTAN_DISTRICT_GROUPS['FATA (source grouping)'].length,13);
});
test('the original ZIP is retained, source identifiers are unique despite repeated OBJECTIDs, and provenance is uploaded-map specific',()=>{
 const hash=createHash('sha256').update(archive).digest('hex');assert.equal(hash,manifest.archiveSha256);assert.equal(hash,DEFAULT_DISTRICT_BOUNDARY.archiveSha256);
 const codes=map.features.map(f=>boundaryFeatureIdentity(f.properties).code);assert.equal(new Set(codes).size,161);
 for(const f of map.features){const id=boundaryFeatureIdentity(f.properties);assert.equal(id.source,'User-supplied Districts.zip');assert.match(id.version,new RegExp(hash.slice(0,16)));assert.equal(id.validOn,'Not supplied in uploaded archive');}
});
test('independent shapefile parser confirms untouched coordinates for 159 units and audit-limited topology repair for two',()=>{
 assert.equal(original.features.length,161);let untouched=0;
 for(let i=0;i<map.features.length;i++){
  const feature=map.features[i],raw=original.features[i];assert.equal(feature.properties.DISTRICT,raw.properties.DISTRICT);assert.equal(feature.properties.PROVINCE,raw.properties.PROVINCE);
  if(feature.properties.geometry_repaired)continue;
  const a=flat(feature.geometry.coordinates),b=flat(raw.geometry.coordinates);assert.equal(a.length,b.length);
  for(let j=0;j<a.length;j++){assert.ok(Math.abs(a[j][0]-b[j][0])<1e-9);assert.ok(Math.abs(a[j][1]-b[j][1])<1e-9);}untouched++;
 }
 assert.equal(untouched,159);assert.equal(manifest.repairs.length,2);assert.deepEqual(manifest.repairs.map(r=>r.district),['BARKHAN','BATAGRAM']);assert.ok(manifest.repairs.every(r=>r.relative_area_change<1e-12));assert.equal(manifest.horizontalEpsg,4326);assert.equal(manifest.simplified,false);assert.equal(manifest.clipped,false);
});
test('the deployment build contains the permanent GeoJSON and unchanged original ZIP',()=>{
 const built=JSON.parse(readFileSync(new URL('../dist/client/data/uploaded-districts.geojson',import.meta.url)));
 assert.deepEqual(built,map);
 const zip=readFileSync(new URL('../dist/client/data/Districts.zip',import.meta.url));assert.equal(createHash('sha256').update(zip).digest('hex'),manifest.archiveSha256);
});
