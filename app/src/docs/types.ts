// The document types every docs module shares: one page's size and text, the
// word boxes of a drawing, and a region of a page. Port of internal/docs
// (index.go's Page/Word/Region and render.go's Region.Valid); the index types
// come with T1.5b. Field order is Go's struct order, because it is the JSON
// byte order of docs/text/<path>.json, which the Go app still reads.

/** One page's size (as displayed) and text. Words are kept for drawings so a crop can say what is written inside it. */
export interface Page {
	/** 1-based. */
	n: number;
	/** PDF points, as displayed: /Rotate 90 and 270 swap w and h. */
	w: number;
	h: number;
	text: string;
	/** Only for drawings (pages of at least wordsMinArea); absent otherwise. */
	words?: Word[];
}

/** One word with its box in points, origin top-left, in the same rotated space as the rendered page. */
export interface Word {
	t: string;
	/** x0, y0, x1, y1. */
	b: [number, number, number, number];
}

/** Part of a page as fractions of its as-displayed width and height, origin top-left: {0,0,1,1} is the whole page. */
export interface Region {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Region.Valid: inside the page and not empty. */
export function regionValid(r: Region): boolean {
	return r.x0 >= 0 && r.y0 >= 0 && r.x1 <= 1 && r.y1 <= 1 && r.x1 - r.x0 > 0.001 && r.y1 - r.y0 > 0.001;
}
