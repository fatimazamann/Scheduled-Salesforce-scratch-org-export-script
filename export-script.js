#!/usr/bin/env node
'use strict';

/**
 * export-script.js
 * ---------------------------------------------------------------------------
 * Exports cja_cj application configuration from EXACTLY ONE Salesforce org.
 *
 * This is a refactor of the existing exporter. Its Salesforce behaviour -- the
 * objects it exports, the SOQL it issues, the fields clean-json.js strips -- is
 * preserved. What changed is everything that made it unsafe to run unattended:
 * shell string interpolation, an interactive browser login fallback, silent
 * path mutation, and success/failure that could only be inferred from log text.
 *
 * Backwards compatibility: every original flag still works with its original
 * short form. Two behaviours intentionally differ, and both are documented in
 * the design note:
 *   1. Interactive `sf org login web` is now OPT-IN (--interactive). It used to
 *      be the automatic fallback, which would hang a scheduled task on a
 *      browser prompt that no one is there to answer.
 *   2. --dir is no longer lowercased. Lowercasing a path is wrong on
 *      case-sensitive filesystems and was never necessary on Windows.
 *
 * EXIT CODES (the orchestrator branches on these; do not repurpose them)
 *   0  SUCCESS
 *   1  UNCAUGHT           an unexpected error escaped
 *   2  INVALID_ARGUMENTS  bad or missing flags -- never retried
 *   3  AUTH               org is not authenticated, or its session is dead
 *   4  EXPORT_FAILED      Salesforce/CLI rejected the export -- never retried
 *   5  CLEANUP_FAILED     the export succeeded but clean-json.js did not
 *   6  TRANSIENT          network/5xx/timeout -- the parent MAY retry this
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');

const { parseArgs, renderHelp, ArgError } = require('./lib/args');
const sfcli = require('./lib/sf-cli');
const { escapeSoqlString, parseConnectorList, soqlStringList } = require('./lib/soql');
const { redactText } = require('./lib/logger');

const EXIT = {
	SUCCESS: 0,
	UNCAUGHT: 1,
	INVALID_ARGUMENTS: 2,
	AUTH: 3,
	EXPORT_FAILED: 4,
	CLEANUP_FAILED: 5,
	TRANSIENT: 6,
};

/** Fields clean-json.js strips. Unchanged from the original implementation. */
const CLEAN_FIELDS = [
	'LastModifiedDate',
	'IsDeleted',
	'LastViewedDate',
	'LastReferencedDate',
	'SystemModstamp',
	'CreatedById',
	'CreatedDate',
	'LastModifiedById',
	'OwnerId',
	'IsDeleted',
	'cja_cj__Connector_Metadata_Name__c',
	'RecordTypeId',
	'DifferenceInMinutes__c',
	'Difference_in_Minutes_minus_1_hour__c',
	'cja_cj__Difference_in_Hours__c',
].join(',');

/**
 * SOQL FIELDS(ALL) is an "unbounded" query and Salesforce REQUIRES a LIMIT of
 * at most 200 rows on it. The LIMIT 200 clauses in the original script are
 * therefore mandatory, not a historical safeguard -- removing them produces a
 * MALFORMED_QUERY error, not more data. See the design note for the migration
 * path (explicit field lists lift the ceiling to the 2,000-record cap that
 * `sf data export tree` imposes).
 */
const FIELDS_ALL_MAX_LIMIT = 200;
/** `sf data export tree`: "The SOQL query can return a maximum of 2,000 records." */
const EXPORT_TREE_MAX_RECORDS = 2000;

// ---------------------------------------------------------------------------
// Logging (plain, prefixed, redacted -- the parent captures these lines)
// ---------------------------------------------------------------------------

let QUIET = false;
const out = (msg) => {
	if (!QUIET) process.stdout.write(`${redactText(String(msg))}\n`);
};
const warn = (msg) => process.stderr.write(`WARNING: ${redactText(String(msg))}\n`);
const err = (msg) => process.stderr.write(`ERROR: ${redactText(String(msg))}\n`);

/** Exit with a code and a message that names what failed and why. */
function die(code, message, detail) {
	err(message);
	if (detail) err(String(detail).trim().split(/\r?\n/).slice(0, 20).join('\n'));
	process.exit(code);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

// Every original flag keeps its original short and long form.
const SPEC = {
	type: { long: 'type', short: 't', default: 'Sandbox', description: 'Org type: Scratch, Sandbox or Production (also x, s, p)' },
	user: { long: 'user', short: 'u', default: '', description: 'Username of the org to export from (required)' },
	dir: { long: 'dir', short: 'd', default: '', description: 'Directory the data is exported into (required)' },
	connector: { long: 'connector', short: 'c', default: '', description: 'CJ Connector name, or a comma-separated list' },
	connectorName: { long: 'connector-name', repeatable: true, description: 'One exact connector name; repeat for several. Use this when a name contains a comma.' },
	integration: { long: 'integration', short: 'i', default: '', description: 'Any-To-Any or Salesforce-To-Any' },
	limit: { long: 'limit', default: String(FIELDS_ALL_MAX_LIMIT), description: `Row limit for FIELDS(ALL) queries (max ${FIELDS_ALL_MAX_LIMIT})` },
	nonInteractive: { long: 'non-interactive', boolean: true, description: 'Never prompt or open a browser (this is the default)' },
	interactive: { long: 'interactive', boolean: true, description: 'Opt in to `sf org login web` when not authenticated' },
	skipAuthCheck: { long: 'skip-auth-check', boolean: true, description: 'Trust the caller that the org is authenticated' },
	sfExecutable: { long: 'sf-executable', default: '', description: 'Full path to the sf CLI (else resolved from PATH)' },
	sfCliEntry: { long: 'sf-cli-entry', default: '', description: "Path to the sf CLI's JS entry point; bypasses the cmd.exe shim" },
	cleanScript: { long: 'clean-script', default: '', description: 'Path to clean-json.js (default: alongside this script)' },
	metadataManifest: { long: 'metadata-manifest', default: '', description: 'package.xml to retrieve metadata with; omit to skip metadata entirely' },
	metadataSubdir: { long: 'metadata-subdir', default: 'metadata', description: 'Folder under --dir the metadata is written into' },
	metadataNamespace: { long: 'metadata-namespace', default: '', description: "Namespace the manifest's unprefixed names resolve against" },
	metadataApiVersion: { long: 'metadata-api-version', default: '', description: "API version for the retrieve; default: the manifest's own <version>" },
	metadataTimeout: { long: 'metadata-timeout', default: '900', description: 'Timeout in seconds for the metadata retrieve' },
	metadataRequired: { long: 'metadata-required', boolean: true, description: 'Fail the whole export if the metadata retrieve fails' },
	timeout: { long: 'timeout', default: '900', description: 'Timeout in seconds for each sf command' },
	quiet: { long: 'quiet', boolean: true, description: 'Suppress informational output' },
	help: { long: 'help', short: 'h', boolean: true, description: 'Show this help' },
};

let options;
try {
	options = parseArgs(process.argv.slice(2), SPEC);
} catch (e) {
	if (e instanceof ArgError) {
		process.stderr.write(`${e.message}\n\n${renderHelp('Usage: node export-script.js [options]', SPEC)}\n`);
		process.exit(EXIT.INVALID_ARGUMENTS);
	}
	throw e;
}
if (options.help) {
	process.stdout.write(
		`${renderHelp(
			'Usage: node export-script.js --user <username> --dir <directory> [options]',
			SPEC,
			'Exit codes: 0 ok | 2 bad arguments | 3 auth | 4 export failed | 5 cleanup failed | 6 transient'
		)}\n`
	);
	process.exit(EXIT.SUCCESS);
}
QUIET = options.quiet === true;

// --- Validate. Every failure here is exit 2 and happens BEFORE any network or
// --- filesystem work, so a misconfigured parent fails fast and identically.

const orgTypeRaw = String(options.type || '').trim();
const orgType = orgTypeRaw.toLowerCase();
const ORG_TYPES = {
	scratch: 'scratch',
	x: 'scratch',
	sandbox: 'sandbox',
	s: 'sandbox',
	production: 'production',
	p: 'production',
};
const resolvedOrgType = ORG_TYPES[orgType];
if (!resolvedOrgType) {
	die(
		EXIT.INVALID_ARGUMENTS,
		`Invalid org type ${JSON.stringify(orgTypeRaw)}. Use Scratch, Sandbox or Production (or x, s, p).`
	);
}

const userName = String(options.user || '').trim();
if (!userName) {
	// The original default was an empty username, which fell through to an
	// interactive login. For a scheduled job that is a hang, not a recovery.
	die(
		EXIT.INVALID_ARGUMENTS,
		'No --user was supplied. The target org username is required; this script never guesses an org.'
	);
}
try {
	sfcli.assertValidUsername(userName);
} catch (e) {
	die(EXIT.INVALID_ARGUMENTS, e.message);
}

// Preserve the caller's path exactly. The original lowercased it, which is
// wrong on case-sensitive filesystems and pointless on Windows.
const directoryPathRaw = String(options.dir || '').trim();
if (!directoryPathRaw) {
	die(
		EXIT.INVALID_ARGUMENTS,
		'No --dir was supplied. Specify the directory the data will be exported into.'
	);
}
// Resolve relative paths against the CALLER's cwd (matching the old `./<dir>`
// behaviour) but store an absolute path, so nothing downstream depends on cwd.
const directoryPath = path.resolve(process.cwd(), directoryPathRaw);

const integrationTypeRaw = String(options.integration || '').trim();
const integrationType = integrationTypeRaw.toLowerCase();
if (integrationType && integrationType !== 'any-to-any' && integrationType !== 'salesforce-to-any') {
	die(
		EXIT.INVALID_ARGUMENTS,
		`Invalid integration type ${JSON.stringify(integrationTypeRaw)}. Use Any-To-Any or Salesforce-To-Any.`
	);
}

// Connector names may legitimately contain commas, which the comma-separated
// --connector form cannot express. --connector-name is repeatable and each
// occurrence is one exact literal, so the orchestrator uses that. --connector
// is kept unchanged for backwards compatibility and for hand-typed runs.
let connectorNames;
try {
	connectorNames = options.connectorName.length
		? options.connectorName.map((s) => String(s).trim()).filter(Boolean)
		: parseConnectorList(options.connector);
	if (options.connectorName.length && options.connector) {
		die(EXIT.INVALID_ARGUMENTS, 'Use either --connector or --connector-name, not both.');
	}
	for (const name of connectorNames) sfcli.assertPrintable(name, 'Connector name');
} catch (e) {
	die(EXIT.INVALID_ARGUMENTS, e.message);
}

const rowLimit = Number(options.limit);
if (!Number.isInteger(rowLimit) || rowLimit < 1 || rowLimit > FIELDS_ALL_MAX_LIMIT) {
	die(
		EXIT.INVALID_ARGUMENTS,
		`--limit must be an integer between 1 and ${FIELDS_ALL_MAX_LIMIT} ` +
			`(Salesforce requires LIMIT <= 200 on FIELDS(ALL) queries).`
	);
}

const timeoutSeconds = Number(options.timeout);
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
	die(EXIT.INVALID_ARGUMENTS, '--timeout must be a positive number of seconds.');
}

// --- Metadata retrieve options ----------------------------------------------
// Metadata is opt-in: no --metadata-manifest means this script behaves exactly
// as it did before the feature existed.
// Absolute for the same reason as the CLI paths below: the retrieve runs with
// a different working directory than the one we were launched in.
const metadataManifestRaw = String(options.metadataManifest || '').trim();
const metadataManifest = metadataManifestRaw ? path.resolve(process.cwd(), metadataManifestRaw) : '';
const metadataEnabled = metadataManifest !== '';
if (metadataEnabled && !fs.existsSync(metadataManifest)) {
	die(EXIT.INVALID_ARGUMENTS, `--metadata-manifest does not exist: ${metadataManifest}`);
}
const metadataSubdir = String(options.metadataSubdir || 'metadata').trim();
if (metadataEnabled && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(metadataSubdir)) {
	die(EXIT.INVALID_ARGUMENTS, `--metadata-subdir must be a single plain folder name, got ${JSON.stringify(metadataSubdir)}.`);
}
const metadataNamespace = String(options.metadataNamespace || '').trim();
if (metadataNamespace && !/^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(metadataNamespace)) {
	die(EXIT.INVALID_ARGUMENTS, `--metadata-namespace is not a valid namespace prefix: ${JSON.stringify(metadataNamespace)}`);
}
const metadataApiVersionFlag = String(options.metadataApiVersion || '').trim();
if (metadataApiVersionFlag && !/^\d{2,3}\.0$/.test(metadataApiVersionFlag)) {
	die(EXIT.INVALID_ARGUMENTS, `--metadata-api-version must look like "63.0", got ${JSON.stringify(metadataApiVersionFlag)}.`);
}
const metadataTimeoutSeconds = Number(options.metadataTimeout);
if (!Number.isFinite(metadataTimeoutSeconds) || metadataTimeoutSeconds <= 0) {
	die(EXIT.INVALID_ARGUMENTS, '--metadata-timeout must be a positive number of seconds.');
}
const metadataRequired = options.metadataRequired === true;

// Non-interactive is the DEFAULT. --interactive is an explicit opt-in and is
// additionally refused for scratch orgs, where re-authenticating via a browser
// is never the right recovery for an automated export.
const allowInteractive = options.interactive === true && options.nonInteractive !== true;
if (allowInteractive && resolvedOrgType === 'scratch') {
	die(
		EXIT.INVALID_ARGUMENTS,
		'--interactive is not supported for scratch orgs. A scratch org must already be authenticated; ' +
			'if it is not, that is a condition to report, not to fix with a browser login.'
	);
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

// Resolved to absolute paths against the CALLER's cwd, immediately.
//
// The metadata retrieve runs with its working directory set to the SFDX
// project folder, so anything still held as a relative path would resolve
// against the wrong directory by the time it is used -- and it would do so
// only for the metadata step, after the data export had already succeeded.
// Pinning them here means cwd can move afterwards without consequence.
let sfExecutable = options.sfExecutable ? path.resolve(process.cwd(), options.sfExecutable) : null;
if (sfExecutable && !fs.existsSync(sfExecutable)) {
	die(EXIT.INVALID_ARGUMENTS, `--sf-executable does not exist: ${sfExecutable}`);
}
const sfCliEntry = options.sfCliEntry ? path.resolve(process.cwd(), options.sfCliEntry) : '';
if (sfCliEntry && !fs.existsSync(sfCliEntry)) {
	die(EXIT.INVALID_ARGUMENTS, `--sf-cli-entry does not exist: ${sfCliEntry}`);
}
if (!sfExecutable && !sfCliEntry) {
	sfExecutable = sfcli.resolveExecutable('sf');
	if (!sfExecutable) {
		die(
			EXIT.INVALID_ARGUMENTS,
			'The Salesforce CLI ("sf") is not on PATH for this account. Pass --sf-executable with its full path.'
		);
	}
}

const runner = sfcli.createSfRunner({
	sfExecutable: sfExecutable || undefined,
	sfCliEntry: sfCliEntry || undefined,
	timeoutMs: timeoutSeconds * 1000,
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

const TRANSIENT_MARKERS = [
	'ECONNRESET',
	'ETIMEDOUT',
	'ENOTFOUND',
	'EAI_AGAIN',
	'ECONNREFUSED',
	'EPIPE',
	'socket hang up',
	'network timeout',
	'Client network socket disconnected',
	'503',
	'Server Unavailable',
	'SERVER_UNAVAILABLE',
	'UNABLE_TO_LOCK_ROW',
	'REQUEST_LIMIT_EXCEEDED',
	'Your request exceeded the time limit',
	'QUERY_TIMEOUT',
];

const AUTH_MARKERS = [
	'INVALID_SESSION_ID',
	'INVALID_LOGIN',
	'expired access/refresh token',
	'RefreshTokenAuthError',
	'NamedOrgNotFoundError',
	'No authorization information found',
	'invalid_grant',
	'This org appears to have a problem with its OAuth configuration',
];

const includesAny = (text, markers) => {
	const h = String(text || '').toLowerCase();
	return markers.some((m) => h.includes(String(m).toLowerCase()));
};

/** Map a failed sf invocation onto one of our exit codes. */
function classifyFailure(res, detail) {
	if (res && res.timedOut) return EXIT.TRANSIENT;
	if (includesAny(detail, AUTH_MARKERS)) return EXIT.AUTH;
	if (includesAny(detail, TRANSIENT_MARKERS)) return EXIT.TRANSIENT;
	return EXIT.EXPORT_FAILED;
}

function detailOf(res) {
	const parts = [];
	const json = sfcli.extractJson(res.stdout) || sfcli.extractJson(res.stderr);
	if (json) {
		if (json.message) parts.push(json.message);
		if (json.name) parts.push(`(${json.name})`);
		if (Array.isArray(json.errors)) for (const e of json.errors) parts.push(typeof e === 'string' ? e : e && e.message);
	}
	if (res.stderr) parts.push(res.stderr);
	if (!json && res.stdout) parts.push(res.stdout);
	return parts.filter(Boolean).join('\n').trim();
}

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

function buildQueries() {
	// Connector filter: safely escaped. The original did
	// options.connector.replaceAll(',', "','"), which breaks on any name
	// containing an apostrophe and would let one alter the query.
	const connectorWhere = connectorNames.length ? ` WHERE Name IN (${soqlStringList(connectorNames)})` : '';

	const connectors = `SELECT FIELDS(ALL) FROM cja_cj__CJ_Connector__c${connectorWhere} LIMIT ${rowLimit}`;

	// NOTE (preserved behaviour): the original had `${!CJconnectorName ? '' : ''}`
	// here -- a ternary that inserts nothing on either branch, i.e. an
	// unfinished filter. Object mappings are therefore NOT restricted to the
	// selected connectors. We keep that behaviour deliberately rather than
	// inventing a relationship we cannot verify from the code, and warn at
	// runtime whenever a connector filter is supplied (see below).
	const mappingTree =
		`SELECT FIELDS(ALL), (` +
		` SELECT FIELDS(ALL) FROM cja_cj__Json_Field_Mappings__r` +
		` ORDER BY cja_cj__Related_Object_Field_Mapping__c LIMIT ${rowLimit})` +
		` FROM cja_cj__JSON_Object_Mapping__c` +
		` ORDER BY cja_cj__Parent_Object_Mapping__c, cja_cj__Version_Control_Mapping__c,` +
		` cja_cj__Succeeding_Object_Mapping__c LIMIT ${rowLimit}`;

	// Explicit field list, so no FIELDS(ALL) limit applies. It is still subject
	// to the 2,000-record ceiling of `sf data export tree`.
	const messageTemplate =
		`SELECT Id, Name, cja_cj__Template__c FROM cja_cj__CJ_Message_Template__c`;

	const dataFlow =
		`SELECT FIELDS(ALL), (` +
		` SELECT Name, CurrencyIsoCode, cja_cj__Dataflow__c, cja_cj__Error_Handling__c,` +
		` cja_cj__External_System_Table_Name__c, cja_cj__Fetch_Child_Reference__c,` +
		` cja_cj__JSON_Object_Mapping__c, cja_cj__Last_Processed_External_IDs__c,` +
		` cja_cj__Last_Sync_Datetime__c,` +
		` (SELECT FIELDS(ALL) FROM cja_cj__Dataflow_Action_Data__r LIMIT ${rowLimit})` +
		` FROM cja_cj__Dataflow_Actions__r LIMIT ${rowLimit} )` +
		` FROM cja_cj__Dataflow__c LIMIT ${rowLimit}`;

	const queries = [
		{ name: 'CJ Connectors', soql: connectors },
		{ name: 'JSON Object Mappings', soql: mappingTree },
		{ name: 'Message Templates', soql: messageTemplate },
	];
	// Preserved: Dataflows are exported only for the any-to-any integration type.
	if (integrationType === 'any-to-any') {
		queries.push({ name: 'Dataflows', soql: dataFlow });
	}
	return queries;
}

// ---------------------------------------------------------------------------
// Truncation detection
// ---------------------------------------------------------------------------

/**
 * Walk the export output and warn whenever a record set came back exactly at a
 * limit. That is the signature of silent truncation: configuration that exists
 * in the org but is missing from the backup.
 *
 * This does not fail the export -- an org can legitimately have exactly 200
 * mappings -- but it must never pass unnoticed, so it is a WARNING on stderr
 * and a flag in the summary file.
 */
function detectTruncation(dir) {
	const findings = [];

	const countRecords = (node, filename, pathLabel) => {
		if (!node || typeof node !== 'object') return;
		if (Array.isArray(node.records)) {
			const n = node.records.length;
			// Only an EXACT match on a limit is evidence of truncation. A count
			// merely greater than rowLimit is normal and expected: `--plan`
			// flattens subquery children into their own file, and the per-parent
			// LIMIT applies to each parent separately, so the file total is a sum
			// across parents and has no relationship to the limit.
			if (n === rowLimit || n === EXPORT_TREE_MAX_RECORDS) {
				findings.push({
					file: filename,
					path: pathLabel,
					count: n,
					limit: n === EXPORT_TREE_MAX_RECORDS ? EXPORT_TREE_MAX_RECORDS : rowLimit,
				});
			}
			node.records.forEach((rec, i) => {
				if (rec && typeof rec === 'object') {
					for (const [k, v] of Object.entries(rec)) {
						if (v && typeof v === 'object' && Array.isArray(v.records)) {
							countRecords(v, filename, `${pathLabel}[${i}].${k}`);
						}
					}
				}
			});
		}
	};

	let entries = [];
	try {
		entries = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
	} catch (_) {
		return findings;
	}

	for (const file of entries) {
		if (/-plan\.json$/i.test(file) || file === '_export-summary.json') continue;
		try {
			const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
			countRecords(parsed, file, 'records');
		} catch (_) {
			/* not a tree file; ignore */
		}
	}
	return findings;
}

// ---------------------------------------------------------------------------
// Metadata retrieve
// ---------------------------------------------------------------------------

const METADATA_STATUS = {
	SKIPPED: 'SKIPPED',
	OK: 'OK',
	OK_WITH_WARNINGS: 'OK_WITH_WARNINGS',
	FAILED: 'FAILED',
};

/** Pull <version>63.0</version> out of a manifest, without an XML parser. */
function manifestApiVersion(manifestPath) {
	try {
		const text = fs.readFileSync(manifestPath, 'utf8');
		const m = text.match(/<version>\s*([\d.]+)\s*<\/version>/i);
		if (!m) return null;
		return /^\d+$/.test(m[1]) ? `${m[1]}.0` : m[1];
	} catch (_) {
		return null;
	}
}

/**
 * `sf project retrieve start` refuses to run anywhere that is not an SFDX
 * project ("InvalidProjectWorkspaceError"), so we give it one: a folder whose
 * only purpose is to hold an sfdx-project.json. Nothing is ever written into
 * it -- the retrieved files go to --output-dir.
 *
 * We create it if it is missing rather than requiring a committed scaffold, so
 * a fresh checkout on a new machine works with no manual setup step.
 */
function ensureSfdxProject(projectRoot, packageDir, apiVersion) {
	fs.mkdirSync(path.join(projectRoot, packageDir), { recursive: true });
	const projectFile = path.join(projectRoot, 'sfdx-project.json');
	const project = {
		packageDirectories: [{ path: packageDir, default: true }],
		namespace: metadataNamespace || '',
		sfdcLoginUrl: 'https://login.salesforce.com',
		sourceApiVersion: apiVersion || '63.0',
	};
	fs.writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`);
	return projectFile;
}

/** Count every file written under a directory tree. */
function countFiles(dir) {
	let n = 0;
	let entries;
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch (_) {
		return 0;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) n += countFiles(path.join(dir, entry.name));
		else n += 1;
	}
	return n;
}

/**
 * Retrieve metadata into <dir>/<subdir>.
 *
 * Returns a status object that always exists, even on failure, so the caller
 * can record what happened rather than inferring it from log text. Whether a
 * failure here sinks the whole export is the caller's decision
 * (--metadata-required), not this function's.
 */
async function retrieveMetadata(outputDir) {
	const startedAt = new Date();
	const apiVersion = metadataApiVersionFlag || manifestApiVersion(metadataManifest) || '';

	// `sf project retrieve start` REFUSES an --output-dir outside the SFDX
	// project it is running in (OutputDirOutsideProjectError). So the project
	// root is the export folder itself, not some scaffold elsewhere: we drop an
	// sfdx-project.json beside the exported data and retrieve into a package
	// directory under it.
	//
	// The useful side effect is that each backup folder is then a valid SFDX
	// project in its own right -- `sf project deploy start` works straight out
	// of it, with no reassembly.
	const projectRoot = directoryPath;
	try {
		ensureSfdxProject(projectRoot, metadataSubdir, apiVersion);
	} catch (e) {
		return {
			status: METADATA_STATUS.FAILED,
			error: `Could not prepare the SFDX project in ${projectRoot}: ${e.message}`,
			startedAt: startedAt.toISOString(),
			finishedAt: new Date().toISOString(),
		};
	}

	const args = [
		'project',
		'retrieve',
		'start',
		'--manifest',
		metadataManifest,
		'--target-org',
		userName,
		// Relative to projectRoot, which is the retrieve's working directory.
		// An absolute path here is what triggered OutputDirOutsideProjectError.
		'--output-dir',
		metadataSubdir,
		// --wait bounds the CLI's own polling; our timeout is the outer bound.
		'--wait',
		String(Math.max(1, Math.ceil(metadataTimeoutSeconds / 60))),
	];
	if (apiVersion) args.push('--api-version', apiVersion);

	out(`Retrieving metadata using ${metadataManifest}${apiVersion ? ` (API ${apiVersion})` : ''}...`);

	// --json, always. The human-readable form is a table with one row per
	// component -- hundreds of lines that would bury everything else in the
	// scheduled run's log while telling us nothing we cannot get from the JSON.
	const res = await runner.sfJson(args, {
		cwd: projectRoot,
		timeoutMs: metadataTimeoutSeconds * 1000,
		onStderrLine: (line) => line.trim() && warn(line),
	});
	const finishedAt = new Date();
	const base = {
		manifest: metadataManifest,
		apiVersion: apiVersion || null,
		outputDirectory: outputDir,
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs: finishedAt.getTime() - startedAt.getTime(),
	};

	if (!res.ok) {
		const detail = detailOf(res.raw);
		return {
			...base,
			status: METADATA_STATUS.FAILED,
			transient: classifyFailure(res.raw, detail) === EXIT.TRANSIENT,
			auth: classifyFailure(res.raw, detail) === EXIT.AUTH,
			error: `"sf project retrieve start" failed (exit ${res.raw.code}). ${detail}`.trim(),
			fileCount: countFiles(outputDir),
		};
	}

	const result = res.result || {};
	// The shape has moved around across CLI versions: newer builds return
	// `files`, older ones `fileProperties`. Fall back to counting what actually
	// landed on disk, which is the number that matters for a backup anyway.
	const components = Array.isArray(result.files)
		? result.files
		: Array.isArray(result.fileProperties)
			? result.fileProperties
			: [];
	const fileCount = countFiles(outputDir);

	// Warnings are how the CLI reports a manifest entry that does not exist in
	// the org ("Entity of type 'Layout' named '...' cannot be found"). The
	// retrieve still succeeds, so these are easy to miss -- and each one is a
	// component you believe you are backing up and are not.
	const messages = []
		.concat(Array.isArray(result.messages) ? result.messages : result.messages ? [result.messages] : [])
		.map((m) => (typeof m === 'string' ? m : m && (m.problem || m.message)))
		.filter(Boolean);

	const byType = {};
	for (const c of components) {
		const t = (c && c.type) || 'unknown';
		byType[t] = (byType[t] || 0) + 1;
	}

	return {
		...base,
		status: messages.length ? METADATA_STATUS.OK_WITH_WARNINGS : METADATA_STATUS.OK,
		componentCount: components.length,
		fileCount,
		componentsByType: byType,
		warnings: messages,
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
	const startedAt = new Date();
	out(`Exporting cja_cj configuration from ${userName}`);
	out(`  org type:         ${resolvedOrgType}`);
	out(`  output directory: ${directoryPath}`);
	out(`  integration type: ${integrationType || '(none)'}`);
	out(`  connectors:       ${connectorNames.length ? connectorNames.join(', ') : '(all)'}`);

	if (connectorNames.length) {
		warn(
			'A connector filter was supplied. It applies to cja_cj__CJ_Connector__c ONLY. ' +
				'Object mappings, message templates and dataflows are exported unfiltered, ' +
				'preserving the existing exporter behaviour. See design note section B-4.'
		);
	}

	// --- 1. Confirm the org is authenticated ------------------------------
	if (!options.skipAuthCheck) {
		// `sf org display` (deliberately WITHOUT --verbose, which returns the
		// sfdxAuthUrl containing a refresh token) verifies both that a local auth
		// record exists and that it still works.
		const display = await runner.sfJson(['org', 'display', '--target-org', userName]);
		if (!display.ok) {
			const detail = detailOf(display.raw);
			if (allowInteractive && resolvedOrgType !== 'scratch') {
				out('Org is not authenticated; --interactive was supplied, opening a browser login...');
				const loginArgs =
					resolvedOrgType === 'sandbox'
						? ['org', 'login', 'web', '--alias', userName, '--instance-url', 'https://test.salesforce.com']
						: ['org', 'login', 'web', '--alias', userName];
				const login = await runner.sf(loginArgs, { timeoutMs: 0 });
				if (login.code !== 0) {
					die(EXIT.AUTH, `Interactive login failed for ${userName}.`, detailOf(login));
				}
			} else {
				die(
					classifyFailure(display.raw, detail) === EXIT.TRANSIENT ? EXIT.TRANSIENT : EXIT.AUTH,
					`Org ${userName} is not usable with the locally stored authentication. ` +
						`This run is non-interactive, so no browser login was attempted.`,
					detail
				);
			}
		} else {
			out('Org authentication verified.');
		}
	}

	// --- 2. Prepare the output directory ----------------------------------
	try {
		fs.mkdirSync(directoryPath, { recursive: true });
	} catch (e) {
		die(EXIT.EXPORT_FAILED, `Cannot create output directory ${directoryPath}: ${e.message}`);
	}

	// --- 3. Export --------------------------------------------------------
	const queries = buildQueries();
	out(`Exporting ${queries.length} query set(s): ${queries.map((q) => q.name).join(', ')}`);

	const exportArgs = [
		'data',
		'export',
		'tree',
		'--plan',
		'--output-dir',
		directoryPath, // passed as one argv element: spaces need no quoting
		'--target-org',
		userName,
	];
	for (const q of queries) exportArgs.push('--query', q.soql);

	const exportRes = await runner.sfJson(exportArgs, {
		onStderrLine: (line) => line.trim() && warn(line),
	});
	if (!exportRes.ok) {
		const detail = detailOf(exportRes.raw);
		die(
			classifyFailure(exportRes.raw, detail),
			`"sf data export tree" failed for ${userName} (exit ${exportRes.raw.code}).`,
			detail
		);
	}
	out(`Export written to ${directoryPath}`);

	// --- 4. Truncation check ----------------------------------------------
	const truncation = detectTruncation(directoryPath);
	for (const t of truncation) {
		warn(
			`Possible truncation in ${t.file} at ${t.path}: exactly ${t.count} record(s) returned, ` +
				`which is the ${t.limit}-record query limit. This is either a coincidence or the query ` +
				`was cut off -- verify with: sf data query --target-org ${userName} ` +
				`--query "SELECT COUNT() FROM <object>"`
		);
	}

	// --- 5. Clean --------------------------------------------------------
	// Resolved against __dirname, never a bare relative path: Task Scheduler
	// controls the working directory and it is frequently C:\Windows\System32.
	// The original `node clean-json.js` would silently fail there.
	const cleanScript = options.cleanScript
		? path.resolve(process.cwd(), options.cleanScript)
		: path.resolve(__dirname, 'clean-json.js');
	if (!fs.existsSync(cleanScript)) {
		die(EXIT.CLEANUP_FAILED, `clean-json.js not found at ${cleanScript}.`);
	}
	out('Cleaning exported data...');
	const clean = await sfcli.run(process.execPath, [cleanScript, directoryPath, CLEAN_FIELDS], {
		cwd: __dirname,
		timeoutMs: timeoutSeconds * 1000,
		onStdoutLine: (line) => line.trim() && out(line),
		onStderrLine: (line) => line.trim() && warn(line),
	});
	if (clean.code !== 0) {
		die(
			clean.timedOut ? EXIT.TRANSIENT : EXIT.CLEANUP_FAILED,
			`clean-json.js failed for ${userName} (exit ${clean.code}).`,
			clean.stderr || clean.stdout
		);
	}

	// --- 6. Metadata ------------------------------------------------------
	// Deliberately AFTER the data export and clean. Data is the part that
	// cannot be reconstructed from a repo; metadata usually can. If we only
	// have time or connectivity for one of the two, the data wins.
	let metadata = { status: METADATA_STATUS.SKIPPED, reason: 'No --metadata-manifest was supplied.' };
	if (metadataEnabled) {
		const metadataDir = path.join(directoryPath, metadataSubdir);
		try {
			metadata = await retrieveMetadata(metadataDir);
		} catch (e) {
			metadata = { status: METADATA_STATUS.FAILED, error: `Unexpected metadata failure: ${e.message}` };
		}

		if (metadata.status === METADATA_STATUS.FAILED) {
			if (metadataRequired) {
				die(
					metadata.auth ? EXIT.AUTH : metadata.transient ? EXIT.TRANSIENT : EXIT.EXPORT_FAILED,
					`Metadata retrieve failed for ${userName} and --metadata-required was set.`,
					metadata.error
				);
			}
			// Non-fatal is the default, and it is the right default: a metadata
			// problem must not discard a data export that already succeeded.
			warn(
				`Metadata retrieve FAILED for ${userName}; the data export is unaffected and is being kept. ` +
					`${metadata.error || ''}`
			);
		} else {
			for (const w of metadata.warnings || []) {
				warn(
					`Metadata manifest entry could not be retrieved: ${w} ` +
						`-- it is listed in ${path.basename(metadataManifest)} but does not exist in this org, ` +
						`so it is NOT in this backup.`
				);
			}
			out(
				`Metadata: ${metadata.componentCount} component(s), ${metadata.fileCount} file(s) ` +
					`in ${Math.round((metadata.durationMs || 0) / 1000)}s` +
					`${metadata.warnings && metadata.warnings.length ? ` (${metadata.warnings.length} warning(s))` : ''}.`
			);
			try {
				fs.writeFileSync(path.join(metadataDir, '_metadata-summary.json'), JSON.stringify(metadata, null, 2));
			} catch (e) {
				warn(`Could not write _metadata-summary.json: ${e.message}`);
			}
		}
	}

	// --- 7. Per-org manifest ---------------------------------------------
	const finishedAt = new Date();
	const manifest = {
		schemaVersion: 1,
		username: userName,
		orgType: resolvedOrgType,
		integrationType: integrationType || null,
		connectorFilter: connectorNames,
		rowLimit,
		queries: queries.map((q) => ({ name: q.name, soql: q.soql })),
		outputDirectory: directoryPath,
		truncationWarnings: truncation,
		metadata,
		startedAt: startedAt.toISOString(),
		finishedAt: finishedAt.toISOString(),
		durationMs: finishedAt.getTime() - startedAt.getTime(),
		status: 'SUCCESS',
	};
	try {
		fs.writeFileSync(path.join(directoryPath, '_export-summary.json'), JSON.stringify(manifest, null, 2));
	} catch (e) {
		warn(`Could not write _export-summary.json: ${e.message}`);
	}

	out(`Process completed in ${Math.round(manifest.durationMs / 1000)}s.`);
	if (metadata.status === METADATA_STATUS.FAILED) {
		out('Completed WITH a metadata failure -- the data export above is complete and valid.');
	}
	if (truncation.length) {
		out(`Completed WITH ${truncation.length} truncation warning(s) -- review them.`);
	}
	process.exit(EXIT.SUCCESS);
}

main().catch((e) => {
	err(`Unexpected failure exporting ${userName}: ${e && e.stack ? e.stack : e}`);
	process.exit(EXIT.UNCAUGHT);
});

module.exports = { EXIT, METADATA_STATUS };
