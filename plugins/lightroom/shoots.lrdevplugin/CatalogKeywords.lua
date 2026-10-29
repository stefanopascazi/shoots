--[[
Writes `rate` keywords into the catalog, under one parent keyword named
`shoots` so they are easy to find, filter and delete together. Re-rating a
photo replaces the keywords shoots gave it before; keywords the user added
are never touched. Must run inside catalog:withWriteAccessDo.
]]

local CatalogKeywords = {}

CatalogKeywords.PARENT = 'shoots'

local function isChildOf(keyword, parent)
  local p = keyword:getParent()
  return p ~= nil and p.localIdentifier == parent.localIdentifier
end

--- `keywordsByKey` = { [key] = { name, ... } } from Results.rateChanges;
--- `photosByKey` = { [key] = { photo, ... } }.
function CatalogKeywords.write(catalog, photosByKey, keywordsByKey)
  if not keywordsByKey or next(keywordsByKey) == nil then return end
  -- The parent itself is not exported; its children are, like any keyword.
  local parent = catalog:createKeyword(CatalogKeywords.PARENT, {}, false, nil, true)
  local made = {}
  for key, names in pairs(keywordsByKey) do
    for _, photo in ipairs(photosByKey[key] or {}) do
      for _, old in ipairs(photo:getRawMetadata('keywords') or {}) do
        if isChildOf(old, parent) then photo:removeKeyword(old) end
      end
      for _, name in ipairs(names) do
        made[name] = made[name] or catalog:createKeyword(name, {}, true, parent, true)
        photo:addKeyword(made[name])
      end
    end
  end
end

return CatalogKeywords
