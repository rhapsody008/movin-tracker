// Test helper (nosdk.test.ts): record every module a process resolves, so a test
// can prove what loading src/main.ts pulls in. Not used by the app.
//
// node:module's synchronous hooks are the reliable way on Node 24: they run for
// every specifier the loader resolves, including the ones inside a package.

import { registerHooks } from "node:module";

const resolved: { specifier: string; url: string }[] = [];
let started = false;

/** start installs the hook; call it before importing the module graph. */
export function start(): void {
	if (started) return;
	started = true;
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const result = nextResolve(specifier, context);
			resolved.push({ specifier, url: result.url });
			return result;
		},
	});
}

/** loaded is every distinct module URL the process resolved. */
export function loaded(): string[] {
	return [...new Set(resolved.map((one) => one.url))].sort();
}
