## What and why

<!-- A short description of the change and the problem it solves. Link issues with "Fixes #123". -->

## Checklist

- [ ] `make check` is green (and `deploy/test.sh` if `deploy/` or templates changed)
- [ ] Tests added or updated
- [ ] Docs and both interface languages (EN and NL) updated where relevant
- [ ] No hardcoded domains, secrets or personal data (tests use `panel.test` / `node1.test`)
- [ ] Contract changes (`packages/api/`, `daemon/proxy/router.go`, env variable names) are in their own commit
- [ ] Tests do not touch a real installation (labels, random ports, temp dirs)
