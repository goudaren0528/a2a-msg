import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createImV2RecoveryServices, createClosedV3Source } from '../../../src/im/v2/recovery.js';
import { createTrustedImV2BackupServices } from '../../../src/im/v2/backup-registry.js';
import { fixture, context } from '../im-v2-backup/helpers.js';
import { legacyPublished } from '../im-v2-backup/legacy-published.js';
import { policy } from '../im-v2-schema/helpers.js';
import { filenames, bytes, sha } from './records.js';

export { context };
export const request=(kind='v3_import')=>({requestRef:'normalization-request',candidateKind:kind,sourceRef:'source',isolationAckRef:'isolated'});
export const hashFile=p=>sha(fs.readFileSync(p));
export const header=p=>[...fs.readFileSync(p).subarray(18,20)];
export const json=p=>JSON.parse(fs.readFileSync(p));
export function tree(root) {
  return Object.fromEntries(fs.readdirSync(root,{recursive:true}).sort().map(name=>{
    const p=join(root,name),s=fs.lstatSync(p);
    return [name,s.isDirectory()?['dir',s.mode]:[hashFile(p),s.size,s.mtimeMs,s.nlink,s.mode]];
  }));
}
export function query(path,callback,{immutable=false}={}) {
  // Immutable only for a proven standalone native backup, never a live WAL DB.
  if(immutable)for(const suffix of ['-wal','-shm','-journal'])assert.equal(fs.existsSync(path+suffix),false);
  const uri=pathToFileURL(path);uri.searchParams.set('mode','ro');uri.searchParams.set('immutable','1');
  const db=new DatabaseSync(immutable?uri:path,{readOnly:true});
  try{return callback(db);}finally{db.close();}
}
const q=name=>'"'+name.replaceAll('"','""')+'"';
// Streaming, deterministic, SQL-type-aware digest of EVERY schema and table row.
// SQLite typeof disambiguates integer/real, null/text and blob/text. No count-only oracle.
export function rowsDigest(db,{exclude=[]}={}) {
  const h=createHash('sha256'),tables=[];
  for(const row of db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").iterate()) {
    if(exclude.includes(row.name))continue;
    h.update(JSON.stringify(['schema',Object.values(row)])+'\n');
    if(row.type==='table')tables.push(row.name);
  }
  const rows={};
  for(const table of tables.sort()) {
    const cols=db.prepare(`PRAGMA table_info(${q(table)})`).all().map(r=>r.name);
    const statement=db.prepare(`SELECT ${cols.map((c,i)=>`${q(c)} AS v${i},typeof(${q(c)}) AS t${i}`).join(',')} FROM ${q(table)} ORDER BY ${cols.map(q).join(',')}`);
    statement.setReadBigInts(true);let count=0;
    for(const row of statement.iterate()) {
      const values=cols.map((_,i)=>{const value=row[`v${i}`],type=row[`t${i}`];return [type,value instanceof Uint8Array?Buffer.from(value).toString('hex'):typeof value==='bigint'?value.toString():value];});
      h.update(JSON.stringify([table,values])+'\n');count++;
    }
    rows[table]=count;
  }
  return {hash:h.digest('hex'),rows};
}
export function records(dir) {
  const out={stage:json(join(dir,'stage.json'))};
  for(const [kind,file]of Object.entries(filenames))if(fs.existsSync(join(dir,file))) {
    out[kind]=json(join(dir,file));assert.deepEqual(fs.readFileSync(join(dir,file)),bytes(kind,out[kind]),`${kind} literal ordered bytes`);
  }
  return out;
}
export function assertChain(dir,{paused=true}={}) {
  const f=records(dir),baseHash=f.stage.sourceEvidence.fileHash??f.stage.sourceEvidence.closedSourceFileHash;
  assert.equal(f.copyIntent.version,1);assert.equal(f.base.version,2);
  for(const kind of ['copyIntent','base','normalizationIntent','normalized',...(paused?['pauseIntent','paused']:[])]) {
    assert.equal(f[kind].runId,f.stage.runId);assert.equal(f[kind].stageHash,sha(fs.readFileSync(join(dir,'stage.json'))));
    assert.equal(f[kind].candidateBaseHash,baseHash);
  }
  for(const [child,key,parent]of [['base','copyIntentHash','copyIntent'],['normalizationIntent','baseRecordHash','base'],
    ['normalized','normalizationIntentHash','normalizationIntent'],...(paused?[['pauseIntent','normalizedRecordHash','normalized'],['paused','pauseIntentHash','pauseIntent']]:[])])
    assert.equal(f[child][key],hashFile(join(dir,filenames[parent])));
  assert.equal(f.base.copyStartedAt,f.copyIntent.copyStartedAt);
  assert.ok(f.stage.createdAt<=f.copyIntent.copyStartedAt&&f.copyIntent.copyStartedAt<=f.normalizationIntent.createdAt&&f.normalizationIntent.createdAt<=f.normalized.normalizedAt);
  if(paused) {
    assert.equal(f.pauseIntent.version,2);assert.equal(f.paused.version,2);
    assert.equal(f.pauseIntent.pauseInputHash,f.normalized.normalizedCandidateHash);
    assert.equal(f.paused.pauseInputHash,f.normalized.normalizedCandidateHash);
    assert.ok(f.normalized.normalizedAt<=f.pauseIntent.createdAt&&f.pauseIntent.createdAt<=f.paused.pausedAt);
    if(f.base.sourceWriteMode==='paused'){assert.equal(f.paused.changed,false);assert.equal(f.paused.pausedCandidateHash,f.normalized.normalizedCandidateHash);}
    else assert.equal(f.paused.changed,true);
  }
  return f;
}
export function openOptions(root,source,now) {
  // Clearly synthetic trusted fixture: tests do not claim real operational closure approval.
  const evidenceAuthority={assertSourceIsolation:()=>true,getSourceClosedEvidence:binding=>({version:1,evidenceRef:'synthetic-closure',...binding,issuedAt:now}),authorizeSourceClosedEvidence:()=>true};
  return {root,sourceCatalog:{source:{kind:'closed-v3',source:createClosedV3Source({path:source,sourceRef:'source',evidenceAuthority})}},
    policy:policy(),authority:{authorizeAdmin:ctx=>ctx===context},evidenceAuthority,
    approvalAuthority:{authorizeApproval:(input,ctx)=>ctx===context&&input.kind==='prepare'&&input.approvalRef==='prepare-ok'},clock:()=>now};
}
export async function setup({route='closed',wal=true,mode='paused'}={}) {
  const cleanups=[],lifecycle={after:fn=>cleanups.push(fn)},f=fixture(lifecycle,{v3:route!=='snapshot'});
  let old,services,record,artifact,source,sourceDb;
  if(mode==='enabled')f.db.exec("UPDATE im_settings SET write_mode='enabled'");
  if(route==='registered') {
    old=await legacyPublished(lifecycle,f,{wal});
    source=old.source;sourceDb=old.db;
    assert.deepEqual(header(old.artifact),wal?[2,2]:[1,1]);
    services=createTrustedImV2BackupServices(f.options);
    ({record}=services.publisher.importRegisteredV3({sourceRegistry:old.old.registry,backupId:old.output.backupId},context));
    artifact=join(f.registryRoot,record.artifactReference);
    assert.deepEqual(header(artifact),wal?[2,2]:[1,1]);
    assert.equal(hashFile(artifact),record.fileHash);
    services.registry.withVerifiedBackup({backupId:record.backupId},context,proof=>assert.equal(proof.record.fileHash,hashFile(artifact)));
  } else if(route==='snapshot') {
    sourceDb=f.db;services=createTrustedImV2BackupServices(f.options);
    ({record}=await services.publisher.publish({approvalRef:'test-approved'},context));await services.publisher.drain();
    artifact=join(f.registryRoot,record.artifactReference);source=artifact;
    assert.deepEqual(header(artifact),[1,1]);
  } else {
    sourceDb=f.db;
    if(wal) {
      const seed=join(f.root,'live.sqlite');await backup(f.db,seed);fs.chmodSync(seed,0o600);
      sourceDb=new DatabaseSync(seed);cleanups.push(()=>sourceDb.close());
      sourceDb.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN IMMEDIATE');
      sourceDb.exec("UPDATE im_agents SET display_name=display_name || ' WAL committed'");sourceDb.exec('COMMIT');
      assert.ok(fs.statSync(seed+'-wal').size>32);
    }
    source=join(f.root,'closed.sqlite');await backup(sourceDb,source);fs.chmodSync(source,0o600);artifact=source;
    assert.deepEqual(header(source),wal?[2,2]:[1,1]);
  }
  const root=join(f.root,'workspace');fs.mkdirSync(root,{mode:0o700});
  const now=Date.now(),options=openOptions(root,artifact,now);
  if(services)options.sourceCatalog={source:{kind:'registered-backup',registry:services.registry,backupId:record.backupId}};
  const unchangedFiles=[artifact];
  if(old)unchangedFiles.push(old.source,old.source+'-wal',old.source+'-shm',old.artifact,...fs.readdirSync(dirname(old.artifact)).filter(n=>n.endsWith('.json')).map(n=>join(dirname(old.artifact),n)));
  if(services)unchangedFiles.push(join(f.registryRoot,'registry/artifacts',`${record.backupId}.manifest.json`));
  const sourceRows=rowsDigest(sourceDb);
  assert.deepEqual(query(artifact,db=>rowsDigest(db),{immutable:true}),sourceRows,
    'actual standalone backup includes every committed source row before B');
  if(old?.committedMessage)assert.equal(query(artifact,db=>db.prepare('SELECT message_id FROM im_messages WHERE message_id=?').get(old.committedMessage),{immutable:true}).message_id,
    old.committedMessage,'genuine old publisher retained the committed WAL message');
  const original=Object.fromEntries([...new Set(unchangedFiles)].map(p=>[p,hashFile(p)]));
  return {...f,root,old,services,record,artifact,source,sourceDb,options,now,sourceRows,
    open:()=>createImV2RecoveryServices(options),input:request(route==='snapshot'?'snapshot_recovery':'v3_import'),
    unchanged(){for(const [p,h]of Object.entries(original))assert.equal(hashFile(p),h,p);assert.deepEqual(rowsDigest(sourceDb),sourceRows);},
    async cleanup(){for(const fn of cleanups.reverse())await fn();},
  };
}
