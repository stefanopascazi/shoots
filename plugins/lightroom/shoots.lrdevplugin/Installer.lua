--[[
Getting the shoots binary onto the machine and keeping it current: install
when missing, update when older than this plug-in, and download the tools and
models the commands need (`shoots setup`). Call from inside an async task.
]]

local LrDialogs = import 'LrDialogs'
local LrFunctionContext = import 'LrFunctionContext'
local LrPathUtils = import 'LrPathUtils'
local LrProgressScope = import 'LrProgressScope'

local Command = require 'Command'
local PluginVersion = require 'PluginVersion'
local Runner = require 'Runner'
local Version = require 'Version'

local Installer = {}

--- The CLI version this plug-in was built against; the installed one must be at least this.
function Installer.requiredVersion()
  return PluginVersion
end

local function scopeFor(context, title)
  local scope = LrProgressScope { title = title, functionContext = context }
  scope:setCancelable(false)
  scope:setIndeterminate()
  return scope
end

--- Run the official installer. Returns true when the binary is in place afterwards.
function Installer.install(context)
  local scope = scopeFor(context, 'Installing shoots')
  scope:setCaption('Downloading the shoots binary')
  local platform = Runner.platform()
  -- Install where the plug-in looks, which honours a custom path from the Plug-in Manager.
  local installDir = LrPathUtils.parent(Runner.binary())
  local exitCode, _, stderr = Runner.execute(function(out, err)
    return Command.installLine(platform, out, err, { SHOOTS_INSTALL_DIR = installDir })
  end)
  scope:done()
  if Runner.isInstalled() then return true end
  LrDialogs.message('Installing shoots failed', (stderr ~= '' and stderr) or ('exit code ' .. tostring(exitCode)), 'critical')
  return false
end

--- `shoots update`. Returns true on success (including already up to date).
function Installer.update(context)
  local scope = scopeFor(context, 'Updating shoots')
  local report, err = Runner.run(Command.updateArgs(), scope)
  scope:done()
  if not report then
    LrDialogs.message('Updating shoots failed', err, 'critical')
    return false
  end
  return true, report
end

--- `shoots setup`: exiftool, the raw decoder and the inference model.
function Installer.setup(context)
  local scope = scopeFor(context, 'Downloading shoots dependencies')
  local report, err = Runner.run(Command.setupArgs(), scope)
  scope:done()
  if not report then
    LrDialogs.message('Downloading dependencies failed', err, 'critical')
    return false
  end
  local missing = {}
  for _, tool in ipairs(type(report.tools) == 'table' and report.tools or {}) do
    if tool.ok ~= true then missing[#missing + 1] = tostring(tool.name) end
  end
  if #missing > 0 then
    LrDialogs.message('Some dependencies are not available', table.concat(missing, ', '), 'warning')
  end
  return true
end

--- Before any command: offer to install when missing, to update when too old.
--- Returns true when the run can go ahead.
function Installer.ensureReady(context)
  if not Runner.isInstalled() then
    local answer = LrDialogs.confirm(
      'shoots is not installed',
      'The plug-in needs the shoots command-line tool. Download and install it now?\n\nIt goes to '
        .. Runner.binary() .. ' and runs only on this machine.',
      'Install'
    )
    if answer ~= 'ok' or not Installer.install(context) then return false end
  end

  local required = Installer.requiredVersion()
  local installed = Runner.installedVersion()
  if not Version.satisfies(installed, required) then
    local answer = LrDialogs.confirm(
      'shoots needs an update',
      string.format('This plug-in needs shoots %s or later; the installed one is %s. Update now?', required, installed or 'unknown'),
      'Update'
    )
    if answer ~= 'ok' or not Installer.update(context) then return false end
  end
  return true
end

--- Menu / button: install when missing, otherwise update. Reports the outcome.
function Installer.installOrUpdate()
  LrFunctionContext.postAsyncTaskWithContext('shoots: Install or Update', function(context)
    LrDialogs.attachErrorDialogToFunctionContext(context)
    if not Runner.isInstalled() then
      if Installer.install(context) then
        LrDialogs.message('shoots installed', 'Version ' .. tostring(Runner.installedVersion()), 'info')
      end
      return
    end
    local ok, report = Installer.update(context)
    if not ok then return end
    if report.installed then
      LrDialogs.message('shoots updated', 'Now on ' .. tostring(report.latest), 'info')
    else
      LrDialogs.message('shoots is up to date', 'Version ' .. tostring(report.current), 'info')
    end
  end)
end

--- Menu / button: `shoots setup`, installing the binary first if needed.
function Installer.setupDependencies()
  LrFunctionContext.postAsyncTaskWithContext('shoots: Download Dependencies', function(context)
    LrDialogs.attachErrorDialogToFunctionContext(context)
    if not Installer.ensureReady(context) then return end
    if Installer.setup(context) then
      LrDialogs.message('shoots dependencies are ready', 'exiftool and the models are downloaded.', 'info')
    end
  end)
end

return Installer
