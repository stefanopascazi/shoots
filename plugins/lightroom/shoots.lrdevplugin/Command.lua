--[[
Builds the shell line LrTasks.execute runs. Pure Lua, no Lightroom imports.

LrTasks.execute hands the string to cmd.exe on Windows and /bin/sh on macOS,
and the two quote differently. cmd.exe also strips the first and last quote of
a line that starts with one, so a Windows line is wrapped in one extra pair.
]]

local Command = {}

Command.INSTALL_PS1 = 'https://www.shoots-ai.com/install.ps1'
Command.INSTALL_SH = 'https://www.shoots-ai.com/install.sh'

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

-- Environment assignments in front of the command, in a stable order.
local function envPrefix(platform, env)
  if not env then return '' end
  local names = {}
  for name in pairs(env) do names[#names + 1] = name end
  table.sort(names)
  local parts = {}
  for _, name in ipairs(names) do
    if platform == 'windows' then
      parts[#parts + 1] = 'set "' .. name .. '=' .. env[name] .. '" && '
    else
      parts[#parts + 1] = name .. '=' .. quotePosix(env[name]) .. ' '
    end
  end
  return table.concat(parts)
end

local function finish(platform, line, env, stdoutPath, stderrPath)
  line = envPrefix(platform, env) .. line
    .. ' > ' .. Command.quote(stdoutPath, platform)
    .. ' 2> ' .. Command.quote(stderrPath, platform)
  if platform == 'windows' then return '"' .. line .. '"' end
  return line
end

--- The full line: executable and arguments, optional env, stdout and stderr each sent to a file.
function Command.build(platform, executable, args, stdoutPath, stderrPath, env)
  local parts = { Command.quote(executable, platform) }
  for _, arg in ipairs(args) do
    parts[#parts + 1] = Command.quote(arg, platform)
  end
  return finish(platform, table.concat(parts, ' '), env, stdoutPath, stderrPath)
end

--- The line that runs the official installer (download, SHA-256 check, PATH).
--- `env.SHOOTS_INSTALL_DIR` picks where the binary lands.
function Command.installLine(platform, stdoutPath, stderrPath, env)
  local line
  if platform == 'windows' then
    line = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ' .. Command.INSTALL_PS1 .. ' | iex"'
  else
    line = "/bin/bash -c 'curl -fsSL " .. Command.INSTALL_SH .. " | bash'"
  end
  return finish(platform, line, env, stdoutPath, stderrPath)
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

--- Arguments for `shoots develop apply` over a catalog export of the selection.
--- Prints the predicted settings; the plugin applies them to the catalog.
function Command.developArgs(catalogPath)
  return { 'develop', 'apply', '--catalog', catalogPath, '--json' }
end

--- Arguments that start the local web app server. Hidden from the CLI's help:
--- only this plug-in starts it.
function Command.appArgs() return { 'app' } end

--- A line that starts `executable args` in the background and returns at once,
--- so LrTasks.execute does not wait for the server. Output goes to `logPath`.
function Command.detachedLine(platform, executable, args, logPath)
  local parts = { Command.quote(executable, platform) }
  for _, arg in ipairs(args) do
    parts[#parts + 1] = Command.quote(arg, platform)
  end
  local line = table.concat(parts, ' ')
  local log = Command.quote(logPath, platform)
  if platform == 'windows' then
    -- 'start' returns immediately; /B keeps the server windowless. The line starts
    -- with a letter, so cmd.exe leaves its quotes alone.
    return 'start "" /B ' .. line .. ' > ' .. log .. ' 2>&1'
  end
  return 'nohup ' .. line .. ' > ' .. log .. ' 2>&1 &'
end

--- The line that ends a running CLI by its pid (from the progress file), with
--- any child it started. Used to cancel: LrTasks.execute gives no handle on it.
function Command.killLine(platform, pid)
  local n = string.format('%d', pid)
  if platform == 'windows' then return 'taskkill /PID ' .. n .. ' /T /F' end
  return 'kill ' .. n
end

function Command.updateArgs() return { 'update', '--json' } end
function Command.setupArgs() return { 'setup', '--json' } end
function Command.versionArgs() return { '--version' } end

return Command
