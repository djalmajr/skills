// Cross-platform fake CLIs for the unit tests (test-only). A fake is a Node
// script `<name>.fake.mjs` plus a launcher that the PATH lookup finds on
// each platform: an executable `<name>` (sh) on POSIX, `<name>.cmd` on
// Windows (findExecutable honors PATHEXT). The launcher runs the script with
// the runtime running the tests (process.execPath: node or bun). Parity tests
// that run the bash script keep their sh fakes; they only run where bash does.
import fs from 'node:fs';
import path from 'node:path';

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// writeFakeCli <dir> <name> <js source> [platform] → the launcher path.
export function writeFakeCli(dir, name, source, platform = process.platform) {
  const script = path.join(dir, `${name}.fake.mjs`);
  fs.writeFileSync(script, source);
  if (platform === 'win32') {
    const launcher = path.join(dir, `${name}.cmd`);
    fs.writeFileSync(launcher, `@"${process.execPath}" "%~dp0${name}.fake.mjs" %*\r\n`);
    return launcher;
  }
  const launcher = path.join(dir, name);
  fs.writeFileSync(launcher, `#!/bin/sh\nexec ${shQuote(process.execPath)} ${shQuote(script)} "$@"\n`, { mode: 0o755 });
  return launcher;
}

// listingFake <first argument> <lines> → source of a fake that prints the
// lines when its first argument matches, and nothing otherwise (exit 0).
export function listingFake(arg, lines) {
  return `if (process.argv[2] === ${JSON.stringify(arg)}) process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')});\n`;
}

// Source of a fake that sleeps `ms` before exiting 0 (timeout cases).
export function sleepingFake(ms) {
  return `setTimeout(() => {}, ${Number(ms)});\n`;
}

// Source of a fake that echoes its arguments on one line.
export const ECHO_FAKE = `process.stdout.write(process.argv.slice(2).join(' ') + '\\n');\n`;
