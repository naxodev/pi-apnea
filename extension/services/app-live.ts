import { Layer } from "effect";
import { ConfigLive } from "./config.ts";
import { FileSystemLive } from "./file-system.ts";
import { RunStoreLive } from "./run-store.ts";
import { VcsLive } from "./vcs.ts";

/**
 * Blueprint layer for tool calls. Built freshly on every `Effect.provide`
 * inside runTool — no module-level ManagedRuntime.
 */
export const AppLive = Layer.provideMerge(
	Layer.mergeAll(RunStoreLive, ConfigLive, VcsLive),
	FileSystemLive,
);
