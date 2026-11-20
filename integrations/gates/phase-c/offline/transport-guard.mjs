// Preloaded only in the disposable original operator test process. In particular,
// its old Windows identity test must never reach a real profile's native pipe.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const blocked = () => { throw Object.assign(new Error('OFFLINE_TRANSPORT_BLOCKED'), { code: 'OFFLINE_TRANSPORT_BLOCKED' }); };
net.connect = net.createConnection = net.Socket.prototype.connect = blocked;
tls.connect = http.request = http.get = https.request = https.get = blocked;
globalThis.fetch = blocked;
syncBuiltinESMExports();
