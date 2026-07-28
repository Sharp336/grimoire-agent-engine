import { randomBytes } from "node:crypto";
import type { Page } from "puppeteer-core";
import type { SecretBroker } from "./broker";
import { getBrowserSecretTaint } from "./browser-with-secret-tool";
import type { SiteRecipe } from "./site-catalog";
import type { SecretHandle } from "./types";

/**
 * Phase C Task C3 — the rotation loop.
 *
 * End-to-end: lease the OLD password (D3), log in via a broker-owned
 * browser page (C1), broker-generate the NEW password out-of-band, set it
 * on the site, VERIFY a fresh login with the new one, write the vault
 * back, retire the lease. On verify failure, attempt a revert.
 *
 * Secret discipline: the old value enters the worker via the lease vault
 * (never a provider re-resolution in agent space); the new value is
 * generated here and reaches the vault via `vaultUpdate` — neither ever
 * appears in the returned {@link RotationResult}, in any error message,
 * or in an un-tainted browser observation (both join the C1b taint set).
 */

export type RotationReasonCode = "login-failed" | "change-failed" | "verify-failed" | "reverted" | "ok";

export interface RotationResult {
	ok: boolean;
	reasonCode: RotationReasonCode;
}

export interface RotationWorkerOptions {
	broker: SecretBroker;
	recipe: SiteRecipe;
	oldHandle: SecretHandle;
	/** The account username — NOT a secret. */
	username: string;
	/** Provider-specific write-back (tonight: stub; the real BW edit path is a follow-up). */
	vaultUpdate: (handle: SecretHandle, newValue: string) => Promise<void>;
	/** Page factory (fresh page per phase; tests inject the broker-owned page). */
	newPage: () => Promise<Page>;
	generatePassword?: () => string;
	/** Taint set for C1b scrubbing. Defaults to the shared browser taint set. */
	taint?: Set<string>;
	/** Lease TTL for the old password. Default 15 minutes. */
	leaseTtlMs?: number;
	/** URL substring proving login success. Default "/account". */
	loginSuccessUrlPart?: string;
	/** Per-step timeouts. */
	navTimeoutMs?: number;
}

function defaultGeneratePassword(): string {
	// 32 url-safe chars, no shell-unsafe characters.
	return randomBytes(24).toString("base64url");
}

const PAGE_GOTO_WAIT = { waitUntil: "domcontentloaded" } as const;

async function submitAndWait(page: Page, submitSelector: string, navTimeoutMs: number): Promise<void> {
	await Promise.all([
		page.waitForNavigation({ ...PAGE_GOTO_WAIT, timeout: navTimeoutMs }).catch(() => null),
		page.click(submitSelector),
	]);
}

export async function rotatePassword(opts: RotationWorkerOptions): Promise<RotationResult> {
	const navTimeoutMs = opts.navTimeoutMs ?? 15_000;
	const successUrlPart = opts.loginSuccessUrlPart ?? "/account";
		// The exported view is ReadonlySet, but the underlying module-level set
	// is the live taint store C1b scrubs against — the rotated values MUST
	// land in it (same contract as C1's fillBrokerPageSecret).
	const taint = opts.taint ?? (getBrowserSecretTaint() as Set<string>);
	const generate = opts.generatePassword ?? defaultGeneratePassword;
	const recipe = opts.recipe;
	const currentSelector = recipe.currentPasswordField ?? recipe.passwordField;
	const confirmSelector = recipe.confirmPasswordField ?? recipe.newPasswordField;

	const { leaseId } = await opts.broker.createLease(opts.oldHandle, opts.leaseTtlMs ?? 15 * 60_000);
	const oldValue = opts.broker.getCredential(`lease:${leaseId}`);
	if (oldValue === undefined) {
		await opts.broker.revokeLease(leaseId);
		return { ok: false, reasonCode: "login-failed" };
	}

	let page: Page | undefined;
	try {
		// 1. Login with the OLD password.
		page = await opts.newPage();
		await page.goto(recipe.loginUrl, { ...PAGE_GOTO_WAIT, timeout: navTimeoutMs });
		await page.type(recipe.usernameField, opts.username);
		await page.type(recipe.passwordField, oldValue, { delay: 20 });
		await submitAndWait(page, recipe.submitButton, navTimeoutMs);
		if (!page.url().includes(successUrlPart)) {
			return { ok: false, reasonCode: "login-failed" };
		}

		// 2. Change to the broker-generated NEW password.
		const newValue = generate();
		await page.goto(recipe.changePasswordUrl, { ...PAGE_GOTO_WAIT, timeout: navTimeoutMs });
		await page.type(currentSelector, oldValue, { delay: 20 });
		await page.type(recipe.newPasswordField, newValue, { delay: 20 });
		await page.type(confirmSelector, newValue, { delay: 20 });
		await submitAndWait(page, recipe.submitButton, navTimeoutMs);
		const afterChange = await page.content();
		if (recipe.postChangeVerification && !afterChange.includes(recipe.postChangeVerification)) {
			return { ok: false, reasonCode: "change-failed" };
		}

		// 3. Verify a FRESH login with the new password.
		const verifyPage = await opts.newPage();
		let verified = false;
		try {
			await verifyPage.goto(recipe.loginUrl, { ...PAGE_GOTO_WAIT, timeout: navTimeoutMs });
			await verifyPage.type(recipe.usernameField, opts.username);
			await verifyPage.type(recipe.passwordField, newValue, { delay: 20 });
			await submitAndWait(verifyPage, recipe.submitButton, navTimeoutMs);
			verified = verifyPage.url().includes(successUrlPart);
		} finally {
			await verifyPage.close().catch(() => undefined);
		}

		if (!verified) {
			// 3b. Revert: set the OLD password back (current=new, new=old).
			let revertSucceeded = false;
			try {
				await page.goto(recipe.changePasswordUrl, { ...PAGE_GOTO_WAIT, timeout: navTimeoutMs });
				await page.type(currentSelector, newValue, { delay: 20 });
				await page.type(recipe.newPasswordField, oldValue, { delay: 20 });
				await page.type(confirmSelector, oldValue, { delay: 20 });
				await submitAndWait(page, recipe.submitButton, navTimeoutMs);
				const afterRevert = await page.content();
				revertSucceeded =
					!recipe.postChangeVerification || afterRevert.includes(recipe.postChangeVerification);
			} catch {
				revertSucceeded = false;
			}
			// Taint both regardless — the attempt happened on a page.
			taint.add(newValue);
			return { ok: false, reasonCode: revertSucceeded ? "reverted" : "verify-failed" };
		}

		// 4. Write the vault back + retire the lease.
		await opts.vaultUpdate(opts.oldHandle, newValue);
		taint.add(newValue);
		return { ok: true, reasonCode: "ok" };
	} finally {
		taint.add(oldValue);
		await opts.broker.revokeLease(leaseId);
		if (page) await page.close().catch(() => undefined);
	}
}
