// The Documents tab's view. Port of docsView (internal/server/docs.go:11-39),
// which T2.1 needs for the SSE `docs` event and T2.2's GET /api/docs reuses.
//
// The body is a Go struct: on, running, lastSync (omitted until the index has
// one), docs. Each document is the index record flattened (Go embeds docs.Doc)
// with its name and folder appended, so the page can show a tree.

import { type Doc, docFolder, docName, encodeDocValue, encodeSyncValue, type Sync } from "../docs/index.ts";
import type { Syncer } from "../docs/sync.ts";
import { Ordered } from "../gojson.ts";

/** The view, ready for goMarshal. Throws when the index cannot be read, as Go's error does. */
export async function docsView(syncer: Syncer | null): Promise<Ordered> {
	// The documents feature is off: on false, running false, no documents ever.
	if (syncer === null) {
		return new Ordered([
			["on", false],
			["running", false],
			["docs", []],
		]);
	}
	const running = syncer.running();
	const ix = await syncer.index();
	const fields: [string, unknown][] = [
		["on", true],
		["running", running],
	];
	const last: Sync | null = ix.lastSync;
	if (last !== null) fields.push(["lastSync", encodeSyncValue(last)]);
	fields.push(["docs", ix.docs.map(docView)]);
	return new Ordered(fields);
}

/** docView is one record with its name and folder: Go's embedded struct plus two fields. */
function docView(d: Doc): Ordered {
	return new Ordered([...encodeDocValue(d).entries, ["name", docName(d)], ["folder", docFolder(d)]]);
}
