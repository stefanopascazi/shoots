--[[
Release version comparison for the plug-in ↔ CLI pairing. Pure Lua.
]]

local Version = {}

--- '0.8.1' or 'shoots 0.8.1-beta.2' -> { 0, 8, 1 }, or nil.
function Version.parse(text)
  if type(text) ~= 'string' then return nil end
  local major, minor, patch = string.match(text, '(%d+)%.(%d+)%.(%d+)')
  if not major then return nil end
  return { tonumber(major), tonumber(minor), tonumber(patch) }
end

--- -1, 0 or 1. Pre-release tags are ignored: the pairing is by release.
function Version.compare(a, b)
  for i = 1, 3 do
    if a[i] ~= b[i] then return a[i] < b[i] and -1 or 1 end
  end
  return 0
end

--- Whether the installed CLI is new enough. A development plug-in (0.0.0)
--- accepts any CLI; an unreadable installed version never does.
function Version.satisfies(installedText, requiredText)
  local required = Version.parse(requiredText)
  if not required or Version.compare(required, { 0, 0, 0 }) == 0 then return true end
  local installed = Version.parse(installedText)
  if not installed then return false end
  return Version.compare(installed, required) >= 0
end

return Version
