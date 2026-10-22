#!/usr/bin/env node
// A stand-in for the bundled connector, for test/sidecar.test.mjs only.
//
// It speaks newline-delimited JSON-RPC on stdio like server/wisply-mcp.mjs,
// and answers every tools/call with what the sidecar sent and what this
// process got: its argv, its environment, its pid and how many initialize
// requests it has seen. A few tool names make it misbehave on purpose:
//
//   exit     exits with code 3 before answering
//   hang     never answers
//   noise    writes 1 MiB to stderr, then answers
//   garbage  writes a line that isn't JSON and one with an unknown id, then answers
//   error    answers with a JSON-RPC error
//   tool-error  answers with an isError tool result whose text is the first argument
//   huge     writes more than the sidecar's line limit without a newline
import { createInterface } from 'node:readline';

let initializes = 0;
let initialized = 0;
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method === 'notifications/initialized') {
    initialized += 1;
    continue;
  }
  if (message.method === 'initialize') {
    initializes += 1;
    send({ jsonrpc: '2.0', id: message.id, result: {
      protocolVersion: message.params?.protocolVersion, capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fake-wisply-connector', version: '0.0.0' },
    } });
    continue;
  }
  if (message.method !== 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not available' } });
    continue;
  }
  const { name, arguments: args } = message.params ?? {};
  if (name === 'exit') process.exit(3);
  if (name === 'hang') continue;
  if (name === 'noise') process.stderr.write('x'.repeat(1024 * 1024));
  if (name === 'garbage') {
    process.stdout.write('this is not json\n');
    send({ jsonrpc: '2.0', id: 999999, result: { content: [] } });
  }
  if (name === 'error') {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'Fixed error text' } });
    continue;
  }
  if (name === 'tool-error') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(args?.text ?? '') }], isError: true } });
    continue;
  }
  if (name === 'huge') {
    process.stdout.write('{"padding":"');
    process.stdout.write('y'.repeat(5 * 1024 * 1024));
    continue;
  }
  const report = {
    tool: name, args, id: message.id, pid: process.pid, argv: process.argv.slice(2),
    env: { ...process.env }, initializes, initialized,
  };
  send({ jsonrpc: '2.0', id: message.id, result: {
    content: [{ type: 'text', text: JSON.stringify(report) }], structuredContent: report, isError: false,
  } });
}
