# Testing

## Automated checks

`npm run check` validates JavaScript syntax and runs dependency-free unit tests with an injected VS Code API. These cover view contributions, commands, ordering, workspace isolation, URI preservation, missing resources, failed writes, and disposal. Folder tests cover nested organization, moving and renaming, inline-edit cancellation, name collisions, cycle prevention, drag ordering, multi-item moves, complete Explorer imports, non-destructive removal, persistence, legacy lists, and corrupt parent links. Release tests also check stable and pre-release tags, package-version matching, and rejection of malformed tags.

`npm run test:webview` runs the sidebar in a real headless Chromium browser with the extension-host message handlers. It checks input focus, Chinese IME confirmation, Enter/Escape, duplicate-name feedback, F2 rename, row drop positions, moves to folders and root, and complete Explorer URI lists with mixed files and directories. It also checks for JavaScript and CSP errors. Use `QUICKLIST_BROWSER` to select a Chrome/Chromium executable; the default is `chromium`. These synthetic drag events do not replace testing the native Explorer-to-Webview boundary.

`npm run test:setup` installs the pinned extension-host test runner without adding runtime dependencies or a lockfile. `npm run test:integration` uses real VS Code processes and a temporary profile to check activation, adding files and folders, deduplication, opening files, non-destructive removal, restart persistence, and workspace isolation. It creates and removes only its own temporary test directories.

CI runs these checks on Linux, Windows, and macOS before packaging a VSIX with `@vscode/vsce`. The Release workflow reuses this same CI workflow before publishing its VSIX artifact. The test runner and packager are pinned; their transitive dependencies are resolved when installed.

## Manual acceptance checks

- Open a workspace. Confirm there is one Quicklist view inside Explorer, no new Activity Bar icon, and no new button on the built-in file-tree title.
- Click the Quicklist title's `+` button while editing a saved workspace file. Confirm it is added without a dialog. Add it again and confirm there is no duplicate.
- Click **New Folder** in the Quicklist title. Confirm an input appears in the sidebar, type a name, and press Enter. Test Escape, empty and duplicate names, click-away behavior, and Chinese IME input. Then use its context menu to create a subfolder and add the active file. Expand and collapse both levels. Confirm no directories were created on disk.
- Drag rows above and below siblings, into collapsed and expanded grouping folders, and onto **Quicklist (root)**. Ctrl/Cmd-select and Shift-select several items and move them together. Try moving a parent with a selected child and try dropping it into its own descendant. Confirm order and nesting survive restart.
- Hold Shift while dragging a mixed selection of files and folders from Explorer into Quicklist. Confirm every item is imported, duplicates are ignored, and files on disk stay in place. Also try dragging outside-workspace resources and dropping onto an empty list.
- Move shortcuts into a folder and back to **Quicklist (root)**. Move a folder with subfolders into another folder. Confirm the moved folder and its descendants are excluded from its destination picker.
- Rename a grouping folder. Confirm empty names and duplicate sibling names are rejected, cancellation changes nothing, and contents remain intact. Close and reopen VS Code to check the whole hierarchy persists.
- Remove a grouping folder with **Remove Folder (Keep Contents)**. Confirm its contents move to its parent and that colliding subfolder names gain a numeric suffix. Files on disk must remain untouched.
- Right-click a folder in the native Explorer and choose **Add to Quicklist**. Click its shortcut and confirm the native Explorer selects and reveals the folder, rather than expanding a second directory tree.
- Click a file shortcut and confirm it opens. Hover over an entry, click `x`, and confirm the original file or folder still exists.
- Add two files in reverse alphabetical order. Confirm addition order is preserved after closing and reopening VS Code.
- Open another workspace and confirm its list is independent. In a multi-root workspace, add identically named files from different roots and check their path descriptions.
- Delete or rename a saved resource, then refresh. Confirm the original shortcut stays visible with a warning and can be removed. A temporarily inaccessible resource should say `unavailable`, not `missing`.
- Repeat adding, opening, revealing, and restarting in WSL or Remote SSH. Unit URI round-trip checks alone do not establish live remote compatibility.
- Check keyboard focus, arrow navigation, F2, multi-selection, light/dark/high-contrast themes, and the built-in file/folder symbols. Custom file icon themes do not apply to the Webview. Confirm labels remain legible and native view actions remain accessible.

Automated command and browser tests do not verify every mouse target or the visual selection state of the native Explorer. Treat the manual checks above as a separate acceptance pass.
