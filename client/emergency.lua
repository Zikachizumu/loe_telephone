--[[
    client/emergency.lua
    --------------------
    Emergency uygulamasının NUI köprüsü (server/emergency.lua). Burada hiçbir şeye karar verilmez:
    kimlerin ulaşılabilir olduğunu, raporu ve aramayı sunucu yapar.
]]

RegisterNUICallback('emergencyList', function(_, cb)
    cb(lib.callback.await('loe_telephone:emergencyList', false))
end)

RegisterNUICallback('emergencyWrite', function(data, cb)
    data = type(data) == 'table' and data or {}
    cb(lib.callback.await('loe_telephone:emergencyWrite', false, data.id, data.text))
end)

RegisterNUICallback('emergencyCall', function(data, cb)
    data = type(data) == 'table' and data or {}
    cb(lib.callback.await('loe_telephone:emergencyCall', false, data.id))
end)
