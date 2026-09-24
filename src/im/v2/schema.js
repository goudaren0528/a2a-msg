import { assertImSchemaV4Internal } from './schema-internal.js';
export const IM_V2_SCHEMA_VERSION = 4;
export const SUPPORTED_IM_V2_SCHEMA_VERSIONS = Object.freeze([4]);
export function assertImSchemaV4(db) { return assertImSchemaV4Internal(db); }
