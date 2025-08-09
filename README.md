## OoTMM-SeedBot

Discord bot to orchestrate OoTMM seed generation via the external OoTMM CLI.
The bot includes a queue system to limit amount of generations.
Slash Commands are used for interaction with users.

### Setup

1) Copy `config.example.json` to `config.json` and fill in values.
2) Ensure the OoTMM CLI is installed at `cliPath` and accessible with `pnpm run start:core`.
3) Install deps: `npm install`
4) Start the bot: `npm start`

Commands are registered for the configured `guildId` at startup.

### Commands

- `/prepare preset:<name>`: Runs generation and stores outputs into backlog.
- `/generate preset:<name>`: Uses a prepared seed if available, otherwise runs full generation, then posts `.ootmm` files.
- `/spoiler public:<boolean>`: Sends spoiler log (DM or channel with `public: true`).
