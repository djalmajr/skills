// Golden (slice 9b-1): the entry-level scenarios run only the JS
// (`node scripts/herdr-agents.mjs`) and compare against the value stored
// once in test/golden/parity-entry.json (test/golden.mjs:
// HERDR_AGENTS_GOLDEN unset checks the JS value against the stored value, =update
// overwrites the stored value with the JS value for review). Scenarios: `help`,
// `-h`, `--help` and no command all print the constant usage text (stdout,
// rc 0, no Herdr needed); an unknown command (`nope`) dies 2 with the
// `unknown command '…'` message on stderr. None of these paths calls an
// external CLI, so the fixture carries no fakes.
import test from 'node:test';
import { goldenScenario } from './parity.mjs';

const SUITE = 'parity-entry';

test('parity: help, -h, --help and no command print the usage (rc 0)', { timeout: 120000 }, () => {
  goldenScenario(SUITE, 'help-variants', {
    steps: [
      { args: ['help'] },
      { args: ['-h'] },
      { args: ['--help'] },
      { args: [] },
    ],
  });
});

test('parity: an unknown command dies 2 with the bash message', { timeout: 120000 }, () => {
  goldenScenario(SUITE, 'unknown-command', {
    steps: [{ args: ['nope'] }],
  });
});
