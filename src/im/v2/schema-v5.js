import { assertImSchemaV5Internal } from './schema-v5-internal.js';

export const IM_V5_SCHEMA_VERSION = 5;
export function assertImSchemaV5(db) { assertImSchemaV5Internal(db); }
