// Native fixture construction only: no B stage/preview/prepare/status invocation.
import { setup,header,hashFile } from './helpers.js';
for(const route of ['registered','closed','snapshot'])for(const mode of ['paused','enabled']) {
  const s=await setup({route,mode,wal:route!=='snapshot'});
  try {
    s.unchanged();
    console.log(JSON.stringify({route,mode,header:header(s.artifact),verifiedArtifactHash:hashFile(s.artifact),
      typedRows:s.sourceRows,genuineCommittedWalMessage:s.old?.committedMessage??null,
      assertion:'native fixture only; no recovery acceptance claim'}));
  }finally{await s.cleanup();}
}
