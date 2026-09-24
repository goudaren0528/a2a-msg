"""Test-only process driver for the existing stdlib client; no receiver journal."""
import base64
import importlib.util
import json
import os
import sys
import uuid


def emit(value):
    frame = json.dumps(value, separators=(',', ':'))
    if len(frame.encode('utf-8')) > 65535:
        raise ValueError('frame limit')
    print(frame, flush=True)


def receive():
    frame = sys.stdin.buffer.readline(65537)
    if len(frame) > 65536 or not frame.endswith(b'\n'):
        raise ValueError('frame limit or EOF')
    return json.loads(frame)


def run():
    emit({'phase': 'ready', 'pid': os.getpid(),
          'clean': os.getcwd() == os.environ.get('HOME')
          and os.environ.get('HOME') == os.environ.get('USERPROFILE')
          and not os.environ.get('PYTHONPATH') and sys.flags.isolated == 1
          and sys.flags.no_site == 1 and sys.dont_write_bytecode})
    config = receive()
    spec = importlib.util.spec_from_file_location('existing_im_client', config['module'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    client = module.ImClient(config['serverUrl'], config['credential'],
                             ca_file=config['ca'], allow_writes=True)
    identity = client.me()['agentId']
    assert identity == config['agentId']
    operation = config['operation']
    if operation == 'send':
        conversation = client.ensure_conversation(config['peerId'])['conversationId']
        attachment = None
        if 'bytes' in config:
            attachment = ('untrusted.bin', base64.b64decode(config['bytes'], validate=True))
        sent = client.send(conversation, config['peerId'], client_message_id=config['clientMessageId'],
                           text=config['text'], attachment=attachment)
        assert client.send_result(config['clientMessageId'])['messageId'] == sent['messageId']
        assert client.message(sent['messageId'])['deliveredAt'] is None
        client.history(conversation)
        emit({'phase': 'sent', 'agentId': identity, 'messageId': sent['messageId'],
              'conversationId': conversation, 'title': sent['title']})
    elif operation == 'stale-ack':
        try:
            client.ack(config['instanceId'], config['generation'], [config['messageId']])
        except module.ImClientError as error:
            assert error.code == 'STALE_FENCE'
            emit({'phase': 'stale-rejected', 'code': error.code})
        else:
            raise AssertionError('stale ACK accepted')
    elif operation == 'reply':
        instance = str(uuid.uuid4())
        lease = client.acquire(instance, str(uuid.uuid4()))
        page = client.sync(instance, lease['generation'])
        assert len(page['items']) == 1
        message = page['items'][0]['message']
        assert message['messageId'] == config['messageId']
        assert message['conversationId'] == config['conversationId']
        assert message['inReplyTo'] == config['inReplyTo']
        assert message['senderAgentId'] == config['peerId']
        assert message['recipientAgentId'] == identity
        assert message['text'] == config['text']
        assert message['title'] is None and message['attachment'] is None
        assert client.message(message['messageId'])['deliveredAt'] is None
        client.history(config['conversationId'])
        emit({'phase': 'reply-before-ack', 'agentId': identity, 'messageId': message['messageId']})
        assert receive() == {'go': True}
        ack = client.ack(instance, lease['generation'], [message['messageId']])
        client.mark_read(message['messageId'])
        client.release(instance, lease['generation'])
        emit({'phase': 'reply-read', 'ackedThrough': ack['ackedThrough']})
    else:
        raise ValueError('unknown fixture operation')


try:
    run()
except Exception:
    # Never emit traceback/config/remote content, even on a failed assertion.
    emit({'phase': 'failure'})
    sys.exit(1)
