# Security policy

## Reporting a vulnerability

Please report security issues **privately** through GitHub:
[Report a vulnerability](https://github.com/St3v3-B/BSSG-Panel/security/advisories/new)
(repository **Security** tab, then **Report a vulnerability**).

Please do not open a public issue or discuss the problem publicly until it is fixed. Include what you found, how to reproduce it, the affected version
(git commit) and its impact. Remove real secrets and domains from your report.

You can expect an acknowledgement within a few days. This is a community project, so fixes are made on a best-effort basis, but security reports get priority.

## Supported versions

The project is in active development and has no tagged releases yet. Fixes land on `main`.

## Design notes

A summary of the security model is in the [README](README.md#security), and an internal review of the panel, daemon, Caddy and deploy setup is in
[docs/security-review.md](docs/security-review.md).
