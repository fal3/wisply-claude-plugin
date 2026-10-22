#!/usr/bin/env node
// wisply-mcp: the Wisply MCP connector. With no command it serves MCP over
// stdio (newline-delimited JSON-RPC) for the AI app that started it, and
// bridges tools/call to the Wisply app on 127.0.0.1 (lib/bridge.mjs).
// `setup`, `status` and `forget` are commands for people at a terminal
// (lib/cli.mjs) that keep the token in the macOS login keychain;
// `print-config` and `install` set up AI apps with the token-free entry.
//
// stdout carries JSON-RPC only. Requests are handled one at a time, in the
// order they arrive. Diagnostics go to stderr only when WISPLY_MCP_DEBUG=1
// (lib/debug.mjs), and never contain arguments, results or the token.
import { createInterface } from 'node:readline';
import contract from '../lib/contract.mjs';
import { DEFAULT_PORT, PLANNED_COMMANDS, VERSION } from '../lib/constants.mjs';
import { createBridge } from '../lib/bridge.mjs';
import { CLI_COMMANDS, runCli } from '../lib/cli.mjs';
import { debugLine } from '../lib/debug.mjs';
import { createLoopback, parsePort } from '../lib/loopback.mjs';
import { HELP, RPC, badPort, notInThisBuild, unknownArgument } from '../lib/messages.mjs';
import { resolveToken } from '../lib/token.mjs';

function usage(text, code = 2) {
  process.stderr.write(`${text}\n`);
  process.exit(code);
}

/** Parses the serve flags. Exits for --help, --version and any mistake. */
function parseArgs(argv, env) {
  const options = { port: undefined, readOnly: false, allowClaudeSetup: env.WISPLY_MCP_ALLOW_CLAUDE_SETUP === '1' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      process.stdout.write(HELP);
      process.exit(0);
    } else if (argument === '--version' || argument === '-v') {
      process.stdout.write(`${VERSION}\n`);
      process.exit(0);
    } else if (argument === '--read-only') {
      options.readOnly = true;
    } else if (argument === '--allow-claude-setup') {
      options.allowClaudeSetup = true;
    } else if (argument === '--port' || argument.startsWith('--port=')) {
      const value = argument === '--port' ? argv[(index += 1)] : argument.slice('--port='.length);
      options.port = parsePort(value);
      if (options.port === null) usage(badPort(value ?? ''));
    } else if (index === 0 && PLANNED_COMMANDS.includes(argument)) {
      // A command of a later 0.x release (none at the moment).
      usage(notInThisBuild(argument), 1);
    } else {
      usage(unknownArgument(argument));
    }
  }
  if (options.port === undefined) {
    const fromEnv = env.WISPLY_MCP_PORT;
    if (fromEnv === undefined || fromEnv.trim() === '') {
      options.port = DEFAULT_PORT;
    } else {
      options.port = parsePort(fromEnv);
      if (options.port === null) usage(badPort(fromEnv));
    }
  }
  return options;
}

async function serve({ port, readOnly, allowClaudeSetup }) {
  const bridge = createBridge({
    contract,
    resolveToken: () => resolveToken(),
    loopback: createLoopback({ port }),
    allowClaudeSetup,
    readOnly,
    port,
    debug: debugLine,
  });
  // The client went away: nothing left to answer.
  process.stdout.on('error', () => process.exit(0));
  const send = (response) => process.stdout.write(`${JSON.stringify(response)}\n`);
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      debugLine({ outcome: 'parse-error' });
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: RPC.PARSE_ERROR } });
      continue;
    }
    let response;
    try {
      response = await bridge.handle(message);
    } catch {
      const id = typeof message?.id === 'string' || typeof message?.id === 'number' ? message.id : null;
      debugLine({ outcome: 'internal' });
      response = { jsonrpc: '2.0', id, error: { code: -32603, message: RPC.INTERNAL } };
    }
    if (response) send(response);
  }
}

const argv = process.argv.slice(2);
if (CLI_COMMANDS.includes(argv[0])) {
  // A closed pipe (status | head) ends the output, not the process with an error.
  process.stdout.on('error', () => {});
  process.exitCode = await runCli(argv, {
    env: process.env,
    platform: process.platform,
    // /usr/bin/security asks for the token on the terminal, so setup needs one.
    isTTY: process.stdin.isTTY === true,
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
} else {
  await serve(parseArgs(argv, process.env));
}
