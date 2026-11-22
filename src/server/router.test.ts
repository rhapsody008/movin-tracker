// The router on its own: the three Go ServeMux rules the API depends on
// (server-spec §9.5, §9.6) and the path cleaning that decides when a request is
// redirected before it is routed. The end-to-end halves are in the transcript
// test; these are the unit cases that name the rule that broke.
import { describe, expect, it } from "vitest";
import { cleanPath, createRouter, type Handler } from "./router.ts";

const nowhere: Handler = () => undefined;

describe("cleanPath (Go's net/http)", () => {
	it("folds duplicate slashes, dots and dot-dots and keeps a trailing slash", () => {
		expect(cleanPath("")).toBe("/");
		expect(cleanPath("/")).toBe("/");
		expect(cleanPath("//api//entries")).toBe("/api/entries");
		expect(cleanPath("/api/entries")).toBe("/api/entries");
		expect(cleanPath("/api/entries/")).toBe("/api/entries/");
		expect(cleanPath("/a/./b")).toBe("/a/b");
		expect(cleanPath("/a/../b")).toBe("/b");
		expect(cleanPath("/..")).toBe("/");
		expect(cleanPath("/api/%2Fentries")).toBe("/api/%2Fentries");
	});
});

describe("the method and pattern match", () => {
	it("serves HEAD from the GET route", () => {
		const router = createRouter();
		router.add("GET", "/api/entries", nowhere);
		expect(router.match("GET", "/api/entries")).not.toBeNull();
		expect(router.match("HEAD", "/api/entries")).not.toBeNull();
	});

	it("answers nothing for an unnamed method, so the caller's catch-all does (no 405)", () => {
		const router = createRouter();
		router.add("GET", "/api/entries", nowhere);
		// Go has no 405 here: the pattern "/" of the api mux takes every method.
		expect(router.match("PUT", "/api/entries")).toBeNull();
		expect(router.match("POST", "/api/meta")).toBeNull();
	});

	it("captures one whole segment as {id} and unescapes it once", () => {
		const router = createRouter();
		router.add("PATCH", "/api/entries/{id}", nowhere);
		expect(router.match("PATCH", "/api/entries/01ARZ3NDEKTSV4RRFFQ69G5FAV")?.id).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
		// The page sends encodeURIComponent(id), so an id with a slash arrives as %2F.
		expect(router.match("PATCH", "/api/entries/a%2Fb")?.id).toBe("a/b");
		// One segment only: an id with a real slash does not match.
		expect(router.match("PATCH", "/api/entries/a/b")).toBeNull();
		// Nor does an empty one.
		expect(router.match("PATCH", "/api/entries/")).toBeNull();
		// A bad escape is left as sent, as Go's unescape does.
		expect(router.match("PATCH", "/api/entries/%zz")?.id).toBe("%zz");
	});

	it("matches a literal against the escaped segment, as Go does", () => {
		const router = createRouter();
		router.add("GET", "/healthz", nowhere);
		expect(router.match("GET", "/healthz")).not.toBeNull();
		// Go matches on r.URL.EscapedPath(); "%68" is not the letter h to it.
		expect(router.match("GET", "/%68ealthz")).toBeNull();
	});

	it("needs a pattern that starts with a slash", () => {
		const router = createRouter();
		expect(() => {
			router.add("GET", "api/entries", nowhere);
		}).toThrow(TypeError);
	});
});
