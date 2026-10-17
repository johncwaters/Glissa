# Glissa repository

Instructions for carbon units editing Glissa, a personal-assistant runtime.

## Map

- `prompts/runtime.md`: runtime rules.
- `prompts/persona.md`: default voice.
- `hooks/guard-writes*.mjs`: PreToolUse write guard enforcing the Write policy, pinned by `hooks/guard-writes.test.mjs`.
- `scripts/`: CLIs.
- `.claude/skills` and `.claude/agents`: the runtime's skills and subagents.
- `systemd/`: units.

## Invariants

- A change to a runtime rule in `prompts/runtime.md` that the guard enforces must change the guard and its test in the same commit, because prose and enforcement must agree.
- `memory/` and `calendar-allow.json` are personal data and never committed.
- Prose names the operator as "the operator", never by a personal name, because the operator's name comes from config at launch.
