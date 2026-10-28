--[[
Applies what the app sent: collects the outbox from the app server, writes the
changes into the catalog as one undo step, and reports back what landed and
which photos the catalog does not have. Called from the lease loop, inside an
async task.
]]

local LrApplication = import 'LrApplication'
local LrHttp = import 'LrHttp'
local LrTasks = import 'LrTasks'

local AppSession = require 'AppSession'
local Outbox = require 'Outbox'

local AppOutbox = {}

local WRITE_TIMEOUT_SECONDS = 10

-- A master and its virtual copies share one file, so all of them take the change.
local function photosAt(catalog, path)
  local master = catalog:findPhotoByPath(path)
  if not master then return nil end
  local photos = { master }
  for _, copy in ipairs(master:getRawMetadata('virtualCopies') or {}) do
    photos[#photos + 1] = copy
  end
  return photos
end

--- Collect and apply everything waiting. Returns how many changes landed.
function AppOutbox.apply(session)
  local body = LrHttp.get(AppSession.endpoint(session, '/api/outbox'), AppSession.headers(session), 10)
  local items = Outbox.items(body)
  if #items == 0 then return 0 end

  local catalog = LrApplication.activeCatalog()
  local found, applied, missing = {}, {}, {}
  for _, item in ipairs(items) do
    local photos = photosAt(catalog, item.path)
    if photos then
      found[#found + 1] = { item = item, photos = photos }
    else
      missing[#missing + 1] = item.id
    end
  end

  if #found > 0 then
    -- Another write in progress (the user editing) makes this fail; nothing is
    -- acknowledged then, so the next heartbeat simply tries again.
    -- LrTasks.pcall: withWriteAccessDo yields, which a plain pcall cannot carry.
    local ok, status = LrTasks.pcall(function()
      return catalog:withWriteAccessDo('shoots: Apply from the app', function()
        for _, entry in ipairs(found) do
          for field, value in pairs(Outbox.fields(entry.item)) do
            for _, photo in ipairs(entry.photos) do
              photo:setRawMetadata(field, value)
            end
          end
        end
      end, { timeout = WRITE_TIMEOUT_SECONDS })
    end)
    -- With a timeout, Lightroom reports 'aborted' instead of raising when it could not get access.
    if not ok or (status ~= nil and status ~= 'executed') then return 0 end
    for _, entry in ipairs(found) do applied[#applied + 1] = entry.item.id end
  end

  LrHttp.post(AppSession.endpoint(session, '/api/outbox/ack'), Outbox.ackBody(applied, missing), AppSession.headers(session), 'POST', 10)
  return #applied
end

return AppOutbox
