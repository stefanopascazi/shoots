--[[
The shared shape of a menu action: take the selected photos, run one shoots
command over them, write the result into the catalog as a single undo step.
]]

local LrApplication = import 'LrApplication'
local LrDialogs = import 'LrDialogs'
local LrFileUtils = import 'LrFileUtils'
local LrFunctionContext = import 'LrFunctionContext'
local LrProgressScope = import 'LrProgressScope'

local Results = require 'Results'
local Runner = require 'Runner'

local Action = {}

--- spec = { title, command, args = function(listPath), changes = function(report, platform) }
function Action.run(spec)
  LrFunctionContext.postAsyncTaskWithContext(spec.title, function(context)
    LrDialogs.attachErrorDialogToFunctionContext(context)

    local catalog = LrApplication.activeCatalog()
    local photos = catalog:getTargetPhotos()
    if #photos == 0 then
      LrDialogs.message(spec.title, 'Select one or more photos first.', 'info')
      return
    end

    local binary = Runner.binary()
    if not LrFileUtils.exists(binary) then
      LrDialogs.message(
        'shoots is not installed',
        'Expected the shoots binary at:\n' .. binary
          .. '\n\nInstall it from shoots-ai.com, or set its path in File > Plug-in Manager.',
        'critical'
      )
      return
    end

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
    progress:setCaption(string.format('%d photos', #paths))
    progress:setIndeterminate()

    local report, err = Runner.run(binary, spec.args, paths)
    if not report then
      progress:done()
      LrDialogs.message(spec.title .. ' failed', err, 'critical')
      return
    end

    local changes, counts = spec.changes(report, platform)
    catalog:withWriteAccessDo(spec.title, function()
      for key, change in pairs(changes) do
        for _, photo in ipairs(byKey[key] or {}) do
          for field, value in pairs(change) do
            photo:setRawMetadata(field, value)
          end
        end
      end
    end)

    progress:done()
    LrDialogs.message(spec.title, Results.summary(spec.command, counts), 'info')
  end)
end

return Action
