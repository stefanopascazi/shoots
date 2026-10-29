-- Lightroom Classic plug-in manifest. VERSION (here and in PluginVersion.lua) is
-- stamped by the build (`npm run build:lrplugin`); the development copy reports 0.0.0.
local menu = {
  { title = 'Open shoots', file = 'OpenApp.lua' },
  { title = 'Cull Selection (flag blurry as rejected)', file = 'CullSelection.lua', enabledWhen = 'photosSelected' },
  { title = 'Rate Selection', file = 'RateSelection.lua', enabledWhen = 'photosSelected' },
  { title = 'Install or Update shoots', file = 'InstallOrUpdate.lua' },
  { title = 'Download Dependencies', file = 'SetupDependencies.lua' },
  { title = 'Close shoots', file = 'CloseApp.lua' },
}

return {
  LrSdkVersion = 10.0,
  LrSdkMinimumVersion = 6.0,
  LrToolkitIdentifier = 'com.shoots-ai.lightroom',
  LrPluginName = 'shoots',
  LrPluginInfoUrl = 'https://www.shoots-ai.com',
  LrPluginInfoProvider = 'PluginInfoProvider.lua',
  -- Stops the app server when Lightroom quits.
  LrShutdownApp = 'ShutdownApp.lua',

  -- Library > Plug-in Extras, and File > Plug-in Extras
  LrLibraryMenuItems = menu,
  LrExportMenuItems = menu,

  -- Library > Publish Services: Rate and Cull collections, "Open shoots" on right-click.
  LrExportServiceProvider = { title = 'shoots', file = 'PublishServiceProvider.lua' },

  VERSION = { major = 0, minor = 0, revision = 0, display = '0.0.0' },
}
