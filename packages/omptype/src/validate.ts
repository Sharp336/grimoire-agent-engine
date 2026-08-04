/**
 * Single validation engine. One semantic definition per IR node kind feeds two
 * execution modes:
 *
 * - the tree-walking interpreter (`walk`) covers a schema's first calls and is
 *   the fallback for recursive or predicate-only subtrees
 * - the JIT (`compile`/`compileAllows`) specializes that same definition into a
 *   `new Function` validator from the third call on, emitting code from the
 *   shared rule descriptors rather than restating them; where a construct
 *   cannot be code-generated it delegates the subtree back to `walk`
 *
 * Semantics (shared by both modes):
 * - success returns the output value; the input is returned as-is unless the
 *   schema morphs (defaults, `"+": "delete"`, embedded stepped schemas), in
 *   which case a fresh object/array is produced and the input is untouched
 * - failure returns an `OmpErrors` with a single fast-fail entry
 */
import { MISSING, OmpErrors } from "./errors";
import { expectedOf, hasAlias, hasMorph, type IR, type MorphContext, type PropIR, type TupleIR } from "./ir";

const own = Object.prototype.hasOwnProperty;
const IDENT = /^[A-Za-z_$][\w$]*$/;

/** Return an independent runtime value for a prevalidated static default. */
function materializeDefault(payload: unknown): unknown {
	if (payload === null || typeof payload !== "object") return payload;
	if (payload instanceof Date) return new Date(payload);
	return structuredClone(payload);
}

let activeVisits: WeakMap<object, Set<IR>> | undefined;
let activeChecks: WeakMap<object, Set<IR>> | undefined;

/**
 * Validate `value` against `ir`; returns output value or `OmpErrors`.
 * `path` seeds the traversal location so nested step callbacks observe
 * absolute ctx.path values when a compiled parent delegates a subtree;
 * resulting error paths are then already absolute.
 */
export function walk(ir: IR, value: unknown, path: PropertyKey[] = []): unknown {
	const previousVisits = activeVisits;
	const previousChecks = activeChecks;
	// Created lazily by visit/checks only when a recursive-alias node is reached.
	activeVisits = undefined;
	activeChecks = undefined;
	try {
		return visit(ir, value, path);
	} finally {
		activeVisits = previousVisits;
		activeChecks = previousChecks;
	}
}

function fail(path: PropertyKey[], expected: string, data: unknown): OmpErrors {
	const storedPath = path.length === 0 ? undefined : path.length === 1 ? path[0] : [...path];
	return new OmpErrors(storedPath, expected, data);
}

/**
 * Leaf-scalar constraint: one atomic guard stated once in both execution
 * forms. `test` is the interpreter predicate over the runtime value; `source`
 * builds the JIT boolean expression from the emitted value identifier. The
 * walker reduces the list imperatively; the JIT joins it into one expression,
 * so a scalar constraint appears exactly once.
 */
interface ScalarCheck {
	readonly test: (v: unknown) => boolean;
	readonly source: (v: string) => string;
}

/**
 * The scalar constraint list for `string`/`number` nodes — the two kinds
 * whose multi-part guards (bounds, exclusivity, divisor, url) the two engines
 * previously restated. Returns undefined for other kinds, whose single-clause
 * predicates the walker and JIT each express directly.
 */
function scalarChecks(ir: IR): ScalarCheck[] | undefined {
	switch (ir.k) {
		case "string": {
			const checks: ScalarCheck[] = [{ test: v => typeof v === "string", source: v => `typeof ${v}==="string"` }];
			if (ir.min !== undefined) {
				const min = ir.min;
				checks.push({ test: v => (v as string).length >= min, source: v => `${v}.length>=${min}` });
			}
			if (ir.max !== undefined) {
				const max = ir.max;
				checks.push({ test: v => (v as string).length <= max, source: v => `${v}.length<=${max}` });
			}
			if (ir.url) {
				checks.push({ test: v => URL.canParse(v as string), source: v => `URL.canParse(${v})` });
			}
			return checks;
		}
		case "number": {
			const checks: ScalarCheck[] = ir.int
				? [{ test: v => Number.isInteger(v as number), source: v => `Number.isInteger(${v})` }]
				: [{ test: v => Number.isFinite(v as number), source: v => `Number.isFinite(${v})` }];
			if (ir.divisor !== undefined) {
				const divisor = ir.divisor;
				checks.push({ test: v => (v as number) % divisor === 0, source: v => `${v}%${divisor}===0` });
			}
			if (ir.min !== undefined) {
				const min = ir.min;
				const exclusive = ir.xmin === true;
				checks.push({
					test: v => (exclusive ? (v as number) > min : (v as number) >= min),
					source: v => `${v}${exclusive ? ">" : ">="}${min}`,
				});
			}
			if (ir.max !== undefined) {
				const max = ir.max;
				const exclusive = ir.xmax === true;
				checks.push({
					test: v => (exclusive ? (v as number) < max : (v as number) <= max),
					source: v => `${v}${exclusive ? "<" : "<="}${max}`,
				});
			}
			return checks;
		}
		default:
			return undefined;
	}
}

/*
 * The remaining single-statement rules shared by both engines. Each is a pure
 * function of the IR node (and, for lengths, the runtime value): the walker
 * passes the results to `fail`, the JIT embeds them into `this.error`. Error
 * text is therefore stated exactly once; the two engines never recompute it.
 */

/** Error expectation shared by every array-shaped node (array and tuple). */
const NOT_ARRAY = "an array";

/** Error expectation for a value that is not a (non-null) object. */
const NOT_OBJECT = "an object";

/** Error expectation for an undeclared key rejected under `extras: "reject"`. */
const EXTRAS_REJECTED = "removed";

function stringExpectation(ir: IR & { k: "string" }): {
	readonly notString: string;
	readonly tooShort: string | undefined;
	readonly tooLong: string | undefined;
	readonly notUrl: string | undefined;
} {
	return {
		notString: "a string",
		tooShort: ir.min === undefined ? undefined : `at least length ${ir.min}`,
		tooLong: ir.max === undefined ? undefined : `at most length ${ir.max}`,
		notUrl: ir.url ? "a URL string" : undefined,
	};
}

function numberExpectation(ir: IR & { k: "number" }): {
	readonly notNumber: string;
	readonly notInteger: string;
	readonly notDivisible: string | undefined;
	readonly belowMin: string | undefined;
	readonly aboveMax: string | undefined;
} {
	return {
		notNumber: ir.int ? "an integer" : "a number",
		notInteger: "an integer",
		notDivisible: ir.divisor === undefined ? undefined : `a number divisible by ${ir.divisor}`,
		belowMin:
			ir.min === undefined
				? undefined
				: ir.min === 0
					? ir.xmin
						? "positive"
						: "non-negative"
					: `a number ${ir.xmin ? "more than" : "at least"} ${ir.min}`,
		aboveMax:
			ir.max === undefined
				? undefined
				: ir.max === 0
					? ir.xmax
						? "negative"
						: "non-positive"
					: `a number ${ir.xmax ? "less than" : "at most"} ${ir.max}`,
	};
}

function arrayExpectation(ir: IR & { k: "array" }): {
	readonly notArray: string;
	readonly tooShort: string | undefined;
	readonly tooLong: string | undefined;
} {
	return {
		notArray: NOT_ARRAY,
		tooShort: ir.min === undefined ? undefined : `at least length ${ir.min}`,
		tooLong: ir.max === undefined ? undefined : `at most length ${ir.max}`,
	};
}

/** Minimum and (non-variadic) maximum length arithmetic for a tuple node. */
function tupleArity(ir: TupleIR): { readonly required: number; readonly maximum: number } {
	let required = ir.postfix.length;
	for (const item of ir.prefix) if (!item.opt && !item.hasDefault) required++;
	return { required, maximum: ir.prefix.length + ir.postfix.length };
}

function tupleExpectation(ir: TupleIR): {
	readonly notArray: string;
	readonly tooShort: string;
	readonly tooLong: string;
} {
	const { required, maximum } = tupleArity(ir);
	return {
		notArray: NOT_ARRAY,
		tooShort: `an array of at least length ${required}`,
		tooLong: `an array of at most length ${maximum}`,
	};
}

/** Prefix positions bound to inputs, and the input index where postfix begins. */
function tupleLayout(ir: TupleIR, length: number): { readonly postfixStart: number; readonly prefixCount: number } {
	const postfixStart = length - ir.postfix.length;
	return { postfixStart, prefixCount: Math.min(ir.prefix.length, postfixStart) };
}

type ObjectIR = Extract<IR, { k: "object" }>;

/**
 * All index-signature validators that claim `key`, shared by both engines.
 * Returns every validator the key must satisfy — the general index (for string
 * keys) plus each matching pattern index, or the symbol index for symbol keys.
 * A key is index-claimed when the result is non-empty; the caller applies the
 * keep/reject consequence of `ir.extras` in its own iteration style.
 */
function objectIndexValidators(ir: ObjectIR, key: PropertyKey): IR[] {
	if (typeof key === "symbol") {
		return ir.symbolIndex !== undefined ? [ir.symbolIndex] : [];
	}
	const result: IR[] = [];
	if (ir.index !== undefined) result.push(ir.index);
	if (ir.patternIndexes !== undefined) {
		for (const pattern of ir.patternIndexes) {
			if (checks(pattern.key, key)) result.push(pattern.val);
		}
	}
	return result;
}

/** Pure predicate used for union-member scanning (no morphs, no errors). */
function checks(ir: IR, v: unknown): boolean {
	// Cycle guards are only needed when the subtree can revisit nodes through
	// recursive aliases; plain schemas skip the WeakMap bookkeeping entirely.
	if (typeof v !== "object" || v === null || !hasAlias(ir)) return checkNode(ir, v);
	activeChecks ??= new WeakMap();
	const visits = activeChecks;
	let visited = visits.get(v);
	if (visited?.has(ir)) return true;
	if (visited === undefined) {
		visited = new Set();
		visits.set(v, visited);
	}
	visited.add(ir);
	try {
		return checkNode(ir, v);
	} finally {
		visited.delete(ir);
	}
}

function checkNode(ir: IR, v: unknown): boolean {
	switch (ir.k) {
		case "string":
		case "number": {
			// string/number guards are the shared scalar constraint list.
			const scalar = scalarChecks(ir);
			if (scalar !== undefined) {
				for (const check of scalar) if (!check.test(v)) return false;
				return true;
			}
			return false;
		}
		case "unknown":
			return true;
		case "null":
			return v === null;
		case "undefined":
			return v === undefined;
		case "boolean":
			return typeof v === "boolean";
		case "bigint":
			return typeof v === "bigint";
		case "symbol":
			return typeof v === "symbol";
		case "never":
			return false;
		case "anyobject":
			return typeof v === "object" && v !== null;
		case "lit":
			return ir.v instanceof Date ? v instanceof Date && v.valueOf() === ir.v.valueOf() : v === ir.v;
		case "union":
			return ir.members.some(m => checks(m, v));
		case "intersection":
			return ir.members.every(member => checks(member, v));
		case "array": {
			if (!Array.isArray(v)) return false;
			if (ir.min !== undefined && v.length < ir.min) return false;
			if (ir.max !== undefined && v.length > ir.max) return false;
			for (const element of v) if (!checks(ir.el, element)) return false;
			return true;
		}
		case "tuple": {
			if (!Array.isArray(v)) return false;
			const { required, maximum } = tupleArity(ir);
			if (v.length < required) return false;
			if (ir.variadic === undefined && v.length > maximum) return false;
			const { postfixStart, prefixCount } = tupleLayout(ir, v.length);
			for (let index = 0; index < prefixCount; index++) {
				if (!checks(ir.prefix[index].val, v[index])) return false;
			}
			for (let index = prefixCount; index < ir.prefix.length; index++) {
				const item = ir.prefix[index];
				if (!item.opt && !item.hasDefault) return false;
			}
			if (ir.variadic !== undefined) {
				for (let index = prefixCount; index < postfixStart; index++) {
					if (!checks(ir.variadic, v[index])) return false;
				}
			}
			for (let index = 0; index < ir.postfix.length; index++) {
				if (!checks(ir.postfix[index], v[postfixStart + index])) return false;
			}
			return true;
		}
		case "object": {
			if (typeof v !== "object" || v === null) return false;
			const rec = v as Record<PropertyKey, unknown>;
			for (const p of ir.props) {
				const present = p.key in rec;
				if (!present) {
					if (!p.opt && !p.hasDefault) return false;
					continue;
				}
				if (!checks(p.val, rec[p.key])) return false;
			}
			for (const key in rec) {
				if (!own.call(rec, key)) continue;
				const indexes = objectIndexValidators(ir, key);
				for (const index of indexes) {
					if (!checks(index, rec[key])) return false;
				}
				if (ir.extras === "reject" && indexes.length === 0 && !ir.props.some(prop => prop.key === key)) {
					return false;
				}
			}
			for (const key of Object.getOwnPropertySymbols(rec)) {
				if (!Object.prototype.propertyIsEnumerable.call(rec, key)) continue;
				const indexes = objectIndexValidators(ir, key);
				for (const index of indexes) {
					if (!checks(index, rec[key])) return false;
				}
				if (ir.extras === "reject" && indexes.length === 0 && !ir.props.some(prop => prop.key === key)) {
					return false;
				}
			}
			return true;
		}
		case "instance":
			return v instanceof ir.ctor;
		case "refine":
			if (!checks(ir.base, v)) return false;
			try {
				return ir.pred(v) === true;
			} catch {
				return false;
			}
		case "alias":
			return checks(ir.resolve(), v);
		case "morph":
			return checks(ir.input, v);
		case "sub":
			return !(ir.schema.run(v) instanceof OmpErrors);
	}
}

function visit(ir: IR, v: unknown, path: PropertyKey[]): unknown {
	if (typeof v !== "object" || v === null || !hasAlias(ir)) return visitFinish(ir, v, path);
	activeVisits ??= new WeakMap();
	const visits = activeVisits;
	let visited = visits.get(v);
	if (visited?.has(ir)) return v;
	if (visited === undefined) {
		visited = new Set();
		visits.set(v, visited);
	}
	visited.add(ir);
	try {
		return visitFinish(ir, v, path);
	} finally {
		visited.delete(ir);
	}
}

/** Run the node visitor, then apply node-local error configuration. */
function visitFinish(ir: IR, v: unknown, path: PropertyKey[]): unknown {
	const out = visitNode(ir, v, path);
	if (!(out instanceof OmpErrors) || ir.cfg === undefined) return out;
	for (const error of out) {
		if (error.path.length !== path.length) return out;
	}
	return out.configure(ir.cfg);
}

function visitNode(ir: IR, v: unknown, path: PropertyKey[]): unknown {
	switch (ir.k) {
		case "alias":
			return visit(ir.resolve(), v, path);
		case "refine": {
			const base = visit(ir.base, v, path);
			if (base instanceof OmpErrors) return base;
			try {
				const result = ir.pred(base);
				if (result instanceof OmpErrors) return path.length === 0 ? result : prefixAll(result, path);
				return result ? base : fail(path, ir.expected, base);
			} catch {
				return fail(path, ir.expected, base);
			}
		}
		case "morph": {
			const input = visit(ir.input, v, path);
			if (input instanceof OmpErrors) return input;
			const context = {
				error: (expected: string, data: unknown = input) => fail(path, expected, data),
				reject: (problem: string, data: unknown = input) => fail(path, problem, data),
			};
			const output = ir.fn(input, context);
			if (output instanceof OmpErrors) return output;
			return ir.out === undefined ? output : visit(ir.out, output, path);
		}
		case "intersection": {
			let output = v;
			for (const member of ir.members) {
				output = visit(member, output, path);
				if (output instanceof OmpErrors) return output;
			}
			return output;
		}
		case "sub": {
			const out = ir.schema.run(v, path);
			if (out instanceof OmpErrors) {
				return path.length === 0 ? out : prefixAll(out, path);
			}
			return out;
		}
		case "union": {
			// fast path: any pure member matching returns the input unchanged
			for (const m of ir.members) {
				if (m.k !== "sub" && checks(m, v)) {
					if (hasMorph(m)) break;
					return v;
				}
			}
			let targeted: OmpErrors | undefined;
			let targetCount = 0;
			for (const member of ir.members) {
				if (member.k === "sub" || hasMorph(member)) {
					const out = visit(member, v, path);
					if (!(out instanceof OmpErrors)) return out;
					if (kindMatches(unwrapBase(member), v)) {
						targetCount++;
						targeted ??= out;
					}
				}
			}
			if (targetCount === 1 && targeted !== undefined) return targeted;
			return ir.members.some(canRefineUnionFailure) ? unionFail(ir, v, path) : fail(path, expectedOf(ir), v);
		}
		case "array": {
			const { notArray, tooShort, tooLong } = arrayExpectation(ir);
			if (!Array.isArray(v)) return fail(path, notArray, v);
			if (ir.min !== undefined && tooShort !== undefined && v.length < ir.min) {
				return fail(path, tooShort, v.length);
			}
			if (ir.max !== undefined && tooLong !== undefined && v.length > ir.max) {
				return fail(path, tooLong, v.length);
			}
			const morph = hasMorph(ir.el);
			const out = morph ? new Array<unknown>(v.length) : v;
			let errors: OmpErrors | undefined;
			for (let index = 0; index < v.length; index++) {
				path.push(index);
				const element = visit(ir.el, v[index], path);
				path.pop();
				if (element instanceof OmpErrors) {
					if (errors) errors.append(element);
					else errors = element;
				} else if (morph) {
					out[index] = element;
				}
			}
			return errors ?? out;
		}
		case "tuple": {
			const expectation = tupleExpectation(ir);
			if (!Array.isArray(v)) return fail(path, expectation.notArray, v);
			const { required, maximum } = tupleArity(ir);
			if (v.length < required) return fail(path, expectation.tooShort, v);
			if (ir.variadic === undefined && v.length > maximum) {
				return fail(path, expectation.tooLong, v);
			}
			const { postfixStart, prefixCount } = tupleLayout(ir, v.length);
			const morph = hasMorph(ir);
			const output = morph ? [...v] : v;
			let errors: OmpErrors | undefined;
			for (let index = 0; index < prefixCount; index++) {
				path.push(index);
				const item = visit(ir.prefix[index].val, v[index], path);
				path.pop();
				if (item instanceof OmpErrors) {
					if (errors) errors.append(item);
					else errors = item;
				} else if (morph) {
					output[index] = item;
				}
			}
			for (let index = prefixCount; index < ir.prefix.length; index++) {
				const item = ir.prefix[index];
				if (item.hasDefault && morph) {
					const payload = item.def;
					if (item.defFactory && typeof payload === "function") {
						path.push(index);
						const resolved = visit(item.val, payload(), path);
						path.pop();
						if (resolved instanceof OmpErrors) {
							if (errors) errors.append(resolved);
							else errors = resolved;
						} else {
							output[index] = resolved;
						}
					} else {
						output[index] = materializeDefault(payload);
					}
				} else if (!item.opt) {
					path.push(index);
					const error = fail(path, expectedOf(item.val), MISSING);
					path.pop();
					if (errors) errors.append(error);
					else errors = error;
				}
			}
			if (ir.variadic !== undefined) {
				for (let index = prefixCount; index < postfixStart; index++) {
					path.push(index);
					const item = visit(ir.variadic, v[index], path);
					path.pop();
					if (item instanceof OmpErrors) {
						if (errors) errors.append(item);
						else errors = item;
					} else if (morph) {
						output[index] = item;
					}
				}
			}
			for (let index = 0; index < ir.postfix.length; index++) {
				const inputIndex = postfixStart + index;
				path.push(inputIndex);
				const item = visit(ir.postfix[index], v[inputIndex], path);
				path.pop();
				if (item instanceof OmpErrors) {
					if (errors) errors.append(item);
					else errors = item;
				} else if (morph) {
					output[inputIndex] = item;
				}
			}
			return errors ?? output;
		}
		case "object": {
			if (typeof v !== "object" || v === null) return fail(path, NOT_OBJECT, v);
			const rec = v as Record<PropertyKey, unknown>;
			const morph = hasMorph(ir);
			let out: Record<PropertyKey, unknown> | undefined;
			let errors: OmpErrors | undefined;
			if (morph) {
				if (
					ir.extras === "delete" &&
					ir.index === undefined &&
					ir.symbolIndex === undefined &&
					ir.patternIndexes === undefined
				) {
					out = {};
				} else {
					out = { ...rec };
				}
			}
			for (const p of ir.props) {
				if (!(p.key in rec)) {
					if (p.hasDefault && out) {
						const payload = p.def;
						if (p.defFactory && typeof payload === "function") {
							path.push(p.key);
							const resolved = visit(p.val, payload(), path);
							path.pop();
							if (resolved instanceof OmpErrors) {
								if (errors) errors.append(resolved);
								else errors = resolved;
							} else {
								out[p.key] = resolved;
							}
						} else {
							out[p.key] = materializeDefault(payload);
						}
						continue;
					}
					if (p.opt || p.hasDefault) continue;
					path.push(p.key);
					const error = fail(path, expectedOf(p.val), MISSING);
					path.pop();
					if (errors) errors.append(error);
					else errors = error;
					continue;
				}
				path.push(p.key);
				const result = visit(p.val, rec[p.key], path);
				path.pop();
				if (result instanceof OmpErrors) {
					if (errors) errors.append(result);
					else errors = result;
				} else if (out) {
					out[p.key] = result;
				}
			}
			for (const key in rec) {
				if (!own.call(rec, key)) continue;
				const indexes = objectIndexValidators(ir, key);
				for (const index of indexes) {
					path.push(key);
					const result = visit(index, rec[key], path);
					path.pop();
					if (result instanceof OmpErrors) {
						if (errors) errors.append(result);
						else errors = result;
					} else if (out) {
						out[key] = result;
					}
				}
				if (ir.extras === "reject" && indexes.length === 0 && !ir.props.some(prop => prop.key === key)) {
					path.push(key);
					const error = fail(path, EXTRAS_REJECTED, rec[key]);
					path.pop();
					if (errors) errors.append(error);
					else errors = error;
				}
			}
			for (const key of Object.getOwnPropertySymbols(rec)) {
				if (!Object.prototype.propertyIsEnumerable.call(rec, key)) continue;
				const indexes = objectIndexValidators(ir, key);
				for (const index of indexes) {
					path.push(key);
					const result = visit(index, rec[key], path);
					path.pop();
					if (result instanceof OmpErrors) {
						if (errors) errors.append(result);
						else errors = result;
					} else if (out) {
						out[key] = result;
					}
				}
				if (ir.extras === "reject" && indexes.length === 0 && !ir.props.some(prop => prop.key === key)) {
					path.push(key);
					const error = fail(path, EXTRAS_REJECTED, rec[key]);
					path.pop();
					if (errors) errors.append(error);
					else errors = error;
				}
			}
			return errors ?? out ?? v;
		}
		case "string": {
			const { notString, tooShort, tooLong, notUrl } = stringExpectation(ir);
			if (typeof v !== "string") return fail(path, notString, v);
			if (ir.min !== undefined && tooShort !== undefined && v.length < ir.min) {
				return fail(path, tooShort, v.length);
			}
			if (ir.max !== undefined && tooLong !== undefined && v.length > ir.max) {
				return fail(path, tooLong, v.length);
			}
			if (notUrl !== undefined && !URL.canParse(v)) return fail(path, notUrl, v);
			return v;
		}
		case "number": {
			const expectation = numberExpectation(ir);
			if (typeof v !== "number" || !Number.isFinite(v)) return fail(path, expectation.notNumber, v);
			let errors: OmpErrors | undefined;
			const add = (expected: string): void => {
				const error = fail(path, expected, v);
				if (errors) errors.append(error);
				else errors = error;
			};
			if (ir.int && !Number.isInteger(v)) add(expectation.notInteger);
			if (ir.divisor !== undefined && expectation.notDivisible !== undefined && v % ir.divisor !== 0) {
				add(expectation.notDivisible);
			}
			if (ir.min !== undefined && expectation.belowMin !== undefined && (ir.xmin ? v <= ir.min : v < ir.min)) {
				add(expectation.belowMin);
			}
			if (ir.max !== undefined && expectation.aboveMax !== undefined && (ir.xmax ? v >= ir.max : v > ir.max)) {
				add(expectation.aboveMax);
			}
			return errors ?? v;
		}
		case "lit": {
			if (checks(ir, v)) return v;
			if ((typeof ir.v === "object" && ir.v !== null) || typeof ir.v === "function") {
				let expected = "the specified reference";
				try {
					const serialized = JSON.stringify(ir.v);
					if (serialized !== undefined) {
						expected = `reference equal to ${serialized}`;
						if (typeof v === "object" && v !== null && JSON.stringify(v) === serialized) {
							expected += " (serialized to the same value)";
						}
					}
				} catch {
					// Cyclic values still get a useful reference-identity expectation.
				}
				return fail(path, expected, v);
			}
			return fail(path, expectedOf(ir), v);
		}
		default:
			return checks(ir, v) ? v : fail(path, expectedOf(ir), v);
	}
}

function prefixAll(errs: OmpErrors, path: PropertyKey[]): OmpErrors {
	for (let i = path.length - 1; i >= 0; i--) errs.prefix(path[i]);
	return errs;
}

/** True when a union failure can be replaced with a more specific nested error. */
function canRefineUnionFailure(member: IR): boolean {
	const base = unwrapBase(member);
	if (base.k === "array" || base.k === "object") return true;
	if (base.k === "string") return base.min !== undefined || base.max !== undefined || base.url === true;
	return base.k === "number" && (base.int === true || base.min !== undefined || base.max !== undefined);
}

/**
 * Detailed failure for a union: descend into the member the value was clearly
 * aimed at — unique runtime-kind match, else an object member whose literal
 * discriminant property (e.g. `type: "'computer_call'"`) equals the value's —
 * for a precise nested error (paths, narrow messages) instead of the coarse
 * "A or B" expectation.
 */
function unionFail(ir: IR & { k: "union" }, v: unknown, path: PropertyKey[], expected?: string): OmpErrors {
	let best: IR | undefined;
	for (const member of ir.members) {
		const base = unwrapBase(member);
		if (!kindMatches(base, v)) continue;
		if (best !== undefined) {
			best = undefined;
			break;
		}
		best = member;
	}
	if (best === undefined) {
		const discriminated = discriminateFailure(ir.members, v, path);
		if (discriminated !== undefined) return discriminated;
	}
	if (best !== undefined) {
		const out = visit(best, v, path);
		if (out instanceof OmpErrors) return out;
	}
	if (ir.members.every(member => unwrapBase(member).k === "object")) {
		const branches = ir.members.flatMap(member => {
			const result = visit(member, v, path);
			return result instanceof OmpErrors ? [[...result]] : [];
		});
		if (branches.length !== 0) {
			const common = branches[0].filter(
				(entry, index, first) =>
					first.findIndex(candidate => pathsEqual(candidate.path, entry.path)) === index &&
					branches.every(branch => branch.some(candidate => pathsEqual(candidate.path, entry.path))),
			);
			const alternatives: OmpErrors[] = [];
			if (common.length !== 0) {
				for (const entry of common) {
					const expectations = new Set<string>();
					for (const branch of branches) {
						for (const candidate of branch) {
							if (pathsEqual(candidate.path, entry.path)) {
								expectations.add(candidate.expected.endsWith(" instance") ? "an object" : candidate.expected);
							}
						}
					}
					alternatives.push(
						new OmpErrors(entry.path, [...expectations].join(" or "), entry.data, { preserveActual: true }),
					);
				}
			} else {
				for (const branch of branches) {
					for (const entry of branch) {
						alternatives.push(
							new OmpErrors(
								entry.path,
								entry.expected.endsWith(" instance") ? "an object" : entry.expected,
								entry.data,
								{ preserveActual: true },
							),
						);
					}
				}
			}
			const combined = alternatives[0];
			for (let index = 1; index < alternatives.length; index++) combined.append(alternatives[index]);
			return alternatives.length === 1 ? combined : combined.asAlternatives();
		}
	}
	return fail(path, expected ?? expectedOf(ir), v);
}

interface LiteralDiscriminant {
	path: PropertyKey[];
	value: unknown;
}

function unwrapBase(member: IR, seen = new Set<IR>()): IR {
	if (seen.has(member)) return member;
	seen.add(member);
	if (member.k === "sub") return unwrapBase(member.schema.ir, seen);
	if (member.k === "alias") return unwrapBase(member.resolve(), seen);
	if (member.k === "refine") return unwrapBase(member.base, seen);
	return member;
}

function collectDiscriminants(member: IR, prefix: PropertyKey[] = [], seen = new Set<IR>()): LiteralDiscriminant[] {
	if (seen.has(member)) return [];
	seen.add(member);
	if (member.k === "alias") return collectDiscriminants(member.resolve(), prefix, seen);
	if (member.k === "sub") return collectDiscriminants(member.schema.ir, prefix, seen);
	if (member.k === "refine") return collectDiscriminants(member.base, prefix, seen);
	if (member.k !== "object") return [];
	const result: LiteralDiscriminant[] = [];
	for (const property of member.props) {
		const propertyPath = [...prefix, property.key];
		const value = unwrapBase(property.val);
		if (value.k === "lit") result.push({ path: propertyPath, value: value.v });
		else result.push(...collectDiscriminants(property.val, propertyPath, new Set(seen)));
	}
	return result;
}

function pathsEqual(left: readonly PropertyKey[], right: readonly PropertyKey[]): boolean {
	return left.length === right.length && left.every((key, index) => key === right[index]);
}

function valueAtPath(value: unknown, path: readonly PropertyKey[]): { present: boolean; value?: unknown } {
	let cursor = value;
	for (const key of path) {
		if ((typeof cursor !== "object" && typeof cursor !== "function") || cursor === null || !(key in cursor)) {
			return { present: false };
		}
		cursor = (cursor as Record<PropertyKey, unknown>)[key];
	}
	return { present: true, value: cursor };
}

function discriminateFailure(members: IR[], value: unknown, path: PropertyKey[]): OmpErrors | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const byMember = members.map(member => collectDiscriminants(member));
	const candidates: { path: PropertyKey[]; distinct: number; declared: number }[] = [];
	for (const discriminants of byMember) {
		for (const discriminant of discriminants) {
			if (candidates.some(candidate => pathsEqual(candidate.path, discriminant.path))) continue;
			const values: unknown[] = [];
			let declared = 0;
			for (const branch of byMember) {
				const match = branch.find(candidate => pathsEqual(candidate.path, discriminant.path));
				if (match === undefined) continue;
				declared++;
				if (!values.some(candidate => Object.is(candidate, match.value))) values.push(match.value);
			}
			if (values.length > 1) candidates.push({ path: discriminant.path, distinct: values.length, declared });
		}
	}
	candidates.sort((left, right) => right.distinct - left.distinct || right.declared - left.declared);
	for (const candidate of candidates) {
		const actual = valueAtPath(value, candidate.path);
		const exact: IR[] = [];
		const defaults: IR[] = [];
		const expectedMembers: IR[] = [];
		for (let index = 0; index < members.length; index++) {
			const discriminant = byMember[index].find(item => pathsEqual(item.path, candidate.path));
			if (discriminant === undefined) {
				defaults.push(members[index]);
				continue;
			}
			expectedMembers.push({ k: "lit", v: discriminant.value });
			if (actual.present && Object.is(actual.value, discriminant.value)) exact.push(members[index]);
		}
		if (!actual.present) {
			if (defaults.length !== 0 && defaults.length < members.length) {
				return discriminateFailure(defaults, value, path);
			}
			return fail([...path, ...candidate.path], expectedOf({ k: "union", members: expectedMembers }), undefined);
		}
		if (exact.length === 0) {
			if (defaults.length !== 0) return discriminateFailure(defaults, value, path);
			return fail([...path, ...candidate.path], expectedOf({ k: "union", members: expectedMembers }), actual.value);
		}
		if (exact.length === 1) {
			const result = visit(exact[0], value, path);
			return result instanceof OmpErrors ? result : undefined;
		}
		const nested = discriminateFailure(exact, value, path);
		if (nested !== undefined) return nested;
	}
	return undefined;
}

/** True when a value's runtime shape could only be aimed at this member. */
function kindMatches(base: IR, v: unknown): boolean {
	switch (base.k) {
		case "array":
			return Array.isArray(v);
		case "object":
		case "anyobject":
			return typeof v === "object" && v !== null && !Array.isArray(v);
		case "string":
			return typeof v === "string";
		case "number":
			return typeof v === "number";
		default:
			return false;
	}
}

/* --------------------------------------------------------------------------
 * JIT specialization stage. Emits a validator from the SAME semantic
 * definition the walker interprets: leaf scalar rules come from
 * `scalarChecks`/`scalarPredicateSource` (the shared descriptors), union
 * failure semantics delegate to the single `unionFail`, and any construct
 * that cannot be code-generated (recursive aliases, pattern/symbol-index
 * objects, refine/cfg nodes, object/function literals) is delegated back to
 * the walker via `boundWalk` instead of being restated.
 * ------------------------------------------------------------------------ */

/** Inline-able literal, else undefined (caller hoists into the refs pool). */
function litSource(v: unknown): string | undefined {
	if (v === null) return "null";
	if (v === undefined) return "undefined";
	switch (typeof v) {
		case "string":
		case "boolean":
			return JSON.stringify(v);
		case "number":
			return Number.isFinite(v) ? String(v) : undefined;
		default:
			return undefined;
	}
}

type PathSeg = { s: PropertyKey } | { d: string };

type LiteralIR = Extract<IR, { k: "lit" }>;

function isPrimitiveLiteral(node: IR): node is LiteralIR {
	return node.k === "lit" && (node.v === null || (typeof node.v !== "object" && typeof node.v !== "function"));
}

/** Whether `undefined` necessarily fails, allowing property-presence checks to be elided. */
function rejectsUndefined(node: IR): boolean {
	switch (node.k) {
		case "unknown":
		case "undefined":
		case "alias":
		case "sub":
			return false;
		case "lit":
			return node.v !== undefined;
		case "union":
			return node.members.every(rejectsUndefined);
		case "intersection":
			return node.members.some(rejectsUndefined);
		case "refine":
			return rejectsUndefined(node.base);
		case "morph":
			return rejectsUndefined(node.input);
		default:
			return true;
	}
}

class CompiledMorphContext implements MorphContext {
	#path: PropertyKey[] | PropertyKey | undefined;
	#data: unknown;

	constructor(path: PropertyKey[] | PropertyKey | undefined, data: unknown) {
		this.#path = path;
		this.#data = data;
	}

	error(expectation: string): OmpErrors {
		return new OmpErrors(this.#path, expectation, this.#data);
	}

	reject(expectation: string): OmpErrors {
		return this.error(expectation);
	}
}

class Builder {
	#lines: string[] = [];
	#refs: unknown[] = [];
	#activeAliases: Set<IR> | undefined;
	#id = 0;

	next(prefix: string): string {
		return `${prefix}${this.#id++}`;
	}

	push(line: string): void {
		this.#lines.push(line);
	}

	ref(value: unknown): string {
		const idx = this.#refs.indexOf(value);
		if (idx >= 0) return `R[${idx}]`;
		this.#refs.push(value);
		return `R[${this.#refs.length - 1}]`;
	}

	lit(v: unknown): string {
		return litSource(v) ?? this.ref(v);
	}

	access(base: string, key: PropertyKey): string {
		return typeof key === "string" && IDENT.test(key) ? `${base}.${key}` : `${base}[${this.lit(key)}]`;
	}

	pathExpr(segs: PathSeg[]): string {
		const parts = segs.map(seg => ("s" in seg ? this.lit(seg.s) : seg.d));
		return `[${parts.join(",")}]`;
	}

	storedPathExpr(segs: PathSeg[]): string {
		if (segs.length === 0) return "undefined";
		if (segs.length === 1) {
			const seg = segs[0];
			return "s" in seg ? this.lit(seg.s) : seg.d;
		}
		const staticParts: PropertyKey[] = [];
		for (const seg of segs) {
			if ("d" in seg) return this.pathExpr(segs);
			staticParts.push(seg.s);
		}
		return this.ref(staticParts);
	}

	error(segs: PathSeg[], expected: string, dataExpr: string): string {
		return `new AE(${this.storedPathExpr(segs)},${JSON.stringify(expected)},${dataExpr})`;
	}

	fail(segs: PathSeg[], expected: string, dataExpr: string): string {
		return `return ${this.error(segs, expected, dataExpr)}`;
	}

	appendError(errors: string, error: string): string {
		return `if(${errors}===undefined)${errors}=${error};else ${errors}.append(${error});`;
	}

	/** Pure boolean predicate for a morph-free subtree. */
	predicate(node: IR, v: string): string {
		const scalar = scalarChecks(node);
		if (scalar !== undefined) return scalar.map(check => check.source(v)).join("&&");
		switch (node.k) {
			case "unknown":
				return "true";
			case "null":
				return `${v}===null`;
			case "undefined":
				return `${v}===undefined`;
			case "boolean":
				return `typeof ${v}==="boolean"`;
			case "bigint":
				return `typeof ${v}==="bigint"`;
			case "symbol":
				return `typeof ${v}==="symbol"`;
			case "never":
				return "false";
			case "anyobject":
				return `(typeof ${v}==="object"&&${v}!==null)`;
			case "lit":
				return node.v instanceof Date
					? `(${v} instanceof Date&&${v}.valueOf()===${node.v.valueOf()})`
					: `${v}===${this.lit(node.v)}`;
			case "instance":
				return `${v} instanceof ${this.ref(node.ctor)}`;
			case "union": {
				const lits = node.members.filter(isPrimitiveLiteral);
				if (lits.length > 8) {
					const values = this.ref(new Set(lits.map(member => member.v)));
					const literalNodes = new Set<IR>(lits);
					const rest = node.members.filter(member => !literalNodes.has(member));
					let out = `${values}.has(${v})`;
					for (const m of rest) out += `||(${this.predicate(m, v)})`;
					return `(${out})`;
				}
				return `(${node.members.map(m => `(${this.predicate(m, v)})`).join("||")})`;
			}
			case "intersection":
				return `(${node.members.map(member => `(${this.predicate(member, v)})`).join("&&")})`;
			case "array": {
				const array = this.next("a");
				const index = this.next("i");
				let out = `Array.isArray(${v})`;
				if (node.min !== undefined) out += `&&${v}.length>=${node.min}`;
				if (node.max !== undefined) out += `&&${v}.length<=${node.max}`;
				const item = `${array}[${index}]`;
				out += `&&((${array})=>{for(let ${index}=0;${index}<${array}.length;${index}++)if(!(${this.predicate(node.el, item)}))return false;return true})(${v})`;
				return out;
			}
			case "object": {
				const objectChecks = [`typeof ${v}==="object"`, `${v}!==null`];
				for (const p of node.props) {
					const av = this.access(v, p.key);
					const present = `${this.lit(p.key)} in ${v}`;
					const propPredicate = this.predicate(p.val, av);
					objectChecks.push(
						p.opt || p.hasDefault
							? rejectsUndefined(p.val)
								? `((${av}!==undefined&&(${propPredicate}))||!(${present}))`
								: `(!(${present})||(${propPredicate}))`
							: rejectsUndefined(p.val)
								? propPredicate
								: `((${present})&&(${propPredicate}))`,
					);
				}
				const stringKey = this.next("k");
				if (node.patternIndexes !== undefined) {
					// Consolidate string-key checks into a single IIFE so each
					// pattern-key predicate is evaluated exactly once per key —
					// matching the walker's objectIndexValidators-once-per-key
					// invariant. The cached match result is reused for both
					// pattern-index validation and extras-reject classification.
					const body: string[] = [`for(const ${stringKey} in ${v})if(own.call(${v},${stringKey})){`];
					if (node.index !== undefined) {
						body.push(`if(!(${this.predicate(node.index, `${v}[${stringKey}]`)}))return false;`);
					}
					const matchVars: string[] = [];
					for (const pattern of node.patternIndexes) {
						const matchVar = this.next("m");
						matchVars.push(matchVar);
						body.push(`const ${matchVar}=(${this.predicate(pattern.key, stringKey)});`);
						body.push(`if(${matchVar}&&!(${this.predicate(pattern.val, `${v}[${stringKey}]`)}))return false;`);
					}
					if (node.extras === "reject" && node.index === undefined) {
						const patternMatch = matchVars.length > 0 ? matchVars.join("||") : "false";
						body.push(`if(!(${this.declaredCheck(node.props, stringKey)})&&!(${patternMatch}))return false;`);
					}
					body.push("}");
					objectChecks.push(`(()=>{${body.join("")}return true})()`);
				} else {
					if (node.index !== undefined) {
						objectChecks.push(
							`(()=>{for(const ${stringKey} in ${v})if(own.call(${v},${stringKey})&&!(${this.predicate(node.index, `${v}[${stringKey}]`)}))return false;return true})()`,
						);
					}
					if (node.extras === "reject" && node.index === undefined) {
						objectChecks.push(
							`(()=>{for(const ${stringKey} in ${v})if(own.call(${v},${stringKey})&&!(${this.declaredCheck(node.props, stringKey)}))return false;return true})()`,
						);
					}
				}
				if (node.symbolIndex !== undefined) {
					const symbol = this.next("s");
					objectChecks.push(
						`(()=>{for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.predicate(node.symbolIndex, `${v}[${symbol}]`)}))return false;return true})()`,
					);
				}
				if (node.extras === "reject" && node.symbolIndex === undefined) {
					const symbol = this.next("s");
					objectChecks.push(
						`(()=>{for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.declaredCheck(node.props, symbol)}))return false;return true})()`,
					);
				}
				return `(${objectChecks.join("&&")})`;
			}
			case "sub":
				return `!(${this.ref(node.schema.run)}(${v}) instanceof AE)`;
			default:
				return `!(${this.ref(boundWalk(node))}(${v}) instanceof AE)`;
		}
	}

	declaredCheck(props: PropIR[], keyVar: string): string {
		if (props.length === 0) return "false";
		if (props.length > 6) {
			const set = this.ref(new Set(props.map(p => p.key)));
			return `${set}.has(${keyVar})`;
		}
		return `(${props.map(p => `${keyVar}===${this.lit(p.key)}`).join("||")})`;
	}

	/**
	 * Run a node through its interpreter/sub-schema runner, appending any
	 * failure to `errors`. `brk` (when given) exits the enclosing block on
	 * failure so dependent statements (output assignment, morph fns) are
	 * skipped. Both runner kinds receive the absolute path so nested step
	 * callbacks observe ctx.path; walk-produced errors are already absolute,
	 * while sub runners return schema-relative errors that need prefixing.
	 */
	emitCollectDelegate(node: IR, v: string, segs: PathSeg[], errors: string, brk?: string, out?: string): void {
		const sub = node.k === "sub";
		const runner = sub ? node.schema.run : boundWalk(node);
		const result = this.next("r");
		const args = segs.length > 0 ? `${v},${this.pathExpr(segs)}` : v;
		this.push(`const ${result}=${this.ref(runner)}(${args});`);
		const failure = sub && segs.length > 0 ? `PF(${result},${this.pathExpr(segs)})` : result;
		this.push(
			`if(${result} instanceof AE){${this.appendError(errors, failure)}${brk === undefined ? "" : `break ${brk};`}}`,
		);
		if (out !== undefined) this.push(`${out}=${result};`);
	}

	/** Snapshot the error count so sequencing sites can detect soft failures. */
	markErrors(errors: string): string {
		const mark = this.next("n");
		this.push(`const ${mark}=${errors}===void 0?0:${errors}.length;`);
		return mark;
	}

	/** Exit `brk` when errors were appended since `mark` (walker's return-on-error). */
	guardGrowth(errors: string, mark: string, brk: string): void {
		this.push(`if((${errors}===void 0?0:${errors}.length)!==${mark})break ${brk};`);
	}

	/** Aggregate every independent failure in a morph-free subtree. */
	emitCollectCheck(node: IR, v: string, segs: PathSeg[], errors: string, failureData = v): void {
		if (node.cfg !== undefined || node.k === "refine") {
			this.emitCollectDelegate(node, v, segs, errors);
			return;
		}
		switch (node.k) {
			case "unknown":
				return;
			case "array": {
				const expectation = arrayExpectation(node);
				this.push(
					`if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, expectation.notArray, failureData))}}`,
				);
				if (node.min !== undefined && expectation.tooShort !== undefined) {
					this.push(
						`else if(${v}.length<${node.min}){${this.appendError(
							errors,
							this.error(segs, expectation.tooShort, `${v}.length`),
						)}}`,
					);
				}
				if (node.max !== undefined && expectation.tooLong !== undefined) {
					this.push(
						`else if(${v}.length>${node.max}){${this.appendError(
							errors,
							this.error(segs, expectation.tooLong, `${v}.length`),
						)}}`,
					);
				}
				this.push("else{");
				const index = this.next("i");
				this.push(`for(let ${index}=0;${index}<${v}.length;${index}++){`);
				this.emitCollectCheck(node.el, `${v}[${index}]`, [...segs, { d: index }], errors);
				this.push("}}");
				return;
			}
			case "tuple": {
				const expectation = tupleExpectation(node);
				this.push(
					`if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, expectation.notArray, failureData))}}else{`,
				);
				const { required: minimum, maximum } = tupleArity(node);
				const requiredPrefix = node.prefix.filter(item => !item.opt && !item.hasDefault).length;
				if (minimum > 0) {
					this.push(
						`if(${v}.length<${minimum}){${this.appendError(
							errors,
							this.error(segs, expectation.tooShort, failureData),
						)}}else{`,
					);
				}
				if (node.variadic === undefined) {
					this.push(
						`if(${v}.length>${maximum}){${this.appendError(
							errors,
							this.error(segs, expectation.tooLong, failureData),
						)}}else{`,
					);
				}
				let postfixStart = `${v}.length`;
				if (node.postfix.length > 0) {
					postfixStart = this.next("p");
					this.push(`const ${postfixStart}=${v}.length-${node.postfix.length};`);
				}
				let prefixCount = String(node.prefix.length);
				if (requiredPrefix !== node.prefix.length) {
					prefixCount = this.next("n");
					this.push(`const ${prefixCount}=Math.min(${node.prefix.length},${postfixStart});`);
				}
				for (let index = 0; index < node.prefix.length; index++) {
					if (index >= requiredPrefix) this.push(`if(${index}<${prefixCount}){`);
					this.emitCollectCheck(node.prefix[index].val, `${v}[${index}]`, [...segs, { d: String(index) }], errors);
					if (index >= requiredPrefix) this.push("}");
				}
				if (node.variadic !== undefined) {
					const index = this.next("i");
					this.push(`for(let ${index}=${prefixCount};${index}<${postfixStart};${index}++){`);
					this.emitCollectCheck(node.variadic, `${v}[${index}]`, [...segs, { d: index }], errors);
					this.push("}");
				}
				for (let index = 0; index < node.postfix.length; index++) {
					const inputIndex = index === 0 ? postfixStart : `${postfixStart}+${index}`;
					this.emitCollectCheck(node.postfix[index], `${v}[${inputIndex}]`, [...segs, { d: inputIndex }], errors);
				}
				if (node.variadic === undefined) this.push("}");
				if (minimum > 0) this.push("}");
				this.push("}");
				return;
			}
			case "object": {
				// Pattern/symbol indexes make extra-key classification depend on
				// matching every index, so they delegate to the walker. The emitted
				// reject loops below rely on that: they classify with a bare
				// `!declaredCheck` because only the pattern-free case reaches them,
				// where the index-claimed test collapses to exactly `!declaredCheck`.
				if (
					node.patternIndexes !== undefined ||
					node.symbolIndex !== undefined ||
					node.props.some(prop => typeof prop.key === "symbol")
				) {
					this.emitCollectDelegate(node, v, segs, errors);
					return;
				}
				this.push(
					`if(typeof ${v}!=="object"||${v}===null){${this.appendError(
						errors,
						this.error(segs, NOT_OBJECT, failureData),
					)}}else{`,
				);
				for (const prop of node.props) {
					const present = `${this.lit(prop.key)} in ${v}`;
					const propSegs: PathSeg[] = [...segs, { s: prop.key }];
					if (prop.opt || prop.hasDefault) {
						this.push(`if(${present}){`);
						this.emitCollectCheck(prop.val, this.access(v, prop.key), propSegs, errors);
						this.push("}");
					} else {
						this.push(
							`if(!(${present})){${this.appendError(
								errors,
								this.error(propSegs, expectedOf(prop.val), "M"),
							)}}else{`,
						);
						this.emitCollectCheck(prop.val, this.access(v, prop.key), propSegs, errors);
						this.push("}");
					}
				}
				if (node.index !== undefined) {
					const key = this.next("k");
					this.push(`for(const ${key} in ${v})if(own.call(${v},${key})){`);
					this.emitCollectCheck(node.index, `${v}[${key}]`, [...segs, { d: key }], errors);
					this.push("}");
				} else if (node.extras === "reject") {
					const key = this.next("k");
					this.push(
						`for(const ${key} in ${v})if(own.call(${v},${key})&&!(${this.declaredCheck(node.props, key)})){`,
					);
					this.push(this.appendError(errors, this.error([...segs, { d: key }], EXTRAS_REJECTED, `${v}[${key}]`)));
					this.push("}");
				}
				if (node.extras === "reject") {
					const symbol = this.next("s");
					this.push(
						`for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.declaredCheck(node.props, symbol)})){${this.appendError(errors, this.error([...segs, { d: symbol }], EXTRAS_REJECTED, `${v}[${symbol}]`))}}`,
					);
				}
				this.push("}");
				return;
			}
			case "union": {
				const failure = node.members.some(canRefineUnionFailure)
					? `UF(${this.ref(node)},${failureData},${this.pathExpr(segs)},${JSON.stringify(expectedOf(node))})`
					: this.error(segs, expectedOf(node), failureData);
				this.push(`if(!(${this.predicate(node, v)})){${this.appendError(errors, failure)}}`);
				return;
			}
			case "string": {
				const expectation = stringExpectation(node);
				this.push(
					`if(typeof ${v}!=="string"){${this.appendError(errors, this.error(segs, expectation.notString, failureData))}}`,
				);
				if (node.min !== undefined && expectation.tooShort !== undefined) {
					this.push(
						`else if(${v}.length<${node.min}){${this.appendError(
							errors,
							this.error(segs, expectation.tooShort, `${v}.length`),
						)}}`,
					);
				}
				if (node.max !== undefined && expectation.tooLong !== undefined) {
					this.push(
						`else if(${v}.length>${node.max}){${this.appendError(
							errors,
							this.error(segs, expectation.tooLong, `${v}.length`),
						)}}`,
					);
				}
				if (expectation.notUrl !== undefined) {
					this.push(
						`else if(!URL.canParse(${v})){${this.appendError(
							errors,
							this.error(segs, expectation.notUrl, failureData),
						)}}`,
					);
				}
				return;
			}
			case "number": {
				const expectation = numberExpectation(node);
				this.push(
					`if(typeof ${v}!=="number"||!Number.isFinite(${v})){${this.appendError(
						errors,
						this.error(segs, expectation.notNumber, failureData),
					)}}else{`,
				);
				if (node.int) {
					this.push(
						`if(!Number.isInteger(${v})){${this.appendError(errors, this.error(segs, expectation.notInteger, failureData))}}`,
					);
				}
				if (node.divisor !== undefined && expectation.notDivisible !== undefined) {
					this.push(
						`if(${v}%${node.divisor}!==0){${this.appendError(
							errors,
							this.error(segs, expectation.notDivisible, failureData),
						)}}`,
					);
				}
				if (node.min !== undefined && expectation.belowMin !== undefined) {
					this.push(
						`if(${v}${node.xmin ? "<=" : "<"}${node.min}){${this.appendError(
							errors,
							this.error(segs, expectation.belowMin, failureData),
						)}}`,
					);
				}
				if (node.max !== undefined && expectation.aboveMax !== undefined) {
					this.push(
						`if(${v}${node.xmax ? ">=" : ">"}${node.max}){${this.appendError(
							errors,
							this.error(segs, expectation.aboveMax, failureData),
						)}}`,
					);
				}
				this.push("}");
				return;
			}
			case "lit":
				if (
					(node.v !== null && typeof node.v === "object" && !(node.v instanceof Date)) ||
					typeof node.v === "function"
				) {
					this.emitCollectDelegate(node, v, segs, errors);
				} else {
					this.push(
						`if(!(${this.predicate(node, v)})){${this.appendError(
							errors,
							this.error(segs, expectedOf(node), failureData),
						)}}`,
					);
				}
				return;
			case "intersection":
			case "sub":
				this.emitCollectDelegate(node, v, segs, errors);
				return;
			case "null":
			case "undefined":
			case "boolean":
			case "bigint":
			case "symbol":
			case "never":
			case "anyobject":
			case "instance":
				this.push(
					`if(!(${this.predicate(node, v)})){${this.appendError(
						errors,
						this.error(segs, expectedOf(node), failureData),
					)}}`,
				);
				return;
			default:
				this.emitCollectDelegate(node, v, segs, errors);
		}
	}

	emitTupleShape(
		node: TupleIR,
		v: string,
		segs: PathSeg[],
		errors: string,
		brk: string,
		failureData: string,
	): { postfixStart: string; prefixCount: string; requiredPrefix: number } {
		const expectation = tupleExpectation(node);
		this.push(
			`if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, expectation.notArray, failureData))}break ${brk};}`,
		);
		const requiredPrefix = node.prefix.filter(item => !item.opt && !item.hasDefault).length;
		const { required: minimum, maximum } = tupleArity(node);
		if (minimum > 0) {
			this.push(
				`if(${v}.length<${minimum}){${this.appendError(
					errors,
					this.error(segs, expectation.tooShort, failureData),
				)}break ${brk};}`,
			);
		}
		if (node.variadic === undefined) {
			this.push(
				`if(${v}.length>${maximum}){${this.appendError(
					errors,
					this.error(segs, expectation.tooLong, failureData),
				)}break ${brk};}`,
			);
		}
		let postfixStart = `${v}.length`;
		if (node.postfix.length > 0) {
			postfixStart = this.next("p");
			this.push(`const ${postfixStart}=${v}.length-${node.postfix.length};`);
		}
		let prefixCount = String(node.prefix.length);
		if (requiredPrefix !== node.prefix.length) {
			prefixCount = this.next("n");
			this.push(`const ${prefixCount}=Math.min(${node.prefix.length},${postfixStart});`);
		}
		return { postfixStart, prefixCount, requiredPrefix };
	}

	/** Fill `target` with a validated default (factory output revalidated per call). */
	emitDefaultFill(val: IR, def: unknown, isFactory: boolean, target: string, segs: PathSeg[], errors: string): void {
		if (isFactory && typeof def === "function") {
			const candidate = this.next("d");
			const resolved = this.next("t");
			const label = this.next("L");
			this.push(`const ${candidate}=${this.ref(def)}();let ${resolved};${label}:{`);
			this.emitCollectProduce(val, candidate, segs, resolved, errors, label);
			this.push(`${target}=${resolved};}`);
		} else {
			// Static defaults were prevalidated at construction; MD clones
			// mutable payloads so callers cannot alias the schema's copy.
			this.push(`${target}=${litSource(def) ?? `MD(${this.ref(def)})`};`);
		}
	}

	/**
	 * Validate `v` against a morphing subtree and assign the produced output
	 * to `out` (an already-declared `let`). Failures append to `errors` and
	 * `break ${brk}` (skipping the output assignment), mirroring the walker: an
	 * error in one child never suppresses sibling validation or morphs.
	 */
	emitCollectProduce(
		node: IR,
		v: string,
		segs: PathSeg[],
		out: string,
		errors: string,
		brk: string,
		failureData = v,
	): void {
		if (node.cfg !== undefined || node.k === "refine") {
			this.emitCollectDelegate(node, v, segs, errors, brk, out);
			return;
		}
		if (!hasMorph(node)) {
			this.emitCollectCheck(node, v, segs, errors, failureData);
			this.push(`${out}=${v};`);
			return;
		}
		switch (node.k) {
			case "sub":
				this.emitCollectDelegate(node, v, segs, errors, brk, out);
				return;
			case "morph": {
				const input = this.next("t");
				this.push(`let ${input};`);
				const mark = this.markErrors(errors);
				this.emitCollectProduce(node.input, v, segs, input, errors, brk, failureData);
				this.guardGrowth(errors, mark, brk);
				const context = this.next("c");
				const result = this.next("r");
				this.push(`const ${context}=new MC(${this.storedPathExpr(segs)},${input});`);
				this.push(`const ${result}=${this.ref(node.fn)}(${input},${context});`);
				this.push(`if(${result} instanceof AE){${this.appendError(errors, result)}break ${brk};}`);
				if (node.out === undefined) this.push(`${out}=${result};`);
				else this.emitCollectProduce(node.out, result, segs, out, errors, brk);
				return;
			}
			case "alias": {
				let active = this.#activeAliases;
				if (active === undefined) {
					active = new Set();
					this.#activeAliases = active;
				}
				if (active.has(node)) {
					this.emitCollectDelegate(node, v, segs, errors, brk, out);
					return;
				}
				active.add(node);
				try {
					this.emitCollectProduce(node.resolve(), v, segs, out, errors, brk, failureData);
				} finally {
					active.delete(node);
				}
				return;
			}
			case "union": {
				const ok = this.next("u");
				this.push(`let ${ok}=false;`);
				const label = this.next("b");
				this.push(`${label}:{`);
				for (const m of node.members) {
					if (m.k !== "sub" && !hasMorph(m)) {
						this.push(`if(${this.predicate(m, v)}){${out}=${v};${ok}=true;break ${label};}`);
					}
				}
				for (const m of node.members) {
					if (m.k === "sub" || hasMorph(m)) {
						const runner = m.k === "sub" ? m.schema.run : m.k === "alias" ? boundWalk(m) : compile(m);
						const r = this.next("r");
						this.push(`const ${r}=${this.ref(runner)}(${v});`);
						this.push(`if(!(${r} instanceof AE)){${out}=${r};${ok}=true;break ${label};}`);
					}
				}
				this.push("}");
				const failure = `UF(${this.ref(node)},${failureData},${this.pathExpr(segs)},${JSON.stringify(expectedOf(node))})`;
				this.push(`if(!${ok}){${this.appendError(errors, failure)}break ${brk};}`);
				return;
			}
			case "array": {
				const expectation = arrayExpectation(node);
				this.push(
					`if(!Array.isArray(${v})){${this.appendError(errors, this.error(segs, expectation.notArray, failureData))}break ${brk};}`,
				);
				if (node.min !== undefined && expectation.tooShort !== undefined) {
					this.push(
						`if(${v}.length<${node.min}){${this.appendError(
							errors,
							this.error(segs, expectation.tooShort, `${v}.length`),
						)}break ${brk};}`,
					);
				}
				if (node.max !== undefined && expectation.tooLong !== undefined) {
					this.push(
						`if(${v}.length>${node.max}){${this.appendError(
							errors,
							this.error(segs, expectation.tooLong, `${v}.length`),
						)}break ${brk};}`,
					);
				}
				const array = this.next("a");
				const index = this.next("i");
				const input = this.next("x");
				const element = this.next("t");
				const label = this.next("L");
				this.push(`const ${array}=new Array(${v}.length);`);
				this.push(
					`for(let ${index}=0;${index}<${v}.length;${index}++){const ${input}=${v}[${index}];let ${element};${label}:{`,
				);
				this.emitCollectProduce(node.el, input, [...segs, { d: index }], element, errors, label);
				this.push(`${array}[${index}]=${element};}}`);
				this.push(`${out}=${array};`);
				return;
			}
			case "tuple": {
				const { postfixStart, prefixCount, requiredPrefix } = this.emitTupleShape(
					node,
					v,
					segs,
					errors,
					brk,
					failureData,
				);
				const tuple = this.next("a");
				this.push(`const ${tuple}=[...${v}];`);
				for (let index = 0; index < node.prefix.length; index++) {
					const item = node.prefix[index];
					const itemSegs: PathSeg[] = [...segs, { s: index }];
					const input = `${v}[${index}]`;
					const output = `${tuple}[${index}]`;
					const label = this.next("L");
					if (index >= requiredPrefix) this.push(`if(${index}<${prefixCount}){`);
					this.push(`${label}:{`);
					if (hasMorph(item.val)) {
						const temporary = this.next("t");
						this.push(`let ${temporary};`);
						this.emitCollectProduce(item.val, input, itemSegs, temporary, errors, label);
						this.push(`${output}=${temporary};`);
					} else {
						this.emitCollectCheck(item.val, input, itemSegs, errors);
					}
					this.push("}");
					if (index >= requiredPrefix) {
						if (item.hasDefault) {
							this.push("}else{");
							this.emitDefaultFill(item.val, item.def, item.defFactory === true, output, itemSegs, errors);
							this.push("}");
						} else {
							this.push("}");
						}
					}
				}
				if (node.variadic !== undefined) {
					const index = this.next("i");
					const input = this.next("x");
					const label = this.next("L");
					this.push(
						`for(let ${index}=${prefixCount};${index}<${postfixStart};${index}++){const ${input}=${v}[${index}];${label}:{`,
					);
					if (hasMorph(node.variadic)) {
						const temporary = this.next("t");
						this.push(`let ${temporary};`);
						this.emitCollectProduce(node.variadic, input, [...segs, { d: index }], temporary, errors, label);
						this.push(`${tuple}[${index}]=${temporary};`);
					} else {
						this.emitCollectCheck(node.variadic, input, [...segs, { d: index }], errors);
					}
					this.push("}}");
				}
				for (let index = 0; index < node.postfix.length; index++) {
					const inputIndex = index === 0 ? postfixStart : `${postfixStart}+${index}`;
					const input = `${v}[${inputIndex}]`;
					const item = node.postfix[index];
					const label = this.next("L");
					this.push(`${label}:{`);
					if (hasMorph(item)) {
						const temporary = this.next("t");
						this.push(`let ${temporary};`);
						this.emitCollectProduce(item, input, [...segs, { d: inputIndex }], temporary, errors, label);
						this.push(`${tuple}[${inputIndex}]=${temporary};`);
					} else {
						this.emitCollectCheck(item, input, [...segs, { d: inputIndex }], errors);
					}
					this.push("}");
				}
				this.push(`${out}=${tuple};`);
				return;
			}
			case "object": {
				// Same delegation invariant as the check path: the emitted reject
				// loops below assume the pattern-free, symbol-free case.
				if (
					node.patternIndexes !== undefined ||
					node.symbolIndex !== undefined ||
					node.props.some(prop => typeof prop.key === "symbol")
				) {
					this.emitCollectDelegate(node, v, segs, errors, brk, out);
					return;
				}
				this.push(
					`if(typeof ${v}!=="object"||${v}===null){${this.appendError(
						errors,
						this.error(segs, NOT_OBJECT, failureData),
					)}break ${brk};}`,
				);
				const object = this.next("o");
				const fresh = node.extras === "delete" && node.index === undefined;
				this.push(fresh ? `const ${object}={};` : `const ${object}={...${v}};`);
				for (const prop of node.props) {
					const present = `${this.lit(prop.key)} in ${v}`;
					const propSegs: PathSeg[] = [...segs, { s: prop.key }];
					const input = this.access(v, prop.key);
					const output = this.access(object, prop.key);
					const label = this.next("L");
					this.push(`if(!(${present})){`);
					if (prop.hasDefault) {
						this.emitDefaultFill(prop.val, prop.def, prop.defFactory === true, output, propSegs, errors);
					} else if (!prop.opt) {
						this.push(this.appendError(errors, this.error(propSegs, expectedOf(prop.val), "M")));
					}
					this.push(`}else{${label}:{`);
					if (hasMorph(prop.val)) {
						const temporary = this.next("t");
						this.push(`let ${temporary};`);
						this.emitCollectProduce(prop.val, input, propSegs, temporary, errors, label);
						this.push(`${output}=${temporary};`);
					} else {
						this.emitCollectCheck(prop.val, input, propSegs, errors);
						if (fresh) this.push(`${output}=${input};`);
					}
					this.push("}}");
				}
				if (node.index !== undefined) {
					const key = this.next("k");
					const label = this.next("L");
					this.push(`for(const ${key} in ${v})if(own.call(${v},${key})){${label}:{`);
					if (hasMorph(node.index)) {
						const temporary = this.next("t");
						this.push(`let ${temporary};`);
						this.emitCollectProduce(node.index, `${v}[${key}]`, [...segs, { d: key }], temporary, errors, label);
						this.push(`${object}[${key}]=${temporary};`);
					} else {
						this.emitCollectCheck(node.index, `${v}[${key}]`, [...segs, { d: key }], errors);
					}
					this.push("}}");
				} else if (node.extras === "reject") {
					const key = this.next("k");
					this.push(
						`for(const ${key} in ${v})if(own.call(${v},${key})&&!(${this.declaredCheck(node.props, key)})){${this.appendError(
							errors,
							this.error([...segs, { d: key }], EXTRAS_REJECTED, `${v}[${key}]`),
						)}}`,
					);
				}
				if (node.extras === "reject") {
					const symbol = this.next("s");
					this.push(
						`for(const ${symbol} of Object.getOwnPropertySymbols(${v}))if(Object.prototype.propertyIsEnumerable.call(${v},${symbol})&&!(${this.declaredCheck(node.props, symbol)})){${this.appendError(errors, this.error([...segs, { d: symbol }], EXTRAS_REJECTED, `${v}[${symbol}]`))}}`,
					);
				}
				this.push(`${out}=${object};`);
				return;
			}
			case "intersection": {
				const current = this.next("t");
				this.push(`let ${current}=${v};`);
				const mark = this.markErrors(errors);
				for (let index = 0; index < node.members.length; index++) {
					if (index > 0) this.guardGrowth(errors, mark, brk);
					const member = node.members[index];
					if (hasMorph(member)) this.emitCollectProduce(member, current, segs, current, errors, brk);
					else this.emitCollectCheck(member, current, segs, errors);
				}
				this.push(`${out}=${current};`);
				return;
			}
			default:
				this.emitCollectDelegate(node, v, segs, errors, brk, out);
		}
	}

	build(ir: IR): (value: unknown) => unknown {
		const errors = this.next("e");
		let ret: string;
		if (hasMorph(ir)) {
			const label = this.next("L");
			this.push(`let ${errors};let o;${label}:{`);
			this.emitCollectProduce(ir, "v", [], "o", errors, label);
			this.push("}");
			ret = "o";
		} else {
			this.push(`let ${errors};`);
			this.emitCollectCheck(ir, "v", [], errors);
			ret = "v";
		}
		this.push(`if(${errors}!==undefined)return ${errors};`);
		const src = `return function(v){${this.#lines.join("")}return ${ret}}`;
		const make = new Function("R", "AE", "M", "PF", "UF", "MC", "own", "MD", src) as (
			refs: unknown[],
			ae: typeof OmpErrors,
			m: typeof MISSING,
			pf: typeof prefixErrors,
			uf: typeof unionFail,
			mc: typeof CompiledMorphContext,
			ownFn: typeof own,
			md: typeof materializeDefault,
		) => (value: unknown) => unknown;
		return make(
			this.#refs,
			OmpErrors,
			MISSING,
			prefixErrors,
			unionFail,
			CompiledMorphContext,
			own,
			materializeDefault,
		);
	}

	emitAllows(node: IR, v: string): void {
		switch (node.k) {
			case "array": {
				const array = this.next("a");
				const index = this.next("i");
				this.push(`const ${array}=${v};if(!Array.isArray(${array}))return false;`);
				if (node.min !== undefined) this.push(`if(${array}.length<${node.min})return false;`);
				if (node.max !== undefined) this.push(`if(${array}.length>${node.max})return false;`);
				this.push(`for(let ${index}=0;${index}<${array}.length;${index}++){`);
				this.emitAllows(node.el, `${array}[${index}]`);
				this.push("}");
				return;
			}
			case "object": {
				const object = this.next("o");
				this.push(`const ${object}=${v};if(typeof ${object}!=="object"||${object}===null)return false;`);
				for (const prop of node.props) {
					const value = this.next("p");
					const present = `${this.lit(prop.key)} in ${object}`;
					this.push(`const ${value}=${this.access(object, prop.key)};`);
					if (prop.opt || prop.hasDefault) {
						if (rejectsUndefined(prop.val)) {
							this.push(`if(${value}!==undefined){`);
							this.emitAllows(prop.val, value);
							this.push(`}else if(${present})return false;`);
						} else {
							this.push(`if(${present}){`);
							this.emitAllows(prop.val, value);
							this.push("}");
						}
					} else {
						if (!rejectsUndefined(prop.val)) this.push(`if(!(${present}))return false;`);
						this.emitAllows(prop.val, value);
					}
				}
				const stringKey = this.next("k");
				if (node.patternIndexes !== undefined) {
					// Consolidate string-key iteration into a single loop so each
					// pattern-key predicate is evaluated exactly once per key —
					// matching the walker's objectIndexValidators-once-per-key
					// invariant. The cached match result is reused for both
					// pattern-index validation and extras-reject classification.
					this.push(`for(const ${stringKey} in ${object}){if(!own.call(${object},${stringKey}))continue;`);
					if (node.index !== undefined) {
						this.emitAllows(node.index, `${object}[${stringKey}]`);
					}
					const matchVars: string[] = [];
					for (const pattern of node.patternIndexes) {
						const matchVar = this.next("m");
						matchVars.push(matchVar);
						this.push(`const ${matchVar}=(${this.predicate(pattern.key, stringKey)});`);
						this.push(
							`if(${matchVar}&&!(${this.predicate(pattern.val, `${object}[${stringKey}]`)}))return false;`,
						);
					}
					if (node.extras === "reject" && node.index === undefined) {
						const patternMatch = matchVars.length > 0 ? matchVars.join("||") : "false";
						this.push(`if(!(${this.declaredCheck(node.props, stringKey)})&&!(${patternMatch}))return false;`);
					}
					this.push("}");
				} else {
					if (node.index !== undefined) {
						this.push(`for(const ${stringKey} in ${object}){if(!own.call(${object},${stringKey}))continue;`);
						this.emitAllows(node.index, `${object}[${stringKey}]`);
						this.push("}");
					}
					if (node.extras === "reject" && node.index === undefined) {
						this.push(
							`for(const ${stringKey} in ${object})if(own.call(${object},${stringKey})&&!(${this.declaredCheck(node.props, stringKey)}))return false;`,
						);
					}
				}
				if (node.symbolIndex !== undefined) {
					const symbol = this.next("s");
					this.push(
						`for(const ${symbol} of Object.getOwnPropertySymbols(${object})){if(!Object.prototype.propertyIsEnumerable.call(${object},${symbol}))continue;`,
					);
					this.emitAllows(node.symbolIndex, `${object}[${symbol}]`);
					this.push("}");
				}
				if (node.extras === "reject" && node.symbolIndex === undefined) {
					const symbol = this.next("s");
					this.push(
						`for(const ${symbol} of Object.getOwnPropertySymbols(${object}))if(Object.prototype.propertyIsEnumerable.call(${object},${symbol})&&!(${this.declaredCheck(node.props, symbol)}))return false;`,
					);
				}
				return;
			}
			case "union": {
				const sources: string[] = [];
				for (const member of node.members) {
					if (!isPrimitiveLiteral(member)) break;
					const source = litSource(member.v);
					if (source === undefined) break;
					sources.push(source);
				}
				if (sources.length === node.members.length && sources.length >= 4) {
					this.push(
						`switch(${v}){${sources.map(source => `case ${source}:`).join("")}break;default:return false;}`,
					);
					return;
				}
				this.push(`if(!(${this.predicate(node, v)}))return false;`);
				return;
			}
			default:
				this.push(`if(!(${this.predicate(node, v)}))return false;`);
		}
	}

	buildAllows(ir: IR): (value: unknown) => value is unknown {
		this.emitAllows(ir, "v");
		const src = `return function(v){${this.#lines.join("")}return true}`;
		const make = new Function("R", "AE", "own", src) as (
			refs: unknown[],
			ae: typeof OmpErrors,
			ownFn: typeof own,
		) => (value: unknown) => value is unknown;
		return make(this.#refs, OmpErrors, own);
	}
}

function prefixErrors(errs: OmpErrors, parts: PropertyKey[]): OmpErrors {
	for (let i = parts.length - 1; i >= 0; i--) errs.prefix(parts[i]);
	return errs;
}

const kWalk = Symbol("omptype.boundWalk");

interface WalkTagged {
	[kWalk]?: (value: unknown, path?: PropertyKey[]) => unknown;
}

/** Cached interpreter closure for recursive aliases and predicate-only fallbacks. */
function boundWalk(node: IR): (value: unknown, path?: PropertyKey[]) => unknown {
	const tagged = node as IR & WalkTagged;
	let fn = tagged[kWalk];
	if (!fn) {
		fn = (value: unknown, path?: PropertyKey[]) => walk(node, value, path);
		tagged[kWalk] = fn;
	}
	return fn;
}

function resolvedRoot(ir: IR): IR {
	return ir.k === "alias" ? ir.resolve() : ir;
}

const compiledCache = new WeakMap<IR, (value: unknown) => unknown>();
const allowsCache = new WeakMap<IR, (value: unknown) => value is unknown>();

/** Compile `ir` into a specialized validator. */
export function compile(ir: IR): (value: unknown) => unknown {
	const root = resolvedRoot(ir);
	const validator = compiledCache.get(root);
	if (validator === undefined) {
		// Publish a deferred wrapper before building: recursive schemas re-enter
		// compile() for the same root mid-build (e.g. an alias element inside an
		// array), and each re-entry must reuse this build instead of starting a
		// fresh one forever. The wrapper resolves to the built validator by call
		// time; the interpreter is a safety net that never triggers post-build.
		let built: ((value: unknown) => unknown) | undefined;
		compiledCache.set(root, value => (built === undefined ? walk(root, value) : built(value)));
		built = new Builder().build(root);
		compiledCache.set(root, built);
		return built;
	}
	return validator;
}

/** Compile `ir` into an allocation-free boolean validator. */
export function compileAllows(ir: IR): (value: unknown) => value is unknown {
	const root = resolvedRoot(ir);
	const validator = allowsCache.get(root);
	if (validator === undefined) {
		let built: ((value: unknown) => value is unknown) | undefined;
		allowsCache.set(root, ((value: unknown) =>
			built === undefined ? !(walk(root, value) instanceof OmpErrors) : built(value)) as (
			value: unknown,
		) => value is unknown);
		built = new Builder().buildAllows(root);
		allowsCache.set(root, built);
		return built;
	}
	return validator;
}

/** Generated source for inspection/debugging. */
export function compileToSource(ir: IR): string {
	const root = resolvedRoot(ir);
	const builder = new Builder();
	if (hasMorph(root)) {
		builder.push("let o;");
		builder.emitCollectProduce(root, "v", [], "o", "e", "L0");
		return `function(v){/* refs elided */return o}`;
	}
	builder.emitCollectCheck(root, "v", [], "e");
	return `function(v){/* refs elided */return v}`;
}
