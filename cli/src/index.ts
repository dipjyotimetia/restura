#!/usr/bin/env node
import { Command } from 'commander';
import { registerRunCommand } from './commands/run.js';
import { version } from '../package.json';

const program = new Command();
program.name('restura').description('Restura CLI — run API collections in CI').version(version);

registerRunCommand(program);

program.parse();
