# Contributing

Thanks for your interest! This is a small, zero-dependency project and it intends to stay that way.

## Ground rules

- **No runtime dependencies.** Standard library only. Dev-only tooling is fine to discuss in an issue first.
- **Keep it Node ≥ 18.17** compatible (we rely on global `fetch` and the built-in test runner).
- **No secrets, ever.** Never commit API keys, tokens, or a populated `.env` / `llm-bridge.config.json`. They're gitignored — keep it that way.

## Getting started

```bash
git clone https://github.com/crossps/llm-bridge-cache
cd llm-bridge-cache
node --test          # all tests run against a mock upstream — no API keys needed
node bin/cli.js      # run locally
```

## Pull requests

1. Open an issue describing the change first for anything non-trivial.
2. Add or update a test in `test/` — the mock upstream pattern makes this easy.
3. Make sure `node --test` is green.
4. Keep PRs focused and the diff small.

## Good first contributions

- Native provider adapters (Gemini, Mistral, OpenRouter, …).
- A `/metrics` or richer `/status` view.
- More routing options (per-model overrides, fallbacks).

See the open **Roadmap** issue for the current direction.
