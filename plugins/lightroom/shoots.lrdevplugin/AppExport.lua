--[[
Exports a folder's develop settings from the catalog for a training the app
started. The app cannot read the catalog, so this is the one step of training
that needs Lightroom; once the export lands the run goes on without it.
Called from the lease loop, inside an async task.
]]

local LrApplication = import 'LrApplication'
local LrHttp = import 'LrHttp'

local AppSession = require 'AppSession'
local CatalogExport = require 'CatalogExport'
local CatalogFolders = require 'CatalogFolders'

local AppExport = {}

-- Reading thousands of photos holds up the lease loop: report progress meanwhile,
-- which also renews the lease and tells the app the plug-in is at work.
local REPORT_EVERY = 50
local POST_TIMEOUT_SECONDS = 120

--- Read the requested folder and post its settings (training, or export only).
--- `report(done, total)` tells the app how far the reading got.
function AppExport.run(session, request, report)
  local catalog = LrApplication.activeCatalog()
  local folder = CatalogFolders.find(catalog, CatalogExport.folderPath(request.folder))
  local photos = {}
  if not folder then
    -- Said out loud: an empty export would read as "nothing edited here".
    LrHttp.post(
      AppSession.endpoint(session, '/api/catalog/export?job=' .. request.job),
      CatalogExport.notFound(request.folder, CatalogFolders.roots(catalog)),
      AppSession.headers(session),
      'POST',
      POST_TIMEOUT_SECONDS
    )
    return
  end
  do
    local all = folder:getPhotos(request.recursive)
    report(0, #all)
    local meta = catalog:batchGetRawMetadata(all, { 'path', 'isVirtualCopy' })
    for i, photo in ipairs(all) do
      local m = meta[photo]
      -- A virtual copy shares its master's file; the master's edit is the one on disk.
      if m and not m.isVirtualCopy and type(m.path) == 'string' then
        local settings = photo:getDevelopSettings()
        -- Export only (the field test) also sends the settings untouched, to compare.
        photos[#photos + 1] = { path = m.path, settings = CatalogExport.settings(settings), raw = request.raw and settings or nil }
      end
      if i % REPORT_EVERY == 0 then report(i, #all) end
    end
  end
  -- A folder with no photos is still sent: the run then says there was nothing to learn from.
  LrHttp.post(
    AppSession.endpoint(session, '/api/catalog/export?job=' .. request.job),
    CatalogExport.body(request.folder, photos),
    AppSession.headers(session),
    'POST',
    POST_TIMEOUT_SECONDS
  )
end

return AppExport
