--[[
Runs the shoots binary and returns its decoded `--json` report, driving a
progress scope from the file the CLI appends progress to. Must be called from
inside an async task (LrTasks).
]]

local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local LrPrefs = import 'LrPrefs'
local LrTasks = import 'LrTasks'

local Command = require 'Command'
local Json = require 'Json'
local Progress = require 'Progress'

local Runner = {}

local POLL_SECONDS = 0.3

--- The error Runner.run returns when the user cancelled the progress scope.
Runner.CANCELED = 'canceled'

function Runner.platform()
  return WIN_ENV and 'windows' or 'posix'
end

--- The binary the installer puts in ~/.shoots/bin, unless the user set a path
--- in the Plug-in Manager.
function Runner.binary()
  local configured = LrPrefs.prefsForPlugin().binaryPath
  if configured and configured ~= '' then return configured end
  local home = LrPathUtils.getStandardFilePath('home')
  local bin = LrPathUtils.child(LrPathUtils.child(home, '.shoots'), 'bin')
  return LrPathUtils.child(bin, WIN_ENV and 'shoots.exe' or 'shoots')
end

function Runner.isInstalled()
  return LrFileUtils.exists(Runner.binary()) == 'file'
end

local function tempFile(name)
  local dir = LrPathUtils.getStandardFilePath('temp')
  return LrFileUtils.chooseUniqueFileName(LrPathUtils.child(dir, name))
end

local function writeText(path, text)
  local f = assert(io.open(path, 'wb'))
  f:write(text)
  f:close()
end

local function readText(path)
  if LrFileUtils.exists(path) then return LrFileUtils.readFile(path) or '' end
  return ''
end

local function cleanup(paths)
  for _, p in ipairs(paths) do
    if LrFileUtils.exists(p) then LrFileUtils.delete(p) end
  end
end

--[[
Run `makeLine(stdoutPath, stderrPath, env)` and wait for it, updating `scope`
(an LrProgressScope, optional) from the progress file meanwhile.
LrTasks.execute blocks its task until exit, so it runs in a task of its own
while this one polls. A cancelled scope kills the CLI by the pid it wrote
first. Returns exitCode, stdout, stderr, canceled.
]]
function Runner.execute(makeLine, scope)
  local outPath = tempFile('shoots-out.json')
  local errPath = tempFile('shoots-err.txt')
  local progressPath = tempFile('shoots-progress.jsonl')
  local line = makeLine(outPath, errPath, { SHOOTS_PROGRESS_FILE = progressPath })

  local finished, exitCode = false, nil
  LrTasks.startAsyncTask(function()
    exitCode = LrTasks.execute(line)
    finished = true
  end)

  local canceled = false
  while not finished do
    LrTasks.sleep(POLL_SECONDS)
    if scope then
      local text = readText(progressPath)
      -- Before the pid is written there is nothing to kill yet: try again next poll.
      if not canceled and scope:isCanceled() then
        local pid = Progress.pid(text)
        if pid then
          LrTasks.execute(Command.killLine(Runner.platform(), pid))
          canceled = true
        end
      end
      local state = not canceled and Progress.parse(text)
      if state then
        if state.fraction then scope:setPortionComplete(state.fraction, 1) else scope:setIndeterminate() end
        scope:setCaption(state.caption)
      end
    end
  end

  local stdout, stderr = readText(outPath), readText(errPath)
  cleanup({ outPath, errPath, progressPath })
  return exitCode, stdout, stderr, canceled
end

local function decode(exitCode, stdout, stderr, canceled)
  if canceled then return nil, Runner.CANCELED end
  -- Exit code 1 still carries a full report (some files failed); only a report
  -- that does not parse is a failure of the run itself.
  local ok, report = pcall(Json.decode, stdout)
  if ok and type(report) == 'table' then return report end
  return nil, (stderr ~= '' and stderr) or ('exit code ' .. tostring(exitCode))
end

--- Run `shoots <args>`; returns report, or nil and a readable error (Runner.CANCELED on cancel).
function Runner.run(args, scope)
  local binary, platform = Runner.binary(), Runner.platform()
  return decode(Runner.execute(function(out, err, env)
    return Command.build(platform, binary, args, out, err, env)
  end, scope))
end

--- Run `shoots <makeArgs(listPath)>` over a file listing `paths`.
function Runner.runOnFiles(makeArgs, paths, scope)
  local listPath = tempFile('shoots-selection.txt')
  writeText(listPath, table.concat(paths, '\n') .. '\n')
  local report, err = Runner.run(makeArgs(listPath), scope)
  cleanup({ listPath })
  return report, err
end

--- The installed CLI's version string, or nil.
function Runner.installedVersion()
  if not Runner.isInstalled() then return nil end
  local binary, platform = Runner.binary(), Runner.platform()
  local _, stdout = Runner.execute(function(out, err)
    return Command.build(platform, binary, Command.versionArgs(), out, err)
  end)
  local v = string.match(stdout or '', '%d+%.%d+%.%d+[%w%.%-]*')
  return v
end

return Runner
