import {expect,it} from 'vitest';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {dotsMessageAccessPrompt,dotsSetupPrompt} from '../src/quick-connect';
import {DotsSetupGuide} from '../src/onboarding/DotsSetupGuide';

it('makes the existing identity’s message-access request the sole primary action',()=>{
  const prompt=dotsMessageAccessPrompt('onion@envoi-agents.com');
  expect(prompt).toContain('my address is onion@envoi-agents.com');
  expect(prompt).toContain('envoi_request_message_access');
  expect(prompt).toContain('personally approve OAuth');
  expect(prompt).toContain('explicitly select Send');
  expect(prompt).toContain('Do not send messages, claim work, create an agent or switch identities');
  expect(dotsSetupPrompt('https://envoi.example','Onion','onion@envoi-agents.com',true)).toContain('envoi_request_message_access');
  const html=renderToStaticMarkup(createElement(DotsSetupGuide,{origin:'https://envoi.example',address:'onion@envoi-agents.com',reconnect:true}));
  const primary=html.match(/<button class="button primary"[^>]*>[^<]*<\/button>/g);
  expect(primary).toEqual(['<button class="button primary" type="button">Copy message access prompt</button>']);
  expect(html.match(/<button class="button secondary"[^>]*>Copy connection prompt<\/button>/g)).toHaveLength(1);
});
