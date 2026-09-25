// Independent amendment oracle: literal field lists, never imported from the writer.
import { createHash } from 'node:crypto';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const fields = Object.freeze({
  copyIntent: ['version','runId','stageHash','candidateReference','candidateBaseHash','sourceSchemaVersion','sourceSchemaChecksum','sourceWriteMode','copyStartedAt'],
  base: ['version','runId','stageHash','candidateReference','copyIntentHash','candidateBaseHash','sourceSchemaVersion','sourceSchemaChecksum','sourceWriteMode','copyStartedAt'],
  normalizationIntent: ['version','runId','stageHash','baseRecordHash','candidateReference','candidateBaseHash','originalHeaderMode','targetHeaderMode','createdAt'],
  normalized: ['version','runId','stageHash','normalizationIntentHash','candidateBaseHash','normalizedCandidateHash','changed','normalizedAt'],
  pauseIntent: ['version','runId','stageHash','candidateBaseHash','normalizedRecordHash','pauseInputHash','originalWriteMode','targetWriteMode','createdAt'],
  paused: ['version','runId','stageHash','pauseIntentHash','candidateBaseHash','pauseInputHash','pausedCandidateHash','changed','pausedAt'],
});
export const filenames = Object.freeze({copyIntent:'copy-intent.json',base:'base.json',normalizationIntent:'normalization-intent.json',normalized:'normalized.json',pauseIntent:'pause-intent.json',paused:'paused.json'});
export function bytes(kind, record) {
  return Buffer.from(JSON.stringify(Object.fromEntries(fields[kind].map(key => [key, record[key]]))));
}
export const recordHash = (kind, record) => sha(bytes(kind, record));
export function rechain(f) {
  f.base.copyIntentHash = recordHash('copyIntent', f.copyIntent);
  f.normalizationIntent.baseRecordHash = recordHash('base', f.base);
  f.normalized.normalizationIntentHash = recordHash('normalizationIntent', f.normalizationIntent);
  if (f.pauseIntent) {
    f.pauseIntent.normalizedRecordHash = recordHash('normalized', f.normalized);
    f.paused.pauseIntentHash = recordHash('pauseIntent', f.pauseIntent);
  }
  return f;
}
export function chainForStage(stage, mode = 'paused', header = 'DELETE') {
  const runId=stage.runId, stageHash=sha(JSON.stringify(stage));
  const candidateBaseHash=stage.sourceEvidence.fileHash ?? stage.sourceEvidence.closedSourceFileHash;
  const copyIntent={version:1,runId,stageHash,candidateReference:stage.candidateReference,candidateBaseHash,
    sourceSchemaVersion:stage.sourceEvidence.schemaVersion,sourceSchemaChecksum:stage.sourceEvidence.schemaChecksum,
    sourceWriteMode:mode,copyStartedAt:stage.createdAt};
  const base={version:2,runId,stageHash,candidateReference:stage.candidateReference,copyIntentHash:recordHash('copyIntent',copyIntent),
    candidateBaseHash,sourceSchemaVersion:copyIntent.sourceSchemaVersion,sourceSchemaChecksum:copyIntent.sourceSchemaChecksum,
    sourceWriteMode:mode,copyStartedAt:copyIntent.copyStartedAt};
  const normalizationIntent={version:1,runId,stageHash,baseRecordHash:recordHash('base',base),
    candidateReference:stage.candidateReference,candidateBaseHash,originalHeaderMode:header,targetHeaderMode:'DELETE',createdAt:stage.createdAt};
  const normalized={version:1,runId,stageHash,normalizationIntentHash:recordHash('normalizationIntent',normalizationIntent),
    candidateBaseHash,normalizedCandidateHash:header==='DELETE'?candidateBaseHash:'e'.repeat(64),changed:header==='WAL',normalizedAt:stage.createdAt};
  const pauseIntent={version:2,runId,stageHash,candidateBaseHash,normalizedRecordHash:recordHash('normalized',normalized),
    pauseInputHash:normalized.normalizedCandidateHash,originalWriteMode:mode,targetWriteMode:'paused',createdAt:stage.createdAt};
  const paused={version:2,runId,stageHash,pauseIntentHash:recordHash('pauseIntent',pauseIntent),candidateBaseHash,
    pauseInputHash:normalized.normalizedCandidateHash,pausedCandidateHash:mode==='paused'?normalized.normalizedCandidateHash:'c'.repeat(64),
    changed:mode==='enabled',pausedAt:stage.createdAt};
  return {stage,copyIntent,base,normalizationIntent,normalized,pauseIntent,paused};
}
