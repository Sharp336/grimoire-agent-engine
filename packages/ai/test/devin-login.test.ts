import { describe, expect, test } from "bun:test";
import { exchangeDevinCliToken } from "@oh-my-pi/pi-ai/registry/oauth/devin";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

describe("Devin CLI login", () => {
	test("exchanges callback code with the current CLI RPC path", async () => {
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const fetchImpl: FetchImpl = async (url, init) => {
			requestUrl = String(url);
			requestInit = init;
			return new Response(
				JSON.stringify({ apiKey: "devin-api-key", apiServerUrl: "https://regional.devin.example" }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		};

		const exchange = await exchangeDevinCliToken("callback-code", "pkce-verifier", fetchImpl);

		expect(exchange).toEqual({
			apiKey: "devin-api-key",
			apiServerUrl: "https://regional.devin.example",
		});
		expect(requestUrl).toBe(
			"https://server.codeium.com/exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode",
		);
		expect(requestInit?.method).toBe("POST");
		expect(requestInit?.headers).toEqual({
			Accept: "application/json",
			"Content-Type": "application/json",
			"Connect-Protocol-Version": "1",
		});
		expect(JSON.parse(String(requestInit?.body))).toEqual({
			authorizationCode: "callback-code",
			codeVerifier: "pkce-verifier",
		});
	});
});
