import type { SVGProps } from "react";

type IconProps = Omit<SVGProps<SVGSVGElement>, "children">;

function iconProps(props: IconProps): SVGProps<SVGSVGElement> {
	return {
		"aria-hidden": true,
		focusable: "false",
		viewBox: "0 0 24 24",
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.8,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		...props,
	};
}

export function OmpMark(props: IconProps) {
	return (
		<svg {...iconProps(props)} viewBox="0 0 32 32">
			<path d="M16 3.5 26.8 9.75v12.5L16 28.5 5.2 22.25V9.75L16 3.5Z" />
			<path d="m10.7 13 5.3-3 5.3 3v6L16 22l-5.3-3v-6Z" />
			<path d="M16 10v12M10.7 13l10.6 6M21.3 13l-10.6 6" />
		</svg>
	);
}

export function CheckIcon(props: IconProps) {
	return (
		<svg {...iconProps(props)}>
			<path d="m5 12.5 4.2 4.2L19.5 6.5" />
		</svg>
	);
}

export function AlertIcon(props: IconProps) {
	return (
		<svg {...iconProps(props)}>
			<path d="M12 3.5 21 20H3L12 3.5Z" />
			<path d="M12 9v4.5M12 17h.01" />
		</svg>
	);
}

export function BrowserIcon(props: IconProps) {
	return (
		<svg {...iconProps(props)}>
			<rect x="3" y="4" width="18" height="16" rx="2" />
			<path d="M3 9h18M7 6.5h.01M10 6.5h.01" />
		</svg>
	);
}

export function RuntimeIcon(props: IconProps) {
	return (
		<svg {...iconProps(props)}>
			<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" />
			<circle cx="12" cy="12" r="4" />
		</svg>
	);
}

export function LinkIcon(props: IconProps) {
	return (
		<svg {...iconProps(props)}>
			<path d="M9.5 14.5 14.5 9" />
			<path d="M7.8 17.8 5.5 20a4.2 4.2 0 0 1-6-6l3.2-3.2a4.2 4.2 0 0 1 5.9 0" transform="translate(3 -3)" />
			<path d="m16.2 6.2 2.3-2.2a4.2 4.2 0 0 1 6 6l-3.2 3.2a4.2 4.2 0 0 1-5.9 0" transform="translate(-3 3)" />
		</svg>
	);
}

export function RestartIcon(props: IconProps) {
	return (
		<svg {...iconProps(props)}>
			<path d="M20 7v5h-5" />
			<path d="M18.3 16.8A8 8 0 1 1 20 12" />
		</svg>
	);
}
