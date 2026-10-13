# VelvetSharp × AI agents (MCP)

VelvetSharp ships a **Model Context Protocol** server so your AI assistants —
Claude Desktop, Claude Code, Cursor, Cline, Windsurf, any MCP client — can ask
the **running editor** what it sees and then fix things with their own tools:

| Tool | What the agent gets |
|------|---------------------|
| `get_workspace_summary` | root, file/script counts, error/warning totals, assemblies, Unity API status — call first |
| `get_problems` | every syntax error / warning the Problems bar shows (including unsaved buffers), compiler-style: `File(line,col): ERROR CS1002: …` |
| `get_project_structure` | the workspace file tree (optionally scoped to a folder) |
| `search_code` | the same find-in-files engine as Ctrl+Shift+F — literal / whole-word / regex |
| `get_file` | file content (or a line range); returns the **live buffer** when the file is open with unsaved changes |
| `apply_payload` | **write access** — create / modify / delete / move text files in one call (same engine as the Agent Bridge window); returns a per-operation report |

Typical agent loop: *get_workspace_summary → get_problems → fix the errors with
`apply_payload` (or your own tooling) → get_problems again to confirm the list
shrank.* Because the answers come from the **live editor**, the agent sees the
same errors you do — no second analyzer, no drift.

**Web AI agents** (ChatGPT, Claude.ai, Gemini — no MCP access) use the editor's
**Agent Bridge** instead: `⧉ Structure → AI` copies the project structure
(you pick the folders; optionally with file contents) plus the JSON contract,
and `⇩ Apply JSON ← AI` applies the agent's JSON reply with the same
create/modify/delete/move operations, then hands you a copyable report to paste
back into the chat.

## Requirements

- VelvetSharp **running** with your Unity project open (tools answer from the live editor)
- Node.js ≥ 16 on the machine running the agent (`node mcp/server.mjs`)

## Setup

The server lives in the VelvetSharp folder (portable zip: next to
`VelvetSharp.exe`; from source: `<repo>/mcp/server.mjs`). Zero dependencies —
no `npm install`.

**Claude Desktop** — `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "velvetsharp": {
      "command": "node",
      "args": ["C:\\path\\to\\VelvetSharp\\mcp\\server.mjs"]
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add velvetsharp -- node "C:\path\to\VelvetSharp\mcp\server.mjs"
```

**Cursor / Cline / Windsurf** — same shape in their MCP config:
command `node`, args `["…/mcp/server.mjs"]`.

### Port discovery

The editor's Neutralino port is random per launch. VelvetSharp publishes its
connection info at boot to the discovery file next to your settings:

- Windows: `%APPDATA%\VelvetSharp\mcp.json`
- macOS: `~/Library/Application Support/VelvetSharp/mcp.json`
- Linux: `~/.local/share/VelvetSharp/mcp.json` (fallbacks: `~/.config/VelvetSharp/mcp.json`, `~/.velvetsharp/mcp.json`)

The file carries `{port, pid, phase, root, token}` — the token is the editor's
**own session token** (Neutralino hands the one-shot token to the first fetcher
— the editor page — so the proxy cannot get a second one any other way). The
token only opens a WebSocket to `127.0.0.1` on that port: it reaches exactly
the same local APIs the editor itself has, and nothing leaves your machine.
The proxy reads that file automatically. If you run multiple instances or want
to pin one, force it:

```bash
node server.mjs --port 12345          # or: VELVETSHARP_MCP_PORT=12345
node server.mjs --config D:\path\mcp.json
```

## Test it by hand (no agent needed)

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"capabilities":{}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_workspace_summary","arguments":{}}}' \
  | node mcp/server.mjs
```

Each line prints one JSON-RPC response on stdout. Protocol notes: stdio
framing is newline-delimited JSON-RPC 2.0; stdout carries protocol messages
only, human-readable logs go to stderr.

## How it works (for the curious)

The editor's Neutralino server can't host custom HTTP routes, so the proxy
speaks the editor's own WebSocket protocol: it takes the session token from
the discovery file, connects to `ws://127.0.0.1:<port>`, and the two sides
exchange `vsMcpRequest` / `vsMcpResponse` broadcasts (via the `events.broadcast`
native method). The answering side is the editor page itself
(`app/src/mcp-server.ts`), so every tool reflects exactly what the editor's
brain engine + Problems bar hold right now. Everything stays on `127.0.0.1` —
nothing leaves your machine.
