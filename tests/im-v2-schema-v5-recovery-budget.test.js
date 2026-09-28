import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { validationLimits } from '../src/im/v2/backup.js';
import { operationBudget,isRecoveryOperationBudget } from '../src/im/v2/recovery-records.js';
import { assertImSchemaV5Internal } from '../src/im/v2/schema-v5-internal.js';
import { fixture,anchor } from './fixtures/im-v2-schema-v5/helpers.js';
import { insert,observe,snapshot } from './fixtures/im-v2-schema/helpers.js';

const genuine=limits => operationBudget(validationLimits(limits));
const standalone=limits => ({limits,tick(){}});
const mismatch='IM_SCHEMA_MISMATCH', exhausted='IM_V2_BUDGET_EXCEEDED';
function fixed(code) {
  return error => {
    assert.ok(error instanceof Error);
    assert.equal(error.code,code);
    assert.equal(error.message,code);
    assert.deepEqual(Object.getOwnPropertyNames(error).sort(),['code','message','stack']);
    assert.equal('cause' in error,false);
    return true;
  };
}
function noReads(parent,code=mismatch) {
  let reads=0;
  assert.throws(() => assertImSchemaV5Internal({prepare(){reads++;throw Error('private SQL');}},parent),fixed(code));
  assert.equal(reads,0);
}
const trapNames=['apply','construct','defineProperty','deleteProperty','get','getOwnPropertyDescriptor',
  'getPrototypeOf','has','isExtensible','ownKeys','preventExtensions','set','setPrototypeOf'];
function hostile() {
  let calls=0;
  const handler=Object.fromEntries(trapNames.map(key => [key,() => {calls++;throw Error('private trap');}]));
  return {handler,zero(){assert.equal(calls,0);}};
}

test('recovery identity is only exact private membership, with no reflective traps',() => {
  const parent=genuine(),h=hostile();
  assert.equal(isRecoveryOperationBudget(parent),true);
  const revoked=Proxy.revocable(parent,h.handler);revoked.revoke();
  for (const value of [null,undefined,false,0,1n,'x',Symbol(),{},()=>{}, {...parent},
    new Proxy(parent,h.handler),new Proxy(function(){},h.handler),revoked.proxy])
    assert.equal(isRecoveryOperationBudget(value),false);
  h.zero();
});

test('actual recovery budget validates fresh/import/snapshot full v5 without writes or budget mutation',async t => {
  for (const kind of ['fresh_bootstrap','v3_import','snapshot_recovery']) await t.test(kind,t => {
    const {db}=fixture(t,{kind}),parent=genuine({maxFileBytes:7,maxMetadataEntries:1});
    const descriptors=Object.getOwnPropertyDescriptors(parent),limits=parent.limits;
    const before=snapshot(db),changes=db.prepare('SELECT total_changes() AS n').get().n,calls=[];
    parent.file(7);parent.entry();
    assert.equal(assertImSchemaV5Internal(observe(db,call => calls.push(call)),parent),undefined);
    assert.ok(calls.some(call => /SELECT \* FROM im_center_schema_transitions/.test(call.sql)));
    assert.ok(calls.some(call => /SELECT \* FROM im_maintenance_time_anchors/.test(call.sql)));
    assert.equal(calls.filter(call => call.method==='run' || call.method==='exec').length,0);
    assert.deepEqual(snapshot(db),before);
    assert.equal(db.prepare('SELECT total_changes() AS n').get().n,changes);
    assert.equal(db.isTransaction,false);
    assert.equal(db.prepare('SELECT count(*) AS n FROM im_maintenance_time_anchors').get().n,0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM im_maintenance_time_head').get().n,0);
    assert.equal(parent.limits,limits);
    assert.deepEqual(Object.getOwnPropertyDescriptors(parent),descriptors);
    assert.equal(operationBudget(validationLimits(),parent),parent);
    assert.equal(isRecoveryOperationBudget(parent),true);
    parent.file(7);
    assert.throws(() => parent.file(8),{code:'RECOVERY_BUSY'});
    assert.throws(() => parent.entry(),{code:'RECOVERY_BUSY'});
  });
});

test('authentic branch still rejects actual transition, anchor and inherited business corruption',async t => {
  for (const [name,mutate] of [
    ['transition',db => db.prepare('UPDATE im_center_schema_transitions SET approved_plan_hash=?').run('f'.repeat(64))],
    ['anchor',db => {anchor(db);db.prepare('UPDATE im_maintenance_time_anchors SET anchor_hash=?').run('f'.repeat(64));}],
    ['business',db => db.exec('DELETE FROM im_send_operation_keys')],
  ]) await t.test(name,t => {
    const {db}=fixture(t,{business:true});
    assert.equal(assertImSchemaV5Internal(db,genuine()),undefined);
    mutate(db);const before=snapshot(db);
    assert.throws(() => assertImSchemaV5Internal(db,genuine()),fixed(mismatch));
    assert.deepEqual(snapshot(db),before);
  });
});

test('genuine parent elapsed time consumed BEFORE entry rejects before first DB read',t => {
  let now=100,ticks=0;
  t.mock.method(performance,'now',() => {ticks++;return now;});
  const parent=genuine({maxElapsedMs:10});
  parent.tick();now=111;
  const before=ticks;
  noReads(parent,exhausted);
  assert.equal(ticks-before,2,'local baseline then actual original parent tick; no local reset can erase 11ms');
  assert.throws(() => parent.tick(),{code:'RECOVERY_BUSY'});
});

test('genuine parent deadline survives local entry, checked throughout and at last DB result',async t => {
  for (const sql of ['SELECT * FROM im_center_schema_transitions LIMIT 2','SELECT * FROM im_maintenance_time_head LIMIT 2'])
    await t.test(sql,t => {
      const {db}=fixture(t);let now=100,hit=false;
      t.mock.method(performance,'now',() => now);
      const parent=genuine({maxElapsedMs:10});parent.tick();now=109;
      const target=observe(db,call => {if (call.sql===sql) {hit=true;now=111;}});
      assert.throws(() => assertImSchemaV5Internal(target,parent),fixed(exhausted));
      assert.equal(hit,true,'expiry is only 2ms after local entry but 11ms after original start');
    });
});

test('captured original parent tick is called immediately before valid return',t => {
  const {db}=fixture(t);let afterHead=false,tailTicks=0;
  const parent={limits:{},tick(){if (afterHead) tailTicks++;}};
  assert.equal(assertImSchemaV5Internal(observe(db,call => {
    if (call.sql==='SELECT * FROM im_maintenance_time_head LIMIT 2') afterHead=true;
  }),parent),undefined);
  assert.equal(tailTicks,2,'one post-head tick and the final boundary tick');
});

test('authentic common lower caps stop actual rows/content before heavy fetch',async t => {
  for (const limits of [{maxMessages:1},{maxOtherRecords:1},{maxVerifiedContentBytes:1}]) await t.test(JSON.stringify(limits),t => {
    const {db}=fixture(t,{business:true});
    if (limits.maxMessages) {
      const row=db.prepare('SELECT * FROM im_messages LIMIT 1').get();
      insert(db,'im_messages',{...row,message_id:randomUUID(),client_message_id:randomUUID()});
    }
    const before=snapshot(db),calls=[];
    assert.throws(() => assertImSchemaV5Internal(observe(db,call => calls.push(call)),genuine(limits)),fixed(exhausted));
    assert.ok(calls.some(call => /count\(\*\).*im_messages LIMIT \?/.test(call.sql)));
    if (limits.maxVerifiedContentBytes) assert.ok(calls.some(call => /length\(CAST\(text AS BLOB\)\)/.test(call.sql)));
    assert.equal(calls.filter(call => /a\.data|SELECT \* FROM im_center_schema_transitions/.test(call.sql)).length,0);
    assert.deepEqual(snapshot(db),before);
  });
});

test('standalone partial limits, metadata and original captured receiver/tick stay compatible',t => {
  const {db}=fixture(t);let ticks=0;
  const parent={start:123,limits:{maxMessages:1},tick(){assert.equal(this,parent);ticks++;}};
  let changed=false;
  assert.equal(assertImSchemaV5Internal(observe(db,() => {
    if (!changed) {changed=true;parent.tick=() => {throw Error('replacement must not run');};parent.limits={maxMessages:0};}
  }),parent),undefined);
  assert.ok(ticks>20);
  assert.equal(assertImSchemaV5Internal(db),undefined);
  anchor(db);anchor(db);
  for (const limits of [{maxMaintenanceAnchors:1},{maxMaintenanceMetadataBytes:1}])
    assert.throws(() => assertImSchemaV5Internal(db,standalone(limits)),fixed(exhausted));
});

test('forged/copy/recovery-shaped budgets cannot fall back to standalone',() => {
  const parent=genuine();
  for (const value of [{...parent},{limits:parent.limits,tick:parent.tick},
    {...standalone({}),file(){}},{...standalone({}),entry(){}},
    standalone({maxFileBytes:1}),standalone({maxMetadataEntries:1}),
    {limits:{},tick:parent.tick,file:parent.file,entry:parent.entry}]) noReads(value);
});

test('Proxy parent/limits/tick and getters/symbols/nonordinary config reject without traps or getters',() => {
  const h=hostile(),parent=genuine();let getters=0;
  const get=() => {getters++;throw Error('private getter');};
  const revoked=Proxy.revocable({},h.handler);revoked.revoke();
  const shapes=[new Proxy(parent,h.handler),revoked.proxy,new Proxy(function(){},h.handler),
    standalone(new Proxy({},h.handler)),{limits:{},tick:new Proxy(function(){},h.handler)},
    Object.defineProperty({limits:{}},'tick',{get,enumerable:true}),
    Object.defineProperty({tick(){}},'limits',{get,enumerable:true}),
    standalone(Object.defineProperty({},'maxMessages',{get,enumerable:true})),
    {...standalone({}),[Symbol('extra')]:1},standalone({[Symbol('extra')]:1}),
    Object.defineProperty(standalone({}),'start',{get,enumerable:true}),
    standalone(Object.defineProperty({},'maxMessages',{value:1})),
    standalone([]),standalone(Object.create(null)),Object.create(standalone({})),
    {limits:{},async tick(){getters++;}}, {limits:{},*tick(){getters++;}}];
  for (const value of shapes) noReads(value);
  h.zero();assert.equal(getters,0);
});

test('exact authenticated six-limit schema and standalone lower-only ceilings',() => {
  const defaults=validationLimits();
  for (const [key,ceiling] of Object.entries(defaults)) {
    for (const value of [0,-1,1.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1,ceiling+1,'1',null])
      noReads(operationBudget({...defaults,[key]:value}));
    const missing={...defaults};delete missing[key];noReads(operationBudget(missing));
  }
  for (const extra of [{unknown:1},{maxMaintenanceAnchors:1},{[Symbol('unknown')]:1}])
    noReads(operationBudget({...defaults,...extra}));
  for (const limits of [{unknown:1},{maxMessages:10001},{maxVerifiedContentBytes:104857601},
    {maxOtherRecords:10001},{maxElapsedMs:10001},{maxMaintenanceAnchors:10001},{maxMaintenanceMetadataBytes:10485761}])
    noReads(standalone(limits));
});

test('only authenticated tick invocation translates RECOVERY_BUSY; DB brand is not authority',t => {
  const h=hostile();let getters=0;
  const foreign=[{code:'RECOVERY_BUSY',message:'private SQL',cause:'private'},new Proxy({},h.handler),
    Object.defineProperty({},'code',{get(){getters++;throw Error('private');}}),null,undefined];
  for (const thrown of foreign) {
    noReads({limits:{},tick(){throw thrown;}});
    let reads=0;
    assert.throws(() => assertImSchemaV5Internal({prepare(){reads++;throw thrown;}},genuine()),fixed(mismatch));
    assert.equal(reads,1);
  }
  h.zero();assert.equal(getters,0);
  noReads({limits:{},tick(){throw {code:'IM_V2_BUDGET_EXCEEDED',message:'private',cause:'private'};}},exhausted);
  const {db}=fixture(t,{business:true});
  assert.throws(() => assertImSchemaV5Internal(db,standalone({maxVerifiedContentBytes:1})),fixed(exhausted));
});

test('unexpected genuine tick failures are sanitized without changing frozen budget or private membership',t => {
  const parent=genuine(),h=hostile();let getters=0,calls=0;
  const foreign=Object.defineProperty({},'code',{get(){getters++;throw Error('private');}});
  let thrown=foreign;
  t.mock.method(performance,'now',() => {if (++calls===2) throw thrown;return 100;});
  for (const value of [foreign,new Proxy({},h.handler),{code:'IM_V2_BUDGET_EXCEEDED'},new Error('private SQL'),null]) {
    thrown=value;calls=0;noReads(parent);assert.equal(calls,2,'failure is inside original tick after local start');
  }
  assert.equal(Object.isFrozen(parent),true);assert.equal(isRecoveryOperationBudget(parent),true);
  h.zero();assert.equal(getters,0);
});

test('synchronous tick refuses returned Proxies, accessor thenables, and observes rejected native promises',async t => {
  const h=hostile();let getters=0;
  for (const value of [new Proxy({},h.handler),new Proxy(function(){},h.handler),
    Object.defineProperty({},'then',{get(){getters++;throw Error('private then');}}),
    {then(){getters++;}},Promise.reject(Error('private rejection'))])
    noReads({limits:{},tick(){return value;}});
  await new Promise(resolve => setImmediate(resolve));
  h.zero();assert.equal(getters,0);
});
