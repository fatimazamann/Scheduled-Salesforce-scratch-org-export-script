#!/usr/bin/env node
'use strict';
/**
 * test/run-tests.js
 * ---------------------------------------------------------------------------
 * Executes the test matrix from the design note against a mock Salesforce CLI.
 * Run with:  node test/run-tests.js
 *
 * Every scenario drives the REAL orchestrator and the REAL exporter; only the
 * `sf` binary and clean-json.js are stubbed.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MOCK_SF = path.join(ROOT, 'test', 'mock-sf.js');
const MOCK_CLEAN = path.join(ROOT, 'test', 'mock-clean-json.js');

let pass = 0;
let fail = 0;
const failures = [];

function check(label, condition, detail) {
	if (condition) {
		pass += 1;
		process.stdout.write(`    ok   ${label}\n`);
	} else {
		fail += 1;
		failures.push(`${label}${detail ? ` -- ${detail}` : ''}`);
		process.stdout.write(`    FAIL ${label}${detail ? ` -- ${detail}` : ''}\n`);
	}
}

function scratchOrg(over) {
	return Object.assign(
		{
			orgId: '00D5g000004ABCDEAO',
			accessToken: '00D5g000004ABCDE!SUPER_SECRET_TOKEN_VALUE_1234567890',
			instanceUrl: 'https://example-dev-ed.scratch.my.salesforce.com',
			username: 'test@example.com',
			alias: 'demo-org',
			isScratch: true,
			isSandbox: false,
			isDevHub: false,
			status: 'Active',
			isExpired: false,
			expirationDate: '2099-12-31',
			devHubUsername: 'devhub@example.com',
			createdDate: '2026-08-01T00:00:00.000Z',
		},
		over
	);
}

/** Build a sandbox for one scenario and run the orchestrator inside it. */
function runScenario(name, { orgs = [], orgFixtures = {}, config = {}, args = [], rootName = null, env = {}, preRun = null, extraBuckets = {} }) {
	process.stdout.write(`\n  ${name}\n`);

	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfexp-'));
	const work = path.join(base, rootName || 'work');
	fs.mkdirSync(work, { recursive: true });

	const fixturePath = path.join(base, 'fixture.json');
	fs.writeFileSync(
		fixturePath,
		JSON.stringify({
			version: '@salesforce/cli/2.99.0 mock node-v22',
			orgList: {
				status: 0,
				result: Object.assign({ scratchOrgs: orgs, nonScratchOrgs: [], sandboxes: [], devHubs: [], other: [] }, extraBuckets),
			},
			orgs: orgFixtures,
		})
	);

	const callLog = path.join(base, 'calls.log');
	const cfgPath = path.join(base, 'config.json');
	fs.writeFileSync(
		cfgPath,
		JSON.stringify(
			Object.assign(
				{
					exportRoot: path.join(work, 'exports'),
					layout: 'per-run',
					orgFolderPattern: '{alias}_{orgId}',
					logRoot: path.join(work, 'logs'),
					lockFile: path.join(work, 'logs', '.lock'),
					exportScript: path.join(ROOT, 'export-script.js'),
					cleanScript: MOCK_CLEAN,
					sfCliEntry: MOCK_SF,
					integrationType: 'any-to-any',
					childTimeoutSeconds: 60,
					sfCommandTimeoutSeconds: 30,
					maxRetries: 0,
					logRetentionDays: 0,
					exportRetentionDays: 0,
				},
				config
			),
			null,
			2
		)
	);

	if (preRun) preRun({ base, work, cfgPath });

	const res = spawnSync(process.execPath, [path.join(ROOT, 'orchestrator.js'), '--config', cfgPath, ...args], {
		cwd: os.tmpdir(), // deliberately NOT the project root: proves cwd independence
		encoding: 'utf8',
		env: Object.assign({}, process.env, {
			MOCK_SF_FIXTURE: fixturePath,
			MOCK_SF_CALLLOG: callLog,
			SFEXPORT_CLEAN_SCRIPT: MOCK_CLEAN,
			...env,
		}),
	});

	const logRoot = (config.logRoot) || path.join(work, 'logs');
	let summary = null;
	const latest = path.join(logRoot, 'latest.json');
	const summaries = fs.existsSync(logRoot) ? fs.readdirSync(logRoot).filter((f) => /^export_.*\.json$/.test(f)) : [];
	const summaryPath = summaries.length ? path.join(logRoot, summaries[0]) : fs.existsSync(latest) ? latest : null;
	if (summaryPath) {
		try {
			summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
		} catch (_) {
			/* leave null */
		}
	}

	const logText = summaries.length
		? fs.readdirSync(logRoot)
				.filter((f) => f.endsWith('.log'))
				.map((f) => fs.readFileSync(path.join(logRoot, f), 'utf8'))
				.join('\n')
		: '';

	return {
		code: res.status,
		stdout: res.stdout || '',
		stderr: res.stderr || '',
		summary,
		logText,
		work,
		base,
		calls: fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8') : '',
	};
}

// ===========================================================================
process.stdout.write('Salesforce scheduled export -- test matrix\n');

// --- Scenario 1: no authenticated scratch orgs -----------------------------
{
	const r = runScenario('S1  no authenticated scratch orgs -> successful no-op', { orgs: [] });
	check('exit code 0', r.code === 0, `got ${r.code}`);
	check('discovered 0', r.summary && r.summary.discovered === 0);
	check('log states nothing to do', /Nothing to do/i.test(r.logText));
}

// --- Scenario 2: one eligible org ------------------------------------------
{
	const r = runScenario('S2  one eligible scratch org -> one successful export', {
		orgs: [scratchOrg()],
		orgFixtures: { 'test@example.com': { describe: 'ok', export: 'ok' } },
	});
	check('exit code 0', r.code === 0, `got ${r.code}`);
	check('1 success', r.summary && r.summary.success === 1);
	check('status SUCCESS', r.summary && r.summary.orgs[0].status === 'SUCCESS');
	const dir = r.summary && r.summary.orgs[0].exportDir;
	check('export directory created', dir && fs.existsSync(dir));
	check('directory named <alias>_<orgId>', dir && path.basename(dir) === 'demo-org_00D5g000004ABCDEAO', dir && path.basename(dir));
	check('per-org manifest written', dir && fs.existsSync(path.join(dir, '_export-summary.json')));
	check('clean-json stripped fields', dir && !/"LastModifiedDate"/.test(fs.readFileSync(path.join(dir, 'cja_cj__CJ_Connector__cs.json'), 'utf8')));
	check('no browser login attempted', !/BROWSER_LOGIN_ATTEMPTED/.test(r.calls));
	check('access token never logged', !/SUPER_SECRET_TOKEN_VALUE/.test(r.logText + r.stdout + JSON.stringify(r.summary)));
	check('dataflows exported for any-to-any', dir && fs.existsSync(path.join(dir, 'cja_cj__Dataflow__cs.json')));
}

// --- Scenario 3: multiple eligible orgs ------------------------------------
{
	const r = runScenario('S3  multiple eligible orgs -> each exported independently', {
		orgs: [
			scratchOrg({ username: 'a@example.com', alias: 'org-a', orgId: '00D000000000001AAA' }),
			scratchOrg({ username: 'b@example.com', alias: 'org-b', orgId: '00D000000000002AAA' }),
			scratchOrg({ username: 'c@example.com', alias: 'org-c', orgId: '00D000000000003AAA' }),
		],
		orgFixtures: {
			'a@example.com': { describe: 'ok', export: 'ok' },
			'b@example.com': { describe: 'ok', export: 'ok' },
			'c@example.com': { describe: 'ok', export: 'ok' },
		},
	});
	check('exit code 0', r.code === 0, `got ${r.code}`);
	check('3 successes', r.summary && r.summary.success === 3, r.summary && String(r.summary.success));
	const dirs = r.summary.orgs.map((o) => o.exportDir);
	check('three distinct directories', new Set(dirs).size === 3);
	check('all under one run directory', dirs.every((d) => d.startsWith(r.summary.runExportRoot)));
}

// --- Scenario 4: org without the CJ application ----------------------------
{
	const r = runScenario('S4  scratch org without the cja_cj package -> skipped, not fatal', {
		orgs: [
			scratchOrg({ username: 'has@example.com', alias: 'has-app', orgId: '00D000000000010AAA' }),
			scratchOrg({ username: 'no@example.com', alias: 'no-app', orgId: '00D000000000011AAA' }),
		],
		orgFixtures: {
			'has@example.com': { describe: 'ok', export: 'ok' },
			'no@example.com': { describe: 'missing' },
		},
	});
	check('exit code 0 (skip is not a failure)', r.code === 0, `got ${r.code}`);
	check('1 success, 1 skipped', r.summary.success === 1 && r.summary.skipped === 1);
	const skipped = r.summary.orgs.find((o) => o.username === 'no@example.com');
	check('status SKIPPED_APP_NOT_INSTALLED', skipped.status === 'SKIPPED_APP_NOT_INSTALLED', skipped.status);
	check('appCheck recorded as ABSENT', skipped.appCheck === 'ABSENT');
}

// --- Scenario 5: expired scratch org ---------------------------------------
{
	const r = runScenario('S5  expired scratch orgs -> never exported', {
		orgs: [
			scratchOrg({ username: 'exp1@example.com', alias: 'expired-flag', orgId: '00D000000000020AAA', isExpired: true }),
			scratchOrg({ username: 'exp2@example.com', alias: 'expired-date', orgId: '00D000000000021AAA', expirationDate: '2020-01-01' }),
			scratchOrg({ username: 'exp3@example.com', alias: 'deleted', orgId: '00D000000000022AAA', status: 'Deleted' }),
			scratchOrg({ username: 'good@example.com', alias: 'live', orgId: '00D000000000023AAA' }),
		],
		orgFixtures: { 'good@example.com': { describe: 'ok', export: 'ok' } },
	});
	check('exit code 0', r.code === 0, `got ${r.code}`);
	check('3 skipped as expired', r.summary.orgs.filter((o) => o.status === 'SKIPPED_EXPIRED').length === 3);
	check('1 exported', r.summary.success === 1);
	check('expired orgs were never probed', !/exp1@example.com/.test(r.calls));
}

// --- Scenario 6: one org fails ---------------------------------------------
{
	const r = runScenario('S6  one export fails -> others continue, exit code 1', {
		orgs: [
			scratchOrg({ username: 'a@example.com', alias: 'org-a', orgId: '00D000000000031AAA' }),
			scratchOrg({ username: 'b@example.com', alias: 'org-b', orgId: '00D000000000032AAA' }),
			scratchOrg({ username: 'c@example.com', alias: 'org-c', orgId: '00D000000000033AAA' }),
			scratchOrg({ username: 'd@example.com', alias: 'org-d', orgId: '00D000000000034AAA' }),
		],
		orgFixtures: {
			'a@example.com': { describe: 'ok', export: 'ok' },
			'b@example.com': { describe: 'ok', export: 'fail' },
			'c@example.com': { describe: 'ok', export: 'ok' },
			'd@example.com': { describe: 'ok', export: 'ok' },
		},
	});
	check('exit code 1', r.code === 1, `got ${r.code}`);
	check('3 successes, 1 failure', r.summary.success === 3 && r.summary.failed === 1);
	check('org-b is the failure', r.summary.orgs.find((o) => o.alias === 'org-b').status === 'FAILED');
	check('orgs after the failure still ran', r.summary.orgs.find((o) => o.alias === 'org-d').status === 'SUCCESS');
	check('child exit code 4 recorded', r.summary.orgs.find((o) => o.alias === 'org-b').exitCode === 4);
	check('deterministic failure was NOT retried', r.summary.orgs.find((o) => o.alias === 'org-b').attempts.length === 1);
}

// --- Scenario 6b: transient failure IS retried -----------------------------
{
	const r = runScenario('S6b transient failure -> retried, then reported', {
		orgs: [scratchOrg({ username: 't@example.com', alias: 'flaky', orgId: '00D000000000040AAA' })],
		orgFixtures: { 't@example.com': { describe: 'ok', export: 'transient' } },
		config: { maxRetries: 1, retryBackoffSeconds: [0] },
	});
	check('exit code 1', r.code === 1, `got ${r.code}`);
	check('child exit code 6 (TRANSIENT)', r.summary.orgs[0].exitCode === 6, String(r.summary.orgs[0].exitCode));
	check('two attempts were made', r.summary.orgs[0].attempts.length === 2, String(r.summary.orgs[0].attempts.length));
}

// --- Scenario 7: sf missing -------------------------------------------------
{
	const r = runScenario('S7  sf CLI missing -> preflight failure, exit 2, no orgs touched', {
		orgs: [scratchOrg()],
		config: { sfCliEntry: '/nonexistent/path/to/sf-run.js' },
	});
	check('exit code 2', r.code === 2, `got ${r.code}`);
	check('discovered 0 (never got that far)', r.summary && r.summary.discovered === 0);
	check('problem is reported', /sfCliEntry does not exist/i.test(r.stderr + r.stdout + r.logText));
}

// --- Scenario 9: paths containing spaces -----------------------------------
{
	const r = runScenario('S9  output path containing spaces (and an apostrophe) -> works', {
		rootName: "My Exports (test) — O'Brien",
		orgs: [scratchOrg({ alias: 'space test org' })],
		orgFixtures: { 'test@example.com': { describe: 'ok', export: 'ok' } },
		config: { connectorFilter: ["O'Brien Sync", 'Normal, Name'] },
	});
	check('exit code 0', r.code === 0, `got ${r.code}\n${r.stderr.slice(0, 800)}`);
	check('exported despite spaces in path', r.summary && r.summary.success === 1);
	const dir = r.summary && r.summary.orgs[0].exportDir;
	check('directory name sanitised', dir && path.basename(dir) === 'space-test-org_00D5g000004ABCDEAO', dir && path.basename(dir));
	check('files landed in the spaced path', dir && fs.existsSync(path.join(dir, 'cja_cj__CJ_Connector__cs.json')));
	const manifestPath = dir && path.join(dir, '_export-summary.json');
	const manifest = manifestPath && fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
	check("apostrophe escaped in SOQL", !!manifest && /Name IN \('O\\'Brien Sync', 'Normal, Name'\)/.test(manifest.queries[0].soql), manifest && manifest.queries[0].soql);
	check('connector filter warning emitted', /connector filter was supplied/i.test(r.logText));
}

// --- Scenario 10: overlapping run -------------------------------------------
{
	const r = runScenario('S10 previous run still active -> second instance exits safely (3)', {
		orgs: [scratchOrg()],
		orgFixtures: { 'test@example.com': { describe: 'ok', export: 'ok' } },
		preRun: ({ work }) => {
			fs.mkdirSync(path.join(work, 'logs'), { recursive: true });
			fs.writeFileSync(
				path.join(work, 'logs', '.lock'),
				JSON.stringify({ runId: 'PREVIOUS', pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })
			);
		},
	});
	check('exit code 3', r.code === 3, `got ${r.code}`);
	check('reports the active run', /Another export run is active/i.test(r.logText + r.stderr));
	check('no export happened', !/data.export.tree/.test(r.calls));
}

// --- Scenario 10b: stale lock is reclaimed ----------------------------------
{
	const r = runScenario('S10b stale lock from a crashed run -> reclaimed with a warning', {
		orgs: [scratchOrg()],
		orgFixtures: { 'test@example.com': { describe: 'ok', export: 'ok' } },
		preRun: ({ work }) => {
			fs.mkdirSync(path.join(work, 'logs'), { recursive: true });
			fs.writeFileSync(
				path.join(work, 'logs', '.lock'),
				JSON.stringify({ runId: 'CRASHED', pid: 999999, hostname: os.hostname(), startedAt: new Date().toISOString() })
			);
		},
	});
	check('exit code 0', r.code === 0, `got ${r.code}`);
	check('warned about the stale lock', /Reclaiming a stale lock/i.test(r.logText));
	check('export proceeded', r.summary && r.summary.success === 1);
}

// --- Scenario 12: dead session ----------------------------------------------
{
	const r = runScenario('S12 stored auth no longer usable -> skipped, no browser, others continue', {
		orgs: [
			scratchOrg({ username: 'dead@example.com', alias: 'dead-session', orgId: '00D000000000050AAA' }),
			scratchOrg({ username: 'alive@example.com', alias: 'alive', orgId: '00D000000000051AAA' }),
		],
		orgFixtures: {
			'dead@example.com': { describe: 'auth' },
			'alive@example.com': { describe: 'ok', export: 'ok' },
		},
	});
	check('exit code 0 (unreachable is a skip, not a failure)', r.code === 0, `got ${r.code}`);
	check('status SKIPPED_UNREACHABLE', r.summary.orgs.find((o) => o.alias === 'dead-session').status === 'SKIPPED_UNREACHABLE');
	check('no browser login attempted', !/BROWSER_LOGIN_ATTEMPTED/.test(r.calls));
	check('the healthy org still exported', r.summary.success === 1);
}

// --- Dry run ------------------------------------------------------------------
{
	const r = runScenario('DR  --dry-run -> classifies and prints, exports nothing', {
		orgs: [
			scratchOrg({ username: 'a@example.com', alias: 'org-a', orgId: '00D000000000060AAA' }),
			scratchOrg({ username: 'x@example.com', alias: 'no-app', orgId: '00D000000000061AAA' }),
		],
		orgFixtures: { 'a@example.com': { describe: 'ok' }, 'x@example.com': { describe: 'missing' } },
		args: ['--dry-run'],
	});
	check('exit code 0', r.code === 0, `got ${r.code}`);
	check('status DRY_RUN for the eligible org', r.summary.orgs.find((o) => o.alias === 'org-a').status === 'DRY_RUN');
	check('eligibility still evaluated', r.summary.orgs.find((o) => o.alias === 'no-app').status === 'SKIPPED_APP_NOT_INSTALLED');
	check('proposed command shown', /DRY RUN -- would export into/.test(r.logText));
	check('nothing was exported', !/data.export.tree/.test(r.calls));
	check('no export directories created', !fs.existsSync(path.join(r.work, 'exports')) || fs.readdirSync(path.join(r.work, 'exports')).length === 0);
}

// --- Non-scratch orgs are never touched ---------------------------------------
{
	process.stdout.write('\n  S0  production / sandbox / dev hub orgs are never processed\n');
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfexp-'));
	const fixturePath = path.join(base, 'fixture.json');
	fs.writeFileSync(
		fixturePath,
		JSON.stringify({
			orgList: {
				status: 0,
				result: {
					nonScratchOrgs: [
						{ username: 'prod@corp.com', alias: 'production', isScratch: false, connectedStatus: 'Connected' },
						{ username: 'devhub@corp.com', alias: 'devhub', isScratch: false, isDevHub: true },
					],
					sandboxes: [{ username: 'uat@corp.com.uat', alias: 'uat', isScratch: false, isSandbox: true }],
					scratchOrgs: [scratchOrg({ username: 'sc@example.com', alias: 'scratchy', orgId: '00D000000000070AAA' })],
					other: [{ username: 'random@corp.com', alias: 'random' }],
				},
			},
			orgs: { 'sc@example.com': { describe: 'ok', export: 'ok' } },
		})
	);
	const work = path.join(base, 'work');
	const cfgPath = path.join(base, 'config.json');
	fs.writeFileSync(
		cfgPath,
		JSON.stringify({
			exportRoot: path.join(work, 'exports'),
			layout: 'per-run',
			orgFolderPattern: '{alias}_{orgId}',
			logRoot: path.join(work, 'logs'),
			lockFile: path.join(work, 'logs', '.lock'),
			exportScript: path.join(ROOT, 'export-script.js'),
			cleanScript: MOCK_CLEAN,
			sfCliEntry: MOCK_SF,
			logRetentionDays: 0,
			exportRetentionDays: 0,
		})
	);
	const callLog = path.join(base, 'calls.log');
	const res = spawnSync(process.execPath, [path.join(ROOT, 'orchestrator.js'), '--config', cfgPath], {
		cwd: os.tmpdir(),
		encoding: 'utf8',
		env: { ...process.env, MOCK_SF_FIXTURE: fixturePath, MOCK_SF_CALLLOG: callLog },
	});
	const summary = JSON.parse(fs.readFileSync(path.join(work, 'logs', 'latest.json'), 'utf8'));
	const calls = fs.readFileSync(callLog, 'utf8');
	check('exit code 0', res.status === 0, `got ${res.status}`);
	check('only the scratch org was discovered', summary.discovered === 1, `discovered ${summary.discovered}`);
	check('production org never contacted', !/prod@corp\.com/.test(calls));
	check('sandbox never contacted', !/uat@corp\.com/.test(calls));
	check('dev hub never contacted', !/devhub@corp\.com/.test(calls));
	check('unclassified org never contacted', !/random@corp\.com/.test(calls));
}

// --- Child-level argument validation (Scenario 11) ----------------------------
{
	process.stdout.write('\n  S11 child called without --user -> exit 2, no browser login\n');
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfexp-'));
	const fixturePath = path.join(base, 'fixture.json');
	fs.writeFileSync(fixturePath, JSON.stringify({ orgList: { status: 0, result: {} }, orgs: {} }));
	const callLog = path.join(base, 'calls.log');
	const res = spawnSync(
		process.execPath,
		[path.join(ROOT, 'export-script.js'), '--dir', path.join(base, 'out'), '--type', 'Scratch', '--sf-cli-entry', MOCK_SF],
		{ encoding: 'utf8', env: { ...process.env, MOCK_SF_FIXTURE: fixturePath, MOCK_SF_CALLLOG: callLog } }
	);
	check('exit code 2 (INVALID_ARGUMENTS)', res.status === 2, `got ${res.status}`);
	check('message names the problem', /No --user was supplied/.test(res.stderr), res.stderr.slice(0, 200));
	check('no sf command was run at all', !fs.existsSync(callLog));

	process.stdout.write('\n  S11b child: --interactive is refused for a scratch org\n');
	const res2 = spawnSync(
		process.execPath,
		[path.join(ROOT, 'export-script.js'), '--user', 'a@b.com', '--dir', path.join(base, 'out'), '--type', 'Scratch', '--interactive', '--sf-cli-entry', MOCK_SF],
		{ encoding: 'utf8', env: { ...process.env, MOCK_SF_FIXTURE: fixturePath } }
	);
	check('exit code 2', res2.status === 2, `got ${res2.status}`);
	check('explains why', /not supported for scratch orgs/.test(res2.stderr));

	process.stdout.write('\n  S11c child: --limit above 200 is refused\n');
	const res3 = spawnSync(
		process.execPath,
		[path.join(ROOT, 'export-script.js'), '--user', 'a@b.com', '--dir', path.join(base, 'out'), '--limit', '500', '--sf-cli-entry', MOCK_SF],
		{ encoding: 'utf8', env: { ...process.env, MOCK_SF_FIXTURE: fixturePath } }
	);
	check('exit code 2', res3.status === 2, `got ${res3.status}`);
	check('cites the FIELDS(ALL) rule', /LIMIT <= 200 on FIELDS\(ALL\)/.test(res3.stderr));
}

// --- Truncation detection ------------------------------------------------------
{
	const r = runScenario('TR  a query returning exactly the limit -> truncation warning', {
		orgs: [scratchOrg({ username: 'big@example.com', alias: 'big-org', orgId: '00D000000000080AAA' })],
		orgFixtures: { 'big@example.com': { describe: 'ok', export: 'ok', records: { cja_cj__JSON_Object_Mapping__c: 200 } } },
	});
	check('export still succeeds', r.code === 0, `got ${r.code}`);
	check('truncation warning surfaced in the log', /Possible truncation/.test(r.logText), r.logText.slice(-400));
	const dir = r.summary.orgs[0].exportDir;
	const manifest = JSON.parse(fs.readFileSync(path.join(dir, '_export-summary.json'), 'utf8'));
	check('truncation recorded in the manifest', manifest.truncationWarnings.length >= 1);
}

// --- Metadata retrieve -----------------------------------------------------------
// The governing rule for this whole block: metadata is a SEPARATE deliverable
// from data. It must never be able to discard a data export that succeeded,
// and its own failures must never be silent.
{
	const mdFixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'sfexp-md-'));
	const manifest = path.join(mdFixtures, 'package.xml');
	fs.writeFileSync(
		manifest,
		'<?xml version="1.0" encoding="UTF-8"?>\n' +
			'<Package xmlns="http://soap.sforce.com/2006/04/metadata">' +
			'<types><members>*</members><name>ApexClass</name></types>' +
			'<version>63.0</version></Package>\n'
	);
	const mdConfig = (over = {}) => ({
		metadata: Object.assign(
			{
				enabled: true,
				manifest,
				projectDir: path.join(mdFixtures, 'project'),
				outputSubdir: 'metadata',
				namespace: 'cja_cj',
				failureIsFatal: false,
				timeoutSeconds: 60,
			},
			over
		),
	});

	// MD1 -- the happy path.
	{
		const r = runScenario('MD1 metadata enabled -> retrieved alongside the data', {
			orgs: [scratchOrg()],
			orgFixtures: { 'test@example.com': { describe: 'ok', export: 'ok', metadata: 'ok' } },
			config: mdConfig(),
		});
		check('exit code 0', r.code === 0, `got ${r.code}\n${r.stderr.slice(-600)}`);
		const dir = r.summary && r.summary.orgs[0].exportDir;
		check('data still exported', dir && fs.existsSync(path.join(dir, 'cja_cj__CJ_Connector__cs.json')));
		check('metadata folder created', dir && fs.existsSync(path.join(dir, 'metadata')));
		check('retrieved files present', dir && fs.existsSync(path.join(dir, 'metadata', 'classes', 'CJThing.cls')));
		check('metadata summary written', dir && fs.existsSync(path.join(dir, 'metadata', '_metadata-summary.json')));
		// The mock refuses to run without an sfdx-project.json in its cwd, so
		// reaching this point at all proves the scaffold was created.
		check('SFDX project scaffold created', fs.existsSync(path.join(mdFixtures, 'project', 'sfdx-project.json')));
		const scaffold = JSON.parse(fs.readFileSync(path.join(mdFixtures, 'project', 'sfdx-project.json'), 'utf8'));
		check('scaffold carries the namespace', scaffold.namespace === 'cja_cj', scaffold.namespace);
		check('scaffold takes the API version from the manifest', scaffold.sourceApiVersion === '63.0', scaffold.sourceApiVersion);
		check('retrieve ran with --json, not the wall of table output', /"--json"/.test(r.calls));
		const md = r.summary.orgs[0].metadata;
		check('metadata status OK in the run summary', md && md.status === 'OK', md && md.status);
		check('component count recorded', md && md.componentCount === 2, md && String(md.componentCount));
		// Counted before _metadata-summary.json is written, so the number is
		// what was retrieved rather than what is in the folder afterwards.
		check('file count recorded', md && md.fileCount === 3, md && String(md.fileCount));
	}

	// MD2 -- a manifest entry that does not exist in the org. The retrieve
	// SUCCEEDS, so this is the case most likely to go unnoticed.
	{
		const r = runScenario('MD2 manifest names a component the org lacks -> warned, not hidden', {
			orgs: [scratchOrg({ username: 'w@example.com', alias: 'warn-org', orgId: '00D000000000091AAA' })],
			orgFixtures: { 'w@example.com': { describe: 'ok', export: 'ok', metadata: 'warn' } },
			config: mdConfig(),
		});
		check('export still succeeds', r.code === 0, `got ${r.code}`);
		const md = r.summary.orgs[0].metadata;
		check('status distinguishes warnings from a clean run', md && md.status === 'OK_WITH_WARNINGS', md && md.status);
		check('the missing component is named in the log', /Missing Layout/.test(r.logText), r.logText.slice(-400));
		check('the log says it is absent from the backup', /NOT in this backup/.test(r.logText));
	}

	// MD3 -- the important one. A metadata failure must leave the data export
	// in place, not throw it away.
	{
		const r = runScenario('MD3 metadata fails, failureIsFatal=false -> data export is kept', {
			orgs: [scratchOrg({ username: 'mf@example.com', alias: 'md-fail', orgId: '00D000000000092AAA' })],
			orgFixtures: { 'mf@example.com': { describe: 'ok', export: 'ok', metadata: 'fail' } },
			config: mdConfig(),
		});
		check('run still exits 0', r.code === 0, `got ${r.code}`);
		check('org counted as a success', r.summary && r.summary.success === 1);
		const dir = r.summary.orgs[0].exportDir;
		check('data export survived and was swapped into place', dir && fs.existsSync(path.join(dir, 'cja_cj__CJ_Connector__cs.json')));
		const md = r.summary.orgs[0].metadata;
		check('metadata failure recorded, not swallowed', md && md.status === 'FAILED', md && md.status);
		check('failure reason recorded', md && /INVALID_TYPE/.test(md.error || ''), md && md.error);
		check('failure is visible in the log', /metadata retrieve did not/i.test(r.logText), r.logText.slice(-400));
	}

	// MD4 -- opting in to the stricter policy.
	{
		const r = runScenario('MD4 metadata fails, failureIsFatal=true -> whole org export fails', {
			orgs: [scratchOrg({ username: 'mr@example.com', alias: 'md-req', orgId: '00D000000000093AAA' })],
			orgFixtures: { 'mr@example.com': { describe: 'ok', export: 'ok', metadata: 'fail' } },
			config: mdConfig({ failureIsFatal: true }),
		});
		check('exit code 1', r.code === 1, `got ${r.code}`);
		check('org counted as a failure', r.summary && r.summary.failed === 1);
		check('status FAILED', r.summary && r.summary.orgs[0].status === 'FAILED');
		const dir = r.summary.orgs[0].exportDir;
		check('the partial export was discarded, not left half-written', !fs.existsSync(dir), dir);
	}

	// MD5 -- setup error. Fail once, before any org is touched, rather than
	// producing the identical failure once per org.
	{
		const r = runScenario('MD5 metadata enabled but manifest missing -> preflight failure', {
			orgs: [scratchOrg()],
			orgFixtures: { 'test@example.com': { describe: 'ok', export: 'ok', metadata: 'ok' } },
			config: mdConfig({ manifest: path.join(mdFixtures, 'nope.xml') }),
		});
		check('exit code 2 (preflight)', r.code === 2, `got ${r.code}`);
		check('names the missing manifest', /manifest was not found/.test(r.stdout + r.stderr + r.logText));
		check('no org was touched', !/data export tree/.test(r.calls.replace(/"/g, '')) && !/retrieve/.test(r.calls));
	}

	// MD6 -- a manifest that is not a manifest. Caught before the run, because
	// a retrieve driven by it succeeds and returns nothing.
	{
		const bogus = path.join(mdFixtures, 'notes.xml');
		fs.writeFileSync(bogus, '<?xml version="1.0"?><notes>hello</notes>');
		const r = runScenario('MD6 manifest is not a package.xml -> preflight failure', {
			orgs: [scratchOrg()],
			orgFixtures: { 'test@example.com': { describe: 'ok', export: 'ok' } },
			config: mdConfig({ manifest: bogus }),
		});
		check('exit code 2 (preflight)', r.code === 2, `got ${r.code}`);
		check('explains why', /does not look like a metadata manifest/.test(r.stdout + r.stderr + r.logText));
	}

	// MD6b -- the real manifest is Prettier-formatted, which wraps long member
	// names as `<members\n  >Name</members\n>`. Valid XML, but it defeats a
	// naive /<members>/ match, so the counts must not depend on one.
	{
		const wrapped = path.join(mdFixtures, 'wrapped.xml');
		fs.writeFileSync(
			wrapped,
			'<?xml version="1.0" encoding="UTF-8"?>\n' +
				'<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
				'\t<types>\n' +
				'\t\t<members>Short__c.Field__c</members>\n' +
				'\t\t<members\n\t\t\t>Object__c.A_Very_Long_Field_Name_That_Got_Wrapped__c</members\n\t\t>\n' +
				'\t\t<name>CustomField</name>\n' +
				'\t</types>\n' +
				'\t<version>63.0</version>\n' +
				'</Package>\n'
		);
		const r = runScenario('MD6b Prettier-wrapped manifest -> accepted and counted correctly', {
			orgs: [scratchOrg({ username: 'pw@example.com', alias: 'wrap-org', orgId: '00D000000000094AAA' })],
			orgFixtures: { 'pw@example.com': { describe: 'ok', export: 'ok', metadata: 'ok' } },
			config: Object.assign(mdConfig({ manifest: wrapped }), { logLevel: 'debug' }),
		});
		check('accepted as a manifest', r.code === 0, `got ${r.code}\n${r.stderr.slice(-400)}`);
		check('both members counted, not just the unwrapped one', /2 member entries/.test(r.logText), r.logText.match(/Metadata manifest:.*/) || '');
		check('the wrapped name is not miscounted as a wildcard', /0 wildcard/.test(r.logText));
	}

	// MD7 -- regression: with metadata off, nothing about the old behaviour
	// changes and no retrieve is ever issued.
	{
		const r = runScenario('MD7 metadata disabled -> no retrieve is issued at all', {
			orgs: [scratchOrg()],
			orgFixtures: { 'test@example.com': { describe: 'ok', export: 'ok' } },
		});
		check('exit code 0', r.code === 0, `got ${r.code}`);
		check('no project retrieve call', !/retrieve/.test(r.calls), r.calls.slice(0, 300));
		check('no metadata folder', !fs.existsSync(path.join(r.summary.orgs[0].exportDir, 'metadata')));
		check('no metadata block in the summary', !r.summary.orgs[0].metadata);
	}

	// MD9 -- relative paths must survive the retrieve's working-directory
	// change. The retrieve runs with cwd set to the SFDX project folder, so a
	// relative --sf-cli-entry or --metadata-manifest that was fine for the data
	// export resolves against the wrong directory by the time metadata runs --
	// and fails only AFTER a successful data export, which is the worst place
	// to find out. Everything is pinned absolute at startup instead.
	{
		process.stdout.write('\n  MD9 relative CLI and manifest paths survive the cwd change\n');
		const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfexp-rel-'));
		const fixture = path.join(base, 'fixture.json');
		fs.writeFileSync(
			fixture,
			JSON.stringify({
				orgList: { status: 0, result: { scratchOrgs: [] } },
				orgs: { 'me@example.com': { describe: 'ok', export: 'ok', metadata: 'ok' } },
			})
		);
		// Both paths given RELATIVE to ROOT, which is also the cwd we launch in.
		const res = spawnSync(
			process.execPath,
			[
				path.join(ROOT, 'export-script.js'),
				'--user', 'me@example.com',
				'--dir', path.join(base, 'out'),
				'--type', 'Scratch',
				'--integration', 'any-to-any',
				'--sf-cli-entry', path.join('test', 'mock-sf.js'),
				'--clean-script', path.join('test', 'mock-clean-json.js'),
				'--metadata-manifest', path.join('config', 'package.xml'),
				'--metadata-project', path.join(base, 'proj'),
			],
			{ cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { MOCK_SF_FIXTURE: fixture }) }
		);
		check('child exits 0', res.status === 0, `got ${res.status}\n${(res.stderr || '').slice(-500)}`);
		const summaryFile = path.join(base, 'out', '_export-summary.json');
		check('summary written', fs.existsSync(summaryFile));
		if (fs.existsSync(summaryFile)) {
			const md = JSON.parse(fs.readFileSync(summaryFile, 'utf8')).metadata;
			check('metadata ran despite the relative paths', md && md.status === 'OK', md && (md.status + ' ' + (md.error || '')));
			check('the manifest path was pinned absolute', md && path.isAbsolute(md.manifest), md && md.manifest);
		}
	}

	// MD8 -- config validation, unit level.
	{
		process.stdout.write('\n  MD8 metadata configuration validation\n');
		const { loadConfig, ConfigError } = require('../lib/config');
		const rejects = (over, pattern) => {
			try {
				loadConfig({ overrides: { metadata: Object.assign({ enabled: true, manifest }, over) }, env: {} });
				return false;
			} catch (e) {
				return e instanceof ConfigError && pattern.test(e.message);
			}
		};
		check('rejects a subdir containing a path separator', rejects({ outputSubdir: 'a/b' }, /single plain folder name/));
		check('rejects a subdir that escapes the export folder', rejects({ outputSubdir: '..' }, /single plain folder name/));
		check('rejects a bad namespace', rejects({ namespace: 'not a namespace' }, /namespace/));
		check('rejects a bad API version', rejects({ apiVersion: '63' }, /apiVersion/));
		check('rejects an empty manifest path', rejects({ manifest: '' }, /metadata.manifest/));
		const ok = loadConfig({ overrides: { metadata: { enabled: true, manifest } }, env: {} });
		check('resolves the manifest to an absolute path', path.isAbsolute(ok.metadata.manifest));
		check('metadata is off by default', loadConfig({ env: {} }).metadata.enabled === false);
		check(
			'SFEXPORT_METADATA can switch it on without editing the config',
			loadConfig({ env: { SFEXPORT_METADATA: 'true', SFEXPORT_METADATA_MANIFEST: manifest } }).metadata.enabled === true
		);
	}
}

// --- Secret redaction ----------------------------------------------------------
{
	process.stdout.write('\n  SEC redaction of tokens and auth URLs\n');
	const { redactText, pickOrgFields } = require('../lib/logger');
	check(
		'sfdxAuthUrl scrubbed',
		redactText('url=force://PlatformCLI::5Aep861ABCDEF@example.my.salesforce.com done') === 'url=<SFDX_AUTH_URL:REDACTED> done'
	);
	check(
		'access token scrubbed',
		!/SUPER_SECRET/.test(redactText('token 00D5g000004ABCDE!SUPER_SECRET_TOKEN_VALUE_1234567890 end'))
	);
	const picked = pickOrgFields(scratchOrg());
	check('org allowlist drops accessToken', picked.accessToken === undefined);
	check('org allowlist keeps username', picked.username === 'test@example.com');
	check('unknown future field is dropped', pickOrgFields({ username: 'a@b.c', futureSecretField: 'nope' }).futureSecretField === undefined);
}

// --- Windows command-line escaping ---------------------------------------------
{
	process.stdout.write('\n  WIN cmd.exe / CommandLineToArgvW escaping\n');
	const { quoteArgvW, escapeForCmd, buildInvocation } = require('../lib/sf-cli');
	check('plain arg is not quoted', quoteArgvW('SELECT') === 'SELECT');
	check('spaces are quoted', quoteArgvW('a b') === '"a b"');
	check('embedded quote is escaped', quoteArgvW('say "hi"') === '"say \\"hi\\""');
	check('no quoting when none is needed', quoteArgvW('C:\\dir\\') === 'C:\\dir\\');
	check('trailing backslash doubled inside quotes', quoteArgvW('C:\\my dir\\') === '"C:\\my dir\\\\"', quoteArgvW('C:\\my dir\\'));
	check('cmd metacharacters are caret-escaped', escapeForCmd('a&b|c') === 'a^&b^|c');
	check('percent expansion is neutralised', escapeForCmd('%PATH%') === '^%PATH^%');
	check(
		'injection attempt is neutralised',
		escapeForCmd('x" & calc.exe & "') === '^"x\\^" ^& calc.exe ^& \\^"^"',
		escapeForCmd('x" & calc.exe & "')
	);
	const inv = buildInvocation('/usr/bin/sf', ['data', 'export']);
	check('non-.cmd targets skip the shell entirely', inv.file === '/usr/bin/sf' && inv.windowsVerbatimArguments === false);
}

// --- SOQL escaping ---------------------------------------------------------------
{
	process.stdout.write('\n  SQL SOQL literal escaping\n');
	const { soqlStringList, escapeSoqlString, parseConnectorList, SoqlError } = require('../lib/soql');
	check("apostrophe escaped", escapeSoqlString("O'Brien") === "O\\'Brien");
	check('backslash escaped first', escapeSoqlString('a\\b') === 'a\\\\b');
	check("injection attempt neutralised", soqlStringList(["x') OR Name != ('"]) === "'x\\') OR Name != (\\''");
	check('empty list rejected', (() => { try { soqlStringList([]); return false; } catch (e) { return e instanceof SoqlError; } })());
	check('list parsing trims and drops blanks', JSON.stringify(parseConnectorList(' a , ,b ')) === '["a","b"]');
	check('control characters rejected', (() => { try { escapeSoqlString('a\u0000b'); return false; } catch (e) { return true; } })());
}

// --- Directory sanitisation -------------------------------------------------------
{
	process.stdout.write('\n  DIR filesystem-safe directory names\n');
	const { sanitizeSegment, orgDirectoryName } = require('../orchestrator');
	check('path separators removed', !/[\\/]/.test(sanitizeSegment('a/b\\c')));
	check('windows reserved name replaced', sanitizeSegment('CON', 'fallback') === 'fallback');
	check('falls back when empty', sanitizeSegment('///', 'fallback') === 'fallback');
	check('length capped', sanitizeSegment('x'.repeat(200)).length <= 60);
	check('default pattern falls back when alias is absent', orgDirectoryName({ username: 'u@e.com', orgId: '00D000000000001AAA' }) === 'cj-export_u', orgDirectoryName({ username: 'u@e.com', orgId: '00D000000000001AAA' }));
	check('orgId used when there is no alias and no username', orgDirectoryName({ orgId: '00D000000000001AAA' }, '{alias}') === '00D000000000001AAA');
}


// --- Per-org layout: stable folders, replaced each run --------------------------
{
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfexp-'));
	const work = path.join(base, 'work');
	const exportRoot = path.join(work, 'connectjunction-exports');
	const perOrgConfig = {
		exportRoot,
		layout: 'per-org',
		orgFolderPattern: 'cj-export_{alias}',
		logRoot: path.join(work, 'logs'),
		lockFile: path.join(work, 'logs', '.lock'),
	};

	const r1 = runScenario('PO1 per-org layout -> one stable folder per org, no run subfolder', {
		orgs: [
			scratchOrg({ username: 'a@example.com', alias: 'my-feature-org', orgId: '00D000000000101AAA' }),
			scratchOrg({ username: 'b@example.com', alias: 'integration-test', orgId: '00D000000000102AAA' }),
			scratchOrg({ username: 'c@example.com', alias: 'dev-org-4', orgId: '00D000000000103AAA' }),
		],
		orgFixtures: {
			'a@example.com': { describe: 'ok', export: 'ok' },
			'b@example.com': { describe: 'ok', export: 'ok' },
			'c@example.com': { describe: 'ok', export: 'ok' },
		},
		config: perOrgConfig,
	});
	check('exit code 0', r1.code === 0, `got ${r1.code}`);
	check('3 successes', r1.summary && r1.summary.success === 3);
	const dirs1 = fs.readdirSync(exportRoot).sort();
	check('exactly 3 folders in the export root', dirs1.length === 3, dirs1.join(', '));
	check('named cj-export_<alias>', dirs1.join(',') === 'cj-export_dev-org-4,cj-export_integration-test,cj-export_my-feature-org', dirs1.join(','));
	check('no timestamped run folder', !dirs1.some((d) => /^\d{8}_\d{6}$/.test(d)));
	check('no leftover temp folders', !dirs1.some((d) => d.startsWith('.tmp_') || d.includes('.old_')));

	// Mark a file so we can prove the second run REPLACED it rather than merged.
	const target = path.join(exportRoot, 'cj-export_my-feature-org');
	fs.writeFileSync(path.join(target, 'stale-leftover.json'), '{"gone":true}');
	const mtimeBefore = fs.statSync(path.join(target, 'cja_cj__CJ_Connector__cs.json')).mtimeMs;

	const r2 = runScenario('PO2 second run -> same folders, content replaced not merged', {
		orgs: [
			scratchOrg({ username: 'a@example.com', alias: 'my-feature-org', orgId: '00D000000000101AAA' }),
			scratchOrg({ username: 'b@example.com', alias: 'integration-test', orgId: '00D000000000102AAA' }),
			scratchOrg({ username: 'c@example.com', alias: 'dev-org-4', orgId: '00D000000000103AAA' }),
		],
		orgFixtures: {
			'a@example.com': { describe: 'ok', export: 'ok', records: { cja_cj__CJ_Connector__c: 7 } },
			'b@example.com': { describe: 'ok', export: 'ok' },
			'c@example.com': { describe: 'ok', export: 'ok' },
		},
		config: perOrgConfig,
	});
	check('exit code 0', r2.code === 0, `got ${r2.code}`);
	const dirs2 = fs.readdirSync(exportRoot).sort();
	check('still exactly 3 folders', dirs2.length === 3, dirs2.join(', '));
	check('stale file from the previous run is gone', !fs.existsSync(path.join(target, 'stale-leftover.json')));
	const reexported = JSON.parse(fs.readFileSync(path.join(target, 'cja_cj__CJ_Connector__cs.json'), 'utf8'));
	check('content is the new export', reexported.records.length === 7, String(reexported.records.length));

	// A failing run must leave the good copy exactly as it was.
	const r3 = runScenario('PO3 failed run -> existing folder left untouched', {
		orgs: [scratchOrg({ username: 'a@example.com', alias: 'my-feature-org', orgId: '00D000000000101AAA' })],
		orgFixtures: { 'a@example.com': { describe: 'ok', export: 'fail' } },
		config: perOrgConfig,
	});
	check('exit code 1', r3.code === 1, `got ${r3.code}`);
	const survived = JSON.parse(fs.readFileSync(path.join(target, 'cja_cj__CJ_Connector__cs.json'), 'utf8'));
	check('previous good export survived the failure', survived.records.length === 7, String(survived.records.length));
	const dirs3 = fs.readdirSync(exportRoot).sort();
	check('no temp folder left behind by the failure', !dirs3.some((d) => d.startsWith('.tmp_')), dirs3.join(', '));
	check('still exactly 3 folders', dirs3.length === 3, dirs3.join(', '));
}

// --- Retention must never eat the per-org folders --------------------------------
{
	process.stdout.write('\n  PO4 exportRetentionDays does not prune per-org folders\n');
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfexp-'));
	const work = path.join(base, 'work');
	const exportRoot = path.join(work, 'connectjunction-exports');
	const cfg = {
		exportRoot,
		layout: 'per-org',
		orgFolderPattern: 'cj-export_{alias}',
		logRoot: path.join(work, 'logs'),
		lockFile: path.join(work, 'logs', '.lock'),
		exportRetentionDays: 1,
	};
	const r = runScenario('    seeding a folder, then ageing it past retention', {
		orgs: [scratchOrg({ username: 'a@example.com', alias: 'old-org', orgId: '00D000000000201AAA' })],
		orgFixtures: { 'a@example.com': { describe: 'ok', export: 'ok' } },
		config: cfg,
	});
	check('first run succeeded', r.code === 0, `got ${r.code}`);
	// Backdate the folder well past the retention window.
	const old = path.join(exportRoot, 'cj-export_old-org');
	const past = Date.now() - 30 * 86400000;
	fs.utimesSync(old, past / 1000, past / 1000);

	const r2 = runScenario('    run again with a different org discovered', {
		orgs: [scratchOrg({ username: 'z@example.com', alias: 'new-org', orgId: '00D000000000202AAA' })],
		orgFixtures: { 'z@example.com': { describe: 'ok', export: 'ok' } },
		config: cfg,
	});
	check('second run succeeded', r2.code === 0, `got ${r2.code}`);
	check('the aged folder was NOT pruned', fs.existsSync(old));
	check('both org folders present', fs.readdirSync(exportRoot).sort().join(',') === 'cj-export_new-org,cj-export_old-org', fs.readdirSync(exportRoot).join(','));
}

// --- Folder naming patterns --------------------------------------------------------
{
	process.stdout.write('\n  PO5 orgFolderPattern token substitution\n');
	const { orgDirectoryName } = require('../orchestrator');
	const org = { alias: 'my-feature-org', username: 'test-abc@example.com', orgId: '00D5g000004ABCDEAO' };
	check('default pattern', orgDirectoryName(org, 'cj-export_{alias}') === 'cj-export_my-feature-org');
	check('alias + orgId', orgDirectoryName(org, '{alias}_{orgId}') === 'my-feature-org_00D5g000004ABCDEAO');
	check('orgId only', orgDirectoryName(org, '{orgId}') === '00D5g000004ABCDEAO');
	check('usernamePrefix', orgDirectoryName(org, 'cj_{usernamePrefix}') === 'cj_test-abc');
	check('alias falls back to username prefix', orgDirectoryName({ username: 'solo@example.com', orgId: '00D000000000001AAA' }, 'cj-export_{alias}') === 'cj-export_solo');
	check('unsafe alias sanitised', orgDirectoryName({ alias: 'a/b\\c:d', username: 'u@e.com', orgId: '00D000000000001AAA' }, 'cj-export_{alias}') === 'cj-export_a-b-c-d', orgDirectoryName({ alias: 'a/b\\c:d', username: 'u@e.com', orgId: '00D000000000001AAA' }, 'cj-export_{alias}'));
}

// --- Config validation rejects a pattern that would collide ------------------------
{
	process.stdout.write('\n  PO6 config rejects an orgFolderPattern with no org token\n');
	const { loadConfig, ConfigError } = require('../lib/config');
	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfexp-'));
	const cfgPath = path.join(base, 'bad.json');
	fs.writeFileSync(cfgPath, JSON.stringify({ orgFolderPattern: 'cj-export' }));
	let threw = null;
	try { loadConfig({ configPath: cfgPath, env: {} }); } catch (e) { threw = e; }
	check('rejected', threw instanceof ConfigError, threw && threw.message);
	check('explains why', threw && /every org would share one folder/.test(threw.message));

	fs.writeFileSync(cfgPath, JSON.stringify({ orgFolderPattern: 'sub\\dir_{alias}' }));
	let threw2 = null;
	try { loadConfig({ configPath: cfgPath, env: {} }); } catch (e) { threw2 = e; }
	check('path separator rejected', threw2 instanceof ConfigError, threw2 && threw2.message);
}


// --- Scratch orgs the CLI never flagged --------------------------------------------
{
	process.stdout.write('\n  URL identifying a scratch org by its instance URL\n');
	const { scratchOrgBasis } = require('../orchestrator');
	const scratchUrl = 'https://platform-agility-854-dev-ed.scratch.my.salesforce.com';

	check('isScratch flag wins when present', scratchOrgBasis({ isScratch: true }, 'other') === 'isScratch flag');
	check('scratchOrgs bucket counts', scratchOrgBasis({}, 'scratchOrgs') === 'scratchOrgs bucket');
	check(
		'unflagged org on a scratch domain is recognised',
		scratchOrgBasis({ instanceUrl: scratchUrl }, 'nonScratchOrgs') === 'scratch instance URL',
		scratchOrgBasis({ instanceUrl: scratchUrl }, 'nonScratchOrgs')
	);

	// The whole point of the URL check is that it cannot catch anything unsafe.
	check('production is never matched', scratchOrgBasis({ instanceUrl: 'https://cloudjunction.my.salesforce.com' }, 'nonScratchOrgs') === null);
	check('a sandbox domain is never matched', scratchOrgBasis({ instanceUrl: 'https://acme--uat.sandbox.my.salesforce.com' }, 'other') === null);
	check('a dev edition domain is never matched', scratchOrgBasis({ instanceUrl: 'https://acme.develop.my.salesforce.com' }, 'other') === null);
	check('an explicit sandbox is refused even on a scratch URL', scratchOrgBasis({ isSandbox: true, instanceUrl: scratchUrl }, 'other') === null);
	check('an explicit Dev Hub is refused even on a scratch URL', scratchOrgBasis({ isDevHub: true, instanceUrl: scratchUrl }, 'other') === null);
	check('a lookalike hostname is not matched', scratchOrgBasis({ instanceUrl: 'https://scratch.my.salesforce.com.evil.example' }, 'other') === null);
	check('missing instanceUrl is safe', scratchOrgBasis({}, 'other') === null);
	check('garbage instanceUrl is safe', scratchOrgBasis({ instanceUrl: 'not a url' }, 'other') === null);
}

// --- Discovery picks up an unflagged scratch org end to end -------------------------
{
	const r = runScenario('URL2 org with no isScratch flag but a scratch URL -> discovered and exported', {
		orgs: [scratchOrg({ username: 'flagged@example.com', alias: 'flagged', orgId: '00D000000000401AAA' })],
		orgFixtures: {
			'flagged@example.com': { describe: 'ok', export: 'ok' },
			'unflagged@example.com': { describe: 'ok', export: 'ok' },
		},
		extraBuckets: {
			nonScratchOrgs: [
				{
					username: 'unflagged@example.com',
					alias: 'logged-in-by-hand',
					orgId: '00D000000000402AAA',
					instanceUrl: 'https://nosoftware-ruby-8756-dev-ed.scratch.my.salesforce.com',
				},
				{
					username: 'prod@corp.com',
					alias: 'production',
					orgId: '00D000000000403AAA',
					instanceUrl: 'https://cloudjunction.my.salesforce.com',
				},
			],
		},
	});
	check('exit code 0', r.code === 0, `got ${r.code}`);
	check('both scratch orgs discovered', r.summary && r.summary.discovered === 2, r.summary && String(r.summary.discovered));
	check('the unflagged org was exported', r.summary.orgs.some((o) => o.alias === 'logged-in-by-hand' && o.status === 'SUCCESS'));
	check('production was NOT discovered', !r.summary.orgs.some((o) => o.alias === 'production'));
	check('production was never contacted', !/prod@corp\.com/.test(r.calls));
	check('log explains the URL-based identification', /identified as scratch by their instance URL/.test(r.logText));
}

// --- A deleted scratch org is reported as gone, not as an unknown error ------------
{
	const r = runScenario('DEAD deleted/expired org returns HTTP 420 -> named clearly, others continue', {
		orgs: [
			scratchOrg({ username: 'gone@example.com', alias: 'deleted-org', orgId: '00D000000000301AAA' }),
			scratchOrg({ username: 'live@example.com', alias: 'live-org', orgId: '00D000000000302AAA' }),
		],
		orgFixtures: {
			'gone@example.com': { describe: 'dead' },
			'live@example.com': { describe: 'ok', export: 'ok' },
		},
	});
	check('exit code 0 (a dead org is a skip, not a failure)', r.code === 0, `got ${r.code}`);
	const dead = r.summary.orgs.find((o) => o.alias === 'deleted-org');
	check('status SKIPPED_UNREACHABLE', dead.status === 'SKIPPED_UNREACHABLE', dead.status);
	check('reason says the org is gone', /deleted or expired/.test(dead.reason), dead.reason);
	check('reason suggests the cleanup command', /sf org list --clean/.test(dead.reason));
	check('not reported as an unrecognised error', !/unrecognised/.test(dead.reason));
	check('the CLI update nag is stripped', !/update available from/.test(dead.reason));
	check('the healthy org still exported', r.summary.success === 1);
}

// --- Windows executable resolution -------------------------------------------------
{
	process.stdout.write('\n  EXE resolving the sf CLI on Windows (npm ships three shims)\n');
	const { pickWindowsExecutable } = require('../lib/sf-cli');
	const none = () => false;
	const npmDir = 'C:\\Users\\Cloud Junction\\AppData\\Roaming\\npm\\';

	// The exact failure seen in the field: `where sf` lists the extensionless
	// bash shim first, which CreateProcess cannot execute (ENOENT).
	check(
		'prefers .cmd over the extensionless npm shim',
		pickWindowsExecutable([npmDir + 'sf', npmDir + 'sf.cmd', npmDir + 'sf.ps1'], none) === npmDir + 'sf.cmd',
		pickWindowsExecutable([npmDir + 'sf', npmDir + 'sf.cmd', npmDir + 'sf.ps1'], none)
	);
	check(
		'prefers a real .exe over everything',
		pickWindowsExecutable(['C:\\sf\\bin\\sf.cmd', 'C:\\sf\\bin\\sf.exe'], none) === 'C:\\sf\\bin\\sf.exe'
	);
	check(
		'never returns a .ps1',
		!/\.ps1$/i.test(pickWindowsExecutable([npmDir + 'sf.ps1', npmDir + 'sf.cmd'], none) || '')
	);
	// Only the unrunnable shim came back -- find the sibling npm installed.
	check(
		'falls back to a sibling .cmd on disk',
		pickWindowsExecutable([npmDir + 'sf'], (p) => p === npmDir + 'sf.cmd') === npmDir + 'sf.cmd'
	);
	check(
		'returns null when nothing is runnable',
		pickWindowsExecutable([npmDir + 'sf'], none) === null
	);
	check('empty input is null', pickWindowsExecutable([], none) === null);

	// A path with a space must keep REAL grouping quotes around the command
	// name, or cmd.exe splits it and reports '"C:\\Users\\Cloud' is not recognized.
	const { buildInvocation, quoteCommandForCmd, findCliEntryNear } = require('../lib/sf-cli');
	check(
		'command name keeps real quotes, not carets',
		quoteCommandForCmd('C:\\Users\\Cloud Junction\\npm\\sf.cmd') === '"C:\\Users\\Cloud Junction\\npm\\sf.cmd"'
	);
	check(
		'refuses a path that cannot be quoted safely',
		(() => { try { quoteCommandForCmd('C:\\a%PATH%\\sf.cmd'); return false; } catch (e) { return /sfCliEntry/.test(e.message); } })()
	);
	check(
		'non-shim targets still bypass the shell entirely',
		buildInvocation('/usr/local/bin/sf', ['org', 'list']).windowsVerbatimArguments === false
	);

	// Auto-discovery of the CLI's JS entry point removes cmd.exe from the path.
	// findCliEntryNear uses the platform's own path module, so the separators in
	// its output differ between Windows and POSIX. Normalise both sides rather
	// than asserting on one platform's spelling.
	const norm = (p) => String(p || '').replace(/\\/g, '/');
	const npmPrefix = '/c/Users/Cloud Junction/AppData/Roaming/npm';
	const npmEntry = npmPrefix + '/node_modules/@salesforce/cli/bin/run.js';
	check(
		'finds run.js beside an npm-installed shim',
		norm(findCliEntryNear(npmPrefix + '/sf.cmd', (p) => norm(p) === npmEntry)) === npmEntry,
		norm(findCliEntryNear(npmPrefix + '/sf.cmd', (p) => norm(p) === npmEntry))
	);
	const posixEntry = '/usr/local/lib/node_modules/@salesforce/cli/bin/run.js';
	check(
		'finds run.js under a POSIX npm prefix',
		norm(findCliEntryNear('/usr/local/bin/sf', (p) => norm(p) === posixEntry)) === posixEntry,
		norm(findCliEntryNear('/usr/local/bin/sf', (p) => norm(p) === posixEntry))
	);
	check('handles a path containing spaces', findCliEntryNear(npmPrefix + '/sf.cmd', none) === null);
	check('returns null when no entry point is near', findCliEntryNear('/somewhere/sf.cmd', none) === null);
}

// ===========================================================================
process.stdout.write(`\n${'='.repeat(56)}\n`);
process.stdout.write(`  ${pass} passed, ${fail} failed\n`);
if (fail) {
	process.stdout.write('\nFailures:\n');
	for (const f of failures) process.stdout.write(`  - ${f}\n`);
}
process.stdout.write(`${'='.repeat(56)}\n`);
process.exit(fail === 0 ? 0 : 1);
