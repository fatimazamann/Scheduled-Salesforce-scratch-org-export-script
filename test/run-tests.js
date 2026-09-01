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
function runScenario(name, { orgs = [], orgFixtures = {}, config = {}, args = [], rootName = null, env = {}, preRun = null }) {
	process.stdout.write(`\n  ${name}\n`);

	const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sfexp-'));
	const work = path.join(base, rootName || 'work');
	fs.mkdirSync(work, { recursive: true });

	const fixturePath = path.join(base, 'fixture.json');
	fs.writeFileSync(
		fixturePath,
		JSON.stringify({
			version: '@salesforce/cli/2.99.0 mock node-v22',
			orgList: { status: 0, result: { scratchOrgs: orgs, nonScratchOrgs: [], sandboxes: [], devHubs: [], other: [] } },
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
	// NOTE: findCliEntryNear uses the platform's own path module, so these cases
	// use POSIX paths -- on Windows the same logic runs against Windows paths.
	const npmWin = '/c/Users/Cloud Junction/AppData/Roaming/npm';
	check(
		'finds run.js beside an npm-installed shim',
		findCliEntryNear(npmWin + '/sf.cmd', (p) => p === npmWin + '/node_modules/@salesforce/cli/bin/run.js') ===
			npmWin + '/node_modules/@salesforce/cli/bin/run.js'
	);
	check(
		'finds run.js under a POSIX npm prefix',
		findCliEntryNear('/usr/local/bin/sf', (p) => p === '/usr/local/lib/node_modules/@salesforce/cli/bin/run.js') ===
			'/usr/local/lib/node_modules/@salesforce/cli/bin/run.js'
	);
	check('handles a path containing spaces', findCliEntryNear(npmWin + '/sf.cmd', none) === null);
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
