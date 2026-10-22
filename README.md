# Quicklist

A minimal file and folder shortcut list for Visual Studio Code.

Quicklist adds a lightweight view to the Explorer sidebar, letting you keep frequently accessed files and folders in one place. Organize shortcuts into folders without configuration or an extra sidebar icon.

## Features

- **One-click add** - Add the active file using the `+` button.
- **File and folder shortcuts** - Add files or folders from the Explorer context menu.
- **Inline folder editing** - Create and rename nested Quicklist folders directly in the sidebar.
- **Drag and drop** - Reorder shortcuts, move them between folders, and import files or folders from Explorer.
- **Quick navigation** - Click a file to open it, or a folder to reveal it in the native Explorer.
- **Easy removal** - Remove shortcuts without affecting the original files.
- **Workspace-specific** - Each workspace maintains its own list, preserved across restarts.
- **Minimal UI** - A shortcut tree integrated into the Explorer sidebar.

## Usage

**Add a file:** Open it and click `+` in the Quicklist view title. Alternatively, right-click it in Explorer and select **Add to Quicklist**.

**Add a folder:** Right-click it in Explorer and select **Add to Quicklist**. Multiple files and folders can be selected together.

**Organize shortcuts:** Click **New Folder** in the Quicklist title and type its name in the new sidebar row. Press **Enter** to create it or **Escape** to cancel. Empty names and duplicate sibling names show an error beside the input. Right-click a Quicklist folder and choose **New Folder** to create a subfolder, or **Add Current File** to add the active file directly into it. These folders organize shortcuts only; they do not create directories on disk.

**Move or rename:** Right-click a shortcut or grouping folder and choose **Move to Folder…**. Select a folder or **Quicklist (root)** to move it. Use **Rename Folder** (or **F2**) on a grouping folder to edit its name in place. Folder names must be unique within their parent, ignoring case.

**Drag items:** Drop on the top or bottom edge of a row to reorder, in the middle of a grouping folder to move inside it, or on **Quicklist (root)** to move out. Ctrl/Cmd-click or Shift-click selects multiple items. Folder contents move with their grouping folder.

**Drag from Explorer:** Hold **Shift** while dragging files or folders into Quicklist. VS Code requires this modifier to deliver external drops to sidebar Webviews. Drop into a grouping folder, between rows, or on the root area. Existing shortcuts are not duplicated or relocated by an Explorer drop.

**Remove a grouping folder:** Choose **Remove Folder (Keep Contents)**. Its shortcuts and subfolders move up one level. If a promoted subfolder has the same name as a sibling, a numeric suffix is added to its name.

**Navigate:** Click a file to open it in the editor. Expand a grouping folder to see its shortcuts. Click a real folder shortcut to reveal it in the native Explorer; real folder shortcuts do not expand into directory trees inside Quicklist.

**Remove an item:** Hover over it and click `x`. This only removes the shortcut, never the actual file or folder.

## Installation

Requires VS Code 1.85 or later. Published versions are available from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=xbghc.quicklist) and as VSIX assets on [GitHub Releases](https://github.com/xbghc/vscode-quicklist/releases).

Download the `quicklist-vsix` artifact from a successful [CI run](https://github.com/xbghc/vscode-quicklist/actions/workflows/ci.yml), extract it, and run **Extensions: Install from VSIX...** in VS Code. Alternatively, build a package locally as described below.

## How it works

- Items within each folder keep their addition order until you reorder them. Duplicate resource URIs are ignored across the entire list; drag an existing Quicklist item or use **Move to Folder…** to reorganize it.
- Only saved files and folders inside the current workspace can be added.
- All folders in a multi-root workspace share one list.
- Lists use VS Code's internal workspace storage, not project files. They are not shared through Git or synchronized between machines by this extension.
- Folder names, nesting, and shortcut locations persist with each workspace. Existing flat lists continue to appear at the root.
- Missing or unavailable entries stay visible and can be removed. Renamed or moved paths are not automatically updated.
- The view refreshes on VS Code file operations, when it becomes visible, and when the window regains focus. Use **Quicklist: Refresh** after other external file-system changes.
- Full resource URIs are preserved, including remote schemes and authorities.
- The sidebar uses a Webview for inline editing, with VS Code theme colors and built-in file/folder symbols. Custom file icon themes are not applied inside the Webview.
- No accounts, external services, telemetry, or runtime npm dependencies.

## Development

Use Node.js 22 or later. There is no compile step and unit tests require no dependency installation.

```sh
npm run check
```

To test the actual sidebar DOM and message handlers in Chromium (including inline editing, IME input, and drag/drop):

```sh
npm run test:webview
```

This requires `chromium` on PATH, or `QUICKLIST_BROWSER` set to a Chromium/Chrome executable. CI runs it on Linux with Google Chrome.

Open this repository in VS Code and press **F5** to launch an Extension Development Host.

To run tests inside real VS Code processes:

```sh
npm run test:setup
npm run test:integration
```

On headless Linux, use `xvfb-run -a npm run test:integration`. The runner downloads VS Code and tests persistence across process restarts and isolation between workspaces. Set `VSCODE_VERSION` to test a specific version; the default is `stable`. Tool installation and VS Code downloads require network access.

Build a VSIX with the official packaging tool:

```sh
npm run package
```

For an offline local package, Python 3.9 or later can be used instead:

```sh
npm run package:offline
```

The offline package is written to `dist/`. CI uses the official packager. See [manual checks](docs/testing.md) for mouse interaction and remote-workspace checks.

## Publishing

The [Release workflow](https://github.com/xbghc/vscode-quicklist/actions/workflows/release.yml) follows the same tag-based publishing process as `vscode-nvim-marks`. Push a version tag or run it manually to test on Windows, macOS, and Linux, package a VSIX, publish it to the Marketplace, and attach it to a GitHub release. See [release setup and instructions](docs/releasing.md) for the required `VSCE_PAT` secret, version tags, pre-releases, and retries.

## Acknowledgments

Quicklist is based on [CØdeZØne Favorites](https://github.com/leandrosilva/vscode-favorites-explorer) by Leandro Silva, licensed under the MIT License. The original copyright and permission terms are retained.

## License

[MIT](LICENSE)
