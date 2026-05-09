#!/usr/bin/env node
import { Command } from 'commander';
import { registerRunCommand } from './commands/run.js';

const program = new Command();
program
  .name('restura')
  .description('Restura CLI — run API collections in CI')
  .version('0.1.0');

registerRunCommand(program);

program.parse();
