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

--- Read the requested folder and post its settings. `renew` renews the lease.
function AppExport.run(session, request, renew)
  local catalog = LrApplication.activeCatalog()
  local folder = catalog:getFolderByPath(request.folder)
  local photos = {}
  if folder then
    local all = folder:getPhotos(request.recursive)
    local meta = catalog:batchGetRawMetadata(all, { 'path', 'isVirtualCopy' })
    for i, photo in ipairs(all) do
      local m = meta[photo]
      -- A virtual copy shares its master's file; the master's edit is the one on disk.
      if m and not m.isVirtualCopy and type(m.path) == 'string' then
        photos[#photos + 1] = { path = m.path, settings = CatalogExport.settings(photo:getDevelopSettings()) }
      end
      if i % RENEW_EVERY == 0 then renew() end
    end
  end
  -- An empty export is still sent: the run then says there was nothing to learn from.
  LrHttp.post(
    AppSession.endpoint(session, '/api/catalog/export?job=' .. request.job),
    CatalogExport.body(request.folder, photos),
    AppSession.headers(session),
    'POST',
    POST_TIMEOUT_SECONDS
  )
end

return AppExport
