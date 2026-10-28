--[[
The app's outbox, read without Lightroom: what the server says is waiting, the
catalog fields each change sets, and the acknowledgement sent back. Pure Lua,
no Lightroom imports; AppOutbox.lua applies what this returns.
]]

local Json = require 'Json'

local Outbox = {}

--- How many changes the heartbeat reply says are waiting; 0 on anything unreadable.
function Outbox.pendingCount(body)
  local ok, reply = pcall(Json.decode, body or '')
  if not ok or type(reply) ~= 'table' then return 0 end
  local n = tonumber(reply.pending)
  if not n or n < 0 then return 0 end
  return n
end

--- The changes in a `GET /api/outbox` reply, or an empty list.
function Outbox.items(body)
  local ok, reply = pcall(Json.decode, body or '')
  if not ok or type(reply) ~= 'table' or type(reply.items) ~= 'table' then return {} end
  local items = {}
  for _, item in ipairs(reply.items) do
    if type(item) == 'table' and type(item.id) == 'number' and type(item.path) == 'string' then
      items[#items + 1] = item
    end
  end
  return items
end

--- The catalog fields one change sets, in Lightroom's terms. A null field is left alone.
function Outbox.fields(item)
  local fields = {}
  local rating = tonumber(item.rating)
  if rating then fields.rating = math.max(0, math.min(5, math.floor(rating + 0.5))) end
  local pick = tonumber(item.pick)
  if pick == -1 or pick == 0 or pick == 1 then fields.pickStatus = pick end
  return fields
end

local function idList(ids)
  local parts = {}
  for i, id in ipairs(ids) do parts[i] = string.format('%d', id) end
  return '[' .. table.concat(parts, ',') .. ']'
end

--- The acknowledgement body: which changes landed, and which photos the catalog does not have.
function Outbox.ackBody(applied, missing)
  return '{"applied":' .. idList(applied) .. ',"missing":' .. idList(missing) .. '}'
end

return Outbox
