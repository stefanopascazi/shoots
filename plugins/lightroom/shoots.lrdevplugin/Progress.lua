--[[
Reads the progress file the CLI appends to (SHOOTS_PROGRESS_FILE, one JSON
object per line) and turns its latest event into what a progress bar shows.
Pure Lua, no Lightroom imports.
]]

local Json = require 'Json'

local Progress = {}

local function lastEvent(text)
  -- The last line may still be half-written: walk back to the newest one that parses.
  local lines = {}
  for line in string.gmatch(text or '', '[^\n]+') do lines[#lines + 1] = line end
  for i = #lines, 1, -1 do
    local ok, event = pcall(Json.decode, lines[i])
    if ok and type(event) == 'table' then return event end
  end
  return nil
end

local function megabytes(bytes)
  return string.format('%.1f MB', bytes / 1048576)
end

--- { fraction = 0..1 or nil (indeterminate), caption = string } or nil when nothing yet.
function Progress.parse(text)
  local e = lastEvent(text)
  if not e then return nil end
  local label = type(e.label) == 'string' and e.label or ''
  local detail = type(e.detail) == 'string' and e.detail or nil

  if e.kind == 'steps' and type(e.total) == 'number' and e.total > 0 then
    local caption = string.format('%s %d/%d', label, e.done, e.total)
    if detail then caption = caption .. ' - ' .. detail end
    return { fraction = math.min(1, e.done / e.total), caption = caption }
  end
  if e.kind == 'download' and type(e.received) == 'number' then
    if type(e.total) == 'number' and e.total > 0 then
      return {
        fraction = math.min(1, e.received / e.total),
        caption = string.format('%s - %s of %s', label, megabytes(e.received), megabytes(e.total)),
      }
    end
    return { caption = string.format('%s - %s', label, megabytes(e.received)) }
  end
  return { caption = detail and (label .. ' - ' .. detail) or label }
end

return Progress
