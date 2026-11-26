import asyncio
import os

import httpx
from a2a.client.transports.rest import RestTransport
from a2a.types import AgentCard, GetTaskRequest, SendMessageRequest
from google.protobuf.json_format import ParseDict


async def main():
    base = os.environ['PHASE_D_PEER_BASE']
    async with httpx.AsyncClient(headers={'Authorization': f"Bearer {os.environ['PHASE_D_PEER_TOKEN']}", 'Content-Type': 'application/a2a+json'}, timeout=20) as http:
        card_response = await http.get(f'{base}/card')
        card_response.raise_for_status()
        card = ParseDict(card_response.json(), AgentCard())
        transport = RestTransport(http, card, base)
        request = ParseDict({
            'message': {'messageId': 'official-sdk-local-1', 'role': 'ROLE_USER', 'parts': [{'text': 'Local SDK exchange'}]},
            'configuration': {'returnImmediately': True},
        }, SendMessageRequest())
        sent = await transport.send_message(request)
        if not sent.HasField('task'):
            raise AssertionError('A2A send did not return a Task')
        polled = await transport.get_task(GetTaskRequest(id=sent.task.id))
        if polled.id != sent.task.id:
            raise AssertionError('A2A Task polling did not return the sent Task')
        print('Official A2A Python SDK 1.2.3 local card/send/poll passed')


asyncio.run(main())
