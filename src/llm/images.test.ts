// Images on the chat-completions wire, against the stub. Ported from
// TestOpenAIImages (internal/llm/images_test.go:18-60): a user image is a text
// part plus an image_url data URL, and tool results keep their text while their
// images follow as one extra user message — pi-ai's sentence, not Go's.

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { DEFAULTS, type LLM } from "../settings/settings.ts";
import { complete } from "./complete.ts";
import { imageContent } from "./images.ts";
import { startStub } from "./stub.ts";

/** Go's test image: a media type and a few bytes, not a real PNG. */
const PNG = { mediaType: "image/png", data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x2d, 0x66, 0x61, 0x6b, 0x65]) };
const PNG_BASE64 = "iVBORy1mYWtl";

/** pi-ai's own sentence for the images it moves out of the tool messages. */
const TOOL_IMAGE_TEXT = "Attached image(s) from tool result:";

function config(baseUrl: string): LLM {
	return { ...DEFAULTS, baseUrl, model: "movin-backend", apiKey: "sk-test-1234", timeoutSec: 5, vision: true };
}

describe("imageContent", () => {
	it("is pi-ai's image part, with the bytes in standard base64", () => {
		expect(imageContent(PNG)).toEqual({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
		expect(imageContent(PNG).data).toBe(Buffer.from(PNG.data).toString("base64"));
	});
});

describe("images on the wire", () => {
	it("sends a user image as a text part and an image_url data URL", async () => {
		const stub = await startStub();
		try {
			await complete(config(`${stub.origin}/v1`), {
				messages: [{ role: "user", content: [{ type: "text", text: "look" }, imageContent(PNG)], timestamp: 1 }],
			});
			expect(stub.requests[0]?.body.messages).toEqual([
				{
					role: "user",
					content: [
						{ type: "text", text: "look" },
						{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
					],
				},
			]);
		} finally {
			await stub.close();
		}
	});

	it("keeps a tool result's text and puts its image in one extra user message", async () => {
		const stub = await startStub();
		try {
			await complete(config(`${stub.origin}/v1`), {
				messages: [
					{ role: "user", content: "look", timestamp: 1 },
					assistantCalling("call_1", "call_2"),
					toolResult("call_1", '{"page":1}'),
					toolResult("call_2", '{"page":2}'),
				],
			});
			const messages = stub.requests[0]?.body.messages as { role: string; content: unknown }[];
			expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "tool", "user"]);
			// Tool messages are text-only: the JSON string stays the string it was.
			expect(messages[2]?.content).toBe('{"page":1}');
			expect(messages[3]?.content).toBe('{"page":2}');
			// Exactly one extra user message carries both images, after the run of tools.
			expect(messages[4]?.content).toEqual([
				{ type: "text", text: TOOL_IMAGE_TEXT },
				{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
				{ type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
			]);
		} finally {
			await stub.close();
		}
	});
});

/** assistantCalling is the assistant turn that asked for two tool calls. */
function assistantCalling(...ids: string[]): AssistantMessage {
	return {
		role: "assistant",
		content: ids.map((id) => ({ type: "toolCall", id, name: "view_document_page", arguments: {} })),
		api: "openai-completions",
		provider: "movin",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

/** toolResult is one tool's answer, text plus an image. */
function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "view_document_page",
		content: [{ type: "text", text }, imageContent(PNG)],
		isError: false,
		timestamp: 3,
	};
}
