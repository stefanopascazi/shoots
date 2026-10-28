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

local AppExport = {}

-- Reading thousands of photos holds up the lease loop: renew the lease meanwhile.
local RENEW_EVERY = 100
local POST_TIMEOUT_SECONDS = 120

--- Read the requested folder and post its settings (training, or export only). `renew` renews the lease.
function AppExport.run(session, request, renew)
  local catalog = LrApplication.activeCatalog()
  local folder = catalog:getFolderByPath(request.folder)
  local photos = {}
  if not folder then
    -- Said out loud: an empty export would read as "nothing edited here".
    LrHttp.post(
      AppSession.endpoint(session, '/api/catalog/export?job=' .. request.job),
      CatalogExport.notFound(request.folder),
      AppSession.headers(session),
      'POST',
      POST_TIMEOUT_SECONDS
    )
    return
  end
  do
    local all = folder:getPhotos(request.recursive)
    local meta = catalog:batchGetRawMetadata(all, { 'path', 'isVirtualCopy' })
    for i, photo in ipairs(all) do
      local m = meta[photo]
      -- A virtual copy shares its master's file; the master's edit is the one on disk.
      if m and not m.isVirtualCopy and type(m.path) == 'string' then
        local settings = photo:getDevelopSettings()
        -- Export only (the field test) also sends the settings untouched, to compare.
        photos[#photos + 1] = { path = m.path, settings = CatalogExport.settings(settings), raw = request.raw and settings or nil }
      end
      if i % RENEW_EVERY == 0 then renew() end
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
