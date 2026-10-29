-- Plug-in Manager panel: the shared shoots settings section.
local SettingsSection = require 'SettingsSection'

return {
  sectionsForTopOfDialog = function(f, propertyTable)
    return { SettingsSection.build(f, propertyTable) }
  end,
}
