--[[
Runs the shoots binary over a list of photographs and returns its decoded
`--json` report. Must be called from inside an async task (LrTasks).
]]

local LrFileUtils = import 'LrFileUtils'
local LrPathUtils = import 'LrPathUtils'
local LrPrefs = import 'LrPrefs'
local LrTasks = import 'LrTasks'

local Command = require 'Command'
local Json = require 'Json'

local Runner = {}

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

local function tempFile(name)
  local dir = LrPathUtils.getStandardFilePath('temp')
  return LrFileUtils.chooseUniqueFileName(LrPathUtils.child(dir, name))
end

local function writeText(path, text)
  local f = assert(io.open(path, 'wb'))
  f:write(text)
  f:close()
end

--- Run `shoots <args>` where makeArgs(listPath) builds the arguments around a
--- file listing `paths`. Returns report, or nil and a readable error.
function Runner.run(binary, makeArgs, paths)
  local listPath = tempFile('shoots-selection.txt')
  local outPath = tempFile('shoots-out.json')
  local errPath = tempFile('shoots-err.txt')
  writeText(listPath, table.concat(paths, '\n') .. '\n')

  local line = Command.build(Runner.platform(), binary, makeArgs(listPath), outPath, errPath)
  local exitCode = LrTasks.execute(line)

  local stdout = LrFileUtils.exists(outPath) and LrFileUtils.readFile(outPath) or ''
  local stderr = LrFileUtils.exists(errPath) and LrFileUtils.readFile(errPath) or ''
  for _, p in ipairs({ listPath, outPath, errPath }) do
    if LrFileUtils.exists(p) then LrFileUtils.delete(p) end
  end

  -- Exit code 1 still carries a full report (some files failed); only a report
  -- that does not parse is a failure of the run itself.
  local ok, report = pcall(Json.decode, stdout)
  if ok and type(report) == 'table' then return report end
  local detail = stderr ~= '' and stderr or ('exit code ' .. tostring(exitCode))
  return nil, detail
end

return Runner
