-- Menu: open the shoots app in the browser, starting its server when needed.
local LrDialogs = import 'LrDialogs'
local LrFunctionContext = import 'LrFunctionContext'

local AppLauncher = require 'AppLauncher'
local Installer = require 'Installer'

LrFunctionContext.postAsyncTaskWithContext('shoots: Open app', function(context)
  LrDialogs.attachErrorDialogToFunctionContext(context)
  if not Installer.ensureReady(context) then return end
  AppLauncher.open()
end)
