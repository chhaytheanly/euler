# euler

A provider-agnostic coding agent for the terminal. Paste an API key once, pick a
model from the provider's live model list, then ask it to inspect, search, edit,
and run things in your project. Tool calls, diffs, approvals, and file undo live
inside a polished boxed chat UI.

```text
╭──────────────────────────────────────────────────────────────────────────────╮
│ ›  explain this function                                                      │
│ enter send  ·  ctrl+j newline  ·  / commands  ·  ctrl+c exit                 │
╰──────────────────────────────────────────────────────────────────────────────╯
 ● OpenAI / gpt-4.1                                                        ↑1.2k ↓340
```

## Quick start

```bash
npm install
npm run dev          # run the TypeScript source directly
npm run build        # bundle to dist/index.js
npm link             # make `euler` available on PATH
```

Requirements: Node.js 22 or newer. The interactive UI needs a TTY.

```bash
euler                # launch chat
euler setup          # force the connection wizard
euler models         # list models for the default provider
euler providers      # show catalog + connection state
euler config         # show config paths
```

## What the CLI does

### First run

If no provider is configured, the CLI opens a setup flow:

1. Choose from the bundled provider catalog or a custom endpoint.
2. Paste an API key (masked input). Local providers skip this step.
3. Fetch the provider's models, search them, and pick a default.
4. Start chatting. The provider and model are saved.

Keys can also come from environment variables. A key pasted into the CLI wins
over the environment variable, so a stale shell export does not block you.

### Chat UI

- Boxed user and assistant messages with role headers, timestamps, and model
  metadata.
- Streaming responses with a live spinner, elapsed time, and token estimate.
- Markdown rendering: headings, lists, quotes, inline code, links, and fenced
  code blocks.
- Reasoning/thinking streams are shown in a dim block when a provider sends
  them (`reasoning_content`, `reasoning`, or Anthropic `thinking_delta`).
- Assistant messages scroll into the terminal's native scrollback via Ink
  `Static`, while only the active response re-renders.
- Cancel a streaming response, running tool, or approval with `esc` or
  `ctrl+c`.

### Agent tools

The model can call tools in a loop (up to 8 iterations), see their results, and
keep working:

| Tool | Approval | What it does |
| --- | --- | --- |
| `list_files` | auto | Show workspace files and directories |
| `read_file` | auto | Read a text file with line numbers |
| `search_code` | auto | Find a literal string across text files |
| `git_status` | auto | Show the branch and changed files |
| `git_diff` | auto | Show unstaged or staged diffs |
| `write_file` | ask | Create or fully overwrite a file |
| `edit_file` | ask | Replace an exact block of text |
| `run_command` | ask | Run a shell command in the workspace root |

Read-only tools run immediately. Writes and commands open an approval box with
a unified diff or the exact command, working directory, and timeout. Press `y`
to approve, `n` or `esc` to deny. A denial is returned to the model as a tool
result, so it can adapt instead of retrying blindly.

Tool calling needs a model that supports function/tool calling. Most current
hosted models do; some local or older models do not. The provider adapters send
tools in each provider's native format.

Finished tool calls become compact cards in the transcript with their status,
duration, and truncated output. Running tools appear live above the prompt.

Every successful write or edit is backed up under the config directory before it
happens. `/undo` restores the previous contents (or removes a file that did not
exist before). Undo is intentionally limited to changes made in the current
session.

### Safety

- Tool paths resolve inside the workspace root. Absolute paths, `..` escapes,
  and symlinks that leave the workspace are rejected.
- Secret-like files (`.env`, SSH keys, `.git`, credentials, and similar) are
  blocked from reads, search, listing, and writes.
- Reads, search results, and command output are capped and truncated with a
  clear marker.
- Commands have a timeout and are killed when you cancel. They still run with
  your user account, so approve them carefully.
- The agent never executes tool calls that you deny.

### Input handling

- `enter` sends.
- `ctrl+j`, `alt+enter`, or `shift+enter` inserts a newline.
- `esc` clears the current input; when empty it cancels a stream.
- `↑` / `↓` recall prompt history on a single line; multiline input uses
  vertical cursor movement.
- `ctrl+w` deletes a word, `ctrl+u` clears the input.
- `/` opens command hints; `tab` completes a command.
- `ctrl+c` twice exits from chat.

### Commands

| Command | What it does |
| --- | --- |
| `/help` | Commands and keyboard shortcuts |
| `/model [id]` | Open the model picker, or switch directly |
| `/models` | Browse models from the current provider |
| `/provider` | Connect or switch a provider |
| `/key` | Replace the saved key for this provider |
| `/new` | Start a fresh conversation |
| `/clear` | Reset the conversation (alias of `/new`) |
| `/config` | Paths, endpoint, model, and key source |
| `/status` | Message count, token usage, agent state, and workspace |
| `/tools` | Available tools and their approval policies |
| `/undo` | Restore the last file write or edit |
| `/about` | Version and storage note |
| `/quit` | Exit (`/exit` and `/q` also work) |

## Providers

The catalog is in `src/configs/catalog.ts`:

- OpenAI
- Anthropic (native Messages API)
- OpenRouter
- Google Gemini (OpenAI-compatibility endpoint)
- DeepSeek
- Groq
- Mistral
- xAI
- Ollama (local)
- LM Studio (local)
- Custom OpenAI-compatible endpoint

Each entry declares its protocol, base URL, models path, chat path, auth style,
and whether a key is required. The registry creates the right adapter from the
saved config.

## Configuration

Files live under `~/.config/euler` by default:

| File | Contents |
| --- | --- |
| `config.json` | Providers, default provider, default model |
| `credentials.json` | Pasted API keys, keyed by provider id |
| `backups/` | Per-session pre-write file backups used by `/undo` |

Both JSON files are written with mode `600`; the directory is created with mode
`700` and backup session directories use mode `700`. Set `EULER_CONFIG_DIR` to
point at another directory (useful for testing).

## Project layout

```text
src/
  index.tsx                  CLI entry point and non-interactive commands
  agent/
    systemPrompt.ts          Workspace-aware agent instructions
  cli/
    App.tsx                  Boot, setup/chat routing, config mutations
    useChat.ts               Agent loop, approvals, tool activity, undo
    commands.ts              Slash commands and autocomplete
    theme.ts                 Colors
    utils.ts                 Formatting helpers
    components/
      ChatScreen.tsx         Static transcript + live stream + prompt
      Setup.tsx              Provider/key/model onboarding
      MessageView.tsx        Message boxes and metadata
      ToolCard.tsx           Tool status, duration, and output
      ApprovalPanel.tsx      y/n approval with diff/command preview
      Markdown.tsx           Lightweight Markdown renderer
      PromptInput.tsx        Multiline input, history, completion
      SelectList.tsx         Searchable list with keyboard navigation
      TextPrompt.tsx         Single-line masked input
      StatusBar.tsx          Provider/model/state/token footer
      HelpPanel.tsx          /help modal
  configs/
    catalog.ts               Provider catalog
    config.ts                Config + credentials persistence
  tools/
    index.ts                 Tool schemas, execution, and previews
    workspace.ts             Path sandbox, file IO, walking, limits
    journal.ts               Backups and /undo
  providers/
    registry.ts              Protocol -> adapter
    openai-compatible.ts     OpenAI-compatible chat + models + tools
    anthropic.ts             Anthropic Messages API + tool blocks
    ollama.ts                Ollama chat + tags + tool calls
    http.ts                  URL/header/SSE helpers
  interfaces/type.ts         Shared types, including tool contracts
```

## How the agent loop works

One user turn can contain several model/tool round trips:

```text
user message
  -> model (with tool schemas)
  -> stream text and accumulate complete tool calls
  -> read-only tool: execute immediately
  -> write/edit/command: preview -> ask y/n -> execute
  -> append the tool result to the conversation
  -> model again
  -> stop on a text-only response or after 8 iterations
```

The loop lives in `src/cli/useChat.ts`. Provider adapters only translate the
shared `ToolDefinition`, `ChatMessage.toolCalls`, and tool-result messages:

- OpenAI: `tools`, `tool_calls`, `role: "tool"`, `tool_call_id`.
- Anthropic: `tools`, `tool_use`, and `tool_result` content blocks with
  alternating user/assistant turns.
- Ollama: `tools`, `message.tool_calls`, and `tool_name` on tool results.

Streamed argument fragments are accumulated in the adapter and emitted as one
complete `tool_call` event, so the loop never parses partial JSON.

## Backups and undo

Before a write or edit, the previous file contents are copied to:

```text
~/.config/euler/backups/<session>/
```

`/undo` restores the most recent backup. If the file did not exist before the
change, `/undo` removes it instead. The journal is intentionally in-memory for
the session: restarting `euler` starts a fresh undo history. Backups are removed
as they are used and the journal is capped so it cannot grow without bound.

## Future: web search

The tool contract is now general enough to add network tools without changing
the UI or the loop. A good next step is one `web_search` tool plus an optional
`fetch_url` tool:

| Option | Good fit | Notes |
| --- | --- | --- |
| Tavily | Agent search | Search + extract, concise answer, citations |
| Exa | Semantic/neural search | Strong for research and similar-page discovery |
| Brave Search API | Broad web index | Independent index, straightforward JSON |
| Serper (Google) | Google-like results | Fast, includes knowledge graph/answer boxes |
| Bing Web Search | Enterprise/global | Rich results, Azure billing |
| Provider-native search | Lowest setup | OpenAI/OpenRouter/Anthropic hosted search, less control |

If you add web tools, treat page content as untrusted: never execute
instructions found in pages, block localhost/private IP ranges for `fetch_url`
(SSRF), cap response size, strip HTML, enforce timeouts, and show the query or
URL in the approval preview.

## Reliability notes

- Tool output, file reads, search results, and command output are capped at
  20,000 characters with an explicit truncation marker.
- Commands time out after 120 seconds by default (600 seconds maximum) and are
  killed when the run is cancelled.
- Malformed tool arguments, unknown tools, missing files, and git failures are
  returned to the model as tool errors instead of crashing the session.
- The loop stops after 8 iterations so a model cannot spin forever; ask it to
  continue when you want another round.
