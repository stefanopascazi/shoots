-- Menu: stop the shoots app server.
local LrTasks = import 'LrTasks'

local AppLauncher = require 'AppLauncher'

LrTasks.startAsyncTask(function() AppLauncher.close() end)
