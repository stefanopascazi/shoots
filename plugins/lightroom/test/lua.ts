/**
 * Runs the plug-in's pure Lua modules under fengari (a Lua VM in JS, MIT), so
 * they are tested without Lightroom. Lightroom ships Lua 5.1 and fengari is 5.3;
 * the modules stay inside the common subset.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { lauxlib, lua, lualib, to_luastring } from 'fengari';
import { SOURCE_DIR } from '../build.js';

/**
 * Evaluate `chunk` (which must `return` one value) with `require` resolving to
 * the plug-in folder, and hand back that value as JSON-decoded data. The chunk
 * gets an `encode` helper for turning Lua tables into JSON.
 */
export function runLua<T = unknown>(chunk: string): T {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const prelude = `
    package.path = ${JSON.stringify(path.join(SOURCE_DIR, '?.lua'))}
    local function encode(v)
      local t = type(v)
      if t == 'nil' then return 'null' end
      if t == 'boolean' or t == 'number' then return tostring(v) end
      if t == 'string' then
        return '"' .. (v:gsub('[%c"\\\\]', function(c) return string.format('\\\\u%04x', c:byte()) end)) .. '"'
      end
      local Json = require 'Json'
      if v == Json.null then return 'null' end
      if #v > 0 or next(v) == nil then
        local parts = {}
        for i = 1, #v do parts[i] = encode(v[i]) end
        return '[' .. table.concat(parts, ',') .. ']'
      end
      local keys = {}
      for k in pairs(v) do keys[#keys + 1] = k end
      table.sort(keys)
      local parts = {}
      for _, k in ipairs(keys) do parts[#parts + 1] = encode(k) .. ':' .. encode(v[k]) end
      return '{' .. table.concat(parts, ',') .. '}'
    end
    return encode((function() ${chunk} end)())
  `;
  if (lauxlib.luaL_dostring(L, to_luastring(prelude)) !== lua.LUA_OK) {
    throw new Error(lua.lua_tojsstring(L, -1));
  }
  return JSON.parse(lua.lua_tojsstring(L, -1)) as T;
}

/** Compile a plug-in file without running it: catches syntax errors in the Lightroom glue. */
export function compileLuaFile(file: string): string | null {
  const L = lauxlib.luaL_newstate();
  const source = readFileSync(path.join(SOURCE_DIR, file));
  if (lauxlib.luaL_loadbuffer(L, source, null, to_luastring(file)) !== lua.LUA_OK) {
    return lua.lua_tojsstring(L, -1);
  }
  return null;
}
