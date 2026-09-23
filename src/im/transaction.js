function invalid(message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.code = 'IM_TRANSACTION_INVALID';
  return error;
}

export function withImmediateTransaction(db, fn) {
  if (!db || typeof db.exec !== 'function' || typeof fn !== 'function' ||
      fn.constructor?.name === 'AsyncFunction' || db.isTransaction !== false) {
    throw invalid('An open database and synchronous callback outside a transaction are required');
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
        typeof result.then === 'function') throw invalid('Transaction callbacks must not return a thenable');
    if (db.isTransaction !== true) throw invalid('Transaction callback changed transaction state');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) {
        // Preserve the original error; never include SQL, message bodies or credentials.
        if (error && typeof error === 'object' && error.cause === undefined) {
          error.cause = invalid('Rollback failed', rollbackError);
        }
      }
    }
    throw error;
  }
}
