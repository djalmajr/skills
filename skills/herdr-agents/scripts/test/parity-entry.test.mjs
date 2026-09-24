// Golden (slice 9b-1): the entry-level scenarios now run only the JS
// (`node scripts/herdr-agents.mjs`) and compare against the reference
// recorded once from the bash script in test/golden/parity-entry.json
// (test/golden.mjs: HERDR_AGENTS_GOLDEN=record records, unset checks,
// =update overwrites the JS value for review). Scenarios: `help`, `-h`,
// `--help` and no command all print the constant usage text (stdout, rc 0,
// no Herdr needed); an unknown command (`nope`) dies 2 with the bash
// `unknown command '…'` message on stderr. None of these paths calls an
// external CLI, so the fixture carries no fakes and check mode is not
// restricted to POSIX hosts.
import test from 'node:test';
import { goldenScenario } from './parity.mjs';
import { goldenMode } from './golden.mjs';
import { findExecutable } from '../lib/platform.mjs';

// Record mode runs the bash reference: it needs bash on PATH. Check mode
// runs the JS against the record and needs nothing else.
const SKIP =
  goldenMode() === 'record' && !findExecutable('bash')
    ? 'record mode needs bash on PATH'
    : false;

const SUITE = 'parity-entry';

test('parity: help, -h, --help and no command print the usage (rc 0)', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'help-variants', {
    steps: [
      { args: ['help'] },
      { args: ['-h'] },
      { args: ['--help'] },
      { args: [] },
    ],
  });
});

test('parity: an unknown command dies 2 with the bash message', { timeout: 120000, skip: SKIP }, () => {
  goldenScenario(SUITE, 'unknown-command', {
    steps: [{ args: ['nope'] }],
  });
});
