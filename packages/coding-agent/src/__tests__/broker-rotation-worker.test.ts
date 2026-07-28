import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { SecretBroker } from "../secrets/broker/broker";
import { rotatePassword, type RotationResult } from "../secrets/broker/rotation-worker";
import type { SiteRecipe } from "../secrets/broker/site-catalog";
import type { SecretHandle, SecretValue } from "../secrets/broker/types";
import {
	acquireBrowser,
	type BrowserHandle,
	holdBrowser,
	type PuppeteerBrowserHandle,
	releaseBrowser,
} from "../tools/browser/registry";
import {
	CHANGE_SUCCESS_MARKER,
	startRotationTestSite,
	type RotationTestSite,
} from "./fixtures/rotation-test-site";

const OLD_PW = "old-fake-pw-12345678";
const OLD_HANDLE: SecretHandle = { provider: "stub", itemId: "old-pw-item" };

function recipeFor(site: RotationTestSite): SiteRecipe {
	return {
		domain: "127.0.0.1",
		tier: 1,
		loginUrl: `${site.url}/login`,
		changePasswordUrl: `${site.url}/account/password`,
		usernameField: "#username",
		passwordField: "#password",
		currentPasswordField: "#current",
		newPasswordField: "#new",
		confirmPasswordField: "#confirm",
		submitButton: "button[type=submit]",
		postChangeVerification: CHANGE_SUCCESS_MARKER,
	};
}

function brokerWithOldPassword(value: string): SecretBroker {
	const broker = new SecretBroker();
	broker.registerProvider({
		name: "stub",
		resolve: async (handle: SecretHandle): Promise<SecretValue> => ({ handle, value }),
		isAvailable: async () => true,
	});
	return broker;
}

describe("Phase C Task C3: rotation loop (self-hosted test site)", () => {
	let browserHandle: PuppeteerBrowserHandle | undefined;

	beforeAll(async () => {
		const handle: BrowserHandle = await acquireBrowser(
			{ kind: "headless", headless: true },
			{ cwd: process.cwd(), signal: AbortSignal.timeout(30_000) },
		);
		if (!("browser" in handle)) throw new Error("expected a Puppeteer browser");
		browserHandle = handle;
		holdBrowser(browserHandle);
	}, 60_000);

	afterAll(async () => {
		if (browserHandle) await releaseBrowser(browserHandle, { kill: true });
	});

	const newPage = async () => browserHandle!.browser.newPage();

	it("happy path: rotate → new works, old rejected, vault updated, no secret in the envelope", async () => {
		const site = await startRotationTestSite({ initialPassword: OLD_PW });
		try {
			let capturedNew: string | undefined;
			const result: RotationResult = await rotatePassword({
				broker: brokerWithOldPassword(OLD_PW),
				recipe: recipeFor(site),
				oldHandle: OLD_HANDLE,
				username: "alice",
				newPage,
				vaultUpdate: async (_handle, newValue) => {
					capturedNew = newValue;
				},
			});
			expect(result).toEqual({ ok: true, reasonCode: "ok" });

			// The site store rotated to a broker-generated value.
			const rotated = site.getPassword();
			expect(rotated).not.toBe(OLD_PW);
			expect(rotated.length).toBeGreaterThanOrEqual(30);

			// Vault write-back received the same value (assert properties only).
			expect(capturedNew).toBe(rotated);

			// Old credential is rejected by the site now.
			const oldLogin = await fetch(`${site.url}/login`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: `username=alice&password=${encodeURIComponent(OLD_PW)}`,
			});
			expect(oldLogin.status).toBe(401);

			// No raw password (old or new) in the returned envelope.
			const envelope = JSON.stringify(result);
			expect(envelope).not.toContain(OLD_PW);
			expect(envelope).not.toContain(rotated);
		} finally {
			await site.stop();
		}
	}, 90_000);

	it("login-failed: wrong old password → no change, no vault write", async () => {
		const site = await startRotationTestSite({ initialPassword: OLD_PW });
		try {
			let vaultCalled = false;
			const result = await rotatePassword({
				broker: brokerWithOldPassword("definitely-wrong-pw-0000"),
				recipe: recipeFor(site),
				oldHandle: OLD_HANDLE,
				username: "alice",
				newPage,
				vaultUpdate: async () => {
					vaultCalled = true;
				},
			});
			expect(result).toEqual({ ok: false, reasonCode: "login-failed" });
			expect(site.getPassword()).toBe(OLD_PW);
			expect(vaultCalled).toBe(false);
		} finally {
			await site.stop();
		}
	}, 90_000);

	it("change-failed: site rejects the change → old still valid", async () => {
		const site = await startRotationTestSite({ initialPassword: OLD_PW });
		try {
			site.rejectNextChange = true;
			const result = await rotatePassword({
				broker: brokerWithOldPassword(OLD_PW),
				recipe: recipeFor(site),
				oldHandle: OLD_HANDLE,
				username: "alice",
				newPage,
				vaultUpdate: async () => {},
			});
			expect(result).toEqual({ ok: false, reasonCode: "change-failed" });
			expect(site.getPassword()).toBe(OLD_PW);
		} finally {
			await site.stop();
		}
	}, 90_000);

	it("verify-failed → reverted: new login fails, worker restores the old password", async () => {
		const site = await startRotationTestSite({ initialPassword: OLD_PW });
		try {
			let vaultCalled = false;
			const result = await rotatePassword({
				broker: brokerWithOldPassword(OLD_PW),
				recipe: recipeFor(site),
				oldHandle: OLD_HANDLE,
				username: "alice",
				newPage,
				generatePassword: () => {
					// Flip the flag AFTER the initial login but before verify —
					// the generator runs between the two phases.
					site.rejectNewLogins = true;
					return "new-fake-pw-99999999";
				},
				vaultUpdate: async () => {
					vaultCalled = true;
				},
			});
			expect(result).toEqual({ ok: false, reasonCode: "reverted" });
			expect(site.getPassword()).toBe(OLD_PW);
			expect(vaultCalled).toBe(false);
		} finally {
			await site.stop();
		}
	}, 90_000);
});
