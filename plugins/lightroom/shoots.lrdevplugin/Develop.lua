--[[
Turns a decoded `develop apply` report into what the plug-in applies, keyed by
photo path. Pure Lua, no Lightroom imports: DevelopSelection.lua does the reading
and the writing.
]]

local Results = require 'Results'

local Develop = {}

local function list(value)
  if type(value) == 'table' then return value end
  return {}
end

--- How many predicted photos already carry an edit.
function Develop.editedCount(report)
  local n = 0
  for _, r in ipairs(list(report.results)) do
    if r.edited then n = n + 1 end
  end
  return n
end

--- report -> { [key] = settings }, and counts. `replaceEdited` false skips photos
--- that already carry an edit. `looks` maps a creative profile's name to the Look
--- table a catalog photo carries, for predictions that name their Look only.
function Develop.plan(report, platform, replaceEdited, looks)
  local changes = {}
  local counts = { applied = 0, skipped = 0, noLook = 0, failed = #list(report.errors) }
  for _, r in ipairs(list(report.results)) do
    if type(r.file) == 'string' and type(r.settings) == 'table' then
      if r.edited and not replaceEdited then
        counts.skipped = counts.skipped + 1
      else
        local settings = r.settings
        if settings.Look == nil and type(r.look) == 'string' then
          local look = looks and looks[r.look]
          if look then settings.Look = look else counts.noLook = counts.noLook + 1 end
        end
        changes[Results.pathKey(r.file, platform)] = settings
        counts.applied = counts.applied + 1
      end
    end
  end
  return changes, counts
end

--- One line for the end-of-run dialog.
function Develop.summary(counts, profile)
  local text = string.format('%d developed with profile %s', counts.applied, tostring(profile))
  if counts.skipped > 0 then text = text .. string.format(', %d already edited left as they were', counts.skipped) end
  if counts.failed > 0 then text = text .. string.format(', %d failed', counts.failed) end
  text = text .. '.'
  if counts.noLook > 0 then
    text = text .. string.format(
      '\n\n%d photos did not get their creative profile: no photo in the selection uses it, so they keep the base profile only.',
      counts.noLook
    )
  end
  return text
end

return Develop
