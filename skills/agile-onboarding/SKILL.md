---
name: agile-onboarding
description: Onboarding guide for new team members in the agile flow with AI. Use when someone new joins the team and needs to understand how the planning, execution, and tracking flow works with AI agents.
compatibility: opencode
metadata:
  audience: engineering
  workflow: onboarding
---

# Onboarding

Use this skill to guide new team members through the agile + AI flow, in a practical and progressive way.

## Prompting

Follow the project-wide convention in `CLAUDE.md` / `AGENTS.md` ("Skill Prompting Conventions"). Use the harness's structured-question tool — `AskUserQuestion` (Claude Code), `ask_user_question` (Codex), or `question` (OpenCode) — for the decision points below.

| Decision point | Why structured | Suggested options |
|---|---|---|
| Role | Shapes the depth and skill set | Engineer · PM · Designer · Mixed |
| Skill-flow depth | Affects scope | Quick (intake → story) · Full (all skills) · Wiki-only |

Free-form prompts (no structured tool):

- Onboardee name
- Tenure / background notes

No-pause mode: if the user has explicitly disabled mid-skill clarification, convert every structured prompt into an entry under *Open questions* (or equivalent) and proceed without blocking.

## Objective

- Provide context about the operational model (Light Scrum + AI as pair)
- Teach the artifact flow in practice, not theory
- Ensure the new member can operate autonomously in 1-2 sprints
- Avoid onboarding being just documentation — it must include practice

## When to use

- New dev or manager joins the team
- Someone changes roles (dev becomes tech lead, for example)
- The team adopts the flow for the first time
- Someone needs retraining after time away

## Onboarding trail

### Day 1: Understand the model

**Objective:** know what exists and why.

1. Present the complete flow:
   ```mermaid
   flowchart LR
       A["/agile-intake"] --> B["/agile-roadmap"]
       B --> C["/agile-epic"]
       C --> D["/agile-story"]
       D --> E[execution]
       E --> F["/agile-status"]
       F --> G["/agile-retro"]
   ```

2. Explain the role division:
   - Human: decides, validates, controls git, communicates
   - AI: structures, implements, verifies, reports

3. Show the decision tree:
   - When to use task vs epic
   - Scope assessment (small to large)

4. Show the available skills and how to invoke each one:
   - `/agile-intake` — capture problems
   - `/agile-roadmap` — strategic direction
   - `/agile-epic` — decompose and structure initiatives
   - `/agile-story` — execution plans
   - `/agile-refinement` — validate artifacts and review code
   - `/agile-status` — track progress (checkpoint, consolidation, closure)
   - `/agile-sprint` — sprint planning
   - `/agile-review` — sprint review and demo
   - `/agile-metrics` — sprint metrics
   - `/agile-retro` — retrospective
   - `/agile-proto` — interactive prototypes
   - `/agile-router` — guidance on which skill to use

### Day 2: Practical exercise — intake and planning

**Objective:** create an intake and a simple plan with AI support.

Suggested exercise:

1. The new member chooses a small, real problem (bug, improvement, task)
2. Uses the `/agile-intake` skill to structure the problem
3. Decides the correct artifact with the decision tree
4. Uses `/agile-router` to validate the choice, then creates the plan with `/agile-story` or `/agile-epic`
5. The mentor/tech lead reviews and gives feedback

### Day 3: Practical exercise — execution with TDD

**Objective:** implement something using the task -> TDD -> verification flow.

Suggested exercise:

1. Take the plan created on day 2
2. Implement using TDD with AI as pair:
   - Describe the expected behavior
   - AI writes the test (red)
   - AI implements (green)
   - Dev requests refactoring if necessary
3. Run verifications (lint, types, tests)
4. Run `/agile-refinement` (code review mode) to review the diff before committing

### Day 4: Practical exercise — tracking

**Objective:** generate status updates and close with a report.

1. Use `/agile-status` (checkpoint mode) to generate a progress update
2. Simulate a `/agile-status` (consolidation mode) report for the period
3. Close the delivery with `/agile-status` (closure mode)
4. Review the complete chain: task -> execution -> status -> closure

### Day 5: Reflection and autonomy

**Objective:** assess if the new member is ready to operate autonomously.

1. The new member conducts an intake alone
2. Creates plan or epic without mentor help
3. Implements with TDD
4. Closes with status report
5. Mentor validates and gives final feedback

## Onboarding checklist

- [ ] Understands the complete flow (intake to retro)
- [ ] Knows how to choose the right artifact (decision tree)
- [ ] Can create task or epic with AI support
- [ ] Knows how to use TDD with AI as pair
- [ ] Knows how to generate status updates and closure reports
- [ ] Understands the responsibility division (human vs AI)
- [ ] Knows which skills are available and when to use each one
- [ ] Completed at least one full cycle (intake -> closure) with supervision

## Adaptation by profile

### For devs
- Focus on: TDD, pair programming with AI, quality gates, git workflow
- Extra exercise: implement a small feature from scratch using the flow

### For managers / scrum masters
- Focus on: roadmap, epic decomposition, sprint planning, retro, status reports
- Extra exercise: conduct an epic decomposition and sprint planning with AI support

### For tech leads
- Both focuses: planning and execution
- Extra exercise: review AI-generated code with `/agile-refinement` and give constructive feedback

## Rules

- Onboarding is not passive. The new member must practice, not just read.
- The mentor does not do it for the new member — guides and reviews.
- Onboarding mistakes are opportunities, not failures. The environment must be safe to experiment.
- If the new member cannot complete the checklist in 5 working days, the problem may be the process, not the person. Discuss in retro.

## Relationship with the flow

This skill acts as the entry point to all others. After onboarding, the member should be able to invoke `/agile-router`, `/agile-story`, `/agile-status`, `/agile-sprint`, and `/agile-retro` autonomously.
