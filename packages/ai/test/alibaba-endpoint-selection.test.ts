import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mock the validation module before importing the login function
const validateMock = mock(async () => {});
mock.module("../src/registry/api-key-validation", () => ({
	validateOpenAICompatibleApiKey: validateMock,
}));

// Import after mock
const { loginAlibabaCodingPlan } = await import("../src/registry/alibaba-coding-plan");

describe("alibaba-coding-plan endpoint selection", () => {
	beforeEach(() => {
		validateMock.mockClear();
	});

	test("option 1 uses international endpoint", async () => {
		const options = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async (prompt: { message: string }) => {
				if (prompt.message.includes("Select Alibaba")) return "1";
				if (prompt.message.includes("Paste your")) return "sk-test-key";
				return "";
			},
		};

		await loginAlibabaCodingPlan(options);

		expect(validateMock).toHaveBeenCalledTimes(1);
		const calls = validateMock.mock.calls;
		expect(calls.length).toBe(1);
		const call = calls[0] as unknown as [{ baseUrl: string; apiKey: string }];
		expect(call[0].baseUrl).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
		expect(call[0].apiKey).toBe("sk-test-key");
	});

	test("option 2 uses China endpoint", async () => {
		const options = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async (prompt: { message: string }) => {
				if (prompt.message.includes("Select Alibaba")) return "2";
				if (prompt.message.includes("Paste your")) return "sk-cn-key";
				return "";
			},
		};

		await loginAlibabaCodingPlan(options);

		expect(validateMock).toHaveBeenCalledTimes(1);
		const calls = validateMock.mock.calls;
		expect(calls.length).toBe(1);
		const call = calls[0] as unknown as [{ baseUrl: string; apiKey: string }];
		expect(call[0].baseUrl).toBe("https://coding.dashscope.aliyuncs.com/v1");
		expect(call[0].apiKey).toBe("sk-cn-key");
	});

	test("option 3 prompts for custom URL and uses it", async () => {
		const prompts: string[] = [];
		const options = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async (prompt: { message: string }) => {
				prompts.push(prompt.message);
				if (prompt.message.includes("Select Alibaba")) return "3";
				if (prompt.message.includes("custom base URL")) return "https://my-proxy.com/v1";
				if (prompt.message.includes("Paste your")) return "sk-custom-key";
				return "";
			},
		};

		await loginAlibabaCodingPlan(options);

		// Verify custom URL prompt was shown
		expect(validateMock).toHaveBeenCalledTimes(1);
		const calls = validateMock.mock.calls;
		expect(calls.length).toBe(1);
		const call = calls[0] as unknown as [{ baseUrl: string; apiKey: string }];
		expect(call[0].baseUrl).toBe("https://my-proxy.com/v1");
		expect(call[0].apiKey).toBe("sk-custom-key");
	});

	test("empty input defaults to international endpoint", async () => {
		const options = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async (prompt: { message: string }) => {
				if (prompt.message.includes("Select Alibaba")) return "";
				if (prompt.message.includes("Paste your")) return "sk-test-key";
				return "";
			},
		};

		await loginAlibabaCodingPlan(options);

		const calls = validateMock.mock.calls;
		expect(calls.length).toBe(1);
		const call = calls[0] as unknown as [{ baseUrl: string }];
		expect(call[0].baseUrl).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
	});
});
