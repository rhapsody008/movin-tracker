// Images on the OpenAI-compatible wire. Port of llm.Image and imageParts
// (internal/llm/openai.go:30-33, :200-225).
//
// pi-ai takes the bytes base64-encoded in the content part and builds the same
// `data:<mediaType>;base64,…` URL Go wrote, with the standard alphabet
// (base64.StdEncoding). A tool result cannot carry an image part — chat
// completions tool messages are text-only — so pi-ai flushes the images into an
// extra user message after the run of tool results, as Go did with its own
// wording (see decisions.md · T3.1 for the two sentences).

import type { ImageContent } from "@earendil-works/pi-ai";

/** Go's llm.Image: the media type ("image/png") and the bytes. */
export interface Image {
	mediaType: string;
	data: Uint8Array;
}

/** imageContent is one pi-ai image part: how Go's imageParts wrote an image. */
export function imageContent(img: Image): ImageContent {
	return { type: "image", data: Buffer.from(img.data).toString("base64"), mimeType: img.mediaType };
}
