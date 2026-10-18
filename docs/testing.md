# Testing

## Automated checks

`npm run check` validates JavaScript syntax and runs dependency-free unit tests with an injected VS Code API. These cover view contributions, commands, ordering, workspace isolation, URI preservation, missing resources, failed writes, and disposal.

`npm run test:setup` installs the pinned extension-host test runner without adding runtime dependencies or a lockfile. `npm run test:integration` uses real VS Code processes and a temporary profile to check activation, adding files and folders, deduplication, opening files, non-destructive removal, restart persistence, and workspace isolation. It creates and removes only its own temporary test directories.

CI runs these checks on Linux, Windows, and macOS before packaging a VSIX with `@vscode/vsce`. The test runner and packager are pinned; their transitive dependencies are resolved when installed.

## Manual acceptance checks

- Open a workspace. Confirm there is one Quicklist view inside Explorer, no new Activity Bar icon, and no new button on the built-in file-tree title.
- Click the Quicklist title's `+` button while editing a saved workspace file. Confirm it is added without a dialog. Add it again and confirm there is no duplicate.
- Right-click a folder in the native Explorer and choose **Add to Quicklist**. Click its shortcut and confirm the native Explorer selects and reveals the folder, rather than expanding a second directory tree.
- Click a file shortcut and confirm it opens. Hover over an entry, click `x`, and confirm the original file or folder still exists.
- Add two files in reverse alphabetical order. Confirm addition order is preserved after closing and reopening VS Code.
- Open another workspace and confirm its list is independent. In a multi-root workspace, add identically named files from different roots and check their path descriptions.
- Delete or rename a saved resource, then refresh. Confirm the original shortcut stays visible with a warning and can be removed. A temporarily inaccessible resource should say `unavailable`, not `missing`.
- Repeat adding, opening, revealing, and restarting in WSL or Remote SSH. Unit URI round-trip checks alone do not establish live remote compatibility.
- Check keyboard focus, light/dark themes, and file icon themes. Confirm labels remain legible and native view actions remain accessible.

Automated command tests do not verify every mouse target or the visual selection state of the native Explorer. Treat the manual checks above as a separate acceptance pass.
