'use strict';

const async = require('async');
const prompt = require('prompt');
const request = require('request');
const cproc = require('child_process');
const semver = require('semver');
const fs = require('fs');
const path = require('path');
const nconf = require('nconf');

const { paths, pluginNamePattern } = require('../constants');

const packageManager = nconf.get('package_manager');

const supportedPackageManagerList = require('./package-install').supportedPackageManager; // load config from src/cli/package-install.js

let packageManagerExecutable = supportedPackageManagerList.indexOf(packageManager) >= 0 ? packageManager : 'npm';
const packageManagerInstallArgs = packageManager === 'yarn' ? ['add'] : ['install', '--save'];

if (process.platform === 'win32') {
	packageManagerExecutable += '.cmd';
}

function getModuleVersions(modules, callback) {
	const versionHash = {};

	async.eachLimit(modules, 50, (module, next) => {
		fs.readFile(path.join(paths.nodeModules, module, 'package.json'), { encoding: 'utf-8' }, (err, pkg) => {
			if (err) {
				return next(err);
			}

			try {
				pkg = JSON.parse(pkg);
				versionHash[module] = pkg.version;
				next();
			} catch (err) {
				next(err);
			}
		});
	}, (err) => {
		callback(err, versionHash);
	});
}

function getInstalledPlugins(callback) {
	async.parallel({
		files: async.apply(fs.readdir, paths.nodeModules),
		deps: async.apply(fs.readFile, paths.currentPackage, { encoding: 'utf-8' }),
		bundled: async.apply(fs.readFile, paths.installPackage, { encoding: 'utf-8' }),
	}, (err, payload) => {
		if (err) {
			return callback(err);
		}

		payload.files = payload.files.filter(file => pluginNamePattern.test(file));

		try {
			payload.deps = Object.keys(JSON.parse(payload.deps).dependencies);
			payload.bundled = Object.keys(JSON.parse(payload.bundled).dependencies);
		} catch (err) {
			return callback(err);
		}

		payload.bundled = payload.bundled.filter(pkgName => pluginNamePattern.test(pkgName));
		payload.deps = payload.deps.filter(pkgName => pluginNamePattern.test(pkgName));

		// Whittle down deps to send back only extraneously installed plugins/themes/etc
		const checklist = payload.deps.filter((pkgName) => {
			if (payload.bundled.includes(pkgName)) {
				return false;
			}

			// Ignore git repositories
			try {
				fs.accessSync(path.join(paths.nodeModules, pkgName, '.git'));
				return false;
			} catch (e) {
				return true;
			}
		});

		getModuleVersions(checklist, callback);
	});
}

function getCurrentVersion(callback) {
	fs.readFile(paths.installPackage, { encoding: 'utf-8' }, (err, pkg) => {
		if (err) {
			return callback(err);
		}

		try {
			pkg = JSON.parse(pkg);
		} catch (err) {
			return callback(err);
		}
		callback(null, pkg.version);
	});
}

function checkPlugins(standalone, callback) {
	if (standalone) {
		process.stdout.write('Checking installed plugins and themes for updates... ');
	}

	async.waterfall([
		async.apply(async.parallel, {
			plugins: getInstalledPlugins,
			version: getCurrentVersion,
		}),
		function (payload, next) {
			const toCheck = Object.keys(payload.plugins);

			if (!toCheck.length) {
				process.stdout.write('  OK'.green + ''.reset);
				return next(null, []);	// no extraneous plugins installed
			}

			request({
				method: 'GET',
				url: `https://packages.nodebb.org/api/v1/suggest?version=${payload.version}&package[]=${toCheck.join('&package[]=')}`,
				json: true,
			}, (err, res, body) => {
				if (err) {
					process.stdout.write('error'.red + ''.reset);
					return next(err);
				}
				process.stdout.write('  OK'.green + ''.reset);

				if (!Array.isArray(body) && toCheck.length === 1) {
					body = [body];
				}

				let current;
				let suggested;
				const upgradable = body.map((suggestObj) => {
					current = payload.plugins[suggestObj.package];
					suggested = suggestObj.version;

					if (suggestObj.code === 'match-found' && semver.gt(suggested, current)) {
						return {
							name: suggestObj.package,
							current: current,
							suggested: suggested,
						};
					}
					return null;
				}).filter(Boolean);

				next(null, upgradable);
			});
		},
	], callback);
}

function upgradePlugins(callback) {
	let standalone = false;
	if (typeof callback !== 'function') {
		callback = function () {};
		standalone = true;
	}

	checkPlugins(standalone, (err, found) => {
		if (err) {
			console.log('Warning'.yellow + ': An unexpected error occured when attempting to verify plugin upgradability'.reset);
			return callback(err);
		}

		if (found && found.length) {
			process.stdout.write(`\n\nA total of ${String(found.length).bold} package(s) can be upgraded:\n\n`);
			found.forEach((suggestObj) => {
				process.stdout.write(`${'  * '.yellow + suggestObj.name.reset} (${suggestObj.current.yellow}${' -> '.reset}${suggestObj.suggested.green}${')\n'.reset}`);
			});
		} else {
			if (standalone) {
				console.log('\nAll packages up-to-date!'.green + ''.reset);
			}
			return callback();
		}

		prompt.message = '';
		prompt.delimiter = '';

		prompt.start();
		prompt.get({
			name: 'upgrade',
			description: '\nProceed with upgrade (y|n)?'.reset,
			type: 'string',
		}, (err, result) => {
			if (err) {
				return callback(err);
			}

			if (['y', 'Y', 'yes', 'YES'].includes(result.upgrade)) {
				console.log('\nUpgrading packages...');
				const args = packageManagerInstallArgs.concat(found.map(suggestObj => `${suggestObj.name}@${suggestObj.suggested}`));

				cproc.execFile(packageManagerExecutable, args, { stdio: 'ignore' }, (err) => {
					callback(err, false);
				});
			} else {
				console.log('Package upgrades skipped'.yellow + '. Check for upgrades at any time by running "'.reset + './nodebb upgrade -p'.green + '".'.reset);
				callback();
			}
		});
	});
}

exports.upgradePlugins = upgradePlugins;
