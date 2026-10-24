--[[
    server/emergency.lua
    --------------------
    Emergency uygulaması: polis, EMS ... ulaşılabilir kurumların listesi, bir kuruma yazılı rapor, kurumun
    dispatcher'ını arama.

    Kurumları, raporu ve dispatcher'ı loe_jobcreator bilir (exports.loe_jobcreator:EmergencyServices /
    EmergencyReport / EmergencyDial); burada yalnızca telefon tarafı var. Client'tan yalnızca "hangi kurum"
    ve "ne yazdı" gelir: raporun yeri ve arayan numara loe_jobcreator'da sunucunun bildiği yerden ve
    karakterin aktif hattından alınır, client'a güvenilmez.

    Arama normal aramayla aynı yoldan gider (LoeTelephone.startCall, server/main.lua): dispatcher'ın telefonu
    çalar, kabul ederse ses kanalı kurulur.

    loe_jobcreator yoksa uygulama "kullanılamıyor" der.
]]

local Config = LoeTelephone.Config
local Utils  = LoeTelephone.Utils

local function jobcreatorUp()
    return GetResourceState('loe_jobcreator') == 'started'
end

--- Karakterin O AN aktif hattı (yoksa nil). loe_jobcreator, raporun "arayan numarası" için sorar.
exports('GetActiveNumber', function(source)
    local ok, player = pcall(function() return exports.qbx_core:GetPlayer(source) end)
    if not ok or not player then return nil end

    local row = MySQL.single.await(
        ('SELECT `number` FROM `%s` WHERE `citizenid` = ? AND `active` = 1 LIMIT 1'):format(Config.db.numbers),
        { player.PlayerData.citizenid }
    )

    return row and row.number or nil
end)

local UNAVAILABLE = { success = false, reason = 'The emergency lines are not available right now.' }

lib.callback.register('loe_telephone:emergencyList', function()
    if not jobcreatorUp() then return UNAVAILABLE end

    local ok, services = pcall(function() return exports.loe_jobcreator:EmergencyServices() end)
    if not ok or type(services) ~= 'table' then return UNAVAILABLE end

    local out = {}
    for _, service in ipairs(services) do
        out[#out + 1] = {
            id = tostring(service.id),
            label = tostring(service.label),
            kind = service.kind == 'ems' and 'ems' or 'police',
            units = tonumber(service.units) or 0,
            dispatcher = service.dispatcher == true,
        }
    end

    return { success = true, services = out }
end)

lib.callback.register('loe_telephone:emergencyWrite', function(source, id, text)
    if not jobcreatorUp() then return UNAVAILABLE end
    if type(id) ~= 'string' or type(text) ~= 'string' then return { success = false, reason = 'Say what is happening.' } end

    local ok, result = pcall(function() return exports.loe_jobcreator:EmergencyReport(source, id, text) end)
    if not ok or type(result) ~= 'table' then return UNAVAILABLE end

    return { success = result.ok == true, reason = result.text }
end)

lib.callback.register('loe_telephone:emergencyCall', function(source, id)
    if not jobcreatorUp() then return UNAVAILABLE end
    if type(id) ~= 'string' then return { success = false, reason = 'Pick who to call.' } end

    local ok, result = pcall(function() return exports.loe_jobcreator:EmergencyDial(source, id) end)
    if not ok or type(result) ~= 'table' then return UNAVAILABLE end
    if not result.ok then return { success = false, reason = result.text } end

    local number = Utils.validNumber(result.number)
    if not number then return { success = false, reason = 'The dispatcher has no phone line. Write a report instead.' } end

    local started = LoeTelephone.startCall(source, number)
    if not started or not started.success then
        return { success = false, reason = 'The call did not go through: you need an active line, and the dispatcher has to be reachable. Write a report instead.' }
    end

    return started
end)
