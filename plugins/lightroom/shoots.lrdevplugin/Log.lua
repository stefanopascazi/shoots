--[[
The plug-in's log file: Documents\LrClassicLogs\shoots.log on Windows,
~/Documents/LrClassicLogs/shoots.log on macOS.
]]

local LrLogger = import 'LrLogger'

local logger = LrLogger('shoots')
logger:enable('logfile')

local Log = {}

function Log.info(...) logger:info(...) end
function Log.error(...) logger:error(...) end

return Log
