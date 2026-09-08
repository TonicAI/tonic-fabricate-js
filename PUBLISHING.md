# Publishing @fabricate-tools/client

Publishing happens in CI, triggered by pushing a tag. The tag is the source of
truth for the version — `package.json` holds a `0.0.0-dev` placeholder and is
never bumped.

## Releasing

1. Merge the changes you want to ship.
2. Tag `main` and push the tag:
   ```bash
   git checkout main && git pull
   git tag v1.5.0
   git push origin v1.5.0
   ```
   `patch` for fixes, `minor` for backwards-compatible additions, `major` for
   breaking changes.
3. Confirm it landed:
   ```bash
   npm view @fabricate-tools/client version
   ```

The tag push builds, tests, publishes to npm, and creates a GitHub Release with
notes generated from the merged pull requests. Tags that are not on `main` are
rejected.

A version already on npm cannot be republished, and publishing cannot be
meaningfully undone. To fix a bad build, release a new patch version.
