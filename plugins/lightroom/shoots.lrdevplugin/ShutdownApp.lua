-- Lightroom is quitting: stop the app server now rather than when its lease lapses.
local LrTasks = import 'LrTasks'

return {
  LrShutdownFunction = function(doneFunction)
    LrTasks.startAsyncTask(function()
      -- LrTasks.pcall: close() posts over HTTP, which yields.
      LrTasks.pcall(function() require('AppLauncher').close() end)
      doneFunction()
    end)
  end,
}
