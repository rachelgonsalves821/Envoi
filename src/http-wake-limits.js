import net from 'node:net';

// Shared document admission state prevents aliases and multiple server instances from bypassing
// the destination limits. Leased slots recover after a worker disappears.
export function wakeNetwork(address) {
  if (net.isIP(address) === 4) return `${address.split('.').slice(0,3).join('.')}.0/24`;
  const expanded = address.split('::');
  const left = expanded[0].split(':').filter(Boolean), right = (expanded[1] || '').split(':').filter(Boolean);
  const parts = expanded.length > 1 ? [...left,...Array(8-left.length-right.length).fill('0'),...right] : left;
  return `${parts.slice(0,3).map(p => Number.parseInt(p,16).toString(16)).join(':')}::/48`;
}
export function createWakeAdmission({store, now=Date.now}) {
  const statePath='http-wake/admission';
  return {
    async admit({subscriptionId,host,addresses,token,limited}) {
      if (!limited) return true;
      return store.withTransaction(['http-wake:admission'],async()=>{
        const state=await store.getJson(statePath,{buckets:{}});
        const buckets=[{key:`host:${host}`,concurrency:4,rate:120},...addresses.map(address=>({key:`ip:${address}`,concurrency:2,rate:60})),...[...new Set(addresses.map(wakeNetwork))].map(network=>({key:`net:${network}`,concurrency:Infinity,rate:120}))];
        let admitted=true;
        for(const rule of buckets){const bucket=state.buckets[rule.key] ||= {slots:[],starts:[],waiting:[]};bucket.slots=bucket.slots.filter(slot=>slot.until>now());bucket.starts=bucket.starts.filter(at=>at>now()-60000);bucket.waiting=bucket.waiting.filter(item=>item.until>now());if(!bucket.waiting.some(item=>item.id===subscriptionId))bucket.waiting.push({id:subscriptionId,until:now()+3600000});if(bucket.slots.length>=rule.concurrency || bucket.starts.length>=rule.rate || bucket.waiting[0].id!==subscriptionId)admitted=false;}
        if(admitted)for(const rule of buckets){const bucket=state.buckets[rule.key];bucket.waiting=bucket.waiting.filter(item=>item.id!==subscriptionId);bucket.starts.push(now());bucket.slots.push({token,until:now()+15000});}
        await store.putJson(statePath,state);return admitted;
      });
    },
    async release(token){await store.withTransaction(['http-wake:admission'],async()=>{const state=await store.getJson(statePath,{buckets:{}});for(const [key,bucket]of Object.entries(state.buckets)){bucket.slots=bucket.slots.filter(slot=>slot.token!==token&&slot.until>now());bucket.starts=bucket.starts.filter(at=>at>now()-60000);bucket.waiting=bucket.waiting.filter(item=>item.until>now());if(!bucket.slots.length&&!bucket.starts.length&&!bucket.waiting.length)delete state.buckets[key];}await store.putJson(statePath,state);});}
  };
}
