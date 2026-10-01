# untick check (GitHub Action)

Scans your deploy or preview with untick and fails the job when it finds **new** serious problems.

- Needs a Pro or Agency account and an API token (Settings, Integrations).
- Compares with your site's latest scan, so old problems don't block a release.
- Posts one pull request comment and keeps it up to date.
- Writes a short summary on the job page.

## Use it

```yaml
name: untick
on: pull_request

permissions:
  pull-requests: write

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: untickio/check@v1
        with:
          api-token: ${{ secrets.UNTICK_TOKEN }}
          url: https://my-preview.vercel.app
          site-id: sit_xxxxxxxx
```

## Inputs

- `api-token` (required): your token. Keep it in a secret.
- `url` (required): the address to scan.
- `site-id`: your untick site to compare with. Needed when a preview has a different address than your site.
- `fail-on`: `new` (default) fails on new serious problems. `any` fails on any serious problem.
- `basic-auth-user`, `basic-auth-pass`: for previews behind a login. Used only for that preview address and never stored.
- `comment`: `true` (default) or `false`.
- `github-token`: defaults to the built-in token.
- `timeout-minutes`: how long to wait. Default 6.

## Good to know

- Exit code 1 means the check failed or the scan couldn't finish.
- Without a baseline (no site found), the job fails on any serious problem.
- The action is a single file with no dependencies: `dist/index.js`.
