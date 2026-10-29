-- Menu: flag blurry photos in the selection as rejected.
local Action = require 'Action'
local Actions = require 'Actions'

Action.run(Actions.cull())
