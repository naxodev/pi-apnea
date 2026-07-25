import * as fs from "node:fs";
import { Context, Effect, Layer } from "effect";

export interface FileSystemService {
	readonly readFile: (path: string) => Effect.Effect<string>;
	readonly writeFile: (path: string, content: string) => Effect.Effect<void>;
	readonly rename: (from: string, to: string) => Effect.Effect<void>;
	readonly exists: (path: string) => Effect.Effect<boolean>;
	readonly mkdir: (
		path: string,
		opts?: { recursive?: boolean },
	) => Effect.Effect<void>;
	readonly remove: (path: string) => Effect.Effect<void>;
}

/**
 * Thin FS service. Unexpected IO failures are defects (orDie) — no FsError tag.
 */
export class FileSystem extends Context.Service<
	FileSystem,
	FileSystemService
>()("apnea/FileSystem") {}

export const FileSystemLive = Layer.succeed(
	FileSystem,
	FileSystem.of({
		readFile: (path) =>
			Effect.try({
				try: () => fs.readFileSync(path, "utf8"),
				catch: (e) => e,
			}).pipe(Effect.orDie),

		writeFile: (path, content) =>
			Effect.try({
				try: () => {
					fs.writeFileSync(path, content, "utf8");
				},
				catch: (e) => e,
			}).pipe(Effect.orDie),

		rename: (from, to) =>
			Effect.try({
				try: () => {
					fs.renameSync(from, to);
				},
				catch: (e) => e,
			}).pipe(Effect.orDie),

		exists: (path) => Effect.sync(() => fs.existsSync(path)),

		mkdir: (path, opts) =>
			Effect.try({
				try: () => {
					fs.mkdirSync(path, { recursive: opts?.recursive ?? true });
				},
				catch: (e) => e,
			}).pipe(Effect.orDie),

		remove: (path) =>
			Effect.try({
				try: () => {
					fs.rmSync(path, { force: true });
				},
				catch: (e) => e,
			}).pipe(Effect.orDie),
	}),
);
