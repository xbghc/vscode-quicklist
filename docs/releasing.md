# Releasing Quicklist

The Release workflow uses the same entry points as `vscode-nvim-marks`: a `v*` tag push or a manual run with a tag input. It publishes to the VS Code Marketplace as `xbghc.quicklist` and attaches the same VSIX to a GitHub release.

## One-time setup

1. In this repository's **Settings → Secrets and variables → Actions**, add a repository secret named `VSCE_PAT`. Use a valid Marketplace publishing token for the `xbghc` publisher, as in `vscode-nvim-marks`. Repository secrets are not shared automatically, and GitHub cannot reveal the existing token from another repository. An organization secret granting access to this repository also works.
2. Ensure repository policy permits the release job to use `contents: write`, which it needs to create tags and GitHub releases. The other jobs request only read access.
3. Merge the workflow into the default branch so **Actions → Release → Run workflow** is available.

This follows the reference project's PAT authentication. Microsoft's [publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace) recommends Microsoft Entra ID for automation and announces retirement of global Azure DevOps PATs on December 1, 2026. Plan the authentication migration for both extensions together.

## Publish a version

1. Update `version` in `package.json` and add the release notes to `CHANGELOG.md`.
2. Run `npm run check` and complete the relevant [manual checks](testing.md).
3. Commit and push those changes, then choose either trigger below.

For the initial `0.1.0` release, push a tag at the intended commit:

```sh
git tag v0.1.0
git push origin v0.1.0
```

Alternatively, open **Actions → Release → Run workflow**, select the branch or tag containing the intended commit, and enter `v0.1.0`. The workflow creates a missing tag only after the tests and packaging pass. If the tag already exists, it must point to the selected commit; the workflow never force-moves it.

For every release, the workflow:

1. Validates the tag against `package.json` and checks that `VSCE_PAT` is configured.
2. Reuses CI to run syntax, unit, and real VS Code extension-host tests on Linux, Windows, and macOS, plus the offline-package checks on Linux.
3. Packages with the pinned official `@vscode/vsce` tool after all three platforms pass.
4. Downloads that run's `quicklist-vsix` artifact and publishes it to the Marketplace.
5. Creates or updates the GitHub release with generated notes and the published VSIX.

The workflow does not increment versions or edit the changelog. Normal pushes to `main`, pull requests, and manual **CI** runs only test and package; they do not publish. Release runs are serialized so two jobs cannot publish at the same time.

## Pre-releases

Use a suffix such as `v0.1.0-alpha.1` to mark both the Marketplace package and GitHub release as pre-release. `package.json` must still contain the plain version `0.1.0`; the suffix is a Git tag label only.

Every new Marketplace build needs a new numeric version. For example, follow `v0.1.0-alpha.1` with `v0.1.1-alpha.2` and set `package.json` to `0.1.1`. Merely changing `alpha.1` to `alpha.2` does not create a new Marketplace version. When maintaining stable and preview channels together, follow the [official versioning guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions) so preview users receive the intended updates.

## Retrying a failed release

Use **Re-run failed jobs** on the original run. If the Marketplace upload succeeded but creating the GitHub release failed, `vsce --skip-duplicate` leaves the published version in place and lets the GitHub release step finish.

For a new manual run, select the existing release tag so it uses the same commit. If source changes are needed, bump the package version and use a new tag. Do not reuse a published numeric version for different code or change its release channel via a retry.
