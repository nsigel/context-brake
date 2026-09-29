# Context Brake

Context Brake watches an AI coding session's context size and last model activity. Before a costly prompt on a likely expired cache, it offers a choice: continue the current session or compact its transcript and resume in a fresh one.

It works with Codex and Claude Code. The local hook service reads their transcript files without changing them. A separate compaction server turns a normalized transcript into a handoff summary using DeepSeek V3.2 on AWS Bedrock.

## The idea

A long coding session can be cheap to continue while its prompt prefix is cached. After the cache expires, the next request may pay to process that prefix again. Context Brake uses the last usage event as a **cache-age estimate**, then compares the estimated full context with an 8,000-token handoff. If the estimated gross savings exceed a threshold, it blocks one prompt and explains the choice. Resubmitting continues the original session; `context-brake relay <session-id>` creates a summary and starts a new session in the same working directory.

Unknown models, unreadable transcripts, and unavailable services fail open.

## Methodology and results

| Measurement | Method | Result |
| --- | --- | --- |
| Native compaction size and duration | A local scan read usage metadata from 129 Claude auto-compaction events: pre-compaction tokens, summary length, and duration. Summary tokens were approximated as characters ÷ 4. | About 167,000 input tokens and 3,000 estimated summary tokens per event; mean duration about 104 seconds (observed range 62–193 seconds). |
| Brake decisions | The [decision test](apps/context-brake/test/eval.test.ts) generates 12 labeled fresh, stale, small, large, and unknown-model transcripts, then runs them through the parser and evaluator. | 12 of 12 expected block/continue decisions pass. |

The savings estimate uses `max(0, context tokens − handoff tokens)` multiplied by the configured cache-write rate. For example, reducing a 150,000-token context to 8,000 tokens avoids about 142,000 tokens on the next request. At the example rate of $6.25 per million tokens, that is **$0.89 in estimated gross savings**. The rates are set in [policy.ts](apps/context-brake/src/policy.ts) and [config.ts](apps/compaction-server/src/config.ts).

## Run locally

Requires Bun 1.3 or newer. Compaction also requires AWS credentials with Bedrock access to DeepSeek V3.2.

```bash
bun install
bun run build
bun run dev                    # local hook service, port 7788
```

In a second terminal:

```bash
bun run dev:compaction-server  # Bedrock service, port 7790
```

Check `http://127.0.0.1:7788/healthz` and `http://127.0.0.1:7790/healthz`. The compaction server uses the standard AWS credential chain and defaults to `us-east-1`. You can also run it with `docker compose up --build compaction-server`; Compose mounts your AWS configuration read only.

To use the relay command from any directory, run `cd apps/context-brake && bun link` after building. The command contacts the local service, prepares a reduced transcript, asks the compaction server for a summary, and launches Codex or Claude Code with that summary. It leaves the original session unchanged. Transcript content sent for compaction goes to AWS Bedrock; decide whether that is appropriate for your data before using relay.

## Connect a coding agent

- **Codex:** Merge the hook groups from [codex-hooks.json](apps/context-brake/examples/codex-hooks.json) into your user or project `hooks.json`. Replace the example command path with this checkout's absolute path, then restart Codex and trust the command hook.
- **Claude Code:** Merge the hook groups from [claude-settings.json](apps/context-brake/examples/claude-settings.json) into your user or project settings, then restart Claude Code.

The examples do not install themselves or change your settings. Remove those hook groups to disable Context Brake.

The service URLs default to `http://127.0.0.1:7788` and `http://127.0.0.1:7790`. Use `CONTEXT_BRAKE_API_URL` for the relay command and Codex hook adapter when the local service uses another address; use `CONTEXT_BRAKE_COMPACTION_URL` for the compaction server. `CONTEXT_BRAKE_MIN_SAVINGS_USD` defaults to `0.05`. See [policy.ts](apps/context-brake/src/policy.ts) and [config.ts](apps/compaction-server/src/config.ts) for other defaults.

## Develop

```bash
bun run test
bun run typecheck
bun run build
```

The workspace has two apps: `apps/context-brake` for hooks, usage estimates, local session state, and relay; `apps/compaction-server` for the Bedrock call. Session metadata lives in a local SQLite file. Prompts and transcript contents are not stored there or written to request logs.

## License

MIT. See [LICENSE](LICENSE).
