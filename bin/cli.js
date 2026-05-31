#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../src/logger');
const { loadConfig } = require('../src/config');
const { createServer } = require('../src/server');

const pkg = require('../package.json');

function printHelp() {
  process.stdout.write(`
LLM Bridge & Cache v${pkg.version}
One OpenAI-compatible endpoint in front of OpenAI & Anthropic, with prompt
injection and prompt-cache keepalive. Bring your own API keys.

USAGE
  llm-bridge-cache [options]
  llm-bridge-cache init            Write a starter config to ./llm-bridge.config.json

OPTIONS
  -c, --config <path>   Path to a JSON config file
  -p, --port <n>        Port to listen on            (default 8787)
  -H, --host <addr>     Host to bind                 (default 127.0.0.1)
  -l, --log-level <lv>  trace|debug|info|warn|error  (default info)
  -h, --help            Show this help
  -v, --version         Show version

KEYS (bring your own — nothing is bundled)
  Set OPENAI_API_KEY and/or ANTHROPIC_API_KEY in your environment (or a .env you
  load), or put literal keys in the config. Without a config file, sensible
  defaults are used and keys are read from those env vars.

DOCS  https://github.com/crossps/llm-bridge-cache
`);
}

function parseArgs(argv) {
  const opts = { overrides: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case 'init': opts.command = 'init'; break;
      case '-h': case '--help': opts.command = 'help'; break;
      case '-v': case '--version': opts.command = 'version'; break;
      case '-c': case '--config': opts.configPath = next(); break;
      case '-p': case '--port': opts.overrides.port = parseInt(next(), 10); break;
      case '-H': case '--host': opts.overrides.host = next(); break;
      case '-l': case '--log-level': opts.overrides.logLevel = next(); break;
      default:
        if (a.startsWith('-')) { process.stderr.write(`Unknown option: ${a}\n`); process.exit(1); }
    }
  }
  return opts;
}

function doInit() {
  const src = path.join(__dirname, '..', 'config.example.json');
  const dest = path.resolve(process.cwd(), 'llm-bridge.config.json');
  if (fs.existsSync(dest)) {
    process.stderr.write(`Refusing to overwrite existing ${dest}\n`);
    process.exit(1);
  }
  fs.copyFileSync(src, dest);
  process.stdout.write(`Wrote starter config to ${dest}\nEdit it, set your API keys, then run: llm-bridge-cache\n`);
}

function banner(config, server) {
  const proto = 'http';
  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host;
  const base = `${proto}://${shown}:${config.port}`;
  const lines = [];
  lines.push('');
  lines.push(`  LLM Bridge & Cache v${pkg.version}`);
  lines.push(`  Listening on ${proto}://${config.host}:${config.port}`);
  lines.push(`  Point any OpenAI-compatible client at:  ${base}/v1`);
  lines.push('  Inbound formats: /v1/chat/completions  /v1/messages  /v1/responses');
  lines.push('');
  lines.push('  Providers:');
  for (const p of server.pool.list()) {
    const keyState = p.keys.length ? `${p.keys.length} key(s)` : 'NO KEY — set its env var';
    lines.push(`    - ${p.name.padEnd(10)} ${String(p.models.length).padStart(2)} model(s), ${keyState}`);
  }
  lines.push(`  Default provider: ${config.defaultProvider}`);
  if (config.apiKey) lines.push('  Bridge auth: ON (clients must send the bridge key)');
  lines.push('');
  process.stdout.write(lines.join('\n') + '\n');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.command === 'help') return printHelp();
  if (opts.command === 'version') return process.stdout.write(pkg.version + '\n');
  if (opts.command === 'init') return doInit();

  let config;
  try {
    config = loadConfig({ configPath: opts.configPath, overrides: opts.overrides });
  } catch (e) {
    process.stderr.write(`Config error: ${e.message}\n`);
    process.exit(1);
  }

  logger.setLevel(config.logLevel);
  const server = createServer(config);

  // Warn loudly if no provider has a key — the bridge will still start.
  const withKeys = server.pool.list().filter((p) => p.keys.length > 0);
  if (withKeys.length === 0) {
    logger.warn('No API keys found for ANY provider. Set OPENAI_API_KEY / ANTHROPIC_API_KEY (or edit your config).');
  }

  server.listen(config.port, config.host, () => {
    banner(config, server);
    server.refresher.logConfig();
    if (config._configPath) logger.info(`Loaded config: ${config._configPath}`);
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') logger.error(`Port ${config.port} is already in use.`);
    else logger.error('Server error:', e.message);
    process.exit(1);
  });

  const shutdown = () => {
    logger.info('Shutting down...');
    server.refresher.shutdown();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
