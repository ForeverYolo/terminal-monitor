'use strict';
// Stable entry for the complete-release updater and command hooks.
module.exports = {};
for (const name of ['runManaged', 'restartWorker', 'notifyReady', 'runHook', 'configureHooks']) {
  module.exports[name] = (...args) => require('./release-runtime')[name](...args);
}
for (const name of ['createReleaseClient', 'createReleaseServer']) {
  module.exports[name] = (...args) => require('./release-transport')[name](...args);
}
if (require.main === module && process.argv[2] === '--hook') module.exports.runHook(process.argv[3], __dirname);
if (require.main === module && process.argv[2] === '--configure-hooks') console.log(JSON.stringify(module.exports.configureHooks(__dirname, {app:process.argv[3],directory:require('path').resolve(process.argv[4]||'.')})));
