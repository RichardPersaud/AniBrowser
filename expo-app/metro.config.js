const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// the entire node runtime (server.js/scraper.js/ui/) ships as one zip asset
config.resolver.assetExts.push('zip');

module.exports = config;