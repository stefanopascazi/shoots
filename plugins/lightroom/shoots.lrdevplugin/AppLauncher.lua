--[[
Opening and closing the local web app.

The plug-in is the only way in: it starts the hidden `shoots app` server,
opens the browser on the one-time launch URL, and holds a lease by posting a
heartbeat while Lightroom runs. When Lightroom quits or crashes the lease
lapses and the server stops itself.
]]

local LrDialogs = import 'LrDialogs'
local LrFileUtils = import 'LrFileUtils'
local LrHttp = import 'LrHttp'
local LrPathUtils = import 'LrPathUtils'
local LrTasks = import 'LrTasks'

local AppOutbox = require 'AppOutbox'
local AppSession = require 'AppSession'
local AppSync = require 'AppSync'
local Command = require 'Command'
local Outbox = require 'Outbox'
local Runner = require 'Runner'
local Sync = require 'Sync'

local AppLauncher = {}

-- Renews the lease, applies changes sent from the app and reads back the folder
-- the app has open. Short, so both directions land within seconds; the server's
-- lease window is far longer.
local HEARTBEAT_SECONDS = 5
local START_TIMEOUT_SECONDS = 20

local function sessionPath()
  local home = LrPathUtils.getStandardFilePath('home')
  return LrPathUtils.child(LrPathUtils.child(home, '.shoots'), 'app.json')
end

local function readSession()
  local path = sessionPath()
  if LrFileUtils.exists(path) ~= 'file' then return nil end
  return AppSession.parse(LrFileUtils.readFile(path))
end

--- POST to the server; returns the reply body on a 200, else nil.
local function post(session, route)
  local body, headers = LrHttp.post(AppSession.endpoint(session, route), '{}', AppSession.headers(session), 'POST', 5)
  if body ~= nil and headers ~= nil and headers.status == 200 then return body end
  return nil
end

-- One lease loop per Lightroom session, renewing whichever server is current.
local leaseRunning = false

local function holdLease()
  if leaseRunning then return end
  leaseRunning = true
  LrTasks.startAsyncTask(function()
    local misses = 0
    while misses < 3 do
      local session = readSession()
      local reply = session and post(session, '/api/host/heartbeat')
      if reply then
        misses = 0
        if Outbox.pendingCount(reply) > 0 then pcall(AppOutbox.apply, session) end
        -- After applying, so what the app just sent reads back as already in place.
        local watch = Sync.watch(reply)
        if watch then pcall(AppSync.run, session, watch) end
      else
        misses = misses + 1
      end
      LrTasks.sleep(HEARTBEAT_SECONDS)
    end
    leaseRunning = false
  end)
end

local function startServer()
  local logPath = LrPathUtils.child(LrPathUtils.getStandardFilePath('temp'), 'shoots-app.log')
  local line = Command.detachedLine(Runner.platform(), Runner.binary(), Command.appArgs(), logPath)
  local before = readSession()
  LrTasks.execute(line)
  local waited = 0
  while waited < START_TIMEOUT_SECONDS do
    LrTasks.sleep(0.5)
    waited = waited + 0.5
    local session = readSession()
    if AppSession.isNew(before, session) and post(session, '/api/host/heartbeat') then return session end
  end
  return nil, logPath
end

--- Open the app: reuse a running server, otherwise start one. Call inside an async task.
function AppLauncher.open()
  local session = readSession()
  if not (session and post(session, '/api/host/heartbeat')) then
    local logPath
    session, logPath = startServer()
    if not session then
      LrDialogs.message('shoots could not start', 'The app server did not answer. Details are in ' .. logPath, 'critical')
      return
    end
  end
  holdLease()
  LrHttp.openUrlInBrowser(session.url)
end

--- Stop the server if one is running. Safe to call when none is.
function AppLauncher.close()
  local session = readSession()
  if session then post(session, '/api/shutdown') end
end

return AppLauncher
