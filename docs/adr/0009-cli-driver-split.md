# CLI driver: one registry, two front-ends

The loop's enforcement lives in `workflows/` + `domain/state-machine.ts`, not in Pi.
`extension/registry.ts` is the single definition of every operation; `extension/index.ts`
binds it to Pi tools and `extension/cli/` binds it to argv, so the two front-ends cannot
desync. Any harness that can run a shell command can hold the orchestrator seat. Pi keeps
its exclusives — streaming `onUpdate` during wait, `sendUserMessage` kick, `/` autocomplete.
`workflow_wait` is bounded and resumable because host shell timeouts are shorter than role
timeouts; the authoritative deadline lives in `state.json`, not in process memory.
