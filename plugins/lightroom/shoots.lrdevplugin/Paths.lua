--[[
Comparing file paths the way Windows and macOS do, without Lightroom. Pure Lua.

The catalog's exact lookups (getFolderByPath, findPhotoByPath) fail on a path
spelled differently from how Lightroom stored it — a network share in another
case, or with / for \ — so the plug-in compares paths itself when they miss.
]]

local Paths = {}

--- One spelling per path: / as the separator, lower case, no trailing separator.
function Paths.key(p)
  local k = p:gsub('\\', '/'):lower()
  -- Keep the root of a drive (c:/) or of a POSIX tree (/) whole.
  if k:match('^%a:/$') or k == '/' then return k end
  return (k:gsub('/+$', ''))
end

--- Whether two paths name the same file or folder.
function Paths.same(a, b)
  return Paths.key(a) == Paths.key(b)
end

--- Whether `p` is `root` or lies under it, whole components only (/a/bc is not under /a/b).
function Paths.within(root, p)
  local r, k = Paths.key(root), Paths.key(p)
  if r == k then return true end
  if r:sub(-1) ~= '/' then r = r .. '/' end
  return k:sub(1, #r) == r
end

--- The folder holding `p`, or nil at a root.
function Paths.parent(p)
  local k = p:gsub('\\', '/'):gsub('/+$', '')
  local dir = k:match('^(.*)/[^/]+$')
  if not dir or dir == '' then return nil end
  return dir
end

return Paths
