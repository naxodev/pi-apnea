import { Layer } from "effect";
import { FileSystemLive } from "./file-system.ts";
import { RunStoreLive } from "./run-store.ts";

/**
 * Blueprint layer for tool calls. Built freshly on every `Effect.provide`
 * inside runTool — no module-level ManagedRuntime.
 */
export const AppLive = Layer.provideMerge(RunStoreLive, FileSystemLive);
