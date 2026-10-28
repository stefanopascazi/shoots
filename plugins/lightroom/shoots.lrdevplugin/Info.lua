-- Lightroom Classic plug-in manifest. VERSION is stamped by the build
-- (`npm run build:lrplugin`); the development copy reports 0.0.0.
return {
  LrSdkVersion = 10.0,
  LrSdkMinimumVersion = 6.0,
  LrToolkitIdentifier = 'com.shoots-ai.lightroom',
  LrPluginName = 'shoots',
  LrPluginInfoUrl = 'https://www.shoots-ai.com',
  LrPluginInfoProvider = 'PluginInfoProvider.lua',

  -- Library > Plug-in Extras
  LrLibraryMenuItems = {
    { title = 'Cull Selection (flag blurry as rejected)', file = 'CullSelection.lua', enabledWhen = 'photosSelected' },
    { title = 'Rate Selection', file = 'RateSelection.lua', enabledWhen = 'photosSelected' },
  },
  -- File > Plug-in Extras
  LrExportMenuItems = {
    { title = 'Cull Selection (flag blurry as rejected)', file = 'CullSelection.lua', enabledWhen = 'photosSelected' },
    { title = 'Rate Selection', file = 'RateSelection.lua', enabledWhen = 'photosSelected' },
  },

  VERSION = { major = 0, minor = 0, revision = 0, display = '0.0.0' },
}
