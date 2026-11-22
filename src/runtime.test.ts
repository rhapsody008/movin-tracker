import { expect, it } from "vitest";

it("runs on the pinned Node 24 major", () => {
	expect(Number.parseInt(process.versions.node, 10)).toBe(24);
});
