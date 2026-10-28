--[[
Builds the shell line LrTasks.execute runs. Pure Lua, no Lightroom imports.

LrTasks.execute hands the string to cmd.exe on Windows and /bin/sh on macOS,
and the two quote differently. cmd.exe also strips the first and last quote of
a line that starts with one, so a Windows line is wrapped in one extra pair.
]]

local Command = {}

local function quoteWindows(arg)
  -- Paths cannot contain '"' on Windows; doubling covers any other argument.
  return '"' .. string.gsub(arg, '"', '""') .. '"'
end

local function quotePosix(arg)
  return "'" .. string.gsub(arg, "'", "'\\''") .. "'"
end

--- Quote one argument for the given platform ('windows' or 'posix').
function Command.quote(arg, platform)
  if platform == 'windows' then return quoteWindows(arg) end
  return quotePosix(arg)
end

--- The full line: executable, arguments, stdout and stderr each sent to a file.
function Command.build(platform, executable, args, stdoutPath, stderrPath)
  local parts = { Command.quote(executable, platform) }
  for _, arg in ipairs(args) do
    parts[#parts + 1] = Command.quote(arg, platform)
  end
  local line = table.concat(parts, ' ')
    .. ' > ' .. Command.quote(stdoutPath, platform)
    .. ' 2> ' .. Command.quote(stderrPath, platform)
  if platform == 'windows' then return '"' .. line .. '"' end
  return line
end

--- Arguments for `shoots cull` over a selection list. Nothing is moved or marked:
--- the plugin writes the verdict into the catalog itself.
function Command.cullArgs(listPath)
  return { 'cull', '--files-from', listPath, '--json' }
end

--- Arguments for `shoots rate` over a selection list. `--dry-run` keeps the CLI
--- from writing JSON sidecars beside the photographs: the catalog is the target.
function Command.rateArgs(listPath, profile)
  return { 'rate', '--files-from', listPath, '--profile', profile, '--dry-run', '--json' }
end

return Command
