# Pi

Pi runs through the [pi-acp](https://github.com/svkozak/pi-acp) bridge on the
machine running your environment. Install and configure Pi first, then enable
Pi in **Settings > Providers**.

```bash
npm install -g @earendil-works/pi-coding-agent pi-acp
pi
```

Use Pi's own setup to choose a model and add API keys. T3 Code does not manage
Pi credentials. The bridge must also be on the server's `PATH`; set **ACP bridge
executable** if it is not. To avoid a global bridge install, set that field to
`npx` and **Bridge arguments** to `-y pi-acp`.

## Models and approvals

T3 Code starts with Pi's configured default model. Add model ids as custom
models if you want to switch from the composer. Pi runs tools using its own
approval configuration, so T3 Code's permission modes do not restrict Pi's
built-in tools.

Pi sessions can use Pi skills, extensions, and MCP servers that you configure in
Pi. T3 Code's own MCP tools are not available to Pi through this bridge.

## Sessions

Pi keeps sessions and history under `~/.pi/agent`. T3 Code resumes Pi sessions
through the bridge's session map and uses `/compact` for manual compaction.
