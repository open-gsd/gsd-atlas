#!/usr/bin/env node
import process from 'node:process';
import { runMcpShim } from '../mcp-shim/index.ts';

process.exitCode = runMcpShim({ stderr: process.stderr });
