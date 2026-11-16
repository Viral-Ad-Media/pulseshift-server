import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './helpers.js';
import { migrate } from '../scripts/migrate.js';
import { createDatabase } from '../database.js';
import { createApp } from '../app.js';
let pool,server,base,db;
async function api(path,{method='GET',body,user='admin'}={}) {
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Authorization:`Bearer ${user}`},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,body:await response.json()};
}
async function rpc(name,args) {const result=await db.rpc(name,args);if(result.error)throw result.error;return result.data;}
const get=async(org='org',user='admin')=>(await api(`/orgs/${org}/schedule`,{user})).body;
async function mutate(action,fields={},org='org',user='admin') {
  const data=await get(org,user);
  return api(`/orgs/${org}/schedule`,{method:'POST',user,body:{action,revision:data.revision,operationId:randomUUID(),...fields}});
}
const shift=(overrides={})=>({title:'Morning care',department:'Ward A',location:'Main clinic',role:'Nurse',requiredCount:1,
  localStart:'2027-01-11T08:00',localEnd:'2027-01-11T16:00',requiresAcknowledgement:true,
  assignments:[{userId:'nurse',breakMinutes:0,breakStartMinutes:0}],...overrides});
const profile={userId:'nurse',roles:['Nurse'],minRestHours:0,maxWeeklyHours:0};
before(async()=>{
  ({pool}=await testDatabase({scheduling:false}));
  await migrate(pool);db=createDatabase(pool);
  for(const [id,org] of [['admin','org'],['outsider','other']]) await rpc('pulse_signup',{
    p_user_id:id,p_org_id:org,p_email:id+'@example.com',p_password_hash:'unused',p_name:id,
    p_org_name:org,p_timezone:'America/Chicago',p_industry:'Healthcare'});
  for(const id of ['nurse','coworker']) {
    await pool.query('insert into users(id,email,name) values($1,$2,$1)',[id,id+'@example.com']);
    await pool.query("insert into memberships(user_id,org_id,role) values($1,'org','NURSE')",[id]);
  }
  // Identity is injected here to isolate application scheduling authorization; http.test.js
  // separately exercises the real Better Auth handler and session revocation.
  const authentication={options:{baseURL:'http://localhost:4000'},api:{async getSession({headers}){
    const id=headers.get('authorization')?.replace('Bearer ','');
    if(!['admin','nurse','coworker','outsider'].includes(id))return null;
    return {user:{id,name:id,email:id+'@example.com'},session:{id}};
  }}};
  server=createApp({db,authentication,logger:{error(...args){console.error(...args);}},authMax:100}).listen(0,'127.0.0.1');
  await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;
});
after(async()=>{await new Promise(resolve=>server?.close(resolve));await pool?.end();});
test('drafts are admin-only, revision checked, idempotent, and cannot be edited by other tenants',async()=>{
  assert.equal((await api('/orgs/org/schedule',{user:'outsider'})).status,403);
  assert.equal((await mutate('SAVE_SHIFT',{shift:shift()},'org','nurse')).status,403);
  const revision=(await get()).revision;
  const body={action:'SAVE_SHIFT',shift:shift(),revision,operationId:randomUUID()};
  const saved=await api('/orgs/org/schedule',{method:'POST',body});assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal((await api('/orgs/org/schedule',{method:'POST',body})).body.replayed,true);
  assert.equal((await get()).shifts.length,1);
  assert.equal((await api('/orgs/org/schedule',{method:'POST',body:{...body,operationId:randomUUID()}})).status,409);
  assert.equal((await get('org','nurse')).shifts.length,0);
  assert.equal((await get('org','nurse')).published.length,0);
  assert.ok((await get()).issues.some(i=>i.code==='ELIGIBILITY'));
  assert.equal((await mutate('PUBLISH')).status,409);
  assert.equal((await mutate('SAVE_PROFILE',{profile})).status,200);
});
test('publication delivers assignment notifications and acknowledgements are publication-specific',async()=>{
  assert.equal((await mutate('PUBLISH')).status,200);
  const data=await get('org','nurse');assert.equal(data.published.length,1);assert.equal(data.shifts.length,0);assert.equal(data.templates.length,0);
  const s=data.published[0];
  const inbox=await api('/orgs/org/notifications',{user:'nurse'});assert.equal(inbox.body.unread,1);
  assert.match(inbox.body.notifications[0].message,/New assignment/);
  assert.equal((await api(`/orgs/org/schedule/${s.id}/acknowledge`,{method:'POST',user:'coworker',body:{publicationVersion:s.publicationVersion}})).status,404);
  assert.equal((await api(`/orgs/org/schedule/${s.id}/acknowledge`,{method:'POST',user:'nurse',body:{publicationVersion:s.publicationVersion+1}})).status,409);
  assert.equal((await api(`/orgs/org/schedule/${s.id}/acknowledge`,{method:'POST',user:'nurse',body:{publicationVersion:s.publicationVersion}})).status,200);
  assert.equal((await get()).acknowledgements.length,1);
  assert.equal((await mutate('PUBLISH')).status,200);
  assert.equal((await get()).published[0].publicationVersion,s.publicationVersion,'unchanged schedules preserve acknowledgements');
  await api('/orgs/org/notifications/read',{method:'PUT',user:'coworker',body:{id:inbox.body.notifications[0].id}});
  assert.equal((await api('/orgs/org/notifications',{user:'nurse'})).body.unread,1,'another user cannot mark an inbox item read');
  await api('/orgs/org/notifications/read',{method:'PUT',user:'nurse',body:{}});
  assert.equal((await api('/orgs/org/notifications',{user:'nurse'})).body.unread,0);
});
test('draft edits leave published assignments intact, and republishing invalidates old acknowledgements',async()=>{
  const old=(await get()).shifts[0];
  assert.equal((await mutate('SAVE_SHIFT',{shiftId:old.id,shift:{...old,title:'Updated care'}})).status,200);
  assert.equal((await get('org','nurse')).published[0].title,'Morning care');
  assert.equal((await mutate('PUBLISH')).status,200);
  const next=(await get('org','nurse')).published[0];assert.equal(next.title,'Updated care');
  assert.ok(!(await get()).acknowledgements.some(a=>a.publicationVersion===next.publicationVersion));
});
test('overlaps block publication while touching shifts are allowed when no rest limit is configured',async()=>{
  assert.equal((await mutate('SAVE_SHIFT',{shift:shift({localStart:'2027-01-11T15:00',localEnd:'2027-01-11T20:00'})})).status,200);
  assert.ok((await get()).issues.some(i=>i.code==='OVERLAP'));
  assert.equal((await mutate('PUBLISH')).status,409);
  const later=(await get()).shifts.find(s=>s.localStart.endsWith('15:00'));
  await mutate('SAVE_SHIFT',{shiftId:later.id,shift:{...later,localStart:'2027-01-11T16:00'}});
  assert.ok(!(await get()).issues.some(i=>i.code==='OVERLAP'));
  await mutate('DISCARD');
});
test('rest and actual weekly working hours are enforced before publication',async()=>{
  await mutate('SAVE_PROFILE',{profile:{...profile,minRestHours:11,maxWeeklyHours:10}});
  await mutate('SAVE_SHIFT',{shift:shift({localStart:'2027-01-12T00:00',localEnd:'2027-01-12T08:00'})});
  const issues=(await get()).issues;assert.ok(issues.some(i=>i.code==='REST'));assert.ok(issues.some(i=>i.code==='HOURS'));
  assert.equal((await mutate('PUBLISH')).status,409);
  await mutate('DISCARD');await mutate('SAVE_PROFILE',{profile});
});
test('break intervals reveal coverage gaps that require an explicit publishing decision',async()=>{
  const s=(await get()).shifts[0];
  await mutate('SAVE_SHIFT',{shiftId:s.id,shift:{...s,assignments:[{userId:'nurse',breakStartMinutes:240,breakMinutes:30}]}});
  assert.ok((await get()).issues.some(i=>i.code==='COVERAGE'&&/including breaks/.test(i.message)));
  assert.equal((await mutate('PUBLISH')).status,409);
  assert.equal((await mutate('PUBLISH',{allowGaps:true})).status,200);
});
test('leave approval cannot invalidate published assignments; cancellation is retained in private request history',async()=>{
  const created=await api('/orgs/org/requests',{method:'POST',user:'nurse',body:{date:'2027-01-11',type:'SICK',notes:'Private reason'}});
  assert.equal(created.status,201,JSON.stringify(created.body));
  const r=created.body.request;
  const decision=await api(`/orgs/org/requests/${r.id}`,{method:'PUT',body:{status:'APPROVED',version:r.version}});
  assert.equal(decision.status,409);assert.match(decision.body.error,/published assignment/);
  await assert.rejects(rpc('pulse_update_request',{p_org_id:'org',p_id:r.id,p_user_id:'admin',p_version:r.version,p_status:'APPROVED'}),/published assignment/);
  await api(`/orgs/org/requests/${r.id}`,{method:'DELETE',user:'nurse',body:{version:r.version}});
  const history=await api('/orgs/org/request-history',{user:'nurse'});
  assert.equal(history.body.requests[0].status,'CANCELLED');assert.equal(history.body.events.length,2);
  assert.equal((await api('/orgs/org/request-history',{user:'coworker'})).body.requests.length,0);
  assert.ok((await api('/orgs/org/notifications',{user:'nurse'})).body.notifications.some(n=>/cancelled/.test(n.message)));
});
test('approved leave blocks new assignments, including overnight overlap on the following date',async()=>{
  const created=await api('/orgs/org/requests',{method:'POST',user:'nurse',body:{date:'2027-01-13',type:'PTO'}});
  const r=created.body.request;
  assert.equal((await api(`/orgs/org/requests/${r.id}`,{method:'PUT',body:{version:r.version,status:'APPROVED'}})).status,200);
  await mutate('SAVE_SHIFT',{shift:shift({localStart:'2027-01-12T20:00',localEnd:'2027-01-13T04:00'})});
  assert.ok((await get()).issues.some(i=>i.code==='LEAVE'));
  assert.equal((await mutate('PUBLISH')).status,409);
  await mutate('DISCARD');
});
test('shared staff cannot be double-booked across workspaces and other workspace details stay private',async()=>{
  await pool.query("insert into memberships(user_id,org_id,role) values('nurse','other','NURSE')");
  await mutate('SAVE_PROFILE',{profile},'other','outsider');
  await mutate('SAVE_SHIFT',{shift:shift({title:'Private other location'})},'other','outsider');
  const preview=await get('other','outsider');
  assert.ok(preview.issues.some(i=>i.code==='OVERLAP'&&/another workspace/.test(i.message)));
  assert.equal((await mutate('PUBLISH',{},'other','outsider')).status,409);
  assert.ok(!JSON.stringify(await get()).includes('Private other location'));
  await mutate('DISCARD',{},'other','outsider');
});
test('another workspace cannot bypass an existing workspace rest limit',async()=>{
  assert.equal((await mutate('SAVE_PROFILE',{profile:{...profile,minRestHours:11}})).status,200);
  assert.equal((await mutate('SAVE_SHIFT',{shift:shift({localStart:'2027-01-11T20:00',localEnd:'2027-01-11T22:00'})},'other','outsider')).status,200);
  assert.ok((await get('other','outsider')).issues.some(i=>i.code==='OTHER_WORKSPACE'));
  assert.equal((await mutate('PUBLISH',{},'other','outsider')).status,409);
  await mutate('DISCARD',{},'other','outsider');
  await mutate('SAVE_PROFILE',{profile});
});
test('staff cannot be removed while upcoming published assignments remain',async()=>{
  const result=await api('/orgs/org/members/nurse',{method:'DELETE',body:{}});
  assert.equal(result.status,409);assert.match(result.body.error,/Unassign/);
  assert.equal((await get('org','nurse')).published.length,1);
});
test('templates repeat local times into drafts, with fresh IDs and conflicts rechecked',async()=>{
  assert.equal((await mutate('SAVE_TEMPLATE',{name:'Ward week',startDate:'2027-01-11',includeAssignments:true})).status,200);
  const template=(await get()).templates[0];assert.equal(template.entries.length,1);
  const body={action:'APPLY_TEMPLATE',templateId:template.id,startDate:'2027-01-18',weeks:2,revision:(await get()).revision,operationId:randomUUID()};
  const first=await api('/orgs/org/schedule',{method:'POST',body});assert.equal(first.status,200,JSON.stringify(first.body));
  await api('/orgs/org/schedule',{method:'POST',body});
  const state=await get();assert.equal(state.shifts.length,3);assert.equal(new Set(state.shifts.map(s=>s.id)).size,3);
  assert.ok(state.shifts.some(s=>s.localStart==='2027-01-25T08:00'));
  assert.equal(state.published.length,1);
  await mutate('DISCARD');
});
test('invalid dates, durations, breaks and DST gap/fold times are rejected without changing the draft',async()=>{
  for(const patch of [
    {localStart:'2027-02-30T08:00'},
    {localEnd:'2027-01-11T08:00'},
    {localEnd:'2027-01-13T08:00'},
    {assignments:[{userId:'nurse',breakMinutes:500,breakStartMinutes:0}]},
    {localStart:'2027-03-14T02:30',localEnd:'2027-03-14T08:00'},
    {localStart:'2027-11-07T01:30',localEnd:'2027-11-07T08:00'},
  ]) assert.equal((await mutate('SAVE_SHIFT',{shift:shift(patch)})).status,400,JSON.stringify(patch));
  assert.equal((await get()).shifts.length,1);
});
test('scheduled reminders are persistent and deduplicated, without implying acknowledgement',async()=>{
  const start=new Date(Date.now()+3600000),end=new Date(Date.now()+7200000);
  const fmt=d=>{const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/Chicago',dateStyle:'short',timeStyle:'short'}).format(d);return parts.replace(' ','T');};
  assert.equal((await mutate('SAVE_SHIFT',{shift:shift({title:'Soon',localStart:fmt(start),localEnd:fmt(end)})})).status,200);
  assert.equal((await mutate('PUBLISH',{allowGaps:true})).status,200);
  await api('/orgs/org/notifications',{user:'nurse'});const inbox=(await api('/orgs/org/notifications',{user:'nurse'})).body;
  assert.equal(inbox.notifications.filter(n=>n.kind==='REMINDER').length,1);
});
