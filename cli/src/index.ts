#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program
  .name('restura')
  .description('Restura CLI — run API collections in CI')
  .version('0.1.0');

// Subcommands wired in later tasks (run command)

program.parse();
