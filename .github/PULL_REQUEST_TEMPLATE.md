## What and why

<!-- What this changes, and the problem it solves. Link the issue if there is one. -->

## Checklist

- [ ] Tests for the change (`yarn test`; a help fixture in `daemon/test/fixtures/help/` for parser changes)
- [ ] `yarn e2e` passes (for anything in `zsh/` or that changes what the popup shows)
- [ ] `yarn budget` stays within limits (for daemon, learning or caching changes)
- [ ] Vendored files: change marked with a `zdrop:` comment and listed in `daemon/vendor/inshellisense/SOURCE.md`
- [ ] README updated for anything a user would notice
