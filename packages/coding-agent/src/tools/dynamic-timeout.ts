/**
 * Dynamic timeout window resolver for bash commands.
 *
 * When the LLM omits the `timeout` parameter, this resolver computes a
 * per-command-signature timeout based on recent wall-time history. Keying by
 * command signature (first two meaningful tokens) means `npm test` informs
 * `npm test` timeouts, not `npm install` timeouts.
 *
 * Timeouts scale with confidence — conservative with few samples, aggressive
 * with a full history window. At MIN_SAMPLES (3) the floor equals the static
 * default; at WINDOW_SIZE (20) the floor drops to 10% of the static default.
 * This prevents a fast-command streak from shrinking the timeout too early
 * while still allowing well-sampled quick commands to get tight deadlines.
 *
 * History is kept per-instance (per session) and bounded to a rolling window.
 */

const MIN_SAMPLES = 3;
const WINDOW_SIZE = 20;

export interface DynamicTimeoutResult {
	timeoutSec: number;
	sampleCount: number;
	p90Ms: number;
	signature: string;
}

export class DynamicTimeoutResolver {
	#history = new Map<string, number[]>();

	/**
	 * Extract a command signature: first two meaningful tokens, normalized.
	 * Strips leading env assignments, sudo, shell builtins (time, nohup, env),
	 * and path prefixes so that `FOO=bar sudo /usr/bin/git status` resolves to
	 * `git status` and `npm test` ≠ `npm install`.
	 */
	static commandSignature(command: string): string {
		let cmd = command.trim();
		// Strip leading env assignments: KEY=value command ...
		cmd = cmd.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "");
		// Strip leading sudo
		cmd = cmd.replace(/^sudo\s+/, "");
		// Strip leading shell builtins that wrap the real command: time, nohup, env
		cmd = cmd.replace(/^(?:time|nohup|env)\s+/, "");
		// Take first two tokens up to whitespace, |, &, ;, (, <
		const tokens = cmd
			.split(/[\s|&;(<]+/)
			.filter(Boolean)
			.slice(0, 2);
		if (tokens.length === 0) return "";
		// Strip path prefix from each token: /usr/bin/git -> git
		const normalized = tokens.map(t => (t.includes("/") ? (t.split("/").pop() ?? "") : t));
		return normalized.join(" ");
	}

	/**
	 * Record a completed command's wall time (ms) against its signature.
	 */
	record(command: string, wallTimeMs: number): void {
		const sig = DynamicTimeoutResolver.commandSignature(command);
		if (!sig) return;
		let samples = this.#history.get(sig);
		if (!samples) {
			samples = [];
			this.#history.set(sig, samples);
		}
		samples.push(wallTimeMs);
		if (samples.length > WINDOW_SIZE) samples.shift();
	}

	/**
	 * Resolve a dynamic timeout in seconds, or `undefined` if insufficient
	 * data (fewer than {@link MIN_SAMPLES} recorded wall times for this
	 * command signature).
	 *
	 * Uses the p90 of recent wall times multiplied by the given multiplier.
	 * A confidence-scaled safety floor prevents the timeout from shrinking
	 * too aggressively when few samples exist:
	 * - At MIN_SAMPLES (3): floor = staticDefaultSec (conservative)
	 * - At WINDOW_SIZE (20): floor = 10% of staticDefaultSec (aggressive)
	 * The result is clamped to `[minSec, maxSec]`.
	 */
	resolve(
		command: string,
		multiplier: number,
		minSec: number,
		maxSec: number,
		staticDefaultSec: number,
	): DynamicTimeoutResult | undefined {
		const sig = DynamicTimeoutResolver.commandSignature(command);
		if (!sig) return undefined;
		const samples = this.#history.get(sig);
		if (!samples || samples.length < MIN_SAMPLES) return undefined;
		// p90 of recent wall times
		const sorted = [...samples].sort((a, b) => a - b);
		const p90Index = Math.floor(sorted.length * 0.9);
		const p90Ms = sorted[p90Index]!;
		const predictedSec = Math.ceil((p90Ms / 1000) * multiplier);
		// Confidence-scaled safety floor: with few samples (3-5), stay closer to
		// the static default. As sample count grows (approaching WINDOW_SIZE),
		// trust the history more and allow the timeout to shrink further.
		// At MIN_SAMPLES (3): floor = staticDefaultSec (conservative)
		// At WINDOW_SIZE (20): floor = 10% of staticDefaultSec (aggressive)
		const confidenceRatio = Math.min(1, (samples.length - MIN_SAMPLES) / (WINDOW_SIZE - MIN_SAMPLES));
		const confidenceFloorSec = Math.ceil(staticDefaultSec * (1 - 0.9 * confidenceRatio));
		const dynamicSec = Math.max(confidenceFloorSec, predictedSec);
		// Clamp to user-configured [minSec, maxSec] range
		const clamped = Math.max(minSec, Math.min(maxSec, dynamicSec));
		return { timeoutSec: clamped, sampleCount: samples.length, p90Ms, signature: sig };
	}
}
