#!/usr/bin/env node
import { Command } from 'commander';
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
import { registerRunCommand } from './commands/run.js';
import { version } from '../package.json';

// Honour HTTP_PROXY / HTTPS_PROXY / NO_PROXY for all outbound requests — the
// behaviour every other CLI behind a corporate proxy has. undici's
// EnvHttpProxyAgent reads these vars (incl. lowercase) and applies the
// NO_PROXY bypass; the CLI fetcher dispatches through undici's global
// dispatcher, so installing it here covers every request. No-op when neither
// proxy var is set.
if (
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  process.env.HTTPS_PROXY ||
  process.env.https_proxy
) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

const program = new Command();
program.name('restura').description('Restura CLI — run API collections in CI').version(version);

registerRunCommand(program);

program.parse();
