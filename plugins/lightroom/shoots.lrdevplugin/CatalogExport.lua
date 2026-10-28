--[[
The catalog export for training, built without Lightroom: which folder the app
asks for, which develop settings travel, and the JSON body sent back. Pure Lua,
no Lightroom imports; AppExport.lua does the reading.

Only scalar settings travel, plus the point tone curve and the creative
profile's name: masks and local adjustments can be large and the engine does not
learn from them.
]]

local Json = require 'Json'

local CatalogExport = {}

-- Must match CATALOG_EXPORT_VERSION in the engine (develop/adapters/lightroom/catalog.ts).
CatalogExport.VERSION = 1

--- The training the heartbeat reply asks the plug-in to export for, or nil.
function CatalogExport.request(body)
  local ok, reply = pcall(Json.decode, body or '')
  if not ok or type(reply) ~= 'table' or type(reply.export) ~= 'table' then return nil end
  local e = reply.export
  if type(e.job) ~= 'string' or not e.job:match('^[%w%-_]+$') or type(e.folder) ~= 'string' then return nil end
  return { job = e.job, folder = e.folder, recursive = e.recursive == true, raw = e.raw == true }
end

local function numbers(list)
  if #list == 0 then return nil end
  for i = 1, #list do
    if type(list[i]) ~= 'number' then return nil end
  end
  return list
end

--- One photo's `getDevelopSettings()` reduced to what the engine reads.
function CatalogExport.settings(raw)
  local out = {}
  for key, value in pairs(raw or {}) do
    local t = type(value)
    if type(key) == 'string' then
      if t == 'number' or t == 'string' or t == 'boolean' then
        out[key] = value
      elseif key == 'ToneCurvePV2012' and t == 'table' then
        out[key] = numbers(value)
      elseif key == 'Look' and t == 'table' and type(value.Name) == 'string' then
        out.LookName = value.Name
      end
    end
  end
  return out
end

local function quote(text)
  return '"' .. text:gsub('[%c"\\]', function(c)
    if c == '"' then return '\\"' end
    if c == '\\' then return '\\\\' end
    return string.format('\\u%04x', c:byte())
  end) .. '"'
end

local function number(n)
  -- NaN and infinities have no JSON form.
  if n ~= n or n == math.huge or n == -math.huge then return 'null' end
  if n == math.floor(n) and math.abs(n) < 1e15 then return string.format('%d', n) end
  return string.format('%.14g', n)
end

local function value(v)
  local t = type(v)
  if t == 'number' then return number(v) end
  if t == 'boolean' then return tostring(v) end
  if t == 'string' then return quote(v) end
  local parts = {}
  for i = 1, #v do parts[i] = number(v[i]) end
  return '[' .. table.concat(parts, ',') .. ']'
end

local function object(settings)
  local keys = {}
  for k in pairs(settings) do keys[#keys + 1] = k end
  table.sort(keys)
  local parts = {}
  for i, k in ipairs(keys) do parts[i] = quote(k) .. ':' .. value(settings[k]) end
  return '{' .. table.concat(parts, ',') .. '}'
end

-- Deep enough for masks inside correction groups; deeper is cut, not followed.
local MAX_DEPTH = 8

local function isSequence(t)
  local n = #t
  if n == 0 then return false end
  local count = 0
  for _ in pairs(t) do count = count + 1 end
  return count == n
end

--- Any Lua value as JSON, as faithfully as it goes: for looking at what the SDK returns.
local function anything(v, depth)
  local t = type(v)
  if t == 'number' then return number(v) end
  if t == 'boolean' then return tostring(v) end
  if t == 'string' then return quote(v) end
  if t ~= 'table' then return quote('<' .. t .. '>') end
  if depth >= MAX_DEPTH then return quote('<too deep>') end
  local parts = {}
  if isSequence(v) then
    for i = 1, #v do parts[i] = anything(v[i], depth + 1) end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  local keys = {}
  for k in pairs(v) do keys[#keys + 1] = tostring(k) end
  table.sort(keys)
  local byName = {}
  for k, value in pairs(v) do byName[tostring(k)] = value end
  for i, k in ipairs(keys) do parts[i] = quote(k) .. ':' .. anything(byName[k], depth + 1) end
  return '{' .. table.concat(parts, ',') .. '}'
end

function CatalogExport.encodeRaw(v) return anything(v, 0) end

--- The body for `POST /api/catalog/export`: `photos` is a list of { path, settings, raw? }.
function CatalogExport.body(folder, photos)
  local parts = {}
  for i, p in ipairs(photos) do
    parts[i] = '{"path":' .. quote(p.path) .. ',"settings":' .. object(p.settings)
      .. (p.raw ~= nil and (',"raw":' .. anything(p.raw, 0)) or '') .. '}'
  end
  return '{"version":' .. string.format('%d', CatalogExport.VERSION)
    .. ',"folder":' .. quote(folder)
    .. ',"photos":[' .. table.concat(parts, ',') .. ']}'
end

return CatalogExport
