--[[
Values as photo:setRawMetadata accepts them. Pure Lua, no Lightroom imports.

shoots speaks of "0 stars"; Lightroom rejects a rating of 0 ("Invalid rating 0")
and clears the stars with nil instead.
]]

local RawMetadata = {}

--- The value to hand setRawMetadata for `field`.
function RawMetadata.value(field, value)
  if field == 'rating' and value == 0 then return nil end
  return value
end

return RawMetadata
