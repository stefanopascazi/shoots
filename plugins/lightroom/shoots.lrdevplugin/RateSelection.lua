-- Menu: write a 0-5 star rating to every photo in the selection.
local LrPrefs = import 'LrPrefs'

local Action = require 'Action'
local Command = require 'Command'
local Results = require 'Results'

local profile = LrPrefs.prefsForPlugin().profile
if not profile or profile == '' then profile = 'street' end

Action.run {
  title = 'shoots: Rate Selection',
  command = 'rate',
  args = function(listPath) return Command.rateArgs(listPath, profile) end,
  changes = Results.rateChanges,
}
