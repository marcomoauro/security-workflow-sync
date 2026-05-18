#!/usr/bin/env node
import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`[fatal] ${err.message}\n`);
  if (process.env.SWS_DEBUG) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
