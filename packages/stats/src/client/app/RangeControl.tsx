import type { TimeRange } from "../types";

export interface RangeControlProps {
	value: TimeRange;
	onChange: (value: TimeRange) => void;
	disabled?: boolean;
	className?: string;
}

const RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
	{ value: "1h", label: "1h" },
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7d" },
	{ value: "30d", label: "30d" },
	{ value: "90d", label: "90d" },
	{ value: "all", label: "All" },
];

export function RangeControl({ value, onChange, disabled = false, className = "" }: RangeControlProps) {
	return (
		<div
			className={`stats-range-control ${className}`}
			role="radiogroup"
			aria-label="Select time range"
			aria-disabled={disabled}
			title={disabled ? "Range filters the session list, not this detail" : undefined}
		>
			{RANGE_OPTIONS.map(opt => {
				const isActive = opt.value === value;
				return (
					<button
						key={opt.value}
						type="button"
						role="radio"
						aria-checked={isActive}
						data-active={isActive ? "true" : "false"}
						className="stats-range-control-btn"
						disabled={disabled}
						onClick={() => onChange(opt.value)}
					>
						{opt.label}
					</button>
				);
			})}
		</div>
	);
}
