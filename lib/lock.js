'use strict';

/**
 * lib/lock.js
 * ---------------------------------------------------------------------------
 * Single-instance lock, so a slow run cannot be overlapped by the next
 * scheduled firing.
 *
 * This is the *application-level* half of the defence. The other half is the
 * Task Scheduler setting "If the task is already running, then the following
 * rule applies: Do not start a new instance". Use both: Task Scheduler only
 * knows about tasks it started, so a manual run from a Command Prompt would
 * otherwise collide with a scheduled one.
 *
 * Mechanism: fs.openSync(path, 'wx') is an atomic create-if-absent at the OS
 * level, so two processes racing cannot both win.
 *
 * Stale locks: a crash or a hard kill leaves the file behind. We take one over
 * when either
 *   (a) it was written by this same machine and its PID is no longer alive, or
 *   (b) it is older than staleMinutes.
 * Both paths log a warning -- a silently reclaimed lock hides a crash loop.
 * ---------------------------------------------------------------------------
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

class LockBusyError extends Error {
	constructor(message, holder) {
		super(message);
		this.name = 'LockBusyError';
		this.holder = holder;
	}
}

function readHolder(lockPath) {
	try {
		return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
	} catch (_) {
		return null; // unreadable or half-written -> treated as stale by age
	}
}

function pidIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0); // signal 0 = existence check only
		return true;
	} catch (err) {
		return err.code === 'EPERM'; // exists but owned by another user
	}
}

/**
 * @param {object} opts
 * @param {string} opts.lockPath
 * @param {string} opts.runId
 * @param {number} [opts.staleMinutes]
 * @param {object} [opts.logger]
 * @returns {{release: function}}
 * @throws {LockBusyError} when another run genuinely holds the lock.
 */
function acquire(opts) {
	const { lockPath, runId, staleMinutes = 180, logger = null } = opts;
	const log = logger || { warn() {}, info() {}, debug() {} };

	fs.mkdirSync(path.dirname(lockPath), { recursive: true });

	const payload = JSON.stringify(
		{
			runId,
			pid: process.pid,
			hostname: os.hostname(),
			user: os.userInfo().username,
			startedAt: new Date().toISOString(),
		},
		null,
		2
	);

	const tryCreate = () => {
		const fd = fs.openSync(lockPath, 'wx'); // atomic: fails with EEXIST if present
		fs.writeSync(fd, payload);
		fs.closeSync(fd);
	};

	try {
		tryCreate();
	} catch (err) {
		if (err.code !== 'EEXIST') throw err;

		const holder = readHolder(lockPath);
		const ageMs = (() => {
			try {
				return Date.now() - fs.statSync(lockPath).mtimeMs;
			} catch (_) {
				return Number.POSITIVE_INFINITY;
			}
		})();
		const ageMinutes = ageMs / 60000;

		const sameMachine = holder && holder.hostname === os.hostname();
		const deadPid = sameMachine && !pidIsAlive(holder.pid);
		const tooOld = ageMinutes > staleMinutes;

		if (!deadPid && !tooOld) {
			throw new LockBusyError(
				`Another export run is active (runId=${holder ? holder.runId : 'unknown'}, ` +
					`pid=${holder ? holder.pid : '?'}, host=${holder ? holder.hostname : '?'}, ` +
					`age=${ageMinutes.toFixed(1)}m). Exiting without doing anything.`,
				holder
			);
		}

		log.warn('Reclaiming a stale lock file. The previous run did not exit cleanly.', {
			lockPath,
			previousRunId: holder ? holder.runId : null,
			previousPid: holder ? holder.pid : null,
			ageMinutes: Number(ageMinutes.toFixed(1)),
			reason: deadPid ? 'owning process is gone' : 'lock older than staleMinutes',
		});

		fs.rmSync(lockPath, { force: true });
		tryCreate(); // if this races and throws EEXIST, the caller sees a hard failure -- correct.
	}

	let released = false;
	const release = () => {
		if (released) return;
		released = true;
		try {
			// Only remove the lock if it is still OURS. Protects against deleting
			// a lock that a later run legitimately took over.
			const holder = readHolder(lockPath);
			if (!holder || holder.runId === runId) {
				fs.rmSync(lockPath, { force: true });
			}
		} catch (_) {
			/* best effort */
		}
	};

	// Release on every plausible exit path, including Ctrl-C and crashes.
	process.on('exit', release);
	for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
		process.on(sig, () => {
			release();
			process.exit(130);
		});
	}

	log.debug('Lock acquired.', { lockPath, runId });
	return { release, lockPath };
}

module.exports = { acquire, LockBusyError };
