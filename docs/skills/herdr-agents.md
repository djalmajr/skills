# herdr-agents (moved)

The `herdr-agents` skill moved to its own repository,
[djalmajr/herdr-soho](https://github.com/djalmajr/herdr-soho), and is now
named `herdr-soho` (skill, CLI and optional Herdr plugin). This repository
no longer distributes it.

Replace a global installation:

```bash
bunx skills remove herdr-agents -g -y
bunx skills add djalmajr/herdr-soho --skill herdr-soho -g
```

Projects set up with `herdr-agents` keep working during the transition:
`herdr-soho` still reads the old configuration, environment and state
names, and `herdr-soho setup` replaces the old instruction block and hooks
in place. See the herdr-soho README for the migration steps.
