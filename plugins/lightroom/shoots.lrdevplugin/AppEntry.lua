-- The "Open shoots" / "Close shoots" entry points, shared by the menu and the publish service.
local LrDialogs = import 'LrDialogs'
local LrFunctionContext = import 'LrFunctionContext'
local LrTasks = import 'LrTasks'

local AppLauncher = require 'AppLauncher'
local Installer = require 'Installer'

local AppEntry = {}

--- Install or update when needed, then open the app in the browser.
function AppEntry.open()
  LrFunctionContext.postAsyncTaskWithContext('shoots: Open app', function(context)
    LrDialogs.attachErrorDialogToFunctionContext(context)
    if not Installer.ensureReady(context) then return end
    AppLauncher.open()
  end)
end

function AppEntry.close()
  LrTasks.startAsyncTask(function() AppLauncher.close() end)
end

return AppEntry
