# Contributing

Thanks for your interest in contributing to `@matte97p/demowright`.

## Getting started

```bash
git clone https://github.com/matte97p/demowright.git
cd demowright
npm install
```

## Submitting changes

1. Fork the repository and create a branch from `main`.
2. Make your changes and ensure existing tests still pass (`npm test`).
3. Open a pull request with a clear description of the problem and solution.

## Credentials and secrets

Demo config files (`.demowright.config.*`) may reference credentials.
**Never commit real credentials** — always read them from environment variables
or a local `.env` that is gitignored.

## Code style

- TypeScript for source files under `src/`.
- Prettier defaults (`npm run format`).

## Reporting bugs

Use [GitHub Issues](https://github.com/matte97p/demowright/issues).
For security issues, see [SECURITY.md](SECURITY.md).
