-- Plug-in Manager panel: where the binary lives and which rating profile to use.
local LrPrefs = import 'LrPrefs'
local LrView = import 'LrView'

local Runner = require 'Runner'

local function sectionsForTopOfDialog(f, _)
  local prefs = LrPrefs.prefsForPlugin()
  local bind = LrView.bind
  return {
    {
      title = 'shoots',
      bind_to_object = prefs,
      f:row {
        f:static_text { title = 'Binary path:', width_in_chars = 12 },
        f:edit_field { value = bind 'binaryPath', width_in_chars = 40, immediate = true },
      },
      f:row {
        f:static_text { title = '', width_in_chars = 12 },
        f:static_text { title = 'Leave empty to use ' .. Runner.binary(), fill_horizontal = 1 },
      },
      f:row {
        f:static_text { title = 'Rating profile:', width_in_chars = 12 },
        f:combo_box {
          value = bind 'profile',
          items = { 'street', 'generic', 'portrait', 'wildlife', 'wedding' },
          width_in_chars = 20,
        },
      },
    },
  }
end

return {
  sectionsForTopOfDialog = sectionsForTopOfDialog,
}
