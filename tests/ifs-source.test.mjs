import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_SOURCE_CONFIG, IFS_PRECIPITATION_NOTICE, requirePrecipitationMillimetres, reanalysisDistrictGrid } from '../lib/online-precipitation.ts';
import { SOURCE_META } from '../lib/idf-data.ts';

test('IFS is an explicit hourly/daily archive with a documented short record', () => {
  assert.equal(LIVE_SOURCE_CONFIG.ifs.openMeteoModel,'ecmwf_ifs');
  assert.equal(LIVE_SOURCE_CONFIG.ifs.firstDate,'2017-01-01');
  assert.deepEqual(LIVE_SOURCE_CONFIG.ifs.supportedResolutions,['daily','hourly']);
  assert.match(SOURCE_META.ifs.label,/operational/);
  assert.match(IFS_PRECIPITATION_NOTICE,/not a homogeneous long-term reanalysis/);
});

test('IFS precipitation must carry millimetre units before fitting', () => {
  assert.doesNotThrow(()=>requirePrecipitationMillimetres('mm'));
  for(const unit of [undefined,null,'m','kg m-2 s-1','mm/hr']) assert.throws(()=>requirePrecipitationMillimetres(unit),/expected mm/);
});

test('IFS district sampling remains bounded and is documented as a request mesh', () => {
  const geometry={type:'Polygon',coordinates:[[[71.5,33.5],[72.5,33.5],[72.5,34.5],[71.5,34.5],[71.5,33.5]]]};
  const grid=reanalysisDistrictGrid('ifs',geometry,4);
  assert.equal(grid.points.length,4);
  assert.ok(grid.candidateCount>4);
  assert.ok(grid.points.every(point=>point.weight>0));
  assert.match(IFS_PRECIPITATION_NOTICE,/not an exact native-grid area integral/);
});
