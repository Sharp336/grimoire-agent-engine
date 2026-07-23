interface ModelFilterProps {
	models: string[];
	value: string | null;
	onChange: (model: string | null) => void;
}

export function ModelFilter({ models, value, onChange }: ModelFilterProps) {
	return (
		<select
			value={value ?? ""}
			onChange={e => onChange(e.target.value || null)}
			className="stats-select"
		>
			<option value="">All Models</option>
			{models.map(model => (
				<option key={model} value={model}>
					{model}
				</option>
			))}
		</select>
	);
}
