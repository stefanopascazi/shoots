--[[
Minimal JSON decoder for the CLI's `--json` output. Pure Lua 5.1, no Lightroom
imports, so it runs under the unit tests as well as inside Lightroom.

`null` decodes to Json.null (a sentinel) rather than nil, so arrays keep their
length and a present-but-null key stays distinguishable from a missing one.
]]

local Json = {}

Json.null = setmetatable({}, { __tostring = function() return 'null' end })

local escapes = { ['"'] = '"', ['\\'] = '\\', ['/'] = '/', b = '\b', f = '\f', n = '\n', r = '\r', t = '\t' }

local function utf8char(code)
  if code < 0x80 then
    return string.char(code)
  elseif code < 0x800 then
    return string.char(0xC0 + math.floor(code / 0x40), 0x80 + code % 0x40)
  elseif code < 0x10000 then
    return string.char(0xE0 + math.floor(code / 0x1000), 0x80 + math.floor(code / 0x40) % 0x40, 0x80 + code % 0x40)
  end
  return string.char(
    0xF0 + math.floor(code / 0x40000),
    0x80 + math.floor(code / 0x1000) % 0x40,
    0x80 + math.floor(code / 0x40) % 0x40,
    0x80 + code % 0x40
  )
end

local function fail(text, pos, what)
  error(string.format('invalid JSON at %d: %s', pos, what), 0)
end

local function skip(text, pos)
  return string.find(text, '[^ \t\r\n]', pos) or (#text + 1)
end

local parseValue

local function parseString(text, pos)
  -- pos points at the opening quote.
  local parts, i = {}, pos + 1
  while true do
    local c = string.sub(text, i, i)
    if c == '' then fail(text, i, 'unterminated string') end
    if c == '"' then return table.concat(parts), i + 1 end
    if c == '\\' then
      local e = string.sub(text, i + 1, i + 1)
      if e == 'u' then
        local code = tonumber(string.sub(text, i + 2, i + 5), 16)
        if not code then fail(text, i, 'bad \\u escape') end
        i = i + 6
        -- A high surrogate must pair with the low one that follows it.
        if code >= 0xD800 and code <= 0xDBFF and string.sub(text, i, i + 1) == '\\u' then
          local low = tonumber(string.sub(text, i + 2, i + 5), 16)
          if low and low >= 0xDC00 and low <= 0xDFFF then
            code = 0x10000 + (code - 0xD800) * 0x400 + (low - 0xDC00)
            i = i + 6
          end
        end
        parts[#parts + 1] = utf8char(code)
      else
        local r = escapes[e]
        if not r then fail(text, i, 'bad escape') end
        parts[#parts + 1] = r
        i = i + 2
      end
    else
      local j = string.find(text, '["\\]', i) or (#text + 1)
      parts[#parts + 1] = string.sub(text, i, j - 1)
      i = j
    end
  end
end

local function parseArray(text, pos)
  local out, n = {}, 0
  pos = skip(text, pos + 1)
  if string.sub(text, pos, pos) == ']' then return out, pos + 1 end
  while true do
    local value
    value, pos = parseValue(text, pos)
    n = n + 1
    out[n] = value
    pos = skip(text, pos)
    local c = string.sub(text, pos, pos)
    if c == ']' then return out, pos + 1 end
    if c ~= ',' then fail(text, pos, "expected ',' or ']'") end
    pos = skip(text, pos + 1)
  end
end

local function parseObject(text, pos)
  local out = {}
  pos = skip(text, pos + 1)
  if string.sub(text, pos, pos) == '}' then return out, pos + 1 end
  while true do
    if string.sub(text, pos, pos) ~= '"' then fail(text, pos, 'expected a key') end
    local key
    key, pos = parseString(text, pos)
    pos = skip(text, pos)
    if string.sub(text, pos, pos) ~= ':' then fail(text, pos, "expected ':'") end
    local value
    value, pos = parseValue(text, skip(text, pos + 1))
    out[key] = value
    pos = skip(text, pos)
    local c = string.sub(text, pos, pos)
    if c == '}' then return out, pos + 1 end
    if c ~= ',' then fail(text, pos, "expected ',' or '}'") end
    pos = skip(text, pos + 1)
  end
end

parseValue = function(text, pos)
  pos = skip(text, pos)
  local c = string.sub(text, pos, pos)
  if c == '{' then return parseObject(text, pos) end
  if c == '[' then return parseArray(text, pos) end
  if c == '"' then return parseString(text, pos) end
  if string.sub(text, pos, pos + 3) == 'true' then return true, pos + 4 end
  if string.sub(text, pos, pos + 4) == 'false' then return false, pos + 5 end
  if string.sub(text, pos, pos + 3) == 'null' then return Json.null, pos + 4 end
  local num = string.match(text, '^-?%d+%.?%d*[eE]?[-+]?%d*', pos)
  if num and num ~= '' and num ~= '-' then
    local value = tonumber(num)
    if value then return value, pos + #num end
  end
  fail(text, pos, 'unexpected character')
end

--- Decode a JSON document. Raises a string error on malformed input.
function Json.decode(text)
  if type(text) ~= 'string' then error('invalid JSON: not a string', 0) end
  local value, pos = parseValue(text, 1)
  pos = skip(text, pos)
  if pos <= #text then fail(text, pos, 'trailing characters') end
  return value
end

return Json
