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
	exportRoot: 'connectjunction-exports',
	logRoot: 'logs',
	exportScript: 'export-script.js',
	cleanScript: 'clean-json.js',
	lockFile: 'logs/.scheduled-export.lock',

	// --- Output layout ----------------------------------------------------
	// 'per-org'  one stable folder per org, replaced on every run. What you see
	//            in the export root is always the current state of each org.
	//            No history: last night's content is gone once tonight succeeds.
	// 'per-run'  a new timestamped folder per run, keeping history. Costs disk,
	//            and is pruned by exportRetentionDays.
	//
	// Either way a run exports into a temporary folder first and only swaps it
	// into place on success, so a failed or partial export never damages the
	// copy that is already there.
	layout: 'per-org',

	// Folder name per org. Tokens: {alias} {orgId} {username} {usernamePrefix}
	// {alias} falls back to {usernamePrefix} when the org has no alias.
	orgFolderPattern: 'cj-export_{alias}',

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

	// --- Metadata retrieve ------------------------------------------------
	// Runs after the data export, into <org folder>/<outputSubdir>, driven by a
	// manifest (package.xml). It is a SEPARATE step on purpose: metadata and
	// data fail for completely different reasons, and a metadata problem must
	// never throw away a good data export. See metadata.failureIsFatal.
	//
	// `sf project retrieve start` refuses to run outside an SFDX project AND
	// refuses an --output-dir outside that project. So the export folder itself
	// becomes the project: an sfdx-project.json is written beside the exported
	// data, with outputSubdir as its package directory. Each backup is then a
	// valid SFDX project you can deploy straight from.
	metadata: {
		enabled: false,
		manifest: 'config/package.xml',
		outputSubdir: 'metadata',
		// Namespace of the scratch orgs. Their metadata carries the prefix but
		// the manifest names it WITHOUT one, and the CLI needs to know which
		// namespace to resolve those unprefixed names against.
		namespace: 'cja_cj',
		// Blank = take the version from the manifest's own <version> element.
		apiVersion: '',
		// false: a failed retrieve is reported and the data export still counts
		//        as a success. true: the whole org export fails.
		failureIsFatal: false,
		timeoutSeconds: 900,
	},

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
	set('SFEXPORT_LAYOUT', (v) => (cfg.layout = v));
	set('SFEXPORT_ORG_FOLDER_PATTERN', (v) => (cfg.orgFolderPattern = v));
	set('SFEXPORT_EXPORT_SCRIPT', (v) => (cfg.exportScript = v));
	set('SFEXPORT_SF_EXECUTABLE', (v) => (cfg.sfExecutable = v));
	set('SFEXPORT_SF_CLI_ENTRY', (v) => (cfg.sfCliEntry = v));
	set('SFEXPORT_INTEGRATION_TYPE', (v) => (cfg.integrationType = v));
	set('SFEXPORT_CONNECTORS', (v) => (cfg.connectorFilter = v.split(',').map((s) => s.trim()).filter(Boolean)));
	set('SFEXPORT_QUERY_LIMIT', (v) => (cfg.queryLimit = parseIntStrict(v, 'SFEXPORT_QUERY_LIMIT')));
	set('SFEXPORT_METADATA', (v) => (cfg.metadata.enabled = parseBool(v, 'SFEXPORT_METADATA')));
	set('SFEXPORT_METADATA_MANIFEST', (v) => (cfg.metadata.manifest = v));
	set('SFEXPORT_METADATA_NAMESPACE', (v) => (cfg.metadata.namespace = v));
	set('SFEXPORT_METADATA_FATAL', (v) => (cfg.metadata.failureIsFatal = parseBool(v, 'SFEXPORT_METADATA_FATAL')));
	set('SFEXPORT_METADATA_TIMEOUT_SECONDS', (v) => (cfg.metadata.timeoutSeconds = parseIntStrict(v, 'SFEXPORT_METADATA_TIMEOUT_SECONDS')));
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
	if (!isPlainObject(cfg.metadata)) {
		throw new ConfigError('metadata must be an object.');
	}
	if (cfg.metadata.enabled) {
		if (typeof cfg.metadata.manifest !== 'string' || !cfg.metadata.manifest.trim()) {
			throw new ConfigError('metadata.manifest must be a path to a package.xml when metadata.enabled is true.');
		}
		// A single folder name, not a path: it is joined onto the org's export
		// folder, and a separator or ".." there would write outside it.
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(cfg.metadata.outputSubdir)) {
			throw new ConfigError(
				`metadata.outputSubdir must be a single plain folder name, got ${JSON.stringify(cfg.metadata.outputSubdir)}.`
			);
		}
		if (cfg.metadata.namespace && !/^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(cfg.metadata.namespace)) {
			throw new ConfigError(`metadata.namespace is not a valid namespace prefix: ${JSON.stringify(cfg.metadata.namespace)}`);
		}
		if (cfg.metadata.apiVersion && !/^\d{2,3}\.0$/.test(String(cfg.metadata.apiVersion))) {
			throw new ConfigError(`metadata.apiVersion must look like "63.0", got ${JSON.stringify(cfg.metadata.apiVersion)}.`);
		}
		if (!Number.isInteger(cfg.metadata.timeoutSeconds) || cfg.metadata.timeoutSeconds < 1) {
			throw new ConfigError('metadata.timeoutSeconds must be a positive integer.');
		}
		if (typeof cfg.metadata.failureIsFatal !== 'boolean') {
			throw new ConfigError('metadata.failureIsFatal must be true or false.');
		}
	}
	if (!isPlainObject(cfg.perOrg)) {
		throw new ConfigError('perOrg must be an object keyed by username or alias.');
	}
	if (!['per-org', 'per-run'].includes(cfg.layout)) {
		throw new ConfigError(`layout must be "per-org" or "per-run"; got ${JSON.stringify(cfg.layout)}.`);
	}
	if (typeof cfg.orgFolderPattern !== 'string' || !cfg.orgFolderPattern.trim()) {
		throw new ConfigError('orgFolderPattern must be a non-empty string.');
	}
	if (/[\\/:*?"<>|]/.test(cfg.orgFolderPattern.replace(/\{\w+\}/g, ''))) {
		throw new ConfigError(
			`orgFolderPattern must not contain path separators or characters illegal in a Windows folder name: ${JSON.stringify(cfg.orgFolderPattern)}`
		);
	}
	if (!/\{(alias|orgId|username|usernamePrefix)\}/.test(cfg.orgFolderPattern)) {
		throw new ConfigError(
			'orgFolderPattern must include at least one of {alias} {orgId} {username} {usernamePrefix}, ' +
				'otherwise every org would share one folder and overwrite each other.'
		);
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
	cfg.metadata = {
		...cfg.metadata,
		manifest: resolvePath(cfg.metadata.manifest),
	};

	return Object.freeze(cfg);
}

module.exports = { ConfigError, DEFAULTS, PROJECT_ROOT, loadConfig, resolvePath };
