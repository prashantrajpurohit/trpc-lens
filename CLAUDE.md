# trpc-lens: project rules

## Git
- Commit only when I have approved the step, using the exact message I provide.
- Never push. Never change branches, rebase, reset, merge, or edit git config.
- Never add a Co-Authored-By trailer, a "Generated with Claude Code" line, or any mention of Claude or AI to commit messages or PR text.
- Stage only the files belonging to the current step. Never use `git add -A` or `git add .`.
- Before committing, show `git diff --stat` so I can check for stray files.

## Security (this package will run inside organization projects)
- Memory only: never write captured event data to disk.
- Never log event contents (inputs, outputs, URLs, payloads). Logs may contain counts, roles, and rejection reasons only.
- No outbound network calls and no telemetry.
- The inspector runs only when `TRPC_INSPECTOR=1` and `APP_ENV` is `development` or `uat`. Production must never run it. Do not use `NODE_ENV` as the gate.
- All captured data must be sanitized (redaction, size limits) before leaving the process. Shape-only mode is the default and full values are allowed only in development.
- Never read or print `.env*` files or the bridge token. Show only the token file path.

## Working rules
- Add only the dependencies the current step names. Ask before adding anything else.
- Do not claim something works until you have run it and shown the output.
- Report any deviation from the spec, and anything you could not test.
