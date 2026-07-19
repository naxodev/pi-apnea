/** Re-exports + async wait helpers for the wait tool */
export {
	herdrEnabled,
	paneGet,
	paneAlive,
	paneRun,
	paneSendKeys,
	sleepMs,
} from "./herdr.ts";
export { abs } from "./paths.ts";

/** Non-blocking sleep (does not freeze the Node event loop). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const t = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(t);
			reject(new Error("aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
