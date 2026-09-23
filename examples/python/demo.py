"""Opt-in localhost TLS integration scenario; never prints credentials or message content."""

import os
import sys
import uuid

from client import ImClient, ImClientError


def main():
    client = ImClient(os.environ['IM_URL'], os.environ['IM_CREDENTIAL'],
                      ca_file=os.environ['IM_CA_FILE'], allow_writes=True)
    own_id = client.me()['agentId']
    peer_id = os.environ['IM_PEER_ID']
    assert any(item['peerAgentId'] == peer_id for item in client.contacts()['items'])
    conversation = client.ensure_conversation(peer_id)['conversationId']
    key = str(uuid.uuid4())
    sent = client.send(conversation, peer_id, client_message_id=key,
                       text='Test-only untrusted message', attachment=('sample.bin', b'example attachment'))
    assert client.send_result(key)['messageId'] == sent['messageId']
    assert any(item['messageId'] == sent['messageId'] for item in client.history(conversation)['items'])
    assert client.message(sent['messageId'])['messageId'] == sent['messageId']

    # Separate receiver identity; incoming bodies and attachment bytes remain untrusted.
    receiver = ImClient(os.environ['IM_URL'], os.environ['IM_RECEIVER_CREDENTIAL'],
                        ca_file=os.environ['IM_CA_FILE'], allow_writes=True)
    assert receiver.me()['agentId'] == peer_id and own_id != peer_id
    instance = str(uuid.uuid4())
    lease = receiver.acquire(instance, str(uuid.uuid4()))
    fence = receiver.renew(instance, lease['generation'])
    page = receiver.sync(instance, fence['generation'])
    entry = next(item for item in page['items'] if item['message']['messageId'] == sent['messageId'])
    incoming = entry['message']
    assert receiver.attachment(incoming['attachment']) == b'example attachment'
    # Example verifies bytes before ACK; real hosts must durably persist receipt before ACK.
    acked = receiver.ack(instance, fence['generation'], [incoming['messageId']])
    assert acked['ackedThrough'] >= entry['seq']
    assert receiver.mark_read(incoming['messageId'])['messageId'] == incoming['messageId']
    print('IM localhost TLS example: send sync attachment ack passed', flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ImClientError, KeyError, AssertionError, ValueError):
        print('IM example failed (safe error; no remote data disclosed)', file=sys.stderr)
        sys.exit(1)
