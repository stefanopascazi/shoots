--[[
Following the app's open folder in the catalog, read without Lightroom: which
folder to read, a photo's flag/stars/label in the app's terms, what changed
since the last read, and the report sent back. Pure Lua, no Lightroom imports;
AppSync.lua does the reading.
]]

local Json = require 'Json'

local Sync = {}

local LABELS = { red = true, yellow = true, green = true, blue = true, purple = true, none = true }

--- The folder the heartbeat reply asks the plug-in to follow, or nil.
function Sync.watch(body)
  local ok, reply = pcall(Json.decode, body or '')
  if not ok or type(reply) ~= 'table' or type(reply.watch) ~= 'table' then return nil end
  if type(reply.watch.folder) ~= 'string' then return nil end
  return { folder = reply.watch.folder, recursive = reply.watch.recursive == true }
end

--- One photo's catalog values as the app reads them: rating 0..5, pick -1/0/1, a label name or 'none'.
function Sync.normalize(raw)
  local rating = tonumber(raw.rating) or 0
  rating = math.max(0, math.min(5, math.floor(rating + 0.5)))
  local pick = tonumber(raw.pickStatus) or 0
  if pick ~= -1 and pick ~= 1 then pick = 0 end
  local label = raw.colorNameForLabel
  if type(label) ~= 'string' or not LABELS[label] then label = 'none' end
  return { rating = rating, pick = pick, label = label }
end

local function same(a, b)
  return a.rating == b.rating and a.pick == b.pick and a.label == b.label
end

--- Photos whose values differ from the previous read; every photo when there is none.
--- Sorted by path, so a report is stable.
function Sync.diff(previous, current)
  local paths = {}
  for path, state in pairs(current) do
    if not previous or not previous[path] or not same(previous[path], state) then paths[#paths + 1] = path end
  end
  table.sort(paths)
  local changes = {}
  for i, path in ipairs(paths) do
    local s = current[path]
    changes[i] = { path = path, rating = s.rating, pick = s.pick, label = s.label }
  end
  return changes
end

local function quote(text)
  return '"' .. text:gsub('[%c"\\]', function(c)
    if c == '"' then return '\\"' end
    if c == '\\' then return '\\\\' end
    return string.format('\\u%04x', c:byte())
  end) .. '"'
end

--- The report body for `POST /api/lightroom/state`.
function Sync.report(folder, changes)
  local parts = {}
  for i, c in ipairs(changes) do
    parts[i] = '{"path":' .. quote(c.path)
      .. ',"rating":' .. string.format('%d', c.rating)
      .. ',"pick":' .. string.format('%d', c.pick)
      .. ',"label":' .. quote(c.label) .. '}'
  end
  return '{"folder":' .. quote(folder) .. ',"photos":[' .. table.concat(parts, ',') .. ']}'
end

return Sync
