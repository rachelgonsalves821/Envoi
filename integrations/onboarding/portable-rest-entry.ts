import { runPortableRestCli } from './portable-rest-cli';

if (!await runPortableRestCli(process.argv.slice(2))) process.exitCode = 1;
