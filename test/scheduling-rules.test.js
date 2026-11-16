import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findConflicts,minimumCoverage } from '../scheduling.js';
const a={userId:'nurse',breakMinutes:0,breakStartMinutes:0};
const base={id:'s',title:'Care',role:'Nurse',requiredCount:1,startsAt:'2027-01-11T08:00:00Z',endsAt:'2027-01-11T16:00:00Z',assignments:[a]};
const context={zone:'UTC',profiles:[{userId:'nurse',roles:['Nurse'],minRestHours:0,maxWeeklyHours:8}],members:[{user_id:'nurse',name:'Nurse'}],now:0};
test('coverage uses every break boundary, including simultaneous and staggered breaks',()=>{
  const s={...base,assignments:[{...a,breakMinutes:30,breakStartMinutes:120},{...a,userId:'other',breakMinutes:30,breakStartMinutes:150}]};
  assert.equal(minimumCoverage(s),1);
  s.assignments[1].breakStartMinutes=140;assert.equal(minimumCoverage(s),0);
});
test('weekly hours split overnight shifts at local Monday and subtract actual breaks',()=>{
  const sunday={...base,startsAt:'2027-01-10T20:00:00Z',endsAt:'2027-01-11T04:00:00Z'};
  const monday={...base,id:'m',startsAt:'2027-01-11T04:00:00Z',endsAt:'2027-01-11T08:00:00Z'};
  assert.ok(!findConflicts({...context,shifts:[sunday,monday]}).some(i=>i.code==='HOURS'));
  monday.endsAt='2027-01-11T08:01:00Z';
  assert.ok(findConflicts({...context,shifts:[sunday,monday]}).some(i=>i.code==='HOURS'));
  monday.assignments=[{...a,breakMinutes:1,breakStartMinutes:60}];
  assert.ok(!findConflicts({...context,shifts:[sunday,monday]}).some(i=>i.code==='HOURS'));
});
test('weekly limits count elapsed working time through a DST transition',()=>{
  const s={...base,startsAt:'2027-03-14T06:00:00Z',endsAt:'2027-03-14T14:00:00Z'};
  assert.ok(!findConflicts({...context,zone:'America/Chicago',shifts:[s]}).some(i=>i.code==='HOURS'));
});
