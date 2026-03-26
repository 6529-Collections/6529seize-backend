#!/usr/bin/env node

import readline from 'node:readline';

const [, , mode, title, ...rest] = process.argv;

if (!mode || !title) {
  process.stderr.write('ghdeploy-picker: missing arguments\n');
  process.exit(1);
}

if (!process.stdin.isTTY || !process.stderr.isTTY) {
  process.stderr.write('ghdeploy-picker: requires an interactive terminal\n');
  process.exit(1);
}

let options = [];
let footer = '';
let multiSelect = false;
let cursor = 0;
let selected = [];
let cleanedUp = false;
let errorMessage = '';
let windowStart = 0;

if (mode === 'multi') {
  options = rest;
  footer = 'Controls: Up/Down move, Space toggles, Enter confirms, q cancels';
  multiSelect = true;
  selected = options.map(() => false);
} else if (mode === 'single') {
  const [defaultOption, ...singleOptions] = rest;

  if (!defaultOption) {
    process.stderr.write('ghdeploy-picker: missing default option\n');
    process.exit(1);
  }

  options = singleOptions;
  footer = 'Controls: Up/Down move, Enter confirms, q cancels';
  cursor = Math.max(options.indexOf(defaultOption), 0);
} else {
  process.stderr.write(`ghdeploy-picker: unsupported mode '${mode}'\n`);
  process.exit(1);
}

if (options.length === 0) {
  process.stderr.write('ghdeploy-picker: no options provided\n');
  process.exit(1);
}

function visibleRows() {
  return Math.max((process.stderr.rows ?? 24) - 8, 5);
}

function ensureCursorVisible() {
  const rows = visibleRows();

  if (cursor < windowStart) {
    windowStart = cursor;
  }

  if (cursor >= windowStart + rows) {
    windowStart = cursor - rows + 1;
  }
}

function selectedCount() {
  return selected.filter(Boolean).length;
}

function renderHeader() {
  process.stderr.write('\x1b[2J\x1b[H');
  process.stderr.write(`${title}\n`);
  process.stderr.write(`${footer}\n`);

  if (multiSelect) {
    process.stderr.write(`Selected: ${selectedCount()} of ${options.length}\n`);
  } else {
    process.stderr.write(`Selected: ${options[cursor]}\n`);
  }

  process.stderr.write(errorMessage ? `Error: ${errorMessage}\n` : '\n');
}

function renderOptions() {
  ensureCursorVisible();

  const rows = visibleRows();
  const end = Math.min(windowStart + rows, options.length);

  for (let idx = windowStart; idx < end; idx += 1) {
    const isSelected = multiSelect ? selected[idx] : idx === cursor;
    const marker = isSelected ? '[x]' : '[ ]';
    const line = `${marker} ${options[idx]}`;

    if (idx === cursor) {
      process.stderr.write(`\x1b[7m${line}\x1b[0m\n`);
    } else {
      process.stderr.write(`${line}\n`);
    }
  }

  if (options.length > rows) {
    process.stderr.write(
      `\nShowing ${windowStart + 1}-${end} of ${options.length} options\n`
    );
  }
}

function render() {
  renderHeader();
  renderOptions();
}

function cleanup() {
  if (cleanedUp) {
    return;
  }

  cleanedUp = true;
  process.stderr.write('\x1b[?25h\x1b[?1049l');

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}

function finishWithSelection() {
  cleanup();

  if (multiSelect) {
    const output = options.filter((_, idx) => selected[idx]).join('\n');
    process.stdout.write(`${output}\n`);
  } else {
    process.stdout.write(`${options[cursor]}\n`);
  }

  process.exit(0);
}

function confirmSelection() {
  if (multiSelect && selectedCount() === 0) {
    errorMessage = 'Select at least one service before continuing.';
    render();
    return;
  }

  finishWithSelection();
}

function cancel() {
  cleanup();
  process.exit(1);
}

process.on('exit', cleanup);
process.on('SIGINT', cancel);

if (process.stderr.isTTY) {
  process.stderr.on('resize', render);
}

readline.emitKeypressEvents(process.stdin);
process.stdin.setRawMode(true);
process.stdin.resume();

process.stderr.write('\x1b[?1049h\x1b[H\x1b[?25l');
render();

process.stdin.on('keypress', (_, key) => {
  if (!key) {
    return;
  }

  if (key.ctrl && key.name === 'c') {
    cancel();
    return;
  }

  switch (key.name) {
    case 'up':
      if (cursor > 0) {
        cursor -= 1;
      }
      break;
    case 'down':
      if (cursor + 1 < options.length) {
        cursor += 1;
      }
      break;
    case 'space':
      if (multiSelect) {
        selected[cursor] = !selected[cursor];
      }
      break;
    case 'return':
    case 'enter':
      confirmSelection();
      return;
    default:
      if (key.name === 'q' || key.sequence === 'q' || key.sequence === 'Q') {
        cancel();
        return;
      }

      if (key.name === 'j' || key.sequence === 'j' || key.sequence === 'J') {
        if (cursor + 1 < options.length) {
          cursor += 1;
        }
      } else if (
        key.name === 'k' ||
        key.sequence === 'k' ||
        key.sequence === 'K'
      ) {
        if (cursor > 0) {
          cursor -= 1;
        }
      } else if (
        multiSelect &&
        (key.name === 'x' || key.sequence === 'x' || key.sequence === 'X')
      ) {
        selected[cursor] = !selected[cursor];
      }
      break;
  }

  errorMessage = '';
  render();
});
