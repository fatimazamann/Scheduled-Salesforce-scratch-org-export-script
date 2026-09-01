'use strict';

/**
 * lib/args.js
 * ---------------------------------------------------------------------------
 * A ~90-line argument parser covering exactly what this project needs.
 *
 * WHY NOT COMMANDER, WHICH THE ORIGINAL USED?
 *
 * The flag surface is identical -- every original short and long form still
 * works -- but dropping the dependency means the whole tool has zero runtime
 * dependencies. That matters here specifically: a Windows scheduled task runs
 * under a different account, often from a directory that was copied or pulled
 * rather than `npm install`-ed, and "cannot find module 'commander'" at 2am is
 * a failure mode with no upside. If you would rather keep commander, the only
 * file that needs changing is export-script.js.
 *
 * Supported forms:  --flag value   --flag=value   -f value   --boolean-flag
 * Unknown flags are an error -- a typo must fail loudly, not be ignored.
 * ---------------------------------------------------------------------------
 */

class ArgError extends Error {}

/**
 * @param {string[]} argv   Usually process.argv.slice(2)
 * @param {object} spec     { camelName: { long, short?, boolean?, default?, repeatable? } }
 * @returns {object}        Parsed values keyed by camelName.
 */
function parseArgs(argv, spec) {
	const byLong = new Map();
	const byShort = new Map();
	const result = {};

	for (const [name, def] of Object.entries(spec)) {
		byLong.set(def.long, { name, def });
		if (def.short) byShort.set(def.short, { name, def });
		result[name] = def.repeatable ? [] : def.default !== undefined ? def.default : def.boolean ? false : '';
	}

	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (typeof token !== 'string' || token.length === 0) continue;

		let key = null;
		let inlineValue = null;

		if (token.startsWith('--')) {
			const eq = token.indexOf('=');
			if (eq !== -1) {
				key = token.slice(2, eq);
				inlineValue = token.slice(eq + 1);
			} else {
				key = token.slice(2);
			}
			if (!byLong.has(key)) throw new ArgError(`Unknown option: --${key}`);
			key = byLong.get(key);
		} else if (token.startsWith('-') && token.length > 1) {
			const short = token.slice(1);
			if (!byShort.has(short)) throw new ArgError(`Unknown option: -${short}`);
			key = byShort.get(short);
		} else {
			throw new ArgError(`Unexpected positional argument: ${JSON.stringify(token)}`);
		}

		const { name, def } = key;

		if (def.boolean) {
			if (inlineValue !== null) {
				const v = inlineValue.toLowerCase();
				if (!['true', 'false', '1', '0', 'yes', 'no'].includes(v)) {
					throw new ArgError(`--${def.long} accepts true/false, got ${JSON.stringify(inlineValue)}`);
				}
				result[name] = ['true', '1', 'yes'].includes(v);
			} else {
				result[name] = true;
			}
			continue;
		}

		let value = inlineValue;
		if (value === null) {
			value = argv[i + 1];
			if (value === undefined || (typeof value === 'string' && value.startsWith('-') && value.length > 1 && !/^-?\d/.test(value))) {
				throw new ArgError(`--${def.long} requires a value.`);
			}
			i += 1;
		}

		if (def.repeatable) result[name].push(value);
		else result[name] = value;
	}

	return result;
}

/** Render a spec as help text. */
function renderHelp(header, spec, footer) {
	const rows = Object.values(spec).map((def) => {
		const flags = (def.short ? `-${def.short}, ` : '    ') + `--${def.long}${def.boolean ? '' : ' <value>'}`;
		return [flags, def.description || ''];
	});
	const width = Math.max(...rows.map((r) => r[0].length));
	const body = rows.map(([f, d]) => `  ${f.padEnd(width)}  ${d}`).join('\n');
	return [header, '', body, footer ? `\n${footer}` : ''].join('\n');
}

module.exports = { ArgError, parseArgs, renderHelp };
