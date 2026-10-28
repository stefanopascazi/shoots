--[[
A failure inside the lease loop, as the app server receives it. Pure Lua, no
Lightroom imports. Without this the loop's failures were invisible: the lease
kept the app alive while sync, sends and exports silently did nothing.
]]

local HostError = {}

-- Long enough for a Lua error with its location; a stack trace is not needed.
local MAX_MESSAGE = 500

local function quote(text)
  return '"' .. text:gsub('[%c"\\]', function(c)
    if c == '"' then return '\\"' end
    if c == '\\' then return '\\\\' end
    return string.format('\\u%04x', c:byte())
  end) .. '"'
end

--- The body for `POST /api/host/error`: which step failed and why.
function HostError.body(where, err)
  local message = tostring(err)
  if #message > MAX_MESSAGE then message = message:sub(1, MAX_MESSAGE) .. '…' end
  return '{"where":' .. quote(tostring(where)) .. ',"message":' .. quote(message) .. '}'
end

return HostError
