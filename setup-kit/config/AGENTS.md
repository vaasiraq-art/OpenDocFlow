# Global rules for all projects

## Language
- Reply in the same language the user writes in (Arabic or English).
- Keep replies short and direct. Do the work, then give a 2-3 line summary.

## Workflow
- For any new app: state a short plan (max 5 lines), then build it without waiting for approval.
- Create each app in its own subfolder inside the current directory. Never write outside it.
- Work in small steps. After each step, run the code and fix errors before continuing.
- Always finish with a working app and the exact command to run it.
- Prefer simple, popular stacks (plain HTML/CSS/JS, Python, or Node) unless told otherwise.

## Code quality
- Write clean, commented-where-needed code. No placeholder or fake code.
- Add a README.md with run instructions for every app.
- Keep secrets (API keys) in a .env file. Never hardcode them or commit them.

## Safety
- Never delete or overwrite existing files without asking first.
- Do not install system-wide tools. Use project-local dependencies.
- Ask only when truly blocked; otherwise make a reasonable choice and say what you chose.

## Free-API friendly
- Free model quotas are limited: avoid reading huge files or dumping long outputs.
- Be concise in reasoning and edit only the files that need changes.
