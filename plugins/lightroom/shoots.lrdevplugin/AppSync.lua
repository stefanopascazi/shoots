--[[
Reads the folder open in the app back from the catalog and reports what
changed, so flags, stars and labels set in Lightroom show up in the app.
Called from the lease loop, inside an async task.
]]

local LrApplication = import 'LrApplication'
local LrHttp = import 'LrHttp'

local AppSession = require 'AppSession'
local CatalogExport = require 'CatalogExport'
local CatalogFolders = require 'CatalogFolders'
local Sync = require 'Sync'

local AppSync = {}

local FIELDS = { 'path', 'rating', 'pickStatus', 'colorNameForLabel', 'isVirtualCopy' }

-- The last read that reached the server, for one followed folder.
local last = { key = nil, states = nil }
-- Folders already reported as missing from the catalog: said once, not every beat.
local missing = {}

--- Read the watched folder and send what changed since the last read.
function AppSync.run(session, watch)
  local catalog = LrApplication.activeCatalog()
  local folder = CatalogFolders.find(catalog, CatalogExport.folderPath(watch.folder))
  if not folder then
    if missing[watch.folder] then return end
    missing[watch.folder] = true
    -- Raised so the lease loop reports it: the app would otherwise just never follow.
    error(CatalogFolders.missing(catalog, watch.folder), 0)
  end

  local photos = folder:getPhotos(watch.recursive)
  local current = {}
  for _, m in pairs(catalog:batchGetRawMetadata(photos, FIELDS)) do
    -- A virtual copy shares its master's file; the master speaks for the path.
    if not m.isVirtualCopy and type(m.path) == 'string' then current[m.path] = Sync.normalize(m) end
  end

  local key = watch.folder .. (watch.recursive and '|r' or '|')
  local previous = (last.key == key) and last.states or nil
  local changes = Sync.diff(previous, current)
  if #changes > 0 then
    local _, headers = LrHttp.post(
      AppSession.endpoint(session, '/api/lightroom/state'),
      Sync.report(watch.folder, changes),
      AppSession.headers(session),
      'POST',
      10
    )
    -- Kept only once delivered, so a failed report is sent again next time.
    if not headers or headers.status ~= 200 then return end
  end
  last = { key = key, states = current }
end

return AppSync
