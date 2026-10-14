# Contributing

Thanks for helping. The project runs on people's own machines with their own tokens and folders, so the one hard rule is: **nothing personal or secret ever reaches the repository**.

## Development setup

```bash
git clone https://github.com/LQLManZz/discord-ai-chatroom.git
cd discord-ai-chatroom
npm install        # also enables the privacy git hooks (.githooks)
npm run setup      # your own .env, never committed
npm test
```

Use a separate Discord server for development: the bot creates and edits channels.

## Where personal things live

| What | Where | Committed? |
|---|---|---|
| Token, channel and user IDs, models, folders, language | `.env` | never |
| Channel IDs of your server, job logs, bot log, autonomy folders | `.chatroom/` | never |
| Files the agents create | `workspace/` and your project folders | never |
| Extra words you never want published (project names, company names…) | `.privacy-blocklist`, one per line | never |
| Shared defaults | `.env.example`, code | yes |

When a feature needs a value that differs per machine, read it from an environment variable with a neutral default and document it in `.env.example`. Do not hard-code paths, IDs, names or model choices from your setup.

## Privacy guard

`npm install` points git at `.githooks/`:

- **pre-commit** scans the lines you are about to commit.
- **pre-push** scans every tracked file, then runs the tests.

They block Discord/GitHub/OpenAI/Anthropic/Google/AWS tokens, private keys, webhook URLs, and anything personal learned from *your* machine: values in your `.env`, your home folder path, your git email, the workspace folders you registered with the bot, and the terms in `.privacy-blocklist`. That list is built locally each time and never stored in the repo.

Run it by hand with `npm run privacy`. If it flags something, move the value to `.env` or remove it. Do not bypass the hooks.

> [!TIP]
> Commit with GitHub's private address so your real email is not published: `git config user.email "<id>+<username>@users.noreply.github.com"` (shown in GitHub → Settings → Emails).

## Pull requests

1. Branch from `main`, keep changes focused.
2. Add or update tests in `test/` (they use fake agents, so they cost no quota).
3. User-facing text goes through `t()` in [src/i18n.js](src/i18n.js), in both English and Vietnamese; `npm test` checks the two stay in sync.
4. `npm test` and `npm run privacy` pass.
