"""Explicit, HTTPS-only IM v1 example. Remote content is untrusted data."""

import base64
import hashlib
import json
import ssl
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_ATTACHMENT = 10 * 1024 * 1024
MAX_JSON = 16 * 1024 * 1024
PROTOCOL = "a2a-msg.im.v1"
ERROR_CODES = frozenset((
    "INVALID_REQUEST", "UNSUPPORTED_VERSION", "INVALID_ATTACHMENT", "AUTH_REQUIRED",
    "INVALID_CREDENTIAL", "TLS_REQUIRED", "OPERATION_FORBIDDEN", "RESOURCE_NOT_FOUND",
    "IDEMPOTENCY_CONFLICT", "LEASE_CONFLICT", "STALE_FENCE", "LEASE_EXPIRED",
    "DELIVERY_REQUIRED", "SYNC_BLOCKED", "CURSOR_RESET_REQUIRED",
    "IDEMPOTENCY_WINDOW_EXPIRED", "PAYLOAD_TOO_LARGE", "RATE_LIMITED",
    "IM_DISABLED", "NEW_WRITES_DISABLED", "POLICY_NOT_CONFIGURED",
    "STORAGE_UNAVAILABLE", "CLOCK_UNSAFE",
))


class ImClientError(Exception):
    """Fixed safe code only; never forwards remote text, URLs, credentials, or paths."""

    def __init__(self, code="STORAGE_UNAVAILABLE"):
        self.code = code if isinstance(code, str) and code in ERROR_CODES else "STORAGE_UNAVAILABLE"
        super().__init__(self.code)


def _id(value):
    try:
        if str(uuid.UUID(value)) == value and value == value.lower():
            return value
    except (ValueError, AttributeError, TypeError):
        pass
    raise ImClientError("INVALID_REQUEST")


class ImClient:
    def __init__(self, server_url, credential, *, ca_file=None, allow_writes=False):
        try:
            url = urllib.parse.urlsplit(server_url)
            if (url.scheme != "https" or not url.hostname or url.username or url.password
                    or url.path not in ("", "/") or url.query or url.fragment):
                raise ValueError()
            if not isinstance(credential, str) or not credential or '\n' in credential or '\r' in credential:
                raise ValueError()
            # The default context validates both chain and hostname; CA is an additive
            # explicit trust source for isolated tests, never a disable-verification knob.
            context = ssl.create_default_context(cafile=ca_file)
            self._opener = urllib.request.build_opener(
                urllib.request.ProxyHandler({}), urllib.request.HTTPSHandler(context=context),
                _NoRedirect())
            self._origin = server_url.rstrip('/')
            self._credential = credential
            self._writes = allow_writes is True
        except (ValueError, TypeError, OSError, ssl.SSLError):
            raise ImClientError("INVALID_REQUEST") from None

    def _request(self, method, path, *, body=None, query=None, headers=None, binary=False):
        if method == "POST" and not self._writes:
            raise ImClientError("NEW_WRITES_DISABLED")
        target = self._origin + "/api/v1" + path
        if query:
            target += '?' + urllib.parse.urlencode(query)
        data = json.dumps(body, separators=(',', ':'), ensure_ascii=False).encode('utf-8') if method == 'POST' else None
        request = urllib.request.Request(target, data=data, method=method, headers={
            'Authorization': 'Bearer ' + self._credential,
            **({'Content-Type': 'application/json'} if method == 'POST' else {}),
            **(headers or {}),
        })
        try:
            with self._opener.open(request, timeout=30) as response:
                maximum = MAX_ATTACHMENT if binary else MAX_JSON
                content = response.read(maximum + 1)
                if len(content) > maximum:
                    raise ImClientError("PAYLOAD_TOO_LARGE")
                if binary:
                    if response.headers.get_content_type() != 'application/octet-stream':
                        raise ImClientError()
                    return content
                if response.headers.get_content_type() != 'application/json':
                    raise ImClientError()
                result = json.loads(content)
                if not isinstance(result, dict):
                    raise ImClientError()
                return result
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read(65537))
                code = payload['error']['code']
            except (ValueError, TypeError, KeyError, UnicodeError):
                code = None
            raise ImClientError(code) from None
        except ImClientError:
            raise
        except (OSError, ValueError, UnicodeError, urllib.error.URLError):
            raise ImClientError() from None

    def me(self):
        return self._request('GET', '/me')

    def contacts(self, *, after=None, limit=20):
        return self._request('GET', '/contacts', query=_page(after, limit))

    def conversations(self, *, after=None, limit=20):
        return self._request('GET', '/conversations', query=_page(after, limit))

    def ensure_conversation(self, peer_agent_id):
        return self._request('POST', '/conversations', body={'peerAgentId': _id(peer_agent_id)})

    def send(self, conversation_id, recipient_agent_id, *, client_message_id, text='', title=None,
             attachment=None, in_reply_to=None, correlation=None):
        """Caller persists/reuses client_message_id after uncertain network outcomes; never auto-retry."""
        raw = {'protocol': PROTOCOL, 'conversationId': _id(conversation_id),
               'recipientAgentId': _id(recipient_agent_id), 'clientMessageId': _id(client_message_id),
               'text': text, 'title': title, 'inReplyTo': _id(in_reply_to) if in_reply_to else None,
               'correlation': correlation}
        if attachment is not None:
            name, content = attachment
            if not isinstance(content, bytes) or not 0 < len(content) <= MAX_ATTACHMENT:
                raise ImClientError('INVALID_ATTACHMENT')
            raw['attachment'] = {'name': name, 'mime': 'application/octet-stream',
                                 'sha256': hashlib.sha256(content).hexdigest(),
                                 'dataBase64': base64.b64encode(content).decode('ascii')}
        return self._request('POST', '/messages', body=raw)

    def send_result(self, client_message_id):
        return self._request('GET', '/sends/' + _id(client_message_id))

    def history(self, conversation_id, *, after=None, limit=20):
        return self._request('GET', '/conversations/' + _id(conversation_id) + '/messages',
                             query=_page(after, limit))

    def message(self, message_id):
        return self._request('GET', '/messages/' + _id(message_id))

    def attachment(self, metadata):
        """Return verified bytes only. Never trust remote name or MIME as a local path/type."""
        try:
            size, digest = metadata['size'], metadata['sha256']
            if (not isinstance(size, int) or isinstance(size, bool) or not 0 < size <= MAX_ATTACHMENT
                    or not isinstance(digest, str) or len(digest) != 64
                    or any(c not in '0123456789abcdef' for c in digest)):
                raise ValueError()
            content = self._request('GET', '/attachments/' + _id(metadata['attachmentId']), binary=True)
            if len(content) != size or hashlib.sha256(content).hexdigest() != digest:
                raise ImClientError('INVALID_ATTACHMENT')
            return content
        except (KeyError, TypeError, ValueError):
            raise ImClientError('INVALID_ATTACHMENT') from None

    def mark_read(self, message_id):
        return self._request('POST', '/messages/' + _id(message_id) + '/read', body={})

    def acquire(self, instance_id, request_id):
        return self._request('POST', '/receiver/lease', body={
            'instanceId': _id(instance_id), 'requestId': _id(request_id)})

    def renew(self, instance_id, generation):
        return self._request('POST', '/receiver/lease/renew', body={
            'instanceId': _id(instance_id), 'generation': generation})

    def release(self, instance_id, generation):
        return self._request('POST', '/receiver/lease/release', body={
            'instanceId': _id(instance_id), 'generation': generation})

    def sync(self, instance_id, generation, *, after=None, stream_epoch=None, limit=20):
        query = _page(after, limit)
        if stream_epoch is not None:
            query['streamEpoch'] = _id(stream_epoch)
        return self._request('GET', '/sync', query=query, headers={
            'X-A2A-Instance-Id': _id(instance_id), 'X-A2A-Generation': str(generation)})

    def ack(self, instance_id, generation, message_ids):
        return self._request('POST', '/acks', body={
            'instanceId': _id(instance_id), 'generation': generation,
            'messageIds': [_id(value) for value in message_ids]})


def _page(after, limit):
    query = {'limit': limit}
    if after is not None:
        query['after'] = after
    return query


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ImClientError()
