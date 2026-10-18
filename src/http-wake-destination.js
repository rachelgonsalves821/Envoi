import net from 'node:net';
import { Resolver } from 'node:dns/promises';
import os from 'node:os';

export const wakeLimits = Object.freeze({ dnsTimeoutMs: 2000, connectTimeoutMs: 5000, deliveryTimeoutMs: 10000, responseBodyReadMaxBytes: 4096 });
const reserved = ['localhost','localdomain','local','internal','intranet','lan','home','corp','home.arpa','arpa','test','example','invalid','onion','alt'];
const blocked4 = ['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.0.2.0/24','192.88.99.0/24','192.168.0.0/16','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/4','240.0.0.0/4'];
const blocked6 = ['2001::/23','2001:db8::/32','2002::/16','3fff::/20'];
export const wakeError = (statusCode, code, reason) => Object.assign(new Error(code), { statusCode, code, ...(reason ? { reason } : {}) });
export function createWakeDestination({ env = process.env, resolver, limits = wakeLimits } = {}) {
  const lists = { 4: new net.BlockList(), 6: new net.BlockList() };
  for (const cidr of [...blocked4, ...blocked6, ...(env.ENVOI_WAKE_EXTRA_BLOCKED_CIDRS || '').split(',').filter(Boolean)]) {
    const [address, prefix] = cidr.trim().split('/');
    const family = net.isIP(address);
    if (!family || !/^\d+$/.test(prefix || '')) throw new Error('Invalid wake blocked CIDR');
    lists[family].addSubnet(address, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
  }
  const global6 = new net.BlockList(); global6.addSubnet('2000::', 3, 'ipv6');
  for (const values of Object.values(os.networkInterfaces())) for (const value of values || []) {
    const family = net.isIP(value.address);
    if(family) lists[family].addAddress(value.address, family===4?'ipv4':'ipv6');
  }
  const selfHosts = (env.ENVOI_WAKE_SELF_HOSTS || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
  if (env.ENVOI_PUBLIC_URL) selfHosts.push(new URL(env.ENVOI_PUBLIC_URL).hostname);
  const allowed = address => {
    const family = net.isIP(address);
    return Boolean(family && (family !== 6 || global6.check(address, 'ipv6')) && !lists[family].check(address, family === 4 ? 'ipv4' : 'ipv6'));
  };
  function canonical(input) {
    let reason, url;
    if (typeof input !== 'string' || input.length > 2048) reason = 'url_too_long';
    try { url = new URL(input); } catch { reason ||= 'url_invalid'; }
    if (url) {
      if (url.href.length > 2048) reason ||= 'url_too_long';
      if (url.protocol !== 'https:') reason ||= 'scheme_not_https';
      if (url.username || url.password) reason ||= 'userinfo_present';
      if (url.port && url.port !== '443') reason ||= 'port_not_allowed';
      if (input.includes('?') || url.href.includes('?')) reason ||= 'query_present';
      if (input.includes('#') || url.href.includes('#')) reason ||= 'fragment_present';
      if (net.isIP(url.hostname.replace(/^\[|\]$/g, ''))) reason ||= 'address_literal';
      if (selfHosts.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) reason ||= 'self_target';
      if (url.hostname.endsWith('.') || !url.hostname.includes('.') || reserved.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) reason ||= 'reserved_name';
    }
    if (reason) throw wakeError(400, 'WAKE_URL_REJECTED', reason);
    return url.href;
  }
  async function resolve(input) {
    const url = canonical(input);
    const dns = resolver || new Resolver({ timeout: limits.dnsTimeoutMs, tries: 1 });
    if (!resolver) {
      const servers = (env.ENVOI_WAKE_DNS_RESOLVERS || '1.1.1.1,8.8.8.8').split(',').map(v => v.trim());
      if (servers.some(server => !allowed(server))) throw new Error('Wake resolvers must be public addresses');
      dns.setServers(servers);
    }
    // Include the service's public addresses in the deny set, including aliases to its
    // configured public hostname. Extra blocked CIDRs supply NAT/egress/platform addresses.
    if(env.ENVOI_PUBLIC_URL){
      const ownHost=new URL(env.ENVOI_PUBLIC_URL).hostname;
      if(net.isIP(ownHost))lists[net.isIP(ownHost)].addAddress(ownHost,net.isIP(ownHost)===4?'ipv4':'ipv6');
      else for(const method of ['resolve4','resolve6']){
        let timer;
        try{const own=await Promise.race([dns[method](ownHost),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Own DNS timeout')),limits.dnsTimeoutMs);})]);for(const address of own){const family=net.isIP(address);if(family)lists[family].addAddress(address,family===4?'ipv4':'ipv6');}}
        catch(error){if(!['ENODATA','ENOTFOUND'].includes(error.code))throw wakeError(400,'WAKE_URL_REJECTED','address_not_allowed');}
        finally{clearTimeout(timer);}
      }
    }
    const query = async method => {
      let timer;
      try { return await Promise.race([dns[method](new URL(url).hostname), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), limits.dnsTimeoutMs); })]); }
      catch (error) { if (['ENODATA','ENOTFOUND'].includes(error.code)) return []; throw error; }
      finally { clearTimeout(timer); }
    };
    try {
      const answers = (await Promise.all([query('resolve4'), query('resolve6')])).flat();
      if (!answers.length || answers.some(address => !allowed(address))) throw new Error('Blocked DNS answer');
      return { url, addresses: [...new Set(answers)] };
    } catch { throw wakeError(400, 'WAKE_URL_REJECTED', 'address_not_allowed'); }
  }
  return { canonical, resolve, allowed };
}
