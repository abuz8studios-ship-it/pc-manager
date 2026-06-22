# ABU Master PC Manager

A small local dashboard (port `9100`) that fuses:

- Microsoft PC Manager–style health/boost/cleanup/storage/startup
- Claude Code token & spend dashboard (reads `./.shared/cost_log.sqlite`)
- AI framework detection (Ollama, LM Studio, ComfyUI, …)
- Agentic framework detection + control (Claude Code, Hermes, etc.)
- Cloud provider auth/credit/model status

By ABUZ8 LLC.

## Run

```bash
npm install
cp .env.example .env   # then edit .env
node src/server.js
```

Open http://127.0.0.1:9100

## Configuration

All secrets are read from the environment — **nothing is hard-coded**. See
[`.env.example`](./.env.example). The only sensitive value is
`ABU_WSL_SUDO_PASS`, used solely to start/stop the `hermes-qadir` WSL service;
leave it blank to disable those privileged actions (status still works).
