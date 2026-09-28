import { deploymentPreflight } from '../src/deployment-preflight.js';

const report = deploymentPreflight(process.env);
console.log(JSON.stringify(report, null, 2));
if (!report.ready) process.exitCode = 1;
