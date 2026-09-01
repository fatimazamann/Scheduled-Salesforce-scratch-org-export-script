'use strict';

/**
 * lib/logger.js
 * ---------------------------------------------------------------------------
 * Line-oriented logging with mandatory secret redaction.
 *
 * `sf org list --json` returns live `accessToken` values for some orgs, and
 * `sf org display --verbose` returns an `sfdxAuthUrl` that embeds a refresh
 * token. Salesforce's own docs warn: "The SFDX auth URL contains sensitive
 * information, such as a refresh token that can be used to access an org. Don't
 * share or distribute this URL or token."
 *
 * Two complementary defences:
 *   - pickOrgFields()  -- an ALLOWLIST. Org records are never logged wholesale;
 *                         only the named fields survive. Nothing new that
 *                         Salesforce adds to the payload can leak by default.
 *   - redactText()     -- a DENYLIST for free text we do not control, such as
 *                         CLI stderr. Belt and braces.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/** Object keys whose values must never be written to a log or summary file. */
const SECRET_KEY_RE =
	/(access|refresh|session|id)[-_]?token|^token$|secret|password|passwd|pwd|sfdxauthurl|auth[-_]?url|private[-_]?key|clientsecret|jwt|assertion|credential|cookie|authorization/i;

/** Literal shapes that must be scrubbed out of free text. */
const SECRET_PATTERNS = [
	// SFDX auth URLs: force://<clientId>:<clientSecret>:<refreshToken>@<instance>
	{ re: /force:\/\/[^\s"'`]+/gi, label: 'SFDX_AUTH_URL' },
	// Session / access tokens: 00D... ! ...
	{ re: /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._\-+/=]{15,}/g, label: 'ACCESS_TOKEN' },
	// Connected-app secrets and refresh tokens
	{ re: /\b(?:5Aep|3MVG)[A-Za-z0-9._\-+/=]{20,}/g, label: 'OAUTH_SECRET' },
	// Bearer headers
	{ re: /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}/gi, label: 'BEARER' },
	// PEM blocks
	{ re: /-----BEGIN[^-]{0,40}PRIVATE KEY-----[\s\S]*?-----END[^-]{0,40}PRIVATE KEY-----/g, label: 'PRIVATE_KEY' },
];

function redactText(input) {
	if (input == null) return input;
	let text = String(input);
	for (const { re, label } of SECRET_PATTERNS) {
		text = text.replace(re, `<${label}:REDACTED>`);
	}
	return text;
}

/** Deep redaction for structured values that are about to be serialised. */
function redactValue(value, depth = 0) {
	if (depth > 8) return '<MAX_DEPTH>';
	if (value == null) return value;
	if (typeof value === 'string') return redactText(value);
	if (typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));

	const out = {};
	for (const [key, val] of Object.entries(value)) {
		out[key] = SECRET_KEY_RE.test(key) ? '<REDACTED>' : redactValue(val, depth + 1);
	}
	return out;
}

/**
 * ALLOWLIST for org records coming out of `sf org list --json`.
 * Anything not named here -- accessToken included -- is dropped.
 */
const ORG_SAFE_FIELDS = [
	'alias',
	'username',
	'orgId',
	'instanceUrl',
	'loginUrl',
	'status',
	'isExpired',
	'expirationDate',
	'createdDate',
	'createdBy',
	'devHubUsername',
	'namespace',
	'isScratch',
	'isSandbox',
	'isDevHub',
	'isDefaultUsername',
	'isDefaultDevHubUsername',
	'connectedStatus',
	'signupUsername',
	'edition',
	'lastUsed',
	'snapshot',
	'tracksSource',
];

function pickOrgFields(org) {
	const out = {};
	if (!org || typeof org !== 'object') return out;
	for (const field of ORG_SAFE_FIELDS) {
		if (org[field] !== undefined) out[field] = org[field];
	}
	// instanceUrl is a plain hostname, but redact defensively in case a token
	// ever rides along in a query string.
	if (typeof out.instanceUrl === 'string') out.instanceUrl = redactText(out.instanceUrl);
	return out;
}

class Logger {
	/**
	 * @param {object} opts
	 * @param {string} [opts.logFile]        Absolute path of the run log.
	 * @param {string} [opts.level]          debug | info | warn | error
	 * @param {boolean} [opts.mirrorConsole] Also write to stdout/stderr.
	 * @param {string} [opts.scope]          Component tag shown in each line.
	 */
	constructor(opts = {}) {
		const { logFile = null, level = 'info', mirrorConsole = true, scope = 'main' } = opts;
		this.level = LEVELS[level] || LEVELS.info;
		this.mirrorConsole = mirrorConsole;
		this.scope = scope;
		this.stream = null;
		this.logFile = logFile;
		this.counts = { debug: 0, info: 0, warn: 0, error: 0 };

		if (logFile) {
			fs.mkdirSync(path.dirname(logFile), { recursive: true });
			this.stream = fs.createWriteStream(logFile, { flags: 'a' });
		}
	}

	/** Child logger sharing the same stream but with a different scope tag. */
	child(scope) {
		const c = Object.create(Logger.prototype);
		Object.assign(c, this, { scope });
		return c;
	}

	_write(level, message, meta) {
		if (LEVELS[level] < this.level) return;
		this.counts[level] += 1;

		const stamp = new Date().toISOString();
		const tag = level.toUpperCase().padEnd(5);
		let line = `${stamp}  ${tag} [${this.scope}] ${redactText(message)}`;

		if (meta !== undefined) {
			let rendered;
			try {
				rendered = JSON.stringify(redactValue(meta));
			} catch (_) {
				rendered = '<unserialisable>';
			}
			line += ` ${rendered}`;
		}

		if (this.stream) this.stream.write(line + os.EOL);
		if (this.mirrorConsole) {
			if (level === 'error' || level === 'warn') process.stderr.write(line + os.EOL);
			else process.stdout.write(line + os.EOL);
		}
	}

	debug(msg, meta) {
		this._write('debug', msg, meta);
	}
	info(msg, meta) {
		this._write('info', msg, meta);
	}
	warn(msg, meta) {
		this._write('warn', msg, meta);
	}
	error(msg, meta) {
		this._write('error', msg, meta);
	}

	/** Unstamped block output, used for the end-of-run summary. */
	raw(text) {
		const body = redactText(text);
		if (this.stream) this.stream.write(body + os.EOL);
		if (this.mirrorConsole) process.stdout.write(body + os.EOL);
	}

	async close() {
		if (!this.stream) return;
		await new Promise((resolve) => this.stream.end(resolve));
		this.stream = null;
	}
}

module.exports = {
	Logger,
	ORG_SAFE_FIELDS,
	pickOrgFields,
	redactText,
	redactValue,
};
