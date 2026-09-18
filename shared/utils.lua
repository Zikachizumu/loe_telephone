--[[
    shared/utils.lua
    ----------------
    Client ve server'ın ortak kullandığı, yan etkisiz yardımcılar.
    LoeTelephone.Utils üzerinden erişilir.

    Numara doğrulama/format mantığının TEK kaynağı burasıdır; hem NUI (client)
    hem de sunucu tarafı doğrulama aynı fonksiyonları kullanır.
]]

LoeTelephone = LoeTelephone or {}

local Config = LoeTelephone.Config
local Utils  = {}

--- Sadece Config.debug açıkken konsola log basar.
function Utils.log(...)
    if Config and Config.debug then
        print('^5[loe_telephone]^7', ...)
    end
end

--- Kullanıcının girdiği telefon numarasını normalize eder: boşluk/tire atar.
--- Geçerli numara TAM `Config.sim.numberLength` haneli, yalnızca rakamdır
--- (baştaki sıfırlar korunur — numara bir metindir, sayı değil).
--- @param value any
--- @return string|nil
function Utils.validNumber(value)
    if type(value) == 'number' then value = tostring(math.floor(value)) end
    if type(value) ~= 'string' then return nil end

    local digits = value:gsub('[%s%-]', '')
    local len = (Config and Config.sim and Config.sim.numberLength) or 8

    if #digits ~= len then return nil end
    if not digits:match('^%d+$') then return nil end

    return digits
end

--- Numarayı okunabilir biçime çevirir: "12345678" -> "1234 5678".
--- @param number string
--- @return string
function Utils.formatNumber(number)
    if type(number) ~= 'string' then return '' end
    local half = math.ceil(#number / 2)
    return number:sub(1, half) .. ' ' .. number:sub(half + 1)
end

--- Rehber ismi doğrular: boş olamaz, Config.contacts.nameMaxLength'i aşamaz,
--- kontrol karakterleri temizlenir. Geçersizse nil.
--- @param value any
--- @return string|nil
function Utils.validContactName(value)
    if type(value) ~= 'string' then return nil end
    local name = value:gsub('[%c]', ''):gsub('^%s+', ''):gsub('%s+$', '')
    if name == '' then return nil end
    local maxLen = (Config and Config.contacts and Config.contacts.nameMaxLength) or 32
    if #name > maxLen then name = name:sub(1, maxLen) end
    return name
end

--- Mesaj gövdesi doğrular: boş olamaz, uzunluk sınırı, kontrol karakteri temizlenir.
--- @param value any
--- @return string|nil
function Utils.validMessageBody(value)
    if type(value) ~= 'string' then return nil end
    local body = value:gsub('[%c]', ''):gsub('^%s+', ''):gsub('%s+$', '')
    if body == '' then return nil end
    local maxLen = (Config and Config.messages and Config.messages.bodyMaxLength) or 400
    if #body > maxLen then body = body:sub(1, maxLen) end
    return body
end

--- Telegram grup adı doğrular: boş olamaz, Config.telegram.groupNameMaxLength'i
--- aşamaz, kontrol karakterleri temizlenir. Geçersizse nil.
--- @param value any
--- @return string|nil
function Utils.validGroupName(value)
    if type(value) ~= 'string' then return nil end
    local name = value:gsub('[%c]', ''):gsub('^%s+', ''):gsub('%s+$', '')
    if name == '' then return nil end
    local maxLen = (Config and Config.telegram and Config.telegram.groupNameMaxLength) or 32
    if #name > maxLen then name = name:sub(1, maxLen) end
    return name
end

--- Telegram grup mesajı doğrular: boş olamaz, uzunluk sınırı, kontrol karakteri temizlenir.
--- @param value any
--- @return string|nil
function Utils.validGroupMessageBody(value)
    if type(value) ~= 'string' then return nil end
    local body = value:gsub('[%c]', ''):gsub('^%s+', ''):gsub('%s+$', '')
    if body == '' then return nil end
    local maxLen = (Config and Config.telegram and Config.telegram.groupMessageMaxLength) or 400
    if #body > maxLen then body = body:sub(1, maxLen) end
    return body
end

--- Mesaja eklenen fotoğrafın data URL'ini doğrular: "data:image/" ile
--- başlamalı ve Config.messages.photoMaxLength'i aşamaz. Geçersizse nil.
--- @param value any
--- @return string|nil
function Utils.validPhotoData(value)
    if type(value) ~= 'string' then return nil end
    if not value:match('^data:image/') then return nil end
    local maxLen = (Config and Config.messages and Config.messages.photoMaxLength) or 1500000
    if #value > maxLen then return nil end
    return value
end

--- Mesaja eklenen konumu doğrular: "x,y" biçiminde iki ondalık sayı.
--- Geçersizse nil.
--- @param value any
--- @return string|nil
function Utils.validLocation(value)
    if type(value) ~= 'string' then return nil end
    local x, y = value:match('^(-?%d+%.?%d*),(-?%d+%.?%d*)$')
    if not x or not y then return nil end
    return ('%.1f,%.1f'):format(tonumber(x), tonumber(y))
end

LoeTelephone.Utils = Utils
