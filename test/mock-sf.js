#!/usr/bin/env node
'use strict';
/**
 * A stand-in for the Salesforce CLI, driven by a JSON fixture. Used by
 * test/run-tests.js so the whole orchestration path can be exercised without a
 * real org. Not part of the shipped tool.
 *
 * Fixture: MOCK_SF_FIXTURE=/path/to/fixture.json
 */
const fs = require('fs');
const path = require('path');

const fixture = JSON.parse(fs.readFileSync(process.env.MOCK_SF_FIXTURE, 'utf8'));
const argv = process.argv.slice(2);

const flag = (name) => {
	const i = argv.indexOf(name);
	return i === -1 ? null : argv[i + 1];
};
const allFlags = (name) => argv.reduce((acc, a, i) => (a === name ? acc.concat(argv[i + 1]) : acc), []);
const has = (name) => argv.includes(name);

const emit = (obj, code = 0) => {
	process.stdout.write(JSON.stringify(obj));
	process.exit(code);
};

// Record every invocation so tests can assert on what was (and was not) called.
if (process.env.MOCK_SF_CALLLOG) {
	fs.appendFileSync(process.env.MOCK_SF_CALLLOG, JSON.stringify(argv) + '\n');
}

if (has('--version')) {
	process.stdout.write((fixture.version || '@salesforce/cli/2.0.0 mock') + '\n');
	process.exit(0);
}

const cmd = argv.filter((a) => !a.startsWith('-')).slice(0, 3).join(' ');

if (cmd.startsWith('org list')) {
	emit(fixture.orgList);
}

const org = (username) => (fixture.orgs && fixture.orgs[username]) || {};

if (cmd.startsWith('org display')) {
	const o = org(flag('--target-org'));
	if (o.display === 'auth') {
		emit({ status: 1, name: 'NamedOrgNotFoundError', message: 'No authorization information found for this org.' }, 1);
	}
	emit({ status: 0, result: { username: flag('--target-org'), id: '00Dmock' } });
}

if (cmd.startsWith('sobject describe')) {
	const o = org(flag('--target-org'));
	switch (o.describe) {
		case 'missing':
			emit({ status: 1, name: 'INVALID_TYPE', message: `sObject type '${flag('--sobject')}' is not supported.` }, 1);
			break;
		case 'auth':
			emit({ status: 1, name: 'RefreshTokenAuthError', message: 'expired access/refresh token' }, 1);
			break;
		case 'dead':
			// What a deleted/expired scratch org actually returns: an HTML error
			// page instead of JSON, surfaced by the CLI as ERROR_HTTP_420.
			process.stdout.write(' \u00bb   Warning: @salesforce/cli update available from 2.118.20 to 2.149.9.\n');
			emit({
				status: 1,
				name: 'ERROR_HTTP_420',
				message: 'HTTP response contains html content.\nCheck that the org exists and can be reached.',
			}, 1);
			break;
		case 'error':
			emit({ status: 1, name: 'SomethingElse', message: 'kaboom' }, 1);
			break;
		case 'garbage':
			// Unparseable --json output whose only readable line is the CLI's own
			// update nag -- which the noise filter strips, leaving nothing. This
			// is what produced a blank "unrecognised error:" in a real run.
			process.stdout.write(' »   Warning: @salesforce/cli update available from 2.118.20 to 2.150.6.\n');
			process.exit(1);
			break;
		default:
			emit({ status: 0, result: { name: flag('--sobject'), fields: [] } });
	}
}

if (cmd.startsWith('org login')) {
	// The whole point of the design is that this must never be reached in a
	// scheduled run. Tests assert on the absence of this marker.
	fs.appendFileSync(process.env.MOCK_SF_CALLLOG || '/dev/null', 'BROWSER_LOGIN_ATTEMPTED\n');
	emit({ status: 0, result: {} });
}

if (cmd.startsWith('project retrieve')) {
	const o = org(flag('--target-org'));
	// The CLI refuses to run outside an SFDX project. Assert that the child
	// actually gave us one, rather than trusting that it did.
	if (!fs.existsSync(path.join(process.cwd(), 'sfdx-project.json'))) {
		emit({
			status: 1,
			name: 'InvalidProjectWorkspaceError',
			message: 'This directory does not contain a valid Salesforce DX project.',
		}, 1);
	}
	// The real CLI refuses an --output-dir that resolves outside the project it
	// is running in. Enforcing it here is the whole reason this mock exists:
	// without it, a design that cannot work in production passes every test.
	const outDirArg = flag('--output-dir') || '';
	const resolvedOut = path.resolve(process.cwd(), outDirArg);
	const projectRoot = path.resolve(process.cwd());
	if (resolvedOut !== projectRoot && !resolvedOut.startsWith(projectRoot + path.sep)) {
		emit({
			status: 1,
			name: 'OutputDirOutsideProjectError',
			message:
				'The output directory must be inside the current project. ' +
				`The path relative you provided ${outDirArg} is outside the project root.`,
		}, 1);
	}
	// ...and it must not overlap a package directory, which is a SEPARATE rule
	// the real CLI enforces (RetrieveTargetDirOverlapsPackageError).
	let pkgDirs = [];
	try {
		pkgDirs = (JSON.parse(fs.readFileSync(path.join(process.cwd(), 'sfdx-project.json'), 'utf8')).packageDirectories || [])
			.map((d) => path.resolve(process.cwd(), d.path));
	} catch (_) {
		/* already validated above */
	}
	for (const pkg of pkgDirs) {
		if (resolvedOut === pkg || resolvedOut.startsWith(pkg + path.sep) || pkg.startsWith(resolvedOut + path.sep)) {
			emit({
				status: 1,
				name: 'RetrieveTargetDirOverlapsPackageError',
				message:
					`The retrieve target directory [${outDirArg}] overlaps one of your package directories. ` +
					'Specify a different retrieve target directory and try again.',
			}, 1);
		}
	}
	// Record the working directory so tests can assert it is NOT a directory the
	// orchestrator later renames. On Windows a process's cwd cannot be renamed
	// or deleted afterwards, which broke the atomic swap with EPERM.
	if (process.env.MOCK_SF_CALLLOG) {
		fs.appendFileSync(process.env.MOCK_SF_CALLLOG, `RETRIEVE_CWD ${process.cwd()}\n`);
	}
	if (o.metadata === 'fail') {
		emit({ status: 1, name: 'SfError', message: 'INVALID_TYPE: Cannot retrieve metadata type Nonsense' }, 1);
	}
	if (o.metadata === 'transient') {
		emit({ status: 1, name: 'NetworkError', message: 'socket hang up (ECONNRESET)' }, 1);
	}
	const dir = flag('--output-dir');
	const files = [];
	const write = (rel, body) => {
		const full = path.join(dir, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, body);
		files.push(rel);
	};
	write(path.join('classes', 'CJThing.cls'), 'public class CJThing {}');
	write(path.join('classes', 'CJThing.cls-meta.xml'), '<ApexClass/>');
	write(path.join('objects', 'Widget__c', 'Widget__c.object-meta.xml'), '<CustomObject/>');

	const result = {
		done: true,
		success: true,
		status: 'Succeeded',
		files: [
			{ fullName: 'CJThing', type: 'ApexClass', state: 'Created' },
			{ fullName: 'Widget__c', type: 'CustomObject', state: 'Created' },
		],
	};
	// A manifest entry that does not exist in the org: the retrieve SUCCEEDS
	// and reports it as a warning, which is exactly why it is easy to miss.
	if (o.metadata === 'warn') {
		result.messages = [{ problem: "Entity of type 'Layout' named 'Gone__c-Missing Layout' cannot be found" }];
	}
	emit({ status: 0, result });
}

if (cmd.startsWith('data export tree')) {
	const username = flag('--target-org');
	const o = org(username);
	if (o.export === 'fail') {
		emit({ status: 1, name: 'MalformedQuery', message: 'MALFORMED_QUERY: unexpected token' }, 1);
	}
	if (o.export === 'transient') {
		emit({ status: 1, name: 'NetworkError', message: 'socket hang up (ECONNRESET)' }, 1);
	}
	const dir = flag('--output-dir');
	fs.mkdirSync(dir, { recursive: true });
	const queries = allFlags('--query');
	const counts = o.records || {};
	const files = [];
	queries.forEach((q, i) => {
		// The outer object always ends in __c; subquery relationships end in __r.
		const m = [...q.matchAll(/FROM\s+(cja_cj__[A-Za-z0-9_]*__c)\b/g)].pop();
		const obj = (m && m[1]) || `Object${i}`;
		const n = counts[obj] !== undefined ? counts[obj] : 2;
		const records = Array.from({ length: n }, (_, k) => ({
			attributes: { type: obj, referenceId: `${obj}Ref${k}` },
			Name: `${obj} ${k}`,
			CreatedDate: '2026-01-01T00:00:00.000Z',
			LastModifiedDate: '2026-01-02T00:00:00.000Z',
			IsDeleted: false,
			cja_cj__Connector_Metadata_Name__c: 'strip-me',
		}));
		const file = `${obj}s.json`;
		fs.writeFileSync(path.join(dir, file), JSON.stringify({ records }, null, 2));
		files.push(file);
	});
	fs.writeFileSync(path.join(dir, 'export-demo-plan.json'), JSON.stringify(files, null, 2));
	emit({ status: 0, result: files.map((f) => ({ file: f })) });
}

emit({ status: 1, name: 'UnknownCommand', message: `mock-sf does not implement: ${argv.join(' ')}` }, 1);
