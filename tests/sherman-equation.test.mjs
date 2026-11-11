import test from 'node:test';
import assert from 'node:assert/strict';
import { fitShermanEquation, shermanIntensity, formatShermanEquation } from '../lib/idf-design.ts';
const surface = (b, derived = false) => [2, 5, 10, 25, 50, 100].flatMap(T =>
  [60, 120, 180, 360, 720, 1440].map(t => ({
    returnPeriodYears:T, durationMinutes:t, intensityMmHr:800*T**0.22/(t+b)**0.8, derived,
  })));

test('native-duration Sherman calibration recovers a positive offset and the four coefficients', () => {
  const fit = fitShermanEquation(surface(35));
  assert.equal(fit.offsetStatus,'fitted');
  assert.ok(Math.abs(fit.b-35)<0.001);
  assert.ok(Math.abs(fit.a-800)<0.01);
  assert.ok(Math.abs(fit.m-0.22)<1e-6);
  assert.ok(Math.abs(fit.n-0.8)<1e-6);
  assert.ok(Math.abs(shermanIntensity(fit, 90, 10)-800*10**0.22/(90+35)**0.8)<0.001);
  assert.match(formatShermanEquation(fit),/t\+35\.000/);
});

test('derived durations cannot identify an offset even if their synthetic curvature fits one', () => {
  const fit = fitShermanEquation(surface(35,true));
  assert.equal(fit.b,0);
  assert.equal(fit.offsetStatus,'not-identifiable');
  assert.equal(fit.calibrationBasis,'derived-duration');
});

test('derived short durations do not contaminate calibration to native durations', () => {
  const native=surface(35);
  const misleading=[2,5,10,25,50,100].map(T => ({returnPeriodYears:T,durationMinutes:5,intensityMmHr:99999,derived:true}));
  const fit = fitShermanEquation([...native,...misleading]);
  assert.ok(Math.abs(fit.b-35)<0.001);
  assert.equal(fit.sampleSize,native.length);
  assert.equal(fit.minDuration,60);
  assert.equal(shermanIntensity(fit,5,10),null);
});

test('pure power boundary, unidentifiable summaries and evaluation bounds are explicit', () => {
  const fit=fitShermanEquation(surface(0));
  assert.equal(fit.b,0);
  assert.equal(fit.offsetStatus,'zero-boundary');
  assert.equal(shermanIntensity(fit,0,10),null);
  assert.equal(shermanIntensity(fit,1441,10),null);
  assert.equal(shermanIntensity(fit,60,500),null);
  assert.equal(fitShermanEquation(surface(35).filter(row=>row.durationMinutes===1440)),null);
  assert.equal(fitShermanEquation([]),null);
});

test('an offset optimum outside the numerical search range is labelled as a boundary fit', () => {
  const rows = [2,10,100].flatMap(T => [60,120,360,1440].map(t => ({
    returnPeriodYears:T,durationMinutes:t,intensityMmHr:800*T**0.2/(t+5000)**0.8,derived:false,
  })));
  const fit=fitShermanEquation(rows);
  assert.equal(fit.offsetStatus,'upper-boundary');
  assert.ok(Math.abs(fit.b-fit.maxOffset)<0.001);
});
