# Prototype sources for front-end TDD

Read from `SKILL.md` step 1 when a front-end change may have prototype evidence.

## Agile-Proto source

Discover browser prototypes in established project locations such as `planning/*/proto/` and `{app}/client-proto/`. Read their stable scene IDs/routes and inspect actual `htm-ui/<module>.js` imports. Those imports are direct component evidence:

- `htm-ui/button.js` maps to the maintained HTM UI Button module;
- prototype-specific composition files are compositions, not a copied primitive catalog;
- custom markup without a maintained import is an unresolved mapping warning, not a reason to stop.

Use the prototype's observable behavior and route flow as interaction evidence. Confirm production equivalents from the target app's installed component system and repository conventions rather than mechanically copying prototype-only markup.

## Agile-Design source

Read `planning/<initiative>/design/README.md` (the prototype index) and the paired notes it summarizes. Screen and state IDs, triggers, action destinations, and visible rules are behavior evidence for the tests. The design file itself is visual reference only: there is no design-to-code component mapping, so component choice comes from the target app's installed component system and `/design-workflow`.

## When both sources exist

Build a combined source map for the target story or screen:

1. match by stable planning/story/requirement IDs and screen/scene purpose;
2. use Agile-Design notes for states, transitions, and visible rules;
3. use Agile-Proto imports and runtime interactions for browser behavior and HTM UI identities;
4. prefer an already installed production component when either source maps to it;
5. when sources disagree, warn and choose the source closest to the target acceptance criteria and current product code. Ask the user only when the disagreement changes user-visible behavior or scope materially.

Never refuse implementation solely because a prototype is absent, incomplete, stale, or represented in more than one format. The AI should use every available signal, state its confidence where useful, and proceed with the best supported component choice.
