/** User-facing thinking levels, ordered least to most intensive. */
export const enum Effort {
	ZeroOff = "0-off",
	Minimal = "minimal",
	Low = "low",
	Medium = "medium",
	High = "high",
	XHigh = "xhigh",
}

export const THINKING_EFFORTS: readonly Effort[] = [
	Effort.ZeroOff,
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
];
