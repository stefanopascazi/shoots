--[[
The shoots publish service: an always-visible entry in Library > Publish
Services. Each published collection runs one action (rate or cull) on the
photos dragged into it when "Publish" is clicked; nothing is rendered or
uploaded. "Open shoots" sits on the collections' context menu.
]]

local LrApplication = import 'LrApplication'
local LrTasks = import 'LrTasks'
local LrView = import 'LrView'

local Action = require 'Action'
local Actions = require 'Actions'
local AppEntry = require 'AppEntry'
local Log = require 'Log'
local Runner = require 'Runner'
local SettingsSection = require 'SettingsSection'

local DEFAULT_COLLECTION = 'Rate'
local CULL_COLLECTION = 'Cull'

local provider = {}

-- Publish only: keeps shoots out of the File > Export dialog.
provider.supportsIncrementalPublish = 'only'
provider.canExportVideo = false
provider.exportPresetFields = {}
provider.hideSections = {
  'exportLocation', 'fileNaming', 'fileSettings', 'imageSettings',
  'outputSharpening', 'metadata', 'watermarking', 'video', 'postProcessing',
}

function provider.sectionsForTopOfDialog(f, propertyTable)
  return { SettingsSection.build(f, propertyTable) }
end

-- Rating or flagging a photo must not put it back in "Modified Photos to Re-Publish".
function provider.metadataThatTriggersRepublish()
  return { default = false }
end

function provider.getCollectionBehaviorInfo()
  return {
    defaultCollectionName = DEFAULT_COLLECTION,
    defaultCollectionCanBeDeleted = true,
    canAddCollection = true,
    maxCollectionSetDepth = 0,
  }
end

-- The default collection rates; add the Cull one beside it, once.
function provider.didCreateNewPublishedCollection(_, info)
  if info.isDefaultCollection == false or info.name ~= DEFAULT_COLLECTION then return end
  LrTasks.startAsyncTask(function()
    local ok, err = LrTasks.pcall(function()
      local service = info.publishService
      for _, c in ipairs(service:getChildCollections()) do
        if c:getName() == CULL_COLLECTION then return end
      end
      LrApplication.activeCatalog():withWriteAccessDo('shoots: Create Cull collection', function()
        local cull = service:createPublishedCollection(CULL_COLLECTION, nil, true)
        if cull then cull:setCollectionSettings { action = 'cull' } end
      end, { timeout = 10 })
    end)
    if not ok then Log.error('Creating the Cull collection failed: ' .. tostring(err)) end
  end)
end

function provider.viewForCollectionSettings(f, _, info)
  local settings = info.collectionSettings
  settings.action = Actions.forCollection(settings)
  return f:row {
    bind_to_object = settings,
    f:static_text { title = 'On Publish:' },
    f:popup_menu { value = LrView.bind 'action', items = Actions.ITEMS },
  }
end

provider.titleForGoToPublishedCollection = 'Open shoots'
provider.titleForGoToPublishedPhoto = 'Open shoots'
function provider.goToPublishedCollection() AppEntry.open() end
function provider.goToPublishedPhoto() AppEntry.open() end

-- Nothing lives remotely: removing a photo only drops it from the collection.
function provider.deletePhotosFromPublishedCollection(_, arrayOfPhotoIds, deletedCallback)
  for _, id in ipairs(arrayOfPhotoIds) do deletedCallback(id) end
end

function provider.processRenderedPhotos(functionContext, exportContext)
  local collection = exportContext.publishedCollection
  local summary = collection and collection:getCollectionInfoSummary() or {}
  local spec = Actions.spec(Actions.forCollection(summary.collectionSettings))

  local renditions, photos = {}, {}
  for _, rendition in exportContext.exportSession:renditions() do
    rendition:skipRender()
    renditions[#renditions + 1] = rendition
    photos[#photos + 1] = rendition.photo
  end
  if #photos == 0 then return end

  -- Failed or declined: the photos stay in "New Photos to Publish" for another try.
  local ok, err = Action.apply(spec, photos, functionContext)
  for _, rendition in ipairs(renditions) do
    if ok then
      rendition:recordPublishedPhotoId(tostring(rendition.photo.localIdentifier))
    else
      rendition:uploadFailed(err == Runner.CANCELED and 'Canceled' or (err or 'shoots is not ready'))
    end
  end
end

return provider
