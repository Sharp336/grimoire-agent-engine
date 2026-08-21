import * as fs from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteJson } from "@oh-my-pi/pi-utils/atomic-write";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import {
	assertProfileExists,
	getProfileBindingsPath,
	loadProfileBindings,
	PROFILE_BINDINGS_VERSION,
	type ProfileBinding,
	resolveBindingTarget,
	resolveProfileBindingFromData,
	storedProfileName,
} from "./profile-binding-resolver";

export * from "./profile-binding-resolver";

function bindingMatchesTarget(
	binding: ProfileBinding,
	target: Pick<ProfileBinding, "kind" | "path" | "subpath">,
): boolean {
	return binding.kind === target.kind && binding.path === target.path && binding.subpath === target.subpath;
}

export async function bindProfileToFolder(
	profile: string,
	inputPath: string = process.cwd(),
	filePath: string = getProfileBindingsPath(),
): Promise<ProfileBinding> {
	const storedProfile = storedProfileName(profile);
	await assertProfileExists(storedProfile);
	const target = await resolveBindingTarget(inputPath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });

	const binding: ProfileBinding = { ...target, profile: storedProfile };
	await withFileLock(filePath, async () => {
		const data = await loadProfileBindings(filePath);
		data.bindings = data.bindings.filter(item => !bindingMatchesTarget(item, target));
		data.bindings.push(binding);
		await atomicWriteJson(filePath, data);
	});
	return binding;
}

export async function unbindProfileFromFolder(
	inputPath: string = process.cwd(),
	filePath: string = getProfileBindingsPath(),
): Promise<ProfileBinding | null> {
	let removed: ProfileBinding | null = null;
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await withFileLock(filePath, async () => {
		const data = await loadProfileBindings(filePath);
		const selected = await resolveProfileBindingFromData(inputPath, data);
		if (!selected) return;
		const kept = data.bindings.filter(item => {
			if (!bindingMatchesTarget(item, selected.binding)) return true;
			removed = item;
			return false;
		});
		await atomicWriteJson(filePath, { version: PROFILE_BINDINGS_VERSION, bindings: kept });
	});
	return removed;
}

export async function listProfileBindings(filePath: string = getProfileBindingsPath()): Promise<ProfileBinding[]> {
	return (await loadProfileBindings(filePath)).bindings;
}
