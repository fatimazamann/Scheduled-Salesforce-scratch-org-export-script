'use strict';

/**
 * lib/sf-cli.js
 * ---------------------------------------------------------------------------
 * Safe process execution for the Salesforce CLI and other executables.
 *
 * WHY THIS FILE EXISTS
 *
 * The original exporter built shell command strings with template literals and
 * handed them to child_process.exec(). That is a command-injection hazard
 * (Node's own docs warn against passing unsanitised input to a shell) and it
 * also breaks on paths containing spaces. Everything here uses argument ARRAYS
 * with shell:false so the OS -- not a shell -- decides where one argument ends
 * and the next begins.
 *
 * THE WINDOWS `.cmd` COMPLICATION
 *
 * On Windows the Salesforce CLI is almost always a batch shim (`sf.cmd`), not a
 * native `.exe`. CreateProcess cannot execute a `.cmd` directly, so *something*
 * has to route it through cmd.exe, and cmd.exe re-parses the command line --
 * which is exactly the injection surface we are trying to remove (this is the
 * class of bug known as "BatBadBut" / CVE-2024-27980).
 *
 * We deal with that in three tiers, best first:
 *
 *   1. `sfCliEntry` in config -- the CLI's own JS entry point. We then spawn
 *      `node <entry> ...args` with shell:false. No shell is involved at all.
 *      This is the safest and also the fastest (skips two process hops).
 *   2. A resolved `.exe` on PATH -- spawned directly with shell:false.
 *   3. A `.cmd`/`.bat` shim -- spawned through cmd.exe with
 *      windowsVerbatimArguments and BOTH layers of escaping applied
 *      (CommandLineToArgvW quoting, then cmd.exe metacharacter carets).
 *
 * Tier 3 is still hardened, but callers should additionally validate untrusted
 * values with the assertValid* helpers below. Defence in depth: escape *and*
 * validate.
 * ---------------------------------------------------------------------------
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const IS_WINDOWS = process.platform === 'win32';

/** Cap on how much child output we retain in memory (bytes). */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Executable resolution
// ---------------------------------------------------------------------------

/** Resolve a System32 tool by absolute path when possible (avoids PATH games). */
function systemExe(name) {
	if (!IS_WINDOWS) return name;
	const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
	const candidate = path.join(root, 'System32', name);
	return fs.existsSync(candidate) ? candidate : name;
}

/**
 * Locate an executable on PATH.
 * Returns the absolute path, or null when it is not found.
 * Prefers a real `.exe` over a `.cmd` shim because `.exe` needs no shell hop.
 */
function resolveExecutable(name) {
	if (!name) return null;
	if (path.isAbsolute(name)) return fs.existsSync(name) ? name : null;

	let finder;
	if (IS_WINDOWS) {
		finder = systemExe('where.exe');
	} else {
		finder = fs.existsSync('/usr/bin/which') ? '/usr/bin/which' : 'which';
	}

	const res = spawnSync(finder, [name], {
		encoding: 'utf8',
		windowsHide: true,
		shell: false,
	});
	if (res.error || res.status !== 0) return null;

	const hits = String(res.stdout || '')
		.split(/\r?\n/)
		.map((s) => s.trim())
		.filter(Boolean);
	if (hits.length === 0) return null;

	return hits.find((h) => /\.exe$/i.test(h)) || hits[0];
}

// ---------------------------------------------------------------------------
// Argument escaping (only ever used on the tier-3 cmd.exe path)
// ---------------------------------------------------------------------------

/**
 * Quote a single argument per the CommandLineToArgvW rules that every normal
 * Windows program uses to split its raw command line back into argv.
 */
function quoteArgvW(arg) {
	const s = String(arg);
	if (s === '') return '""';
	if (!/[\s"]/.test(s)) return s;

	let out = '"';
	let backslashes = 0;
	for (const ch of s) {
		if (ch === '\\') {
			backslashes += 1;
			continue;
		}
		if (ch === '"') {
			// Backslashes preceding a quote must be doubled, then the quote escaped.
			out += '\\'.repeat(backslashes * 2 + 1) + '"';
			backslashes = 0;
			continue;
		}
		out += '\\'.repeat(backslashes) + ch;
		backslashes = 0;
	}
	// Trailing backslashes precede the closing quote, so they must be doubled too.
	out += '\\'.repeat(backslashes * 2) + '"';
	return out;
}

/** cmd.exe metacharacters. `%` and `!` matter because of variable expansion. */
const CMD_METACHARACTERS = /[()%!^"<>&|]/g;

/**
 * Escape an argument for a command line that cmd.exe will process FIRST and the
 * target program will re-parse SECOND. Both layers must be neutralised, so we
 * apply argv quoting and then caret-escape every character cmd.exe treats as
 * special -- including the quotes we just added.
 */
function escapeForCmd(arg) {
	return quoteArgvW(arg).replace(CMD_METACHARACTERS, '^$&');
}

/**
 * Decide how to actually launch `exe` with `args`.
 * Returns spawn-ready { file, args, windowsVerbatimArguments }.
 */
function buildInvocation(exe, args) {
	if (IS_WINDOWS && /\.(cmd|bat)$/i.test(exe)) {
		const comspec = process.env.ComSpec || systemExe('cmd.exe');
		const line = [exe, ...args].map(escapeForCmd).join(' ');
		// /d = skip AutoRun, /s = strip the outermost quote pair, /c = run and exit.
		return {
			file: comspec,
			args: ['/d', '/s', '/c', `"${line}"`],
			windowsVerbatimArguments: true,
		};
	}
	return { file: exe, args, windowsVerbatimArguments: false };
}

// ---------------------------------------------------------------------------
// Input validation (defence in depth -- run BEFORE anything reaches a command line)
// ---------------------------------------------------------------------------

const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._%+-]*@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const ORG_ID_RE = /^[A-Za-z0-9]{15,18}$/;
const SOBJECT_RE = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

class ValidationError extends Error {}

function assertValidUsername(value) {
	if (typeof value !== 'string' || value.length === 0) {
		throw new ValidationError('Salesforce username is missing.');
	}
	if (value.length > 255 || !USERNAME_RE.test(value)) {
		throw new ValidationError(`Salesforce username has an unexpected shape: ${JSON.stringify(value)}`);
	}
	return value;
}

function assertValidOrgId(value) {
	if (typeof value !== 'string' || !ORG_ID_RE.test(value)) {
		throw new ValidationError(`Org ID has an unexpected shape: ${JSON.stringify(value)}`);
	}
	return value;
}

function assertValidSObject(value) {
	if (typeof value !== 'string' || !SOBJECT_RE.test(value)) {
		throw new ValidationError(`sObject API name has an unexpected shape: ${JSON.stringify(value)}`);
	}
	return value;
}

/**
 * Record names (connectors) are free text in Salesforce, so we cannot allowlist
 * them. We only reject control characters, which have no legitimate place in a
 * name and are the part that makes escaping unreliable. Quoting for SOQL is
 * handled separately in lib/soql.js.
 */
function assertPrintable(value, label) {
	if (typeof value !== 'string' || value.length === 0) {
		throw new ValidationError(`${label} must be a non-empty string.`);
	}
	if (CONTROL_CHARS_RE.test(value)) {
		throw new ValidationError(`${label} contains control characters: ${JSON.stringify(value)}`);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Run a command with an argument array. Never uses a shell on POSIX, and only
 * uses cmd.exe on Windows when the target is a .cmd/.bat shim.
 *
 * @returns {Promise<{code:number|null, signal:string|null, stdout:string,
 *                    stderr:string, timedOut:boolean, durationMs:number,
 *                    truncated:boolean, display:string}>}
 */
function run(exe, args, options = {}) {
	const {
		cwd,
		env = process.env,
		timeoutMs = 0,
		onStdoutLine = null,
		onStderrLine = null,
		capture = true,
	} = options;

	const invocation = buildInvocation(exe, args);
	// A safe, log-friendly rendering of what we are about to run. Not a shell
	// command -- purely for humans reading the log.
	const display = [exe, ...args]
		.map((a) => (/[\s"]/.test(String(a)) ? JSON.stringify(String(a)) : String(a)))
		.join(' ');

	return new Promise((resolve) => {
		const startedAt = Date.now();
		let stdout = '';
		let stderr = '';
		let truncated = false;
		let timedOut = false;
		let settled = false;

		let child;
		try {
			child = spawn(invocation.file, invocation.args, {
				cwd,
				env,
				shell: false,
				windowsHide: true,
				windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (err) {
			resolve({
				code: null,
				signal: null,
				stdout: '',
				stderr: `Failed to spawn ${exe}: ${err.message}`,
				timedOut: false,
				durationMs: 0,
				truncated: false,
				display,
			});
			return;
		}

		const makeSink = (which, onLine) => {
			let carry = '';
			return (chunk) => {
				const text = chunk.toString('utf8');
				if (capture) {
					const target = which === 'out' ? stdout : stderr;
					if (target.length + text.length > MAX_CAPTURE_BYTES) {
						truncated = true;
					} else if (which === 'out') {
						stdout += text;
					} else {
						stderr += text;
					}
				}
				if (!onLine) return;
				carry += text;
				const lines = carry.split(/\r?\n/);
				carry = lines.pop();
				for (const line of lines) onLine(line);
			};
		};

		child.stdout.on('data', makeSink('out', onStdoutLine));
		child.stderr.on('data', makeSink('err', onStderrLine));

		let timer = null;
		if (timeoutMs > 0) {
			timer = setTimeout(() => {
				timedOut = true;
				try {
					child.kill('SIGTERM');
				} catch (_) {
					/* already gone */
				}
				// Windows has no graceful SIGTERM for detached trees; force it.
				setTimeout(() => {
					try {
						child.kill('SIGKILL');
					} catch (_) {
						/* already gone */
					}
				}, 5000).unref();
			}, timeoutMs);
		}

		const finish = (code, signal, spawnError) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (spawnError) stderr += `\n${spawnError.message}`;
			resolve({
				code,
				signal,
				stdout,
				stderr,
				timedOut,
				durationMs: Date.now() - startedAt,
				truncated,
				display,
			});
		};

		child.on('error', (err) => finish(null, null, err));
		child.on('close', (code, signal) => finish(code, signal, null));
	});
}

/**
 * Tolerant extraction of the JSON document from a `--json` CLI response.
 * The Salesforce CLI occasionally prints update notices or warnings around the
 * payload, so we take the outermost {...} rather than JSON.parse the whole
 * stream. Returns null when nothing parseable is present.
 */
function extractJson(text) {
	if (!text) return null;
	const first = text.indexOf('{');
	const last = text.lastIndexOf('}');
	if (first === -1 || last <= first) return null;
	try {
		return JSON.parse(text.slice(first, last + 1));
	} catch (_) {
		return null;
	}
}

/**
 * Build a bound runner for the Salesforce CLI.
 *
 * @param {object} opts
 * @param {string} [opts.sfExecutable] Resolved path to sf / sf.cmd / sf.exe.
 * @param {string} [opts.sfCliEntry]   Path to the CLI's JS entry point. When
 *                                     set, we run `node <entry> ...` and no
 *                                     shell is used on any platform.
 * @param {number} [opts.timeoutMs]
 */
function createSfRunner(opts = {}) {
	const { sfExecutable, sfCliEntry, timeoutMs = 120000 } = opts;

	if (!sfCliEntry && !sfExecutable) {
		throw new Error('createSfRunner requires sfExecutable or sfCliEntry.');
	}

	async function sf(args, runOptions = {}) {
		if (sfCliEntry) {
			return run(process.execPath, [sfCliEntry, ...args], {
				timeoutMs,
				...runOptions,
			});
		}
		return run(sfExecutable, args, { timeoutMs, ...runOptions });
	}

	/** Run an `sf ... --json` command and return { ok, json, result, raw }. */
	async function sfJson(args, runOptions = {}) {
		const raw = await sf([...args, '--json'], runOptions);
		const json = extractJson(raw.stdout) || extractJson(raw.stderr);
		const ok = raw.code === 0 && json != null && json.status === 0;
		return { ok, json, result: json ? json.result : undefined, raw };
	}

	return { sf, sfJson };
}

module.exports = {
	IS_WINDOWS,
	ValidationError,
	assertPrintable,
	assertValidOrgId,
	assertValidSObject,
	assertValidUsername,
	buildInvocation,
	createSfRunner,
	escapeForCmd,
	extractJson,
	quoteArgvW,
	resolveExecutable,
	run,
	systemExe,
};
