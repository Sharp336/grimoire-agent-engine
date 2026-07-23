import { describe, expect, it } from "bun:test";
import {
	decodeLosslessJsonTable,
	encodeLosslessJsonTable,
	reencodeLosslessJsonArray,
} from "@oh-my-pi/pi-coding-agent/session/lossless-reencode";

function expectRoundTrip(input: string): string {
	const encoded = encodeLosslessJsonTable(input);
	expect(encoded).toBeDefined();
	expect(decodeLosslessJsonTable(encoded!)).toEqual(JSON.parse(input));
	return encoded!;
}

describe("lossless schema+CSV format", () => {
	it("round-trips flat primitive objects with sorted columns", () => {
		const input =
			'[{"z":"plain","id":2,"note":"","nullable":null,"active":true},{"id":1,"z":"second","note":"null","active":false},{"z":"東京","id":3,"note":"last","nullable":"value","active":true}]';
		const encoded = expectRoundTrip(input);

		expect(encoded.split("\n", 1)[0]).toBe("[3]{active:boolean,id:number,note:string,nullable:string?,z:string}");
	});

	it("distinguishes null, absent fields, and empty strings reversibly", () => {
		const input = '[{"id":1,"value":null},{"id":2},{"id":3,"value":""},{"id":4,"value":"null"}]';
		const encoded = expectRoundTrip(input);
		const decoded = decodeLosslessJsonTable(encoded)!;

		expect(encoded).toContain('\n1,null\n2,\n3,""\n4,"null"');
		expect(Object.hasOwn(decoded[0], "value")).toBe(true);
		expect(decoded[0].value).toBeNull();
		expect(Object.hasOwn(decoded[1], "value")).toBe(false);
		expect(decoded[2].value).toBe("");
		expect(decoded[3].value).toBe("null");
	});

	it("marks a column optional only when it is absent from at least one row", () => {
		const input = '[{"always":null,"id":1,"sometimes":true},{"always":"x","id":2}]';
		const encoded = expectRoundTrip(input);

		expect(encoded.split("\n", 1)[0]).toBe("[2]{always:string,id:number,sometimes:boolean?}");
	});

	it("quotes comma, quote, CR, LF, edge whitespace, empty, and reserved null strings while preserving Unicode", () => {
		const input = JSON.stringify([
			{ id: 1, value: "comma,value" },
			{ id: 2, value: 'quote"value' },
			{ id: 3, value: "carriage\rreturn" },
			{ id: 4, value: "line\nfeed" },
			{ id: 5, value: " padded " },
			{ id: 6, value: "" },
			{ id: 7, value: "null" },
			{ id: 8, value: "東京 α" },
		]);
		const encoded = expectRoundTrip(input);

		expect(encoded).toContain('1,"comma,value"');
		expect(encoded).toContain('2,"quote""value"');
		expect(encoded).toContain('3,"carriage\rreturn"');
		expect(encoded).toContain('4,"line\nfeed"');
		expect(encoded).toContain('5," padded "');
		expect(encoded).toContain('6,""');
		expect(encoded).toContain('7,"null"');
		expect(encoded).toContain("8,東京 α");
	});

	it("rejects escaped lone surrogates before emitting CSV", () => {
		const input = '[{"id":1,"value":"\\ud800"},{"id":2,"value":"well-formed"}]';
		expect(encodeLosslessJsonTable(input)).toBeUndefined();
		expect(reencodeLosslessJsonArray(input)).toBe(input);
	});

	it("accepts escaped well-formed surrogate pairs", () => {
		expectRoundTrip('[{"id":1,"value":"\\ud83d\\ude00"},{"id":2,"value":"well-formed"}]');
	});

	it("accepts only canonical, exactly round-trippable JSON number literals", () => {
		const input = '[{"n":0},{"n":42},{"n":-42},{"n":1.25},{"n":0.000001},{"n":1e-7}]';
		expectRoundTrip(input);

		for (const literal of ["1.0", "1e3", "1E-7", "-0", "9007199254740992", "-9007199254740992"]) {
			const original = `[{"n":${literal}},{"n":1}]`;
			expect(encodeLosslessJsonTable(original)).toBeUndefined();
			expect(reencodeLosslessJsonArray(original)).toBe(original);
		}
	});

	it("allows null alongside one concrete column type but rejects mixed concrete types", () => {
		expectRoundTrip('[{"id":1,"value":null},{"id":2,"value":3}]');

		const mixed = '[{"id":1,"value":3},{"id":2,"value":"3"}]';
		expect(encodeLosslessJsonTable(mixed)).toBeUndefined();
		expect(reencodeLosslessJsonArray(mixed)).toBe(mixed);
	});

	it("passes through nested values and unsupported root or row shapes unchanged", () => {
		const unsupported = [
			'[{"id":1,"nested":{"x":1}},{"id":2,"nested":{"x":2}}]',
			'[{"id":1,"nested":[1,2]},{"id":2,"nested":[3,4]}]',
			'{"id":1}',
			"[1,2,3]",
			'[{"id":1},2]',
			'[{"id":1}]',
			"not json",
		];

		for (const input of unsupported) {
			expect(encodeLosslessJsonTable(input)).toBeUndefined();
			expect(reencodeLosslessJsonArray(input)).toBe(input);
		}
	});

	it("rejects duplicate keys and disjoint object shapes rather than guessing", () => {
		const duplicate = '[{"id":1,"id":2},{"id":3}]';
		const escapedDuplicate = '[{"id":1,"\\u0069d":2},{"id":3}]';
		const disjoint = '[{"left":1},{"right":2}]';

		for (const input of [duplicate, escapedDuplicate, disjoint]) {
			expect(encodeLosslessJsonTable(input)).toBeUndefined();
			expect(reencodeLosslessJsonArray(input)).toBe(input);
		}
	});

	it("emits byte-stable golden output independent of object key insertion order", () => {
		const first = '[{"b":"x","a":1},{"a":2,"b":" y "}]';
		const reordered = '[{"a":1,"b":"x"},{"b":" y ","a":2}]';
		const golden = '[2]{a:number,b:string}\n1,x\n2," y "';

		expect(encodeLosslessJsonTable(first)).toBe(golden);
		expect(encodeLosslessJsonTable(first)).toBe(golden);
		expect(encodeLosslessJsonTable(reordered)).toBe(golden);
		expect(decodeLosslessJsonTable(golden)).toEqual([
			{ a: 1, b: "x" },
			{ a: 2, b: " y " },
		]);
	});

	it("rejects malformed encoded tables in the decoder", () => {
		expect(decodeLosslessJsonTable("[2]{id:number}\n1")).toBeUndefined();
		expect(decodeLosslessJsonTable("[1]{id:number}\n1\n2")).toBeUndefined();
		expect(decodeLosslessJsonTable("[1]{id:number}\n1.0")).toBeUndefined();
		expect(decodeLosslessJsonTable("not a table")).toBeUndefined();
	});
});
