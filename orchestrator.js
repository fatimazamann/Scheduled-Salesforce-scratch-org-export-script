#!/usr/bin/env node
'use strict';

/**
 * orchestrator.js
 * ---------------------------------------------------------------------------
 * The parent process. Launched by scheduled-export.bat, which is what Windows
 * Task Scheduler runs.
 *
 * Responsibilities (and nothing else):
 *   - validate the environment
 *   - discover orgs via `sf org list --json`
 *   - decide which are eligible scratch orgs
 *   - decide whether the cja_cj package is present
 *   - allocate one export directory per org
 *   - invoke export-script.js once per eligible org, sequentially
 *   - record outcomes, retry conservatively, and never let one org stop the run
 *   - emit a human log, a machine-readable summary, and a meaningful exit code
 *
 * It deliberately contains NO SOQL and NO knowledge of the cja_cj data model.
 * That lives in the child exporter.
 *
 * EXIT CODES
 *   0  every eligible org exported successfully (including "nothing to do")
 *   1  at least one org export failed
 *   2  preflight, configuration, or discovery failure -- no orgs were processed
 *   3  another run holds the lock; this instance exited without doing anything
 *
 * Rationale for adding 3: Task Scheduler shows the last result code, and an
 * overlap is not the same event as a failure. Treating it as 1 would make a
 * healthy "previous run still going" look like a broken export. Configure the
 * task's own "Do not start a new instance" rule as well and 3 should be rare.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig, ConfigError } = require('./lib/config');
const { Logger, pickOrgFields } = require('./lib/logger');
const lock = require('./lib/lock');
const sfcli = require('./lib/sf-cli');

const EXIT = { SUCCESS: 0, EXPORT_FAILURES: 1, PREFLIGHT: 2, LOCKED: 3 };

const STATUS = {
	SUCCESS: 'SUCCESS',
	FAILED: 'FAILED',
	SKIPPED_APP_NOT_INSTALLED: 'SKIPPED_APP_NOT_INSTALLED',
	SKIPPED_EXPIRED: 'SKIPPED_EXPIRED',
	SKIPPED_UNREACHABLE: 'SKIPPED_UNREACHABLE',
	SKIPPED_INVALID_ORG: 'SKIPPED_INVALID_ORG',
	SKIPPED_BY_CONFIG: 'SKIPPED_BY_CONFIG',
	DRY_RUN: 'DRY_RUN',
};

/** Child exit codes, mirrored from export-script.js. Keep the two in sync. */
const CHILD_EXIT = {
	SUCCESS: 0,
	UNCAUGHT: 1,
	INVALID_ARGUMENTS: 2,
	AUTH: 3,
	EXPORT_FAILED: 4,
	CLEANUP_FAILED: 5,
	TRANSIENT: 6,
};

/** Only these child failures are worth a second attempt. */
const RETRYABLE_CHILD_EXITS = new Set([CHILD_EXIT.TRANSIENT]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function makeRunId(date = new Date()) {
	const p = (n) => String(n).padStart(2, '0');
	return (
		`${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
		`_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
	);
}

/**
 * Scratch orgs live on a distinctive host: <name>.scratch.my.salesforce.com.
 * Sandboxes use .sandbox.my.salesforce.com, Developer Edition orgs use
 * .develop.my.salesforce.com, and production uses a bare .my.salesforce.com --
 * so this pattern cannot match anything we must not touch.
 */
const SCRATCH_HOST_RE = /\.scratch\.my\.salesforce\.com$/i;

function hostOf(url) {
	try {
		return new URL(String(url)).hostname;
	} catch (_) {
		return null;
	}
}

/**
 * Decide whether an org is a scratch org, and say on what evidence.
 *
 * The CLI only sets `isScratch` for orgs it created itself with
 * `sf org create scratch`. An org someone authenticated with `sf org login web`
 * or an auth URL carries no such flag, even though it is plainly a scratch org
 * -- which silently excluded real orgs from the backup. The instance URL is the
 * fallback: it is set on every org, comes from Salesforce rather than local
 * bookkeeping, and is specific enough that it cannot misfire.
 *
 * Returns the basis as a string, or null when the org is not a scratch org.
 */
function scratchOrgBasis(org, bucket) {
	if (!org || typeof org !== 'object') return null;
	// An explicit "this is a sandbox / Dev Hub" always wins over any inference.
	if (org.isSandbox === true || org.isDevHub === true) return null;

	if (org.isScratch === true) return 'isScratch flag';
	if (bucket === 'scratchOrgs') return 'scratchOrgs bucket';

	const host = hostOf(org.instanceUrl);
	if (host && SCRATCH_HOST_RE.test(host)) return 'scratch instance URL';

	return null;
}

const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

/**
 * Turn an alias/username into a filesystem-safe directory segment.
 * Conservative on purpose: this string is concatenated into a path that a
 * scheduled task writes to.
 */
function sanitizeSegment(input, fallback) {
	let s = String(input || '')
		.normalize('NFKD')
		.replace(/[^A-Za-z0-9._-]+/g, '-')
		.replace(/-{2,}/g, '-')
		.replace(/^[-._]+|[-._]+$/g, '')
		.slice(0, 60);
	if (!s || WINDOWS_RESERVED.test(s)) s = String(fallback || 'org');
	return s;
}

/**
 * Directory name for one org, built from cfg.orgFolderPattern.
 *
 * Tokens: {alias} {orgId} {username} {usernamePrefix}
 * {alias} falls back to the username prefix when the org has no alias, because
 * aliases are local conveniences that may be missing entirely.
 *
 * Every substituted value is sanitised individually, then the whole name is
 * sanitised again -- this string becomes a path a scheduled task writes to.
 */
function orgDirectoryName(org, pattern = 'cj-export_{alias}') {
	const usernamePrefix = (org.username || '').split('@')[0];
	const orgId = org.orgId ? String(org.orgId).slice(0, 18) : 'unknown-org';
	const tokens = {
		alias: org.alias || usernamePrefix || orgId,
		orgId,
		username: org.username || orgId,
		usernamePrefix: usernamePrefix || orgId,
	};
	const filled = String(pattern).replace(/\{(\w+)\}/g, (whole, key) =>
		tokens[key] === undefined ? whole : sanitizeSegment(tokens[key], 'org')
	);
	return sanitizeSegment(filled, `org_${orgId}`);
}

/**
 * Swap a freshly exported temp folder into its final place.
 *
 * The temp-then-swap dance exists so a failed or partial export can never
 * damage the copy that is already on disk -- important with layout "per-org",
 * where that copy is the only one there is. The old folder is moved aside
 * first, so the window in which the destination does not exist is a single
 * rename rather than a recursive delete.
 */
function swapIntoPlace(tempDir, targetDir, runId) {
	const asideDir = `${targetDir}.old_${runId}`;
	// The parent must exist before a rename can land in it. Under the per-run
	// layout that parent is the run folder, which nothing has created yet.
	fs.mkdirSync(path.dirname(targetDir), { recursive: true });
	if (fs.existsSync(targetDir)) {
		fs.renameSync(targetDir, asideDir);
	}
	try {
		fs.renameSync(tempDir, targetDir);
	} catch (err) {
		// Put the previous content back rather than leaving nothing behind.
		if (fs.existsSync(asideDir) && !fs.existsSync(targetDir)) {
			try {
				fs.renameSync(asideDir, targetDir);
			} catch (_) {
				/* nothing further we can safely do */
			}
		}
		throw err;
	}
	fs.rmSync(asideDir, { recursive: true, force: true });
}

/**
 * Remove temp and set-aside folders left behind by a run that was killed
 * mid-swap. Runs before any export so a crashed night cannot accumulate.
 */
function cleanStaleWorkDirs(root, log) {
	if (!fs.existsSync(root)) return;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		if (!/^\.tmp_/.test(entry.name) && !/\.old_\d{8}_\d{6}$/.test(entry.name)) continue;
		const full = path.join(root, entry.name);
		try {
			fs.rmSync(full, { recursive: true, force: true });
			log.warn(`Removed leftover work directory from an interrupted run: ${entry.name}`);
		} catch (err) {
			log.warn(`Could not remove leftover work directory ${entry.name}: ${err.message}`);
		}
	}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function formatDuration(ms) {
	if (ms == null) return '-';
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}

// ---------------------------------------------------------------------------
// CLI parsing (tiny on purpose -- the batch file passes through at most a flag
// or two; everything substantial belongs in the config file)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
	const out = { overrides: {}, onlyOrgs: [], configPath: null, runId: null, help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => {
			const v = argv[i + 1];
			if (v === undefined || v.startsWith('--')) {
				throw new ConfigError(`${arg} requires a value.`);
			}
			i += 1;
			return v;
		};
		switch (arg) {
			case '--dry-run':
				out.overrides.dryRun = true;
				break;
			case '--config':
				out.configPath = next();
				break;
			case '--run-id':
				out.runId = next();
				break;
			case '--org': // repeatable; restricts the run to these orgs
				out.onlyOrgs.push(next());
				break;
			case '--log-level':
				out.overrides.logLevel = next();
				break;
			case '--no-app-check':
				out.overrides.appCheck = { enabled: false };
				break;
			case '--metadata':
				out.overrides.metadata = { enabled: true };
				break;
			case '--no-metadata':
				out.overrides.metadata = { enabled: false };
				break;
			case '--help':
			case '-h':
				out.help = true;
				break;
			default:
				throw new ConfigError(`Unknown argument: ${arg}`);
		}
	}
	return out;
}

const HELP = `
scheduled-export.bat [options]      (or: node orchestrator.js [options])

  --dry-run              Discover and classify orgs, print the exact child
                         invocations that would run, export nothing.
  --config <path>        Use a specific config file.
  --run-id <id>          Override the generated run identifier.
  --org <user-or-alias>  Restrict the run to this org. Repeatable.
  --no-app-check         Skip the cja_cj package check for this run.
  --metadata             Retrieve metadata for this run (needs a manifest at
                         metadata.manifest).
  --no-metadata          Skip the metadata retrieve for this run.
  --log-level <level>    debug | info | warn | error
  -h, --help             Show this help.

Exit codes: 0 all good | 1 an export failed | 2 preflight failure | 3 locked.
`.trim();

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function preflight(cfg, log) {
	const findings = { ok: true, problems: [], versions: {} };
	const fail = (msg) => {
		findings.ok = false;
		findings.problems.push(msg);
		log.error(msg);
	};

	// node is obviously present (we are running in it) -- record it anyway,
	// because the version that Task Scheduler resolves may differ from the one a
	// developer sees in their own shell.
	findings.versions.node = process.version;
	findings.versions.nodeExecutable = process.execPath;
	log.info(`node ${process.version} at ${process.execPath}`);

	// --- Salesforce CLI ---------------------------------------------------
	let sfExecutable = cfg.sfExecutable || null;
	if (sfExecutable && !fs.existsSync(sfExecutable)) {
		fail(`Configured sfExecutable does not exist: ${sfExecutable}`);
		sfExecutable = null;
	}
	if (!sfExecutable && !cfg.sfCliEntry) {
		sfExecutable = sfcli.resolveExecutable('sf');
		if (!sfExecutable) {
			fail(
				'The Salesforce CLI ("sf") was not found on PATH for this account. ' +
					'A scheduled task runs as its configured run-as user and does not inherit ' +
					'a developer\'s interactive PATH. Either add the CLI to the machine PATH ' +
					'or set "sfExecutable" in config/export-config.json to its full path.'
			);
		}
	}
	if (cfg.sfCliEntry && !fs.existsSync(cfg.sfCliEntry)) {
		fail(`Configured sfCliEntry does not exist: ${cfg.sfCliEntry}`);
	}
	findings.sfExecutable = sfExecutable;
	if (sfExecutable) log.info(`sf resolved to ${sfExecutable}`);

	// Prefer the CLI's own JS entry point when we can find it next to the shim.
	// Spawning `node run.js` uses no shell at all, so paths with spaces and
	// shell metacharacters stop being a concern entirely. Only fall back to the
	// .cmd shim (and its cmd.exe hop) when no entry point is discoverable.
	let sfCliEntry = cfg.sfCliEntry || '';
	if (!sfCliEntry && sfExecutable) {
		const discovered = sfcli.findCliEntryNear(sfExecutable);
		if (discovered) {
			sfCliEntry = discovered;
			log.info(`Found the CLI entry point; invoking it directly with no shell: node ${discovered}`);
		} else if (/\.(cmd|bat)$/i.test(sfExecutable)) {
			log.debug(
				'No run.js found near the shim; falling back to invoking sf.cmd through cmd.exe. ' +
					'Set "sfCliEntry" in the config to skip that hop.'
			);
		}
	} else if (sfCliEntry) {
		log.info(`sf will be invoked as: node ${sfCliEntry}`);
	}
	findings.sfCliEntry = sfCliEntry;

	// --- Scripts ----------------------------------------------------------
	for (const [label, p] of [
		['exportScript', cfg.exportScript],
		['cleanScript', cfg.cleanScript],
	]) {
		if (!fs.existsSync(p)) fail(`Required script missing (${label}): ${p}`);
	}

	// --- Metadata manifest -------------------------------------------------
	// Checked here, once, rather than per org: a missing manifest is a setup
	// error and should stop the run before any org is touched, not produce the
	// same failure six times over.
	if (cfg.metadata && cfg.metadata.enabled) {
		if (!fs.existsSync(cfg.metadata.manifest)) {
			fail(
				`Metadata export is enabled but the manifest was not found: ${cfg.metadata.manifest}. ` +
					`Copy your package.xml there, or set metadata.enabled to false in the config.`
			);
		} else {
			try {
				const text = fs.readFileSync(cfg.metadata.manifest, 'utf8');
				if (!/<Package\b/i.test(text) || !/<types>/i.test(text)) {
					fail(
						`${cfg.metadata.manifest} does not look like a metadata manifest ` +
							`(no <Package> / <types> element). A retrieve driven by it would silently return nothing.`
					);
				} else {
					const types = (text.match(/<name>/gi) || []).length;
					const members = (text.match(/<members>/gi) || []).length;
					const wildcards = (text.match(/<members>\s*\*\s*<\/members>/gi) || []).length;
					log.info(
						`Metadata manifest: ${path.basename(cfg.metadata.manifest)} ` +
							`(${types} type(s), ${members} member entr${members === 1 ? 'y' : 'ies'}, ${wildcards} wildcard(s))`
					);
					if (!wildcards) {
						log.debug(
							'This manifest names every component explicitly, so anything created in an org ' +
								'after the manifest was written will not be backed up. Regenerate it periodically, ' +
								'or switch the types you want tracked to <members>*</members>.'
						);
					}
				}
			} catch (err) {
				fail(`Cannot read the metadata manifest ${cfg.metadata.manifest}: ${err.message}`);
			}
		}
	}

	// --- Writable directories --------------------------------------------
	for (const [label, dir] of [
		['exportRoot', cfg.exportRoot],
		['logRoot', cfg.logRoot],
	]) {
		try {
			fs.mkdirSync(dir, { recursive: true });
			const probe = path.join(dir, `.write-probe-${process.pid}`);
			fs.writeFileSync(probe, 'ok');
			fs.rmSync(probe, { force: true });
		} catch (err) {
			fail(
				`Cannot write to ${label} (${dir}): ${err.message}. ` +
					`Check that the task's run-as user has write permission here.`
			);
		}
	}

	if (!findings.ok) return findings;

	// --- CLI version (also proves the CLI actually executes for this user) --
	const runner = sfcli.createSfRunner({
		sfExecutable: findings.sfExecutable,
		sfCliEntry: findings.sfCliEntry || undefined,
		timeoutMs: cfg.sfCommandTimeoutSeconds * 1000,
	});
	const version = await runner.sf(['--version']);
	if (version.code !== 0) {
		const stderr = (version.stderr || '').trim();
		let hint = '';
		if (/ENOENT/i.test(stderr)) {
			// Almost always the extensionless npm shim, which Windows cannot start.
			hint =
				' This usually means the resolved path is a shim Windows cannot execute directly ' +
				'(npm installs an extensionless bash script alongside the .cmd). Set "sfExecutable" ' +
				'in the config to the full path of sf.cmd, or better, set "sfCliEntry" to the CLI\'s ' +
				'run.js so it is invoked as `node run.js` with no shell at all.';
		}
		fail(`"sf --version" failed with exit code ${version.code}. stderr: ${stderr.slice(0, 500)}${hint}`);
		return findings;
	}
	findings.versions.sf = (version.stdout || '').trim().split(/\r?\n/)[0];
	log.info(`sf ${findings.versions.sf}`);
	findings.runner = runner;

	return findings;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/**
 * Discover orgs through `sf org list --json`.
 *
 * We deliberately do NOT pass --all. Salesforce documents --all as "Include
 * expired, deleted, and unknown-status scratch orgs", which is precisely the
 * set we must not export.
 *
 * We also do not use `sf org list auth`: that reads locally cached auth files
 * without checking whether the org is still alive, so it would happily hand us
 * scratch orgs that were deleted days ago.
 *
 * The result is an object of buckets (scratchOrgs, nonScratchOrgs, sandboxes,
 * devHubs, other, ...). We prefer result.scratchOrgs but fall back to scanning
 * every bucket for isScratch === true, because bucket names have changed across
 * CLI versions and an org can legitimately appear in more than one.
 */
async function discoverScratchOrgs(runner, log) {
	const res = await runner.sfJson(['org', 'list', '--skip-connection-status']);
	if (!res.ok) {
		const detail =
			(res.json && (res.json.message || res.json.name)) ||
			(res.raw.stderr || '').trim().slice(0, 800) ||
			`exit code ${res.raw.code}`;
		throw new Error(`"sf org list --json" failed: ${detail}`);
	}

	const result = res.result || {};
	const seen = new Map(); // username -> org

	const consider = (org, bucket) => {
		const basis = scratchOrgBasis(org, bucket);
		if (!basis) return;
		const key = org.username || org.orgId || org.alias;
		if (!key) return;
		if (!seen.has(key)) seen.set(key, { ...org, _bucket: bucket, _scratchBasis: basis });
	};

	if (Array.isArray(result.scratchOrgs)) {
		for (const o of result.scratchOrgs) consider(o, 'scratchOrgs');
	} else {
		log.warn('`sf org list --json` returned no "scratchOrgs" array; falling back to scanning all buckets.');
	}
	for (const [bucket, value] of Object.entries(result)) {
		if (bucket === 'scratchOrgs' || !Array.isArray(value)) continue;
		for (const o of value) consider(o, bucket);
	}

	const orgs = [...seen.values()];

	// Surface orgs the CLI did not flag, so it is obvious why they are included.
	const byUrl = orgs.filter((o) => o._scratchBasis === 'scratch instance URL');
	if (byUrl.length) {
		log.info(
			`${byUrl.length} org(s) identified as scratch by their instance URL rather than by the CLI's ` +
				`isScratch flag. That flag is only set for orgs created locally with \`sf org create scratch\`; ` +
				`one authenticated with \`sf org login web\` or an auth URL has no flag to read.`,
			{ orgs: byUrl.map((o) => o.alias || o.username) }
		);
	}

	log.info(`Discovered ${orgs.length} scratch org(s).`, {
		buckets: Object.fromEntries(
			Object.entries(result)
				.filter(([, v]) => Array.isArray(v))
				.map(([k, v]) => [k, v.length])
		),
	});
	return orgs;
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Local, no-network eligibility. Reachability and package presence are checked
 * separately because they cost an API round trip each.
 */
function classifyOrg(org, cfg, onlyOrgs) {
	const username = org.username;
	const alias = org.alias || null;

	if (!username) {
		return { status: STATUS.SKIPPED_INVALID_ORG, reason: 'Org record has no username; cannot target it.' };
	}
	try {
		sfcli.assertValidUsername(username);
	} catch (err) {
		return { status: STATUS.SKIPPED_INVALID_ORG, reason: err.message };
	}
	if (org.orgId) {
		try {
			sfcli.assertValidOrgId(org.orgId);
		} catch (err) {
			return { status: STATUS.SKIPPED_INVALID_ORG, reason: err.message };
		}
	}

	// --- Expiry ------------------------------------------------------------
	if (org.isExpired === true) {
		return { status: STATUS.SKIPPED_EXPIRED, reason: 'isExpired is true.' };
	}
	if (typeof org.status === 'string' && !/^active$/i.test(org.status)) {
		return { status: STATUS.SKIPPED_EXPIRED, reason: `Org status is "${org.status}", not Active.` };
	}
	if (org.expirationDate) {
		// expirationDate is a date-only string (YYYY-MM-DD). A scratch org is
		// usable through the END of its expiration day, so compare against the
		// end of that day rather than midnight.
		const expiry = new Date(`${String(org.expirationDate).slice(0, 10)}T23:59:59Z`);
		if (Number.isNaN(expiry.getTime())) {
			return { status: STATUS.SKIPPED_INVALID_ORG, reason: `Unparseable expirationDate: ${org.expirationDate}` };
		}
		const hoursLeft = (expiry.getTime() - Date.now()) / 3600000;
		if (hoursLeft <= 0) {
			return { status: STATUS.SKIPPED_EXPIRED, reason: `Expired on ${org.expirationDate}.` };
		}
		if (hoursLeft < cfg.orgFilter.minHoursUntilExpiry) {
			return {
				status: STATUS.SKIPPED_EXPIRED,
				reason: `Expires in ${hoursLeft.toFixed(1)}h, below the configured minHoursUntilExpiry of ${cfg.orgFilter.minHoursUntilExpiry}.`,
			};
		}
	} else {
		// No expiry information is a yellow flag, not a blocker: `sf org list`
		// already excludes expired scratch orgs unless --all is passed.
		return { status: null, warn: 'Org has no expirationDate field; relying on `sf org list` having excluded expired orgs.' };
	}

	return { status: null };
}

/** Config-driven include/exclude and --org restriction. */
function applyOrgFilters(org, cfg, onlyOrgs) {
	const { includeAliases, excludeAliases, includeUsernames, excludeUsernames } = cfg.orgFilter;
	const alias = org.alias || '';
	const username = org.username || '';

	if (onlyOrgs.length && !onlyOrgs.includes(username) && !onlyOrgs.includes(alias)) {
		return { status: STATUS.SKIPPED_BY_CONFIG, reason: 'Not in the --org restriction list.' };
	}
	if (excludeUsernames.includes(username)) {
		return { status: STATUS.SKIPPED_BY_CONFIG, reason: 'Username is in orgFilter.excludeUsernames.' };
	}
	if (alias && excludeAliases.includes(alias)) {
		return { status: STATUS.SKIPPED_BY_CONFIG, reason: 'Alias is in orgFilter.excludeAliases.' };
	}
	if (includeUsernames.length || includeAliases.length) {
		const included = includeUsernames.includes(username) || (alias && includeAliases.includes(alias));
		if (!included) {
			return { status: STATUS.SKIPPED_BY_CONFIG, reason: 'Not in orgFilter.includeUsernames / includeAliases.' };
		}
	}
	const perOrg = cfg.perOrg[username] || (alias ? cfg.perOrg[alias] : null);
	if (perOrg && perOrg.skip === true) {
		return { status: STATUS.SKIPPED_BY_CONFIG, reason: perOrg.reason || 'perOrg.skip is true.' };
	}
	return { status: null };
}

// ---------------------------------------------------------------------------
// Reachability + package detection
// ---------------------------------------------------------------------------

const AUTH_ERROR_MARKERS = [
	'INVALID_SESSION_ID',
	'INVALID_LOGIN',
	'expired access/refresh token',
	'RefreshTokenAuthError',
	'NamedOrgNotFoundError',
	'No authorization information found',
	'This org appears to have a problem with its OAuth configuration',
	'invalid_grant',
];

/**
 * A scratch org that has been deleted or has expired stops serving the API and
 * returns a Salesforce HTML error page instead of JSON. The CLI surfaces that
 * as ERROR_HTTP_420 with "HTTP response contains html content". It is not an
 * authentication problem and not a missing package -- the org is simply gone --
 * so it gets its own markers and a message that says so plainly.
 */
const DEAD_ORG_MARKERS = [
	'ERROR_HTTP_420',
	'HTTP response contains html content',
	'Check that the org exists and can be reached',
	'ENOTFOUND',
	'getaddrinfo',
];

const MISSING_SOBJECT_MARKERS = [
	'INVALID_TYPE',
	'sObject type',
	'The requested resource does not exist',
	'NOT_FOUND',
	'Unknown sobject',
];

/** Drop the CLI's own update nag so it does not pollute error messages. */
function stripCliNoise(text) {
	return String(text || '')
		.split(/\r?\n/)
		.filter((line) => !/^\s*[»>]/.test(line) && !/update available from/i.test(line))
		.join('\n')
		.trim();
}

function messageOf(res) {
	const parts = [];
	if (res.json) {
		if (res.json.message) parts.push(res.json.message);
		if (res.json.name) parts.push(res.json.name);
		if (Array.isArray(res.json.errors)) {
			for (const e of res.json.errors) parts.push(typeof e === 'string' ? e : e && e.message);
		}
	}
	if (res.raw && res.raw.stderr) parts.push(res.raw.stderr);
	return stripCliNoise(parts.filter(Boolean).join(' | ')).slice(0, 2000);
}

const includesAny = (haystack, needles) => {
	const h = String(haystack || '').toLowerCase();
	return needles.some((n) => h.includes(String(n).toLowerCase()));
};

/**
 * One call that answers two questions at once: can we still reach this org with
 * the stored authentication, and is the packaged object present?
 *
 * `sf sobject describe` is the right probe because it is metadata-only. A
 * record COUNT would be wrong: a legitimately installed package can contain
 * zero records, and we must not skip an org just because it is empty.
 */
async function checkOrgAndPackage(runner, org, cfg, log) {
	const username = org.username;

	if (!cfg.appCheck.enabled) {
		// Still confirm the stored auth works, or we would hand a dead org to the
		// child and get a confusing failure. NOTE: no --verbose -- that flag
		// returns the sfdxAuthUrl, which embeds a refresh token.
		const res = await runner.sfJson(['org', 'display', '--target-org', username]);
		if (res.ok) return { reachable: true, appPresent: null };
		return {
			reachable: false,
			appPresent: null,
			status: STATUS.SKIPPED_UNREACHABLE,
			reason: `sf org display failed: ${messageOf(res)}`,
		};
	}

	const sobject = cfg.appCheck.sobject;
	const res = await runner.sfJson(['sobject', 'describe', '--sobject', sobject, '--target-org', username]);

	if (res.ok) {
		return { reachable: true, appPresent: true };
	}

	const detail = messageOf(res);

	if (includesAny(detail, AUTH_ERROR_MARKERS)) {
		return {
			reachable: false,
			appPresent: null,
			status: STATUS.SKIPPED_UNREACHABLE,
			reason: `Stored authentication is no longer usable: ${detail.slice(0, 300)}`,
		};
	}
	if (includesAny(detail, DEAD_ORG_MARKERS)) {
		return {
			reachable: false,
			appPresent: null,
			status: STATUS.SKIPPED_UNREACHABLE,
			reason:
				'Org is not reachable -- it has most likely been deleted or expired. ' +
				'Run `sf org list --clean` to drop dead scratch orgs from the local auth store.',
		};
	}
	if (includesAny(detail, MISSING_SOBJECT_MARKERS)) {
		return {
			reachable: true,
			appPresent: false,
			status: STATUS.SKIPPED_APP_NOT_INSTALLED,
			reason: `${sobject} is not present in this org.`,
		};
	}
	if (res.raw.timedOut) {
		return {
			reachable: false,
			appPresent: null,
			status: STATUS.SKIPPED_UNREACHABLE,
			reason: `Package check timed out after ${cfg.sfCommandTimeoutSeconds}s.`,
		};
	}

	// Unclassified failure: treat as unreachable rather than guessing that the
	// package is missing. Skipping for the wrong reason is a silent data gap.
	return {
		reachable: false,
		appPresent: null,
		status: STATUS.SKIPPED_UNREACHABLE,
		reason: `Package check failed with an unrecognised error: ${detail.slice(0, 300)}`,
	};
}

// ---------------------------------------------------------------------------
// Child invocation
// ---------------------------------------------------------------------------

/**
 * Lift the metadata block out of the child's _export-summary.json. Everything
 * here is best-effort: a missing or malformed summary means "we don't know",
 * never a failed run.
 */
function readChildMetadataResult(workDir) {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(workDir, '_export-summary.json'), 'utf8'));
		const md = parsed && parsed.metadata;
		if (!md || typeof md !== 'object') return null;
		// "Metadata was not requested" is not a result worth carrying into the
		// run summary; it would just add a noise line to every org.
		if (md.status === 'SKIPPED') return null;
		return {
			status: md.status || 'UNKNOWN',
			componentCount: md.componentCount,
			fileCount: md.fileCount,
			durationMs: md.durationMs,
			warnings: Array.isArray(md.warnings) ? md.warnings : [],
			error: md.error || null,
		};
	} catch (_) {
		return null;
	}
}

function buildChildArgs(cfg, org, exportDir) {
	const perOrg = cfg.perOrg[org.username] || (org.alias ? cfg.perOrg[org.alias] : null) || {};
	const integrationType = perOrg.integrationType !== undefined ? perOrg.integrationType : cfg.integrationType;
	const connectors = perOrg.connectorFilter !== undefined ? perOrg.connectorFilter : cfg.connectorFilter;

	const args = [
		cfg.exportScript,
		'--type',
		'Scratch', // scheduled runs always target scratch orgs
		'--non-interactive', // never fall back to `sf org login web`
		'--user',
		org.username,
		'--dir',
		exportDir,
		'--limit',
		String(cfg.queryLimit),
	];
	if (integrationType) args.push('--integration', integrationType);
	// One --connector-name per connector, never a joined comma list: a connector
	// name is free text and may itself contain a comma, which join/split would
	// silently turn into two nonexistent connectors.
	if (Array.isArray(connectors)) {
		for (const name of connectors) args.push('--connector-name', String(name));
	}
	if (cfg.sfExecutable) args.push('--sf-executable', cfg.sfExecutable);
	// resolvedSfCliEntry is what preflight actually settled on, which may have
	// been auto-discovered rather than configured.
	if (cfg.resolvedSfCliEntry) args.push('--sf-cli-entry', cfg.resolvedSfCliEntry);
	else if (cfg.sfCliEntry) args.push('--sf-cli-entry', cfg.sfCliEntry);
	if (cfg.cleanScript) args.push('--clean-script', cfg.cleanScript);

	// Metadata is opt-in and per-org overridable: an org can turn it off (or a
	// different manifest on) without a second config file.
	const md = cfg.metadata || {};
	const mdEnabled = perOrg.metadata && perOrg.metadata.enabled !== undefined ? perOrg.metadata.enabled : md.enabled;
	const mdManifest = (perOrg.metadata && perOrg.metadata.manifest) || md.manifest;
	if (mdEnabled && mdManifest) {
		args.push('--metadata-manifest', mdManifest);
		args.push('--metadata-subdir', md.outputSubdir || 'metadata');
		args.push('--metadata-project', md.projectDir);
		if (md.namespace) args.push('--metadata-namespace', md.namespace);
		if (md.apiVersion) args.push('--metadata-api-version', String(md.apiVersion));
		args.push('--metadata-timeout', String(md.timeoutSeconds || 900));
		if (md.failureIsFatal) args.push('--metadata-required');
	}

	return { args, integrationType, connectors, metadataEnabled: Boolean(mdEnabled && mdManifest) };
}

/**
 * The child's wall clock is data export + clean + (optionally) a metadata
 * retrieve, and a retrieve of a few hundred components is minutes on its own.
 * Killing the child at childTimeoutSeconds while the retrieve is still running
 * would throw away a data export that had already succeeded, so the metadata
 * budget is ADDED to the child budget rather than shared with it.
 */
function effectiveChildTimeoutSeconds(cfg) {
	const md = cfg.metadata || {};
	const extra = md.enabled && md.manifest ? Number(md.timeoutSeconds) || 900 : 0;
	// +60s of headroom so our timeout always fires after the child's own, which
	// exits cleanly with a status instead of being killed mid-write.
	return cfg.childTimeoutSeconds + (extra ? extra + 60 : 0);
}

async function runChildOnce(cfg, childArgs, log) {
	// process.execPath, not the string "node": guarantees the child runs on the
	// same Node the parent did, regardless of PATH.
	const res = await sfcli.run(process.execPath, childArgs, {
		cwd: cfg.projectRoot,
		timeoutMs: effectiveChildTimeoutSeconds(cfg) * 1000,
		onStdoutLine: (line) => line.trim() && log.info(`  | ${line}`),
		onStderrLine: (line) => line.trim() && log.warn(`  | ${line}`),
	});
	return res;
}

/**
 * Retry policy -- deliberately narrow.
 *
 * Retrying a deterministic failure just burns time and API calls and delays the
 * rest of the queue. So we retry ONLY when the child explicitly reports exit
 * code 6 (TRANSIENT), which it does for network errors, socket hang-ups, 5xx
 * responses and request-limit responses -- or when the child was killed by our
 * own timeout, which is usually a stalled connection rather than a bug.
 *
 * Never retried: invalid arguments (2), authentication (3), a Salesforce
 * export error such as a malformed query or a missing object (4), and
 * clean-json failures (5). Those will fail identically on a second attempt.
 */
function isRetryable(res) {
	if (res.timedOut) return true;
	return RETRYABLE_CHILD_EXITS.has(res.code);
}

async function exportOrg(cfg, org, exportDir, log) {
	const { args, integrationType, connectors } = buildChildArgs(cfg, org, exportDir);
	const attempts = [];
	const maxAttempts = 1 + cfg.maxRetries;

	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		if (attempt > 1) {
			const backoff = cfg.retryBackoffSeconds[Math.min(attempt - 2, cfg.retryBackoffSeconds.length - 1)] || 15;
			log.warn(`Attempt ${attempt - 1} failed with a transient error; retrying in ${backoff}s.`);
			await sleep(backoff * 1000);
		}

		const startedAt = new Date();
		log.info(`Export attempt ${attempt}/${maxAttempts}`, { command: `node ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}` });
		const res = await runChildOnce(cfg, args, log);
		const finishedAt = new Date();

		attempts.push({
			attempt,
			exitCode: res.code,
			timedOut: res.timedOut,
			startedAt: startedAt.toISOString(),
			finishedAt: finishedAt.toISOString(),
			durationMs: res.durationMs,
		});

		if (res.code === CHILD_EXIT.SUCCESS) {
			return { status: STATUS.SUCCESS, attempts, exitCode: 0, error: null, integrationType, connectors };
		}
		if (!isRetryable(res) || attempt === maxAttempts) {
			const tail = (res.stderr || res.stdout || '').trim().split(/\r?\n/).slice(-8).join('\n');
			return {
				status: STATUS.FAILED,
				attempts,
				exitCode: res.code,
				error: res.timedOut
					? `Child timed out after ${effectiveChildTimeoutSeconds(cfg)}s.`
					: `Child exited ${res.code} (${Object.keys(CHILD_EXIT).find((k) => CHILD_EXIT[k] === res.code) || 'UNKNOWN'}). ${tail}`,
				integrationType,
				connectors,
			};
		}
	}
	/* istanbul ignore next -- unreachable */
	return { status: STATUS.FAILED, attempts, exitCode: null, error: 'Exhausted attempts.' };
}

// ---------------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------------

function pruneOldEntries(root, retentionDays, log, kind) {
	if (!retentionDays || retentionDays <= 0) return 0;
	if (!fs.existsSync(root)) return 0;
	const cutoff = Date.now() - retentionDays * 86400000;
	let removed = 0;
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		if (entry.name.startsWith('.')) continue; // never touch the lock file
		const full = path.join(root, entry.name);
		try {
			if (fs.statSync(full).mtimeMs >= cutoff) continue;
			fs.rmSync(full, { recursive: true, force: true });
			removed += 1;
		} catch (err) {
			log.warn(`Could not prune ${kind} entry ${entry.name}: ${err.message}`);
		}
	}
	if (removed) log.info(`Pruned ${removed} ${kind} entr${removed === 1 ? 'y' : 'ies'} older than ${retentionDays} days.`);
	return removed;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function renderSummary(summary) {
	const bar = '='.repeat(56);
	const lines = [
		'',
		bar,
		'Salesforce Scheduled Export Summary',
		bar,
		'',
		`Scratch orgs discovered: ${summary.discovered}`,
		`Eligible:                ${summary.eligible}`,
		`Successful:              ${summary.success}`,
		`Failed:                  ${summary.failed}`,
		`Skipped:                 ${summary.skipped}`,
		'',
	];

	if (summary.orgs.length === 0) {
		lines.push('  (no scratch orgs were discovered)', '');
	} else {
		const width = Math.max(...summary.orgs.map((o) => (o.alias || o.username || '').length), 10);
		for (const o of summary.orgs) {
			const label = (o.alias || o.username || o.orgId || '?').padEnd(width);
			const detail = o.status === STATUS.SUCCESS ? formatDuration(o.durationMs) : o.reason || o.error || '';
			lines.push(`  ${o.status.padEnd(26)} ${label}  ${String(detail).split('\n')[0].slice(0, 90)}`);
			if (o.metadata) {
				// Called out on its own line rather than folded into the status:
				// the export can be a clean success while the metadata beside it
				// is not, and that combination must be visible at a glance.
				const md = o.metadata;
				const note =
					md.status === 'FAILED'
						? `FAILED -- ${String(md.error || '').split('\n')[0].slice(0, 70)}`
						: `${md.componentCount != null ? `${md.componentCount} components, ` : ''}` +
							`${md.fileCount != null ? `${md.fileCount} files` : ''}` +
							`${md.warnings && md.warnings.length ? `, ${md.warnings.length} manifest warning(s)` : ''}`;
				lines.push(`  ${' '.repeat(26)} ${' '.repeat(width)}  metadata: ${note}`);
			}
		}
		lines.push('');
	}

	lines.push(
		`Run ID:    ${summary.runId}`,
		`Started:   ${summary.startedAt}`,
		`Finished:  ${summary.finishedAt}`,
		`Duration:  ${formatDuration(summary.durationMs)}`,
		`Log:       ${summary.logFile}`,
		`Exports:   ${summary.runExportRoot}`,
		`Exit code: ${summary.exitCode}`,
		bar,
		''
	);
	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	let cli;
	try {
		cli = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`${err.message}\n\n${HELP}\n`);
		return EXIT.PREFLIGHT;
	}
	if (cli.help) {
		process.stdout.write(`${HELP}\n`);
		return EXIT.SUCCESS;
	}

	let cfg;
	try {
		cfg = loadConfig({ configPath: cli.configPath, overrides: cli.overrides });
	} catch (err) {
		process.stderr.write(`Configuration error: ${err.message}\n`);
		return EXIT.PREFLIGHT;
	}

	const runId = cli.runId || process.env.SFEXPORT_RUN_ID || makeRunId();
	const startedAt = new Date();
	fs.mkdirSync(cfg.logRoot, { recursive: true });
	const logFile = path.join(cfg.logRoot, `export_${runId}.log`);
	const summaryFile = path.join(cfg.logRoot, `export_${runId}.json`);

	const log = new Logger({ logFile, level: cfg.logLevel, scope: 'orchestrator' });

	const summary = {
		runId,
		startedAt: startedAt.toISOString(),
		finishedAt: null,
		durationMs: null,
		dryRun: cfg.dryRun,
		machine: os.hostname(),
		user: os.userInfo().username,
		platform: `${os.type()} ${os.release()} ${os.arch()}`,
		workingDirectory: process.cwd(),
		projectRoot: cfg.projectRoot,
		configFile: cfg.configFileUsed,
		versions: {},
		discovered: 0,
		eligible: 0,
		success: 0,
		failed: 0,
		skipped: 0,
		runExportRoot: null,
		logFile,
		summaryFile,
		exitCode: null,
		orgs: [],
	};

	log.info('='.repeat(56));
	log.info(`Scheduled Salesforce export starting. Run ID ${runId}${cfg.dryRun ? ' (DRY RUN)' : ''}`);
	log.info('Environment', {
		machine: summary.machine,
		user: summary.user,
		platform: summary.platform,
		workingDirectory: summary.workingDirectory,
		projectRoot: cfg.projectRoot,
		configFile: cfg.configFileUsed || '(defaults only)',
	});

	// --- Preflight --------------------------------------------------------
	const pre = await preflight(cfg, log);
	summary.versions = pre.versions;
	// cfg is frozen; carry the resolved entry alongside it for buildChildArgs.
	cfg = Object.freeze({ ...cfg, resolvedSfCliEntry: pre.sfCliEntry || '' });
	if (!pre.ok) {
		log.error('Preflight failed. No orgs were processed.');
		summary.exitCode = EXIT.PREFLIGHT;
		summary.finishedAt = new Date().toISOString();
		summary.durationMs = Date.now() - startedAt.getTime();
		summary.preflightProblems = pre.problems;
		fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
		log.raw(renderSummary(summary));
		await log.close();
		return EXIT.PREFLIGHT;
	}

	// --- Lock -------------------------------------------------------------
	// A dry run neither writes exports nor mutates anything, so it does not take
	// the lock -- you can safely inspect eligibility while a real run is going.
	let held = null;
	if (!cfg.dryRun) {
		try {
			held = lock.acquire({
				lockPath: cfg.lockFile,
				runId,
				staleMinutes: cfg.lockStaleMinutes,
				logger: log,
			});
		} catch (err) {
			if (err.name === 'LockBusyError') {
				log.warn(err.message);
				summary.exitCode = EXIT.LOCKED;
				summary.finishedAt = new Date().toISOString();
				summary.lockHolder = err.holder;
				fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
				await log.close();
				return EXIT.LOCKED;
			}
			log.error(`Could not acquire the run lock: ${err.message}`);
			summary.exitCode = EXIT.PREFLIGHT;
			await log.close();
			return EXIT.PREFLIGHT;
		}
	}

	let exitCode = EXIT.SUCCESS;
	try {
		// --- Discovery ----------------------------------------------------
		let orgs;
		try {
			orgs = await discoverScratchOrgs(pre.runner, log);
		} catch (err) {
			log.error(`Org discovery failed: ${err.message}`);
			summary.exitCode = EXIT.PREFLIGHT;
			summary.discoveryError = err.message;
			summary.finishedAt = new Date().toISOString();
			summary.durationMs = Date.now() - startedAt.getTime();
			fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
			log.raw(renderSummary(summary));
			return EXIT.PREFLIGHT;
		}

		summary.discovered = orgs.length;
		// per-org: one stable folder per org directly under the export root.
		// per-run: a timestamped folder per run, keeping history.
		const runExportRoot = cfg.layout === 'per-run' ? path.join(cfg.exportRoot, runId) : cfg.exportRoot;
		summary.runExportRoot = runExportRoot;
		summary.layout = cfg.layout;
		if (!cfg.dryRun) cleanStaleWorkDirs(cfg.exportRoot, log);

		if (orgs.length === 0) {
			log.info('No authenticated scratch orgs found. Nothing to do -- this is a successful no-op.');
		}

		// --- Per-org loop -------------------------------------------------
		for (const org of orgs) {
			const safe = pickOrgFields(org);
			const record = {
				alias: safe.alias || null,
				username: safe.username || null,
				orgId: safe.orgId || null,
				expirationDate: safe.expirationDate || null,
				devHubUsername: safe.devHubUsername || null,
				status: null,
				reason: null,
				appCheck: null,
				exportDir: null,
				startedAt: null,
				finishedAt: null,
				durationMs: null,
				exitCode: null,
				attempts: [],
				error: null,
			};
			summary.orgs.push(record);

			const label = safe.alias || safe.username || safe.orgId;
			log.info('-'.repeat(56));
			log.info(`Org: ${label}`, safe);

			// 1. local eligibility
			const local = classifyOrg(org, cfg, cli.onlyOrgs);
			if (local.warn) log.warn(local.warn);
			if (local.status) {
				record.status = local.status;
				record.reason = local.reason;
				summary.skipped += 1;
				log.info(`${local.status}: ${local.reason}`);
				continue;
			}

			// 2. config filters
			const filtered = applyOrgFilters(org, cfg, cli.onlyOrgs);
			if (filtered.status) {
				record.status = filtered.status;
				record.reason = filtered.reason;
				summary.skipped += 1;
				log.info(`${filtered.status}: ${filtered.reason}`);
				continue;
			}

			// 3. reachability + package
			const probe = await checkOrgAndPackage(pre.runner, org, cfg, log);
			record.appCheck = cfg.appCheck.enabled
				? probe.appPresent === true
					? 'PRESENT'
					: probe.appPresent === false
						? 'ABSENT'
						: 'UNKNOWN'
				: 'DISABLED';
			if (probe.status) {
				record.status = probe.status;
				record.reason = probe.reason;
				summary.skipped += 1;
				log.info(`${probe.status}: ${probe.reason}`);
				continue;
			}
			log.info(`Reachable; app check: ${record.appCheck}`);

			// 4. eligible -> export
			summary.eligible += 1;
			const folderName = orgDirectoryName(safe, cfg.orgFolderPattern);
			const exportDir = path.join(runExportRoot, folderName);
			record.exportDir = exportDir;
			record.folderName = folderName;

			if (cfg.dryRun) {
				const { args } = buildChildArgs(cfg, safe, exportDir);
				record.status = STATUS.DRY_RUN;
				record.reason = 'Dry run; nothing was exported.';
				log.info('DRY RUN -- would export into:', {
					exportDir,
					replacesExisting: fs.existsSync(exportDir),
					command: `node ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`,
				});
				continue;
			}

			// Export into a temp folder, then swap. A failed run therefore leaves
			// the existing folder exactly as it was rather than half-overwriting it.
			const workDir = path.join(cfg.exportRoot, `.tmp_${folderName}_${runId}`);
			try {
				fs.rmSync(workDir, { recursive: true, force: true });
				fs.mkdirSync(workDir, { recursive: true });
			} catch (err) {
				record.status = STATUS.FAILED;
				record.error = `Could not create working directory ${workDir}: ${err.message}`;
				summary.failed += 1;
				log.error(record.error);
				continue;
			}

			const orgStart = new Date();
			record.startedAt = orgStart.toISOString();
			// One org's failure must never abort the loop: every throwing path
			// inside exportOrg is already converted into a status.
			let outcome;
			try {
				outcome = await exportOrg(cfg, safe, workDir, log.child(label));
			} catch (err) {
				outcome = { status: STATUS.FAILED, attempts: [], exitCode: null, error: `Unexpected orchestrator error: ${err.message}` };
			}

			// The child records what happened to the metadata retrieve in its own
			// summary file rather than in an exit code, precisely so that a
			// metadata problem cannot be mistaken for an export failure. Read it
			// back here, while the work directory still exists.
			if (outcome.status === STATUS.SUCCESS) {
				record.metadata = readChildMetadataResult(workDir);
				if (record.metadata && record.metadata.status === 'FAILED') {
					log.warn(
						`Data export succeeded but the metadata retrieve did not: ${record.metadata.error || 'no detail'}`
					);
				} else if (record.metadata && record.metadata.warnings && record.metadata.warnings.length) {
					log.warn(
						`Metadata retrieved with ${record.metadata.warnings.length} manifest warning(s); ` +
							`those components are listed in the manifest but absent from the org.`
					);
				}
			}

			// Only a fully successful export is allowed to replace what is there.
			if (outcome.status === STATUS.SUCCESS) {
				try {
					swapIntoPlace(workDir, exportDir, runId);
				} catch (err) {
					outcome = {
						...outcome,
						status: STATUS.FAILED,
						error: `Export succeeded but could not be moved into place (${exportDir}): ${err.message}`,
					};
				}
			}
			if (outcome.status !== STATUS.SUCCESS) {
				// Discard the partial export; the previous folder is untouched.
				fs.rmSync(workDir, { recursive: true, force: true });
			}
			const orgEnd = new Date();

			record.finishedAt = orgEnd.toISOString();
			record.durationMs = orgEnd.getTime() - orgStart.getTime();
			record.status = outcome.status;
			record.exitCode = outcome.exitCode;
			record.attempts = outcome.attempts;
			record.error = outcome.error;
			record.integrationType = outcome.integrationType;
			record.connectors = outcome.connectors;

			if (outcome.status === STATUS.SUCCESS) {
				summary.success += 1;
				log.info(`SUCCESS in ${formatDuration(record.durationMs)} -> ${exportDir}`);
			} else {
				summary.failed += 1;
				log.error(`FAILED after ${formatDuration(record.durationMs)}: ${outcome.error}`);
			}
		}

		exitCode = summary.failed > 0 ? EXIT.EXPORT_FAILURES : EXIT.SUCCESS;
	} finally {
		if (held) held.release();
	}

	// --- Housekeeping -----------------------------------------------------
	if (!cfg.dryRun) {
		log.info('-'.repeat(56));
		pruneOldEntries(cfg.logRoot, cfg.logRetentionDays, log, 'log');
		// Export pruning applies ONLY to the per-run layout, where old entries are
		// old run folders. Under per-org the entries ARE the live per-org folders,
		// so age-based pruning would delete the export of any org that has not run
		// recently -- exactly the org whose backup you would still want.
		if (cfg.layout === 'per-run') {
			pruneOldEntries(cfg.exportRoot, cfg.exportRetentionDays, log, 'export');
		} else if (cfg.exportRetentionDays > 0) {
			log.debug('exportRetentionDays is ignored under layout "per-org" -- each org keeps exactly one folder.');
		}
	}

	// --- Summary ----------------------------------------------------------
	summary.finishedAt = new Date().toISOString();
	summary.durationMs = Date.now() - startedAt.getTime();
	summary.exitCode = exitCode;

	try {
		fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
		fs.writeFileSync(path.join(cfg.logRoot, 'latest.json'), JSON.stringify(summary, null, 2));
	} catch (err) {
		log.warn(`Could not write the machine-readable summary: ${err.message}`);
	}

	log.raw(renderSummary(summary));
	await log.close();
	return exitCode;
}

// A top-level failure must still produce an exit code the scheduler can read.
main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err) => {
		process.stderr.write(`Fatal orchestrator error: ${err && err.stack ? err.stack : err}\n`);
		process.exitCode = EXIT.PREFLIGHT;
	});

module.exports = { STATUS, EXIT, CHILD_EXIT, makeRunId, sanitizeSegment, orgDirectoryName, classifyOrg, renderSummary, swapIntoPlace, scratchOrgBasis };
