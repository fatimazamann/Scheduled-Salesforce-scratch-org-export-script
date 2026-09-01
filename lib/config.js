'use strict';

/**
 * lib/config.js
 * ---------------------------------------------------------------------------
 * Configuration model.
 *
 * Three layers, later wins:
 *   1. DEFAULTS below            -- so a fresh checkout runs with no config file
 *   2. config/export-config.json -- the reviewable, version-controlled settings
 *   3. SFEXPORT_* environment variables and CLI flags
 *                                -- so Task Scheduler and ad-hoc runs can
 *                                   override without editing a tracked file
 *
 * Deliberately NOT a configuration framework. One JSON file, a small set of env
 * overrides, and validation that fails loudly on unknown or malformed keys.
 * Every relative path is resolved against the project root so the process is
 * immune to whatever working directory Task Scheduler hands it.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
	// --- Filesystem -------------------------------------------------------
	exportRoot: 'exports',
	logRoot: 'logs',
	exportScript: 'export-script.js',
	cleanScript: 'clean-json.js',
	lockFile: 'logs/.scheduled-export.lock',

	// --- Salesforce CLI ---------------------------------------------------
	// Leave blank to resolve `sf` from PATH. Set sfCliEntry to the CLI's JS
	// entry point (e.g. C:\\Program Files\\sf\\client\\...\\bin\\run.js) to skip
	// the cmd.exe shim entirely -- faster and removes a whole escaping layer.
	sfExecutable: '',
	sfCliEntry: '',
	sfCommandTimeoutSeconds: 120,

	// --- What to export ---------------------------------------------------
	// Applied to every org unless overridden in perOrg. We do NOT infer this
	// per org: there is no deterministic org-level signal for it in the data we
	// have, and guessing differently per org would make runs irreproducible.
	integrationType: 'any-to-any', // '' | 'any-to-any' | 'salesforce-to-any'
	connectorFilter: [], // [] = export every connector
	queryLimit: 200, // preserves the existing LIMIT 200 behaviour

	// --- Which orgs -------------------------------------------------------
	appCheck: {
		enabled: true,
		sobject: 'cja_cj__CJ_Connector__c',
	},
	orgFilter: {
		includeAliases: [],
		excludeAliases: [],
		includeUsernames: [],
		excludeUsernames: [],
		// Skip orgs about to expire mid-run. 0 = only skip already-expired orgs.
		minHoursUntilExpiry: 0,
	},
	// Per-org overrides, keyed by username OR alias. Example:
	//   "perOrg": { "test-abc@example.com": { "integrationType": "salesforce-to-any" },
	//               "sandbox-clone":        { "skip": true, "reason": "owned by QA" } }
	perOrg: {},

	// --- Execution --------------------------------------------------------
	maxRetries: 1, // total attempts = 1 + maxRetries
	retryBackoffSeconds: [15, 45],
	childTimeoutSeconds: 900,
	lockStaleMinutes: 180,
	dryRun: false,

	// --- Housekeeping -----------------------------------------------------
	logLevel: 'info',
	logRetentionDays: 30,
	exportRetentionDays: 14,
};

class ConfigError extends Error {}

function isPlainObject(v) {
	return v != null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, patch) {
	const out = Array.isArray(base) ? base.slice() : { ...base };
	for (const [k, v] of Object.entries(patch || {})) {
		if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
		else out[k] = v;
	}
	return out;
}

function parseBool(value, label) {
	const s = String(value).trim().toLowerCase();
	if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
	if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
	throw new ConfigError(`${label} must be a boolean-ish value, got ${JSON.stringify(value)}.`);
}

function parseIntStrict(value, label) {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 0) {
		throw new ConfigError(`${label} must be a non-negative integer, got ${JSON.stringify(value)}.`);
	}
	return n;
}

/** Resolve a possibly-relative path against the project root. */
function resolvePath(p) {
	if (!p) return p;
	return path.isAbsolute(p) ? path.normalize(p) : path.resolve(PROJECT_ROOT, p);
}

/** Environment overrides. Keep this list short and obvious. */
function applyEnvOverrides(cfg, env) {
	const set = (envKey, apply) => {
		if (env[envKey] !== undefined && env[envKey] !== '') apply(env[envKey]);
	};

	set('SFEXPORT_EXPORT_ROOT', (v) => (cfg.exportRoot = v));
	set('SFEXPORT_LOG_ROOT', (v) => (cfg.logRoot = v));
	set('SFEXPORT_EXPORT_SCRIPT', (v) => (cfg.exportScript = v));
	set('SFEXPORT_SF_EXECUTABLE', (v) => (cfg.sfExecutable = v));
	set('SFEXPORT_SF_CLI_ENTRY', (v) => (cfg.sfCliEntry = v));
	set('SFEXPORT_INTEGRATION_TYPE', (v) => (cfg.integrationType = v));
	set('SFEXPORT_CONNECTORS', (v) => (cfg.connectorFilter = v.split(',').map((s) => s.trim()).filter(Boolean)));
	set('SFEXPORT_QUERY_LIMIT', (v) => (cfg.queryLimit = parseIntStrict(v, 'SFEXPORT_QUERY_LIMIT')));
	set('SFEXPORT_APP_CHECK', (v) => (cfg.appCheck.enabled = parseBool(v, 'SFEXPORT_APP_CHECK')));
	set('SFEXPORT_APP_CHECK_OBJECT', (v) => (cfg.appCheck.sobject = v));
	set('SFEXPORT_MAX_RETRIES', (v) => (cfg.maxRetries = parseIntStrict(v, 'SFEXPORT_MAX_RETRIES')));
	set('SFEXPORT_CHILD_TIMEOUT_SECONDS', (v) => (cfg.childTimeoutSeconds = parseIntStrict(v, 'SFEXPORT_CHILD_TIMEOUT_SECONDS')));
	set('SFEXPORT_DRY_RUN', (v) => (cfg.dryRun = parseBool(v, 'SFEXPORT_DRY_RUN')));
	set('SFEXPORT_LOG_LEVEL', (v) => (cfg.logLevel = v));
	set('SFEXPORT_LOG_RETENTION_DAYS', (v) => (cfg.logRetentionDays = parseIntStrict(v, 'SFEXPORT_LOG_RETENTION_DAYS')));
	set('SFEXPORT_EXPORT_RETENTION_DAYS', (v) => (cfg.exportRetentionDays = parseIntStrict(v, 'SFEXPORT_EXPORT_RETENTION_DAYS')));
	return cfg;
}

const VALID_INTEGRATION_TYPES = ['', 'any-to-any', 'salesforce-to-any'];
const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function validate(cfg) {
	if (!VALID_INTEGRATION_TYPES.includes(cfg.integrationType)) {
		throw new ConfigError(
			`integrationType must be one of ${VALID_INTEGRATION_TYPES.map((t) => JSON.stringify(t)).join(', ')}; got ${JSON.stringify(cfg.integrationType)}.`
		);
	}
	if (!VALID_LOG_LEVELS.includes(cfg.logLevel)) {
		throw new ConfigError(`logLevel must be one of ${VALID_LOG_LEVELS.join(', ')}.`);
	}
	if (!Array.isArray(cfg.connectorFilter)) {
		throw new ConfigError('connectorFilter must be an array of connector names.');
	}
	if (!Array.isArray(cfg.retryBackoffSeconds) || cfg.retryBackoffSeconds.some((n) => !Number.isFinite(n) || n < 0)) {
		throw new ConfigError('retryBackoffSeconds must be an array of non-negative numbers.');
	}
	if (cfg.appCheck.enabled && !/^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(cfg.appCheck.sobject)) {
		throw new ConfigError(`appCheck.sobject is not a valid sObject API name: ${JSON.stringify(cfg.appCheck.sobject)}`);
	}
	if (cfg.queryLimit < 1 || cfg.queryLimit > 2000) {
		// `sf data export tree` refuses anything above 2,000 records per query.
		throw new ConfigError('queryLimit must be between 1 and 2000 (sf data export tree caps a query at 2,000 records).');
	}
	if (!isPlainObject(cfg.perOrg)) {
		throw new ConfigError('perOrg must be an object keyed by username or alias.');
	}
	return cfg;
}

/**
 * Load and freeze the effective configuration.
 * @param {object} [opts]
 * @param {string} [opts.configPath] Explicit config file; defaults to
 *                                   config/export-config.json (optional file).
 * @param {object} [opts.overrides]  CLI-flag overrides, applied last.
 * @param {object} [opts.env]
 */
function loadConfig(opts = {}) {
	const env = opts.env || process.env;
	const configPath = resolvePath(opts.configPath || env.SFEXPORT_CONFIG || 'config/export-config.json');

	let fileConfig = {};
	let configFileUsed = null;
	if (fs.existsSync(configPath)) {
		let text;
		try {
			text = fs.readFileSync(configPath, 'utf8');
		} catch (err) {
			throw new ConfigError(`Cannot read config file ${configPath}: ${err.message}`);
		}
		try {
			fileConfig = JSON.parse(text);
		} catch (err) {
			throw new ConfigError(`Config file ${configPath} is not valid JSON: ${err.message}`);
		}
		// Comment convention for JSON: keys starting with "_" are ignored.
		for (const k of Object.keys(fileConfig)) {
			if (k.startsWith('_')) delete fileConfig[k];
		}
		const unknown = Object.keys(fileConfig).filter((k) => !(k in DEFAULTS));
		if (unknown.length) {
			throw new ConfigError(
				`Unknown key(s) in ${configPath}: ${unknown.join(', ')}. ` +
					`Valid keys: ${Object.keys(DEFAULTS).join(', ')}.`
			);
		}
		configFileUsed = configPath;
	} else if (opts.configPath || env.SFEXPORT_CONFIG) {
		// An explicitly requested config file that does not exist is an error;
		// a missing default file just means "use the defaults".
		throw new ConfigError(`Config file not found: ${configPath}`);
	}

	let cfg = deepMerge(DEFAULTS, fileConfig);
	cfg = applyEnvOverrides(cfg, env);
	cfg = deepMerge(cfg, opts.overrides || {});
	validate(cfg);

	// Resolve every path once, here, so nothing downstream depends on cwd.
	cfg.projectRoot = PROJECT_ROOT;
	cfg.configFileUsed = configFileUsed;
	cfg.exportRoot = resolvePath(cfg.exportRoot);
	cfg.logRoot = resolvePath(cfg.logRoot);
	cfg.exportScript = resolvePath(cfg.exportScript);
	cfg.cleanScript = resolvePath(cfg.cleanScript);
	cfg.lockFile = resolvePath(cfg.lockFile);
	if (cfg.sfCliEntry) cfg.sfCliEntry = resolvePath(cfg.sfCliEntry);

	return Object.freeze(cfg);
}

module.exports = { ConfigError, DEFAULTS, PROJECT_ROOT, loadConfig, resolvePath };
