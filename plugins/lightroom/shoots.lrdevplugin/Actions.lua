--[[
The commands the plug-in runs on photos, as Action specs, and how a published
collection picks one. `forCollection` is pure; the specs read plug-in prefs.
]]

local Command = require 'Command'
local Results = require 'Results'

local Actions = {}

--- Popup items for a published collection's settings, in display order.
Actions.ITEMS = {
  { title = 'Rate (0-5 stars)', value = 'rate' },
  { title = 'Cull (flag blurry as rejected)', value = 'cull' },
}

--- The action a published collection runs; unset or unknown means rate.
function Actions.forCollection(settings)
  local action = type(settings) == 'table' and settings.action or nil
  if action == 'cull' then return 'cull' end
  return 'rate'
end

function Actions.cull()
  return {
    title = 'shoots: Cull Selection',
    command = 'cull',
    args = Command.cullArgs,
    changes = Results.cullChanges,
  }
end

function Actions.rate()
  local LrPrefs = import 'LrPrefs'
  local profile = LrPrefs.prefsForPlugin().profile
  if not profile or profile == '' then profile = 'street' end
  return {
    title = 'shoots: Rate Selection',
    command = 'rate',
    args = function(listPath) return Command.rateArgs(listPath, profile) end,
    changes = Results.rateChanges,
  }
end

--- The spec for an action name ('rate' | 'cull').
function Actions.spec(name)
  if name == 'cull' then return Actions.cull() end
  return Actions.rate()
end

return Actions
