"""Isolated Python stdlib sender; configuration arrives on stdin, never argv."""
import base64
import importlib.util
import json
import sys


def main():
    config = json.loads(sys.stdin.buffer.readline(65537))
    spec = importlib.util.spec_from_file_location('im_example_client', config['module'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    client = module.ImClient(config['serverUrl'], config['credential'], ca_file=config['ca'], allow_writes=True)
    assert client.me()['agentId'] == config['agentId']
    conversation = client.ensure_conversation(config['peerId'])['conversationId']
    attachment = ('demo.bin', base64.b64decode(config['bytes'], validate=True)) if config.get('bytes') else None
    result = client.send(conversation, config['peerId'], client_message_id=config['clientMessageId'],
                         text=config['text'], attachment=attachment)
    assert client.send_result(config['clientMessageId'])['messageId'] == result['messageId']
    print(json.dumps({'messageId': result['messageId'], 'conversationId': conversation}), flush=True)


try:
    main()
except Exception:
    print('sender failed (details suppressed)', file=sys.stderr)
    sys.exit(1)
