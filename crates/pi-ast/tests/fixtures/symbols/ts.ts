export function greet(name: string): string {
	return `Hi ${name}`;
}

export class Greeter {
	count = 0;

	greet(): string {
		return "hi";
	}
}

export interface Thing {
	doIt(): void;
}

export enum Color {
	Red,
	Green,
}
