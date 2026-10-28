--[[
The app server's session file (~/.shoots/app.json), read without Lightroom.
The server writes it once it listens; it names the port, the token and the
launch URL. Pure Lua, no Lightroom imports.
]]

local Json = require 'Json'

local AppSession = {}

--- Decode the file's text; nil when missing, torn or not a session.
function AppSession.parse(text)
  if not text or text == '' then return nil end
  local ok, s = pcall(Json.decode, text)
  if not ok or type(s) ~= 'table' then return nil end
  if type(s.port) ~= 'number' or type(s.token) ~= 'string' or type(s.url) ~= 'string' then return nil end
  return s
end

--- The URL of an API route on the session's server.
function AppSession.endpoint(session, route)
  return 'http://127.0.0.1:' .. string.format('%d', session.port) .. route
end

--- Headers that authenticate the plug-in, in LrHttp's shape.
function AppSession.headers(session)
  return {
    { field = 'x-shoots-token', value = session.token },
    { field = 'Content-Type', value = 'application/json' },
  }
end

--- Whether `current` is a different server from `previous` (a fresh start).
function AppSession.isNew(previous, current)
  if not current then return false end
  if not previous then return true end
  return previous.pid ~= current.pid or previous.startedAt ~= current.startedAt
end

return AppSession
