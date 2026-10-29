--[[
Turns a decoded `cull` / `rate` report into catalog changes, keyed by photo
path. Pure Lua, no Lightroom imports: the glue applies what this returns.
]]

local Results = {}

--- A path as a lookup key. Windows paths compare case-insensitively and with
--- either separator; elsewhere the path is taken as is.
function Results.pathKey(p, platform)
  if platform == 'windows' then
    return string.lower((string.gsub(p, '/', '\\')))
  end
  return p
end

local function list(value)
  if type(value) == 'table' then return value end
  return {}
end

--- `cull` report -> { [key] = { pickStatus = -1 } } for every blurry frame.
--- Sharp frames get no change: a keeper keeps whatever flag the user gave it.
function Results.cullChanges(report, platform)
  local changes, rejected, kept = {}, 0, 0
  for _, r in ipairs(list(report.results)) do
    if r.verdict == 'blurry' then
      changes[Results.pathKey(r.file, platform)] = { pickStatus = -1 }
      rejected = rejected + 1
    else
      kept = kept + 1
    end
  end
  return changes, { rejected = rejected, kept = kept, failed = #list(report.errors) }
end

--- `rate` report -> { [key] = { rating = n } }, n clamped to Lightroom's 0..5.
function Results.rateChanges(report, platform)
  local changes, rated = {}, 0
  for _, r in ipairs(list(report.results)) do
    local stars = tonumber(r.stars)
    if stars then
      stars = math.max(0, math.min(5, math.floor(stars + 0.5)))
      changes[Results.pathKey(r.file, platform)] = { rating = stars }
      rated = rated + 1
    end
  end
  return changes, { rated = rated, failed = #list(report.errors) }
end

--- One line for the end-of-run dialog.
function Results.summary(command, counts)
  local text
  if command == 'cull' then
    text = string.format('%d rejected as blurry, %d kept', counts.rejected, counts.kept)
  else
    text = string.format('%d rated', counts.rated)
  end
  if counts.failed > 0 then
    text = text .. string.format(', %d failed', counts.failed)
  end
  return text .. '.'
end

return Results
