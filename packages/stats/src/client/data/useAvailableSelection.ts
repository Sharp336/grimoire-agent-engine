import { useEffect } from "react";
import { resolveAvailableSelection } from "./view-models";

/** Keep a model-panel filter reset after its selected option disappears. */
export function useAvailableSelection(
	selected: string | null,
	options: readonly string[],
	setSelected: (next: string | null) => void,
): string | null {
	const effectiveSelection = resolveAvailableSelection(selected, options);

	useEffect(() => {
		if (selected !== null && effectiveSelection === null) {
			setSelected(null);
		}
	}, [effectiveSelection, selected, setSelected]);

	return effectiveSelection;
}
