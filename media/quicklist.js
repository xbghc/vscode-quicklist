'use strict';

(() => {
  const vscode = acquireVsCodeApi();
  const tree = document.getElementById('tree');
  const rootDrop = document.getElementById('root-drop');
  const status = document.getElementById('status');
  const mime = 'application/vnd.quicklist.items';
  const saved = vscode.getState() || {};
  const expanded = new Set(saved.expanded || []);
  let items = [];
  let editing;
  let selected = new Set();
  let focused;
  let hasWorkspace = false;
  let dragKeys;
  let dropHint;
  let hoverTimer;
  let hoverKey;
  const send = (message) => vscode.postMessage(message);
  const action = (name, key) => send({ type: 'action', action: name, key });
  const save = () => vscode.setState({ expanded: [...expanded] });
  const find = (key) => items.find((item) => item.key === key);
  const nodes = () => [...tree.querySelectorAll('.node')];
  const nodeFor = (key) => nodes().find((node) => node.dataset.key === key);

  function icon(name) {
    const paths = {
      folder: 'M1.5 4h5l1.5 2h6.5v7h-13z M1.5 4V2.5h5L8 4h6.5v2',
      file: 'M4 1.5h5l3 3v10H4z M9 1.5v3h3',
      warning: 'M8 1.5l7 12H1z M8 5v4 M8 11v.5',
      right: 'M6 3l5 5-5 5', down: 'M3 6l5 5 5-5',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svg.namespaceURI, 'path');
    path.setAttribute('d', paths[name] || paths.file);
    svg.append(path);
    return svg;
  }

  function expandAncestors(item) {
    let parentId = item?.parentId;
    while (parentId) {
      expanded.add(parentId);
      parentId = items.find((item) => item.id === parentId)?.parentId;
    }
  }

  function select(key, event = {}) {
    if (event.shiftKey && focused) {
      const keys = nodes().map((node) => node.dataset.key);
      const a = keys.indexOf(focused);
      const b = keys.indexOf(key);
      if (a >= 0 && b >= 0) selected = new Set(keys.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else if (event.ctrlKey || event.metaKey) {
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
    } else selected = new Set([key]);
    focused = key;
    updateSelection();
  }

  function updateSelection() {
    const first = nodes()[0]?.dataset.key;
    for (const node of nodes()) {
      const key = node.dataset.key;
      node.tabIndex = key === (focused || first) ? 0 : -1;
      node.setAttribute('aria-selected', String(selected.has(key)));
      node.classList.toggle('selected', selected.has(key));
    }
    tree.tabIndex = nodes().length ? -1 : 0;
  }

  function toggle(item) {
    if (expanded.has(item.id)) expanded.delete(item.id);
    else expanded.add(item.id);
    save();
    render(true);
  }

  function render(restoreFocus = false) {
    const input = tree.querySelector('input');
    const caret = input && [input.selectionStart, input.selectionEnd];
    const hadFocus = tree.contains(document.activeElement);
    // Replacing a focused input can trigger blur; only a user blur commits it.
    if (input) input.onblur = null;
    tree.replaceChildren();
    if (editing) expandAncestors(editing);

    function append(parent, parentId, depth) {
      if (editing && !editing.id && editing.parentId === parentId) appendEditor(parent, depth);
      const children = items.filter((item) => item.parentId === parentId);
      children.forEach((item, index) => {
        if (editing?.id === item.id && item.type === 'group') {
          appendEditor(parent, depth);
          return;
        }
        const node = document.createElement('div');
        node.className = 'node';
        node.dataset.key = item.key;
        node.addEventListener('focus', () => {
          focused = item.key;
          if (!selected.size) selected.add(item.key);
          updateSelection();
        });
        node.setAttribute('role', 'treeitem');
        node.setAttribute('aria-label', [item.label, item.description].filter(Boolean).join(', '));
        node.setAttribute('aria-level', String(depth));
        node.setAttribute('aria-posinset', String(index + 1));
        node.setAttribute('aria-setsize', String(children.length));
        if (item.type === 'group') node.setAttribute('aria-expanded', String(expanded.has(item.id)));
        const row = document.createElement('div');
        row.className = 'row';
        row.dataset.key = item.key;
        row.title = item.tooltip || item.label;
        row.draggable = !editing;
        row.dataset.vscodeContext = JSON.stringify({
          webviewSection: item.type === 'group' ? 'quicklistGroup' : 'quicklistEntry',
          quicklistItem: item.type === 'group' ? { type: 'group', id: item.id } : { type: item.type, uri: item.uri },
          preventDefaultContextMenuItems: true,
        });
        const twisty = document.createElement('span');
        twisty.className = 'twisty';
        if (item.type === 'group') twisty.append(icon(expanded.has(item.id) ? 'down' : 'right'));
        row.append(twisty, icon(item.icon));
        const label = document.createElement('span');
        label.className = 'label';
        label.textContent = item.label;
        row.append(label);
        if (item.description) {
          const description = document.createElement('span');
          description.className = 'description';
          description.textContent = item.description;
          row.append(description);
        }
        if (item.type !== 'group') {
          const remove = document.createElement('button');
          remove.className = 'remove';
          remove.textContent = '×';
          remove.title = 'Remove from Quicklist';
          remove.setAttribute('aria-label', `Remove ${item.label} from Quicklist`);
          remove.onclick = (event) => { event.stopPropagation(); action('remove', item.key); };
          row.append(remove);
        }
        row.onclick = (event) => {
          select(item.key, event);
          node.focus();
          if (event.ctrlKey || event.metaKey || event.shiftKey) return;
          if (item.type === 'group') toggle(item);
          else action('open', item.key);
        };
        row.oncontextmenu = () => { select(item.key); node.focus(); };
        row.ondragstart = (event) => {
          if (editing) { event.preventDefault(); return; }
          if (!selected.has(item.key)) select(item.key);
          dragKeys = nodes().map((node) => node.dataset.key).filter((key) => selected.has(key));
          event.dataTransfer.setData(mime, JSON.stringify(dragKeys));
          const uris = dragKeys.map(find).filter((item) => item.uri).map((item) => item.uri);
          if (uris.length) event.dataTransfer.setData('text/uri-list', uris.join('\r\n'));
          event.dataTransfer.effectAllowed = 'copyMove';
          document.body.classList.add('dragging');
        };
        node.append(row);
        parent.append(node);
        if (item.type === 'group' && expanded.has(item.id)) {
          const group = document.createElement('div');
          group.className = 'children';
          group.setAttribute('role', 'group');
          node.append(group);
          append(group, item.id, depth + 1);
        }
      });
    }
    append(tree, undefined, 1);
    if (focused && !nodeFor(focused)) focused = nodes()[0]?.dataset.key;
    updateSelection();
    if (editing) {
      const next = tree.querySelector('input');
      if (next && (editing.focus || hadFocus || restoreFocus)) {
        next.focus();
        if (editing.focus) { next.select(); editing.focus = false; }
        else if (caret) next.setSelectionRange(...caret);
      }
    } else if (hadFocus || restoreFocus) (nodeFor(focused) || tree).focus();
  }

  function appendEditor(parent, depth) {
    const wrapper = document.createElement('div');
    wrapper.className = 'editor';
    wrapper.setAttribute('role', 'treeitem');
    wrapper.setAttribute('aria-level', String(depth));
    const row = document.createElement('div');
    row.className = 'row';
    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    row.append(twisty, icon('folder'));
    const input = document.createElement('input');
    input.value = editing.value;
    input.setAttribute('aria-label', editing.id ? 'Rename folder' : 'Folder name');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.readOnly = Boolean(editing.pending);
    input.oninput = () => { editing.value = input.value; clearError(); };
    input.onkeydown = (event) => {
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
    };
    input.onblur = () => {
      if (editing?.pending) return;
      if (!input.value.trim()) cancel();
      else submit();
    };
    row.append(input);
    wrapper.append(row);
    const error = document.createElement('div');
    error.id = 'name-error';
    error.className = 'name-error';
    error.setAttribute('role', 'alert');
    error.textContent = editing.error || '';
    input.setAttribute('aria-describedby', error.id);
    input.setAttribute('aria-invalid', String(Boolean(editing.error)));
    wrapper.append(error);
    parent.append(wrapper);
  }

  function clearError() {
    if (!editing) return;
    delete editing.error;
    const error = document.getElementById('name-error');
    if (error) error.textContent = '';
    tree.querySelector('input')?.setAttribute('aria-invalid', 'false');
  }

  function submit() {
    if (!editing || editing.pending) return;
    const name = editing.value.trim();
    let error;
    if (!name) error = 'Enter a folder name.';
    else if (name.length > 100 || /[\r\n]/.test(name)) error = 'Use a single line of 100 characters or fewer.';
    else if (items.some((item) => item.type === 'group' && item.id !== editing.id &&
      item.parentId === editing.parentId && item.name.toLowerCase() === name.toLowerCase())) {
      error = 'A folder with this name already exists here.';
    }
    if (error) {
      editing.error = error;
      render(true);
      return;
    }
    editing.pending = true;
    tree.querySelector('input').readOnly = true;
    send({ type: 'submitEdit', token: editing.token, value: editing.value });
  }

  function cancel() {
    if (!editing || editing.pending) return;
    const token = editing.token;
    editing = undefined;
    render(true);
    send({ type: 'cancelEdit', token });
  }

  tree.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
    const node = event.target.closest('.node');
    const item = find(node?.dataset.key);
    if (!item) return;
    const visible = nodes();
    const index = visible.indexOf(node);
    let next;
    if (event.key === 'ArrowDown') next = visible[Math.min(index + 1, visible.length - 1)];
    else if (event.key === 'ArrowUp') next = visible[Math.max(0, index - 1)];
    else if (event.key === 'Home') next = visible[0];
    else if (event.key === 'End') next = visible.at(-1);
    else if (event.key === 'ArrowRight' && item.type === 'group') {
      if (!expanded.has(item.id)) toggle(item);
      else next = node.querySelector('.children > .node');
    } else if (event.key === 'ArrowLeft') {
      if (item.type === 'group' && expanded.has(item.id)) toggle(item);
      else next = nodeFor(`group:${item.parentId}`);
    } else if (event.key === 'Enter' || event.key === ' ') {
      if (item.type === 'group') toggle(item);
      else action('open', item.key);
    } else if (event.key === 'F2' && item.type === 'group') action('renameFolder', item.key);
    else if (event.key === 'Delete') action(item.type === 'group' ? 'removeFolder' : 'remove', item.key);
    else return;
    event.preventDefault();
    if (next) { select(next.dataset.key, event); next.focus(); }
  });

  function clearDrop() {
    document.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach((node) =>
      node.classList.remove('drop-before', 'drop-after', 'drop-inside'));
    dropHint = undefined;
  }

  function endDrag() {
    clearDrop();
    clearTimeout(hoverTimer);
    hoverKey = undefined;
    dragKeys = undefined;
    document.body.classList.remove('dragging');
  }

  function accepts(transfer) {
    return hasWorkspace && !editing && [...transfer.types].some((type) =>
      [mime, 'application/vnd.code.uri-list', 'text/uri-list', 'resourceurls'].includes(type.toLowerCase()));
  }

  document.addEventListener('dragover', (event) => {
    if (!event.dataTransfer || !accepts(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dragKeys ? 'move' : 'copy';
    document.body.classList.add('dragging');
    const row = event.target.closest('.row');
    const target = find(row?.dataset.key);
    const rect = row?.getBoundingClientRect();
    let position = 'inside';
    if (target) {
      const y = (event.clientY - rect.top) / rect.height;
      position = target.type === 'group' && y >= 0.25 && y <= 0.75 ? 'inside' : y < 0.5 ? 'before' : 'after';
    }
    clearDrop();
    dropHint = { target: target?.key, position };
    (target ? row : rootDrop).classList.add(`drop-${position}`);
    const newHover = target?.type === 'group' && position === 'inside' ? target.key : undefined;
    if (newHover !== hoverKey) {
      clearTimeout(hoverTimer);
      hoverKey = newHover;
      // Do not replace an internal drag's source DOM while the browser owns it.
      if (!dragKeys && newHover && !expanded.has(target.id)) hoverTimer = setTimeout(() => {
        expanded.add(target.id); save(); render();
      }, 600);
    }
  });

  document.addEventListener('drop', (event) => {
    if (!event.dataTransfer || !accepts(event.dataTransfer)) return;
    event.preventDefault();
    const destination = dropHint || { position: 'inside' };
    try {
      const internal = event.dataTransfer.getData(mime);
      if (internal && dragKeys) {
        send({ type: 'drop', keys: dragKeys, ...destination });
      } else {
        // VS Code's full URI list includes all selected directories and files.
        // ResourceURLs excludes directories, and text/uri-list may contain only
        // the first item. Prefer the complete list when Explorer supplies it.
        const fullList = event.dataTransfer.getData('application/vnd.code.uri-list');
        const resources = event.dataTransfer.getData('ResourceURLs');
        const uriList = fullList || event.dataTransfer.getData('text/uri-list');
        const uris = !fullList && resources ? JSON.parse(resources) :
          uriList.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
        if (Array.isArray(uris) && uris.length) send({ type: 'drop', uris, ...destination });
      }
    } catch {
      status.textContent = 'Unable to read the dragged items.';
    }
    endDrag();
  });
  document.addEventListener('dragend', endDrag);
  document.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget) { clearDrop(); clearTimeout(hoverTimer); hoverKey = undefined; document.body.classList.remove('dragging'); }
  });

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'state') {
      items = data.items;
      hasWorkspace = data.hasWorkspace;
      document.getElementById('drag-help').hidden = !hasWorkspace || !items.length;
      if (data.editing?.token !== editing?.token) editing = data.editing ? { ...data.editing, focus: true } : undefined;
      else if (editing && data.editing?.error) {
        editing.error = data.editing.error;
        editing.pending = false;
        editing.focus = true;
      }
      selected = new Set([...selected].filter(find));
      render();
    } else if (data.type === 'reveal') {
      const item = find(data.key);
      expandAncestors(item);
      if (item?.type === 'group') expanded.add(item.id);
      save();
      select(data.key);
      render(true);
      nodeFor(data.key)?.scrollIntoView({ block: 'nearest' });
    } else if (data.type === 'dropped') {
      const target = find(data.target);
      if (target?.type === 'group' && data.position === 'inside') { expanded.add(target.id); save(); render(); }
      status.textContent = 'Quicklist updated.';
    } else if (data.type === 'error') status.textContent = data.text;
  });
  send({ type: 'ready' });
})();
