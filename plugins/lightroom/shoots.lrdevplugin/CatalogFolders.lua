--[[
Finding a folder or a photo in the catalog by path, whatever its spelling.

The SDK's exact lookups come first; when they miss, the catalog's folder tree
is walked comparing paths as Windows and macOS do (Paths.lua). That is what a
network share needs: Lightroom stores \\NAS\Share as it saw it at import, and
an exact lookup with any other spelling returns nothing.
]]

local Paths = require 'Paths'

local CatalogFolders = {}

--- Descend from the catalog's root folders to the one at `path`; nil if absent.
local function walk(catalog, path)
  local level = catalog:getFolders()
  while level and #level > 0 do
    local next = nil
    for _, folder in ipairs(level) do
      local p = folder:getPath()
      if Paths.same(p, path) then return folder end
      if Paths.within(p, path) then
        next = folder:getChildren()
        break
      end
    end
    level = next
  end
  return nil
end

--- The catalog folder at `path`, or nil.
function CatalogFolders.find(catalog, path)
  return catalog:getFolderByPath(path) or walk(catalog, path)
end

--- The catalog's root folders as Lightroom spells them, for an error message.
function CatalogFolders.roots(catalog)
  local out = {}
  for i, folder in ipairs(catalog:getFolders()) do
    out[i] = folder:getPath()
  end
  return out
end

--- The photo at `path`, or nil. Falls back to its folder's photos, compared by path.
function CatalogFolders.photo(catalog, path)
  local photo = catalog:findPhotoByPath(path)
  if photo then return photo end
  local dir = Paths.parent(path)
  local folder = dir and CatalogFolders.find(catalog, dir)
  if not folder then return nil end
  local photos = folder:getPhotos(false)
  for p, m in pairs(catalog:batchGetRawMetadata(photos, { 'path', 'isVirtualCopy' })) do
    if not m.isVirtualCopy and type(m.path) == 'string' and Paths.same(m.path, path) then return p end
  end
  return nil
end

--- "Lightroom has no folder X" with the roots it does have, so a spelling difference shows.
function CatalogFolders.missing(catalog, path)
  local roots = CatalogFolders.roots(catalog)
  return 'Lightroom has no folder ' .. path .. '. Its catalog folders start at: ' .. table.concat(roots, ', ')
end

return CatalogFolders
