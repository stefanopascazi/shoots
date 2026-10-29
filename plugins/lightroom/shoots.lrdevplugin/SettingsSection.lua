--[[
The shoots settings section: status, install/update/dependencies buttons,
binary path and rating profile. Shown in the Plug-in Manager and in the
publish service's settings dialog.
]]

local LrPrefs = import 'LrPrefs'
local LrTasks = import 'LrTasks'
local LrView = import 'LrView'

local AppEntry = require 'AppEntry'
local Installer = require 'Installer'
local Runner = require 'Runner'

local SettingsSection = {}

function SettingsSection.build(f, propertyTable)
  local prefs = LrPrefs.prefsForPlugin()
  local bind = LrView.bind

  -- Filled in asynchronously: asking the binary its version runs a process.
  propertyTable.status = 'Checking...'
  local function refreshStatus()
    LrTasks.startAsyncTask(function()
      if not Runner.isInstalled() then
        propertyTable.status = 'Not installed'
      else
        propertyTable.status = 'Installed: ' .. (Runner.installedVersion() or 'unknown version')
      end
    end)
  end
  refreshStatus()

  return {
    title = 'shoots',
    f:row {
      f:static_text { title = 'Status:', width_in_chars = 12 },
      f:static_text { title = bind 'status', bind_to_object = propertyTable, fill_horizontal = 1 },
    },
    f:row {
      f:static_text { title = '', width_in_chars = 12 },
      f:push_button { title = 'Open shoots', action = function() AppEntry.open() end },
      f:push_button { title = 'Close shoots', action = function() AppEntry.close() end },
    },
    f:row {
      f:static_text { title = '', width_in_chars = 12 },
      f:push_button { title = 'Install or Update', action = function() Installer.installOrUpdate() end },
      f:push_button { title = 'Download Dependencies', action = function() Installer.setupDependencies() end },
      f:push_button { title = 'Refresh', action = refreshStatus },
    },
    f:row {
      bind_to_object = prefs,
      f:static_text { title = 'Binary path:', width_in_chars = 12 },
      f:edit_field { value = bind 'binaryPath', width_in_chars = 40, immediate = true },
    },
    f:row {
      f:static_text { title = '', width_in_chars = 12 },
      f:static_text { title = 'Leave empty to use ~/.shoots/bin', fill_horizontal = 1 },
    },
    f:row {
      bind_to_object = prefs,
      f:static_text { title = 'Rating profile:', width_in_chars = 12 },
      f:combo_box {
        value = bind 'profile',
        items = { 'street', 'generic', 'portrait', 'wildlife', 'wedding' },
        width_in_chars = 20,
      },
    },
  }
end

return SettingsSection
