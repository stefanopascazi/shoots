--[[
Menu: develop the selected photos with the trained profile.

The selection's current settings go to `shoots develop apply` as a catalog
export (so "already edited" is judged the way training judges it); the
predicted settings come back and are applied in one undo step, each photo
getting a history step named after the profile. Photos that already carry an
edit are replaced only on an explicit yes.
]]

local LrApplication = import 'LrApplication'
local LrDialogs = import 'LrDialogs'
local LrFunctionContext = import 'LrFunctionContext'
local LrProgressScope = import 'LrProgressScope'

local CatalogExport = require 'CatalogExport'
local Command = require 'Command'
local Develop = require 'Develop'
local Installer = require 'Installer'
local Paths = require 'Paths'
local Results = require 'Results'
local Runner = require 'Runner'

local TITLE = 'shoots: Develop Selection'

-- Each photo's settings for the export, and the creative profiles in use, by name.
local function readSelection(photos, platform)
  local byKey, entries, parents, looks = {}, {}, {}, {}
  for _, photo in ipairs(photos) do
    local p = photo:getRawMetadata('path')
    local key = Results.pathKey(p, platform)
    local settings = photo:getDevelopSettings()
    if type(settings.Look) == 'table' and type(settings.Look.Name) == 'string' then
      looks[settings.Look.Name] = looks[settings.Look.Name] or settings.Look
    end
    if not byKey[key] then
      byKey[key] = {}
      entries[#entries + 1] = { path = p, settings = CatalogExport.settings(settings) }
      parents[#parents + 1] = Paths.parent(p) or p
    end
    table.insert(byKey[key], photo)
  end
  return byKey, entries, Paths.common(parents) or '', looks
end

-- Ask before replacing edits; nil means stop.
local function replaceEdited(count)
  if count == 0 then return false end
  local answer = LrDialogs.confirm(
    string.format('%d of these photos are already edited', count),
    'Replace their develop settings with the prediction? Each change is one history step, and Edit > Undo takes the whole run back.',
    'Replace',
    'Cancel',
    'Skip Edited Photos'
  )
  if answer == 'ok' then return true end
  if answer == 'other' then return false end
  return nil
end

LrFunctionContext.postAsyncTaskWithContext(TITLE, function(context)
  LrDialogs.attachErrorDialogToFunctionContext(context)
  local catalog = LrApplication.activeCatalog()
  local photos = catalog:getTargetPhotos()
  if #photos == 0 then
    LrDialogs.message(TITLE, 'Select one or more photos first.', 'info')
    return
  end
  if not Installer.ensureReady(context) then return end

  local platform = Runner.platform()
  local byKey, entries, folder, looks = readSelection(photos, platform)

  local progress = LrProgressScope { title = TITLE, functionContext = context }
  progress:setCancelable(true)
  progress:setIndeterminate()
  progress:setCaption(string.format('Starting on %d photos', #entries))

  local report, err = Runner.runOnInput(
    Command.developArgs,
    'shoots-selection.json',
    CatalogExport.body(folder, entries),
    progress
  )
  if not report then
    progress:done()
    if err ~= Runner.CANCELED then LrDialogs.message(TITLE .. ' failed', err, 'critical') end
    return
  end

  local replace = replaceEdited(Develop.editedCount(report))
  if replace == nil then
    progress:done()
    return
  end

  progress:setCaption('Writing to the catalog')
  local history = 'shoots: ' .. tostring(report.profile)
  local changes, counts = Develop.plan(report, platform, replace, looks)
  catalog:withWriteAccessDo(TITLE, function()
    for key, settings in pairs(changes) do
      for _, photo in ipairs(byKey[key] or {}) do
        photo:applyDevelopSettings(settings, history)
      end
    end
  end)

  progress:done()
  LrDialogs.message(TITLE, Develop.summary(counts, report.profile), 'info')
end)
