--[[
The shared shape of an action: take photos, run one shoots command over them,
write the result into the catalog as a single undo step. The menu runs it on
the selection, the publish service on a published collection.
]]

local LrApplication = import 'LrApplication'
local LrDialogs = import 'LrDialogs'
local LrFunctionContext = import 'LrFunctionContext'
local LrProgressScope = import 'LrProgressScope'

local Installer = require 'Installer'
local RawMetadata = require 'RawMetadata'
local Results = require 'Results'
local Runner = require 'Runner'

local Action = {}

--- spec = { title, command, args = function(listPath), changes = function(report, platform) }
--- Runs inside an async task. Returns true, or false and an error
--- (Runner.CANCELED on cancel, nil when the user declined the install).
function Action.apply(spec, photos, context)
  if not Installer.ensureReady(context) then return false end

  -- Virtual copies share a file: one entry in the list, every copy updated.
  local platform = Runner.platform()
  local byKey, paths = {}, {}
  for _, photo in ipairs(photos) do
    local p = photo:getRawMetadata('path')
    local key = Results.pathKey(p, platform)
    if not byKey[key] then
      byKey[key] = {}
      paths[#paths + 1] = p
    end
    table.insert(byKey[key], photo)
  end

  local progress = LrProgressScope { title = spec.title, functionContext = context }
  progress:setCancelable(true)
  progress:setIndeterminate()
  progress:setCaption(string.format('Starting on %d photos', #paths))

  local report, err = Runner.runOnFiles(spec.args, paths, progress)
  if not report then
    progress:done()
    -- Cancelled: the CLI is gone and nothing reached the catalog.
    if err ~= Runner.CANCELED then LrDialogs.message(spec.title .. ' failed', err, 'critical') end
    return false, err
  end

  progress:setCaption('Writing to the catalog')
  local catalog = LrApplication.activeCatalog()
  local changes, counts = spec.changes(report, platform)
  catalog:withWriteAccessDo(spec.title, function()
    for key, change in pairs(changes) do
      for _, photo in ipairs(byKey[key] or {}) do
        for field, value in pairs(change) do
          photo:setRawMetadata(field, RawMetadata.value(field, value))
        end
      end
    end
  end)

  progress:done()
  LrDialogs.message(spec.title, Results.summary(spec.command, counts), 'info')
  return true
end

--- Menu: run the spec on the selected photos.
function Action.run(spec)
  LrFunctionContext.postAsyncTaskWithContext(spec.title, function(context)
    LrDialogs.attachErrorDialogToFunctionContext(context)
    local photos = LrApplication.activeCatalog():getTargetPhotos()
    if #photos == 0 then
      LrDialogs.message(spec.title, 'Select one or more photos first.', 'info')
      return
    end
    Action.apply(spec, photos, context)
  end)
end

return Action
