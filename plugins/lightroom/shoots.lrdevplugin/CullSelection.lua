-- Menu: flag blurry photos in the selection as rejected.
local Action = require 'Action'
local Command = require 'Command'
local Results = require 'Results'

Action.run {
  title = 'shoots: Cull Selection',
  command = 'cull',
  args = Command.cullArgs,
  changes = Results.cullChanges,
}
