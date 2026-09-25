import { types } from 'node:util';
import { assertImSchemaV4Internal, V4_CHECKSUM } from './schema-internal.js';
import { assertImSchemaV5Internal, V5_CHECKSUM } from './schema-v5-internal.js';

export function assertSupportedImV2Center(db) {
  try {
    const rows=db.prepare('SELECT version FROM im_schema LIMIT 2').all();
    if (rows.length===1 && rows[0].version===4) {
      assertImSchemaV4Internal(db);
      return Object.freeze({schemaVersion:4,schemaChecksum:V4_CHECKSUM});
    }
    if (rows.length===1 && rows[0].version===5) {
      assertImSchemaV5Internal(db);
      return Object.freeze({schemaVersion:5,schemaChecksum:V5_CHECKSUM});
    }
  } catch (error) {
    let budgetExceeded=false;
    try {
      if (error!==null && (typeof error==='object' || typeof error==='function') && !types.isProxy(error)) {
        const descriptor=Object.getOwnPropertyDescriptor(error,'code');
        budgetExceeded=!!descriptor && Object.hasOwn(descriptor,'value') && descriptor.value==='IM_V2_BUDGET_EXCEEDED';
      }
    } catch {}
    if (budgetExceeded) throw Object.assign(new Error('IM_V2_BUDGET_EXCEEDED'),{code:'IM_V2_BUDGET_EXCEEDED'});
  }
  throw Object.assign(new Error('IM_SCHEMA_MISMATCH'),{code:'IM_SCHEMA_MISMATCH'});
}
