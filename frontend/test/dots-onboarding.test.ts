import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { contractRegistry, loadContractFixture } from '../../integrations/contract-fixtures/setup';
import { dotsSetupPrompt, dotsSetupSteps, dotsVerificationPrompt, envoiWorkRule } from '../src/quick-connect';
import { ConnectPage } from '../src/onboarding/ConnectPage';
import { DotsPermissionRecovery, DotsSetupGuide } from '../src/onboarding/DotsSetupGuide';
import { connectionOffer } from '../src/onboarding/connect-state';
import { AuthorizeAgentPage } from '../src/onboarding/AuthorizeAgentPage';
import { ConsentController } from '../src/onboarding/consent-state';
import type { RemoteAuthApi } from '../src/onboarding/remote-auth-types';

const contract = contractRegistry.contracts.find(item => item.id === 'agent-remote-auth')!;
const fixture = (name: string): any => loadContractFixture(contract, name + '.json');
const origin = 'https://envoi.example';

describe('Dots onboarding route and grant recovery', () => {
  it.each([['routes-available-remote-mcp', true], ['routes-available-provider', false]])('consumes approved availability %s without rejecting other valid routes', (name, available) => {
    const body = fixture(name as string).response.body;
    expect(connectionOffer(body).remoteMcp).toBe(available);
    const html = renderToStaticMarkup(createElement(ConnectPage, { initialAvailability: body, initialAgentId: 'dots', origin }));
    expect(html.includes('aria-label="Dots connection instructions"')).toBe(available);
    if (!available) expect(html).toContain('Dots OAuth route is unavailable');
  });

  it('refuses inconsistent remote availability instead of inventing a working route', () => {
    const body = fixture('routes-available-remote-mcp').response.body;
    for (const mutate of [
      (value: any) => { value.deliveryModes.find((item: any) => item.deliveryMode === 'on_demand').available = false; },
      (value: any) => { value.registrationEnabled = false; },
      (value: any) => { value.routes.reverse(); }
    ]) { const value = structuredClone(body); mutate(value); expect(() => connectionOffer(value)).toThrow('unavailable'); }
  });

  it('links a Dots reconnect to the troubleshooting guide', () => {
    const html = renderToStaticMarkup(createElement(DotsSetupGuide, { origin, name: 'Example', address: 'example@envoi.example', reconnect: true }));
    expect(html).toContain('href="/docs/dots/"');
    expect(html).toContain('Stuck? Dots setup guide');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('href="https://envoi.example/mcp"');
    expect(html).not.toContain('href="https://chatgpt.com/plugins"');
  });

  it('reuses installed plugins and verifies identity and scope before any send', () => {
    const prompt = dotsSetupPrompt(origin, 'Example', 'example@envoi.example', true);
    expect(prompt).toContain('Use the official Envoi plugin already installed');
    expect(prompt).not.toContain('Add custom MCP server');
    expect(prompt).toContain('Do not create a separate personal plugin');
    expect(prompt).toContain('stop and report the missing send scope');
    expect(prompt).toContain('envoi.agent envoi.send');
    expect(prompt).toContain('explicitly select Send agent messages');
    expect(prompt).toContain('stop before sending');
    expect(prompt).toContain('envoi_agent_info');
    expect(prompt).toContain('envoi_send_message');
    expect(prompt).toContain('native monitoring task');
    expect(prompt).toContain('canonical reply and settlement');
    expect(prompt).toContain('Restore the native source on the existing task in its current execution chat');
    expect(prompt).toContain('On a new claim for the same work, generate fresh admission and completion keys');
    expect(prompt).toContain('Keep the identical reply payload and key across claims');
    expect(dotsSetupSteps(origin).join(' ')).toContain('Each owner connects their own account');
    const check = dotsVerificationPrompt('example@envoi.example');
    expect(check).toContain('example@envoi.example');
    expect(check).toContain('Do not claim work, send a message');
  });

  it.each(['routine', 'ask'] as const)('includes the selected rule and alert proof for saved and direct setup (%s)', mode => {
    for (const saved of [false, true]) {
      const prompt = dotsSetupPrompt(origin, 'Mark', 'mark@envoi.example', false, saved, mode);
      expect(prompt).toContain(envoiWorkRule(mode));
      expect(prompt).toContain('Say Ready only when backgroundReceiving.state is on and lastAlertAt is present and not null.');
      expect(prompt).toContain('wait for the first alert run, then call envoi_agent_info once more');
      expect(prompt).toContain('At the start of every monitoring run, call envoi_agent_info');
      expect(prompt).toContain('endedReason: "credential_ended"');
      expect(prompt).toContain('envoi_claim_work for the waiting work');
      expect(prompt).toContain('Background receiving isn\'t available in this Dot yet, so Mark will only check Envoi when you ask.');
      expect(prompt).toContain('/docs/fix/#background-receiving-unavailable');
    }
  });

  it('keeps setup on demand when selected', () => {
    const prompt = dotsSetupPrompt(origin, 'Mark', 'mark@envoi.example', true, false, 'on_demand');
    expect(prompt).not.toContain('envoi.work_available');
    expect(prompt.endsWith('Mark will only check Envoi when you ask. You can turn on background receiving any time.')).toBe(true);
  });

  it('does not offer OAuth permission recovery for frozen identities', () => {
    const html = renderToStaticMarkup(createElement(DotsPermissionRecovery, { origin, agents: [{ id: 'frozen', name: 'Frozen', address: 'frozen@envoi.example', principalHumanId: 'owner', status: 'revoked', onboardingStatus: 'revoked', permissions: [] }] }));
    expect(html).toBe('');
  });

  it.each([false, true])('explains receive-only consent (requested send: %s) without widening the request', async requestedSend => {
    const body = structuredClone(fixture('consent-view').response.body);
    body.requestedPermissions = requestedSend ? ['receive_agent_messages', 'send_agent_messages'] : ['receive_agent_messages'];
    body.grantablePermissions = ['receive_agent_messages'];
    const client = { view: vi.fn().mockResolvedValue(body) } as unknown as RemoteAuthApi;
    const controller = new ConsentController('fixture_handle', client, vi.fn(), () => Date.parse('2026-10-21T12:01:00Z'));
    await controller.load();
    const html = renderToStaticMarkup(createElement(AuthorizeAgentPage, { humanId: 'owner', handle: 'fixture_handle', workspaces: [], agents: [], controller }));
    expect(html).toContain(requestedSend ? 'Workspace policy does not allow sending' : 'Receive-only connection');
    expect(controller.getSnapshot().view!.requestedPermissions).toEqual(body.requestedPermissions);
    expect(html).toContain('Approve access');
  });
});
