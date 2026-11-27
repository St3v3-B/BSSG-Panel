# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Before you start

- Search existing issues first. For larger changes, open an issue to discuss the idea.
- Read [docs/development.md](docs/development.md) for the layout, toolchain and contracts.
- Be kind: see the [Code of Conduct](CODE_OF_CONDUCT.md).

## Workflow

1. Fork the repository and create a branch.
2. Make your change in small commits. Start the message with the component: `daemon: console backlog of 500 lines`, `panel-ui: ...`, `docs: ...`.
3. Run `make check`. If you touch `deploy/` or templates, run `deploy/test.sh` too.
4. Add or update tests and docs for what you changed.
5. Open a pull request and fill in the template.

## Rules of the house

- **No hardcoded domains.** Tests use `panel.test` and `node1.test`; docs use `example.com`.
- **No personal data** in code, docs, fixtures or screenshots (no real IPs, e-mail addresses or Discord IDs).
- **Contracts** (`packages/api/`, `daemon/proxy/router.go`, `deploy/panel.env.example` variable names) change deliberately and in their own commit.
- **Tests must not touch a real installation.** Label Docker objects with `panel.test=true` and a run label, use random free ports and temporary directories.
- The interface is available in English and Dutch; add both strings for new text.

## Reporting security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the [AGPL-3.0-or-later](LICENSE).
