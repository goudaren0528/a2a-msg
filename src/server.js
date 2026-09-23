import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { CONFIG } from './config.js';
import { initDb, syncMembers, insertMessage, getMessageById, getAttachmentById, queryMessages, markMessagesRead, getUnreadSummary, getUnreadMetadata } from './db.js';
import { loadAccessConfig } from './access.js';
import { createUnreadEvents } from './unread-events.js';
import { createImHandler } from './im/http.js';
import { sendMessageSchema, getMsgQuerySchema, readMessageQuerySchema, markReadSchema, attachmentTextQuerySchema } from './validation.js';

function sendJson(res, statusCode, data) {
  const json = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function parseJsonBody(req, maxBytes = CONFIG.maxBodyBytes) {
  return new Promise((resolve, reject) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    if (contentLength > maxBytes) {
      const err = new Error(`Payload too large. Maximum size is ${maxBytes} bytes.`);
      err.statusCode = 413;
      return reject(err);
    }

    let received = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        const err = new Error(`Payload too large. Maximum size is ${maxBytes} bytes.`);
        err.statusCode = 413;
        req.destroy();
        return reject(err);
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) {
        return resolve({});
      }
      try {
        const buffer = Buffer.concat(chunks);
        req.receivedBodyBytes = buffer.length;
        resolve(JSON.parse(buffer.toString('utf8')));
      } catch {
        const err = new Error('Invalid JSON payload');
        err.statusCode = 400;
        reject(err);
      }
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

// Decodes and fully verifies an attachment payload. Returns { error } instead of
// throwing so the caller can pick 400 (bad input) vs 413 (too large).
function decodeAttachment(attachment) {
  const data = Buffer.from(attachment.data_base64, 'base64');
  // Buffer.from is lenient; a round-trip catches truncated or non-canonical input
  // that the character-class check alone would accept.
  if (data.toString('base64') !== attachment.data_base64) {
    return { error: { status: 400, message: 'attachment.data_base64 is not valid base64' } };
  }
  if (data.length === 0) {
    return { error: { status: 400, message: 'Attachment is empty (0 bytes)' } };
  }
  if (data.length > CONFIG.maxAttachmentBytes) {
    return {
      error: {
        status: 413,
        message: `Attachment is ${data.length} bytes, exceeding the ${CONFIG.maxAttachmentBytes} byte limit`,
      },
    };
  }
  // Integrity is re-derived server-side; the client-supplied digest is only a claim.
  const sha256 = crypto.createHash('sha256').update(data).digest('hex');
  if (sha256 !== attachment.sha256) {
    return { error: { status: 400, message: 'Attachment SHA-256 mismatch; please resend' } };
  }
  return { value: { name: attachment.name, mime: attachment.mime ?? null, sha256, data } };
}

// Preview eligibility is a usability guard, not a security boundary: MIME and
// extension are both sender-controlled, so previewing only ever returns bytes
// the recipient is already entitled to download.
function isPreviewableText(row) {
  if (row.size > CONFIG.maxAttachmentPreviewBytes) return false;
  const lowerName = row.name.toLowerCase();
  if (CONFIG.textAttachmentExtensions.some((ext) => lowerName.endsWith(ext))) return true;
  return typeof row.mime === 'string' && row.mime.toLowerCase().startsWith('text/');
}

export function createServer(options = {}) {
  const disabledImHandler = createImHandler();
  // Validate before opening/creating any database. Identity always comes from the socket.
  const access = loadAccessConfig(options.accessConfigPath || process.env.MSG_ACCESS_CONFIG || CONFIG.accessConfig);
  const dbPath = options.dbPath || process.env.MSG_DB_PATH || CONFIG.dbPath;
  const db = options.db || initDb(dbPath);
  try { syncMembers(db, access.members); } catch (err) { db.close(); throw err; }
  const unreadEvents = createUnreadEvents(access.members, to => getUnreadSummary(db, { to }));
  // Notification transport is best effort; a committed write must keep its HTTP result.
  const notifyUnread = (to, reason) => {
    try { unreadEvents.publish(to, reason); } catch { /* subscribers were closed on failure */ }
  };

  const server = http.createServer(async (req, res) => {
    try {
      if (typeof req.url === 'string' && /^\/api\/v1(?:\/[^?]*)?(?:\?|$)/.test(req.url)) {
        if (options.imHandler && await options.imHandler.handle(req, res)) return;
        // The versioned namespace never reaches IP identity or legacy routing,
        // even if an injected handler unexpectedly declines this request.
        await disabledImHandler.handle(req, res);
        return;
      }
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;
      const method = req.method.toUpperCase();

      const member = access.identify(req.socket.remoteAddress);
      if (!member) return sendJson(res, 403, { error: 'Forbidden: source IP is not allowed and mapped' });
      req.member = member;

      if (method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, {
          service: 'team-mailbox',
          status: 'ok',
          time: new Date().toISOString(),
          member,
        });
      }

      if (!pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: 'Not Found' });
      }

      // GET /api/peers
      if (method === 'GET' && pathname === '/api/peers') {
        const peers = access.peers;
        return sendJson(res, 200, peers);
      }

      // POST /api/messages
      if (method === 'POST' && pathname === '/api/messages') {
        // Only this endpoint accepts attachments, so only it reads up to 16 MiB.
        // A body without an attachment still has to fit the ordinary 64 KiB
        // budget, which is enforced after parsing (see below).
        const body = await parseJsonBody(req, CONFIG.maxAttachmentBodyBytes);
        const parsed = sendMessageSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: 'Validation failed',
            details: parsed.error.issues.map((i) => i.message),
          });
        }

        const msgData = parsed.data;

        if (!msgData.attachment && req.receivedBodyBytes > CONFIG.maxBodyBytes) {
          return sendJson(res, 413, {
            error: `Payload too large. Maximum size is ${CONFIG.maxBodyBytes} bytes.`,
          });
        }

        let attachmentRecord = null;
        if (msgData.attachment) {
          const decoded = decodeAttachment(msgData.attachment);
          if (decoded.error) {
            return sendJson(res, decoded.error.status, { error: decoded.error.message });
          }
          attachmentRecord = decoded.value;
        }

        // Check if recipient exists and is active
        if (!access.hasMember(msgData.to)) {
          return sendJson(res, 404, { error: `Recipient "${msgData.to}" is not in current access configuration` });
        }

        const deviceName = (req.headers['x-device-name'] || '').toString().slice(0, CONFIG.maxDeviceNameChars) || null;

        const inserted = insertMessage(db, {
          from: req.member.name,
          to: msgData.to,
          title: msgData.title,
          // messages.text stays NOT NULL; file-only messages store an empty string
          // so the existing table never has to be rebuilt.
          text: msgData.text ?? '',
          project: msgData.project,
          deviceName,
          attachment: attachmentRecord,
        });
        notifyUnread(msgData.to, 'message');

        return sendJson(res, 201, {
          id: inserted.id,
          createdAt: inserted.createdAt,
          ...(inserted.attachment ? { attachment: inserted.attachment } : {}),
        });
      }

      // GET /api/messages (query/getmsg)
      if (method === 'GET' && pathname === '/api/messages') {
        const queryParams = Object.fromEntries(parsedUrl.searchParams.entries());
        const parsed = getMsgQuerySchema.safeParse(queryParams);
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: 'Query parameter validation failed',
            details: parsed.error.issues.map((i) => i.message),
          });
        }

        const { from, unread_only, project, cursor, limit } = parsed.data;

        const result = queryMessages(db, {
          to: req.member.name,
          from,
          unreadOnly: unread_only,
          project,
          cursor,
          limit,
        });

        return sendJson(res, 200, result);
      }

      // GET /api/unread-summary — counts only, scoped to the caller's own inbox.
      // Takes no parameters: a sidebar polls it, and anything selectable would be
      // another way to ask about someone else's mail.
      if (method === 'GET' && pathname === '/api/unread-summary') {
        return sendJson(res, 200, getUnreadSummary(db, { to: req.member.name }));
      }

      if (method === 'GET' && pathname === '/api/unread-events') {
        if (req.url.includes('?')) return sendJson(res, 400, { error: 'Query parameters are not supported' });
        const result = unreadEvents.subscribe(req, res, req.member.name, req.headers['last-event-id']);
        if (result) return sendJson(res, result.status, { error: result.error });
        return;
      }

      // The only selectable content is metadata for the authenticated inbox.
      if (method === 'GET' && pathname === '/api/unread-metadata') {
        const params = parsedUrl.searchParams;
        const keys = [...params.keys()];
        const validKeys = keys.every(key => ['from', 'cursor', 'limit'].includes(key) && params.getAll(key).length === 1);
        const from = params.get('from');
        const cursorRaw = params.get('cursor');
        const limitRaw = params.get('limit');
        const decimal = value => /^(0|[1-9]\d*)$/.test(value);
        const cursor = cursorRaw === null ? 0 : Number(cursorRaw);
        const limit = limitRaw === null ? 10 : Number(limitRaw);
        if (!validKeys || (from !== null && !/^[\p{L}\p{N}_-]{1,32}$/u.test(from)) ||
            (cursorRaw !== null && (!decimal(cursorRaw) || !Number.isSafeInteger(cursor))) ||
            (limitRaw !== null && (!decimal(limitRaw) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100))) {
          return sendJson(res, 400, { error: 'Query parameter validation failed' });
        }
        return sendJson(res, 200, getUnreadMetadata(db, { to: req.member.name, from, cursor, limit }));
      }

      // GET /api/messages/:id (read message chunk)
      const messageIdMatch = pathname.match(/^\/api\/messages\/(\d+)$/);
      if (method === 'GET' && messageIdMatch) {
        const id = parseInt(messageIdMatch[1], 10);
        const queryParams = Object.fromEntries(parsedUrl.searchParams.entries());
        const parsed = readMessageQuerySchema.safeParse({ id, ...queryParams });
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: 'Validation failed',
            details: parsed.error.issues.map((i) => i.message),
          });
        }

        const msg = getMessageById(db, id);
        if (!msg) {
          return sendJson(res, 404, { error: 'Message not found' });
        }

        // Security check: Only the recipient can read their messages
        if (msg.to !== req.member.name) {
          return sendJson(res, 403, { error: 'Forbidden: access restricted to message recipient' });
        }

        const { offset, limit } = parsed.data;
        const totalLength = msg.text.length;
        const textChunk = msg.text.slice(offset, offset + limit);
        const hasMore = offset + limit < totalLength;

        // Only a valid final chunk marks read; out-of-range offsets still return an
        // empty body for compatibility, but must not consume the unread state.
        // For a file-only message, offset zero is the sole valid empty-body page.
        const reachedEnd = !hasMore && (totalLength === 0 ? offset === 0 : textChunk.length > 0);
        let markedRead = false;
        const alreadyRead = msg.readAt !== null;
        if (reachedEnd && !alreadyRead) {
          try {
            // Reuses the recipient-scoped, already-unread guarded update, so a concurrent
            // mark_read cannot be double counted.
            markedRead = markMessagesRead(db, { to: req.member.name, ids: [msg.id] }).markedCount === 1;
          } catch {
            // Read is the primary operation: a failed bookkeeping write must not turn a
            // successful body fetch into an error. The message simply stays unread.
            markedRead = false;
          }
        }
        if (markedRead) notifyUnread(req.member.name, 'read');

        return sendJson(res, 200, {
          id: msg.id,
          from: msg.from,
          to: msg.to,
          title: msg.title,
          project: msg.project,
          time: msg.time,
          // Reflects the state after this call, so a caller that just finished the body
          // does not have to re-query to learn the message is now read.
          read: alreadyRead || markedRead,
          markedRead,
          totalLength,
          offset,
          limit,
          hasMore,
          text: textChunk,
          attachment: msg.attachment,
        });
      }

      // GET /api/attachments/:id — metadata plus base64 content, recipient only.
      const attachmentMatch = pathname.match(/^\/api\/attachments\/(\d+)$/);
      if (method === 'GET' && attachmentMatch) {
        const row = getAttachmentById(db, parseInt(attachmentMatch[1], 10));
        if (!row) return sendJson(res, 404, { error: 'Attachment not found' });
        // Senders are denied too (decision C3). The message is identical to the
        // third-party case so neither can probe for another member's files.
        if (row.to !== req.member.name) {
          return sendJson(res, 403, { error: 'Forbidden: access restricted to message recipient' });
        }
        return sendJson(res, 200, {
          id: row.id,
          messageId: row.messageId,
          name: row.name,
          size: row.size,
          mime: row.mime,
          sha256: row.sha256,
          createdAt: row.createdAt,
          from: row.from,
          to: row.to,
          data_base64: Buffer.from(row.data).toString('base64'),
        });
      }

      // GET /api/attachments/:id/text — paginated preview for text-like files only.
      const attachmentTextMatch = pathname.match(/^\/api\/attachments\/(\d+)\/text$/);
      if (method === 'GET' && attachmentTextMatch) {
        const parsed = attachmentTextQuerySchema.safeParse(Object.fromEntries(parsedUrl.searchParams.entries()));
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: 'Validation failed',
            details: parsed.error.issues.map((i) => i.message),
          });
        }

        const row = getAttachmentById(db, parseInt(attachmentTextMatch[1], 10));
        if (!row) return sendJson(res, 404, { error: 'Attachment not found' });
        if (row.to !== req.member.name) {
          return sendJson(res, 403, { error: 'Forbidden: access restricted to message recipient' });
        }
        if (!isPreviewableText(row)) {
          return sendJson(res, 400, {
            error: `Attachment is not previewable as text (binary type or larger than ${CONFIG.maxAttachmentPreviewBytes} bytes); use save_attachment instead`,
          });
        }

        const { offset, limit } = parsed.data;
        const text = Buffer.from(row.data).toString('utf8');
        const totalLength = text.length;
        return sendJson(res, 200, {
          id: row.id,
          name: row.name,
          size: row.size,
          mime: row.mime,
          sha256: row.sha256,
          totalLength,
          offset,
          limit,
          hasMore: offset + limit < totalLength,
          text: text.slice(offset, offset + limit),
        });
      }

      // POST /api/messages/mark-read
      if (method === 'POST' && pathname === '/api/messages/mark-read') {
        const body = await parseJsonBody(req);
        const parsed = markReadSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: 'Validation failed',
            details: parsed.error.issues.map((i) => i.message),
          });
        }

        const result = markMessagesRead(db, {
          to: req.member.name,
          ids: parsed.data.ids,
        });
        if (result.markedCount > 0) notifyUnread(req.member.name, 'read');

        return sendJson(res, 200, result);
      }

      return sendJson(res, 404, { error: 'Not Found' });
    } catch (err) {
      const status = err.statusCode || 500;
      const message = status === 500 ? 'Internal server error' : err.message;
      return sendJson(res, status, { error: message });
    }
  });

  return {
    server,
    db,
    start(port = options.port || CONFIG.port, host = options.host || CONFIG.host) {
      return new Promise((resolve, reject) => {
        server.listen(port, host, () => {
          const addr = server.address();
          const actualPort = typeof addr === 'object' && addr ? addr.port : port;
          const actualHost = typeof addr === 'object' && addr ? addr.address : host;
          resolve({ host: actualHost, port: actualPort, url: `http://${actualHost}:${actualPort}` });
        });
        server.once('error', reject);
      });
    },
    close() {
      return new Promise((resolve) => {
        disabledImHandler.close();
        unreadEvents.close();
        server.close(() => {
          try {
            db.close();
          } catch {
            // Already closed
          }
          resolve();
        });
      });
    },
  };
}

// Start standalone server if run directly
const isMain = import.meta.url === `file://${process.argv[1]}` ||
               process.argv[1]?.endsWith('server.js');
if (isMain) {
  const serverInstance = createServer();
  serverInstance.start(CONFIG.port, CONFIG.host).then(({ url }) => {
    console.log(`team-mailbox server listening at ${url}`);
    console.log(`Database path: ${process.env.MSG_DB_PATH || CONFIG.dbPath}`);
  }).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });

  const shutdown = async () => {
    console.log('Shutting down server...');
    await serverInstance.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
