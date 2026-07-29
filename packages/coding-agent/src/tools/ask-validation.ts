import type { ExtensionAskDialogValidation } from "../extensibility/extensions";

export function getAskCustomInputValidationError(
	input: string,
	validation: ExtensionAskDialogValidation | undefined,
): string | undefined {
	if (!validation) return undefined;
	let failed = false;
	if (validation.minLength !== undefined && input.length < validation.minLength) failed = true;
	if (validation.maxLength !== undefined && input.length > validation.maxLength) failed = true;
	if (validation.pattern !== undefined) {
		try {
			if (!new RegExp(validation.pattern).test(input)) failed = true;
		} catch {
			failed = true;
		}
	}
	return failed ? (validation.message ?? "Custom answer does not meet the required format.") : undefined;
}
