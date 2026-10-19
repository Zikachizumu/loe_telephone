--[[
    client/main.lua
    ---------------
    Görevleri:
        - Yön tuşu (Yukarı) ile telefonu aç/kapat (RegisterKeyMapping).
        - NUI <-> server köprüsü (tüm ekranlar: hat, rehber, mesaj, arama).
        - SIM kullanılınca numara sorma diyaloğu (ox_lib inputDialog).
        - Gelen arama/mesaj bildirimleri — telefon kapalıyken bile gelen
          aramayı tam ekran gösterir.
        - GTA Online tarzı TAM EKRAN kamera (script cam + fare ile bakış, WASD
          ile yürüme); kareyi NUI game-view dokusundan yakalar. Gerçek sesli arama server/main.lua'da
          pma-voice (resources/[core]/pma-voice) ile yapılır — client'ta ekstra
          bir şey gerekmez.
]]

local Config = LoeTelephone.Config
local Utils  = LoeTelephone.Utils

local phoneOpen   = false
local cameraOpen  = false
local cameraHandle = nil
local activeCallId = nil
local callAnimActive = false -- arama CEVAPLANINCA true: telefon kulağa gider (ringing'te değil)

-- Kamera bölümünde tanımlanır; telefon/arama olayları kamerayı kapatabilsin diye önden bildirilir.
local stopCamera, exitCamera, refreshPhoneAnim

---------------------------------------------------------------------------
-- NUI AÇ / KAPAT
---------------------------------------------------------------------------
local function closePhone()
    if not phoneOpen then return end
    if cameraOpen then exitCamera() end
    phoneOpen = false
    SetNuiFocus(false, false)
    SendNUIMessage({ action = 'close' })
    refreshPhoneAnim() -- arama devam ediyorsa kulak animasyonu telefon kapansa da sürer
end

local function openPhone(view)
    local state = lib.callback.await('loe_telephone:getState', false)
    if not state or not state.success then
        lib.notify({ type = 'error', description = 'Telefon verisi alınamadı.' })
        return
    end

    phoneOpen = true
    SetNuiFocus(true, true) -- tam NUI odağı: fare/klavye oyuna sızmaz (yumruk/araç hareketi olmaz)
    refreshPhoneAnim()

    SendNUIMessage({
        action = 'open',
        view   = view,
        state  = state,
    })
end

local function togglePhone()
    -- Kamera açıkken telefon tuşu kameradan çıkıp telefona döner.
    if cameraOpen then return exitCamera() end
    if phoneOpen then closePhone() else openPhone('home') end
end

---------------------------------------------------------------------------
-- AÇILIŞ TUŞU
---------------------------------------------------------------------------
RegisterKeyMapping(Config.keybind.mapping, Config.keybind.description, 'keyboard', Config.keybind.defaultKey)
RegisterCommand(Config.keybind.mapping, function()
    togglePhone()
end, false)

---------------------------------------------------------------------------
-- NUI CALLBACK'LERİ — HAT
---------------------------------------------------------------------------
RegisterNUICallback('close', function(_, cb)
    closePhone()
    cb(true)
end)

RegisterNUICallback('getState', function(_, cb)
    cb(lib.callback.await('loe_telephone:getState', false))
end)

-- Marketplace App Store'dan indirilir; ayrı bir resource'un (loe_marketplace)
-- kendi tam ekran NUI'sini kullanır. Telefon kapanır, tablet onun yerine açılır.
RegisterNUICallback('openMarketplace', function(_, cb)
    closePhone()
    local ok = pcall(function() exports.loe_marketplace:open() end)
    if not ok then
        lib.notify({ type = 'error', description = 'Marketplace açılamadı.' })
        openPhone('home')
    end
    cb(true)
end)

RegisterNUICallback('setActiveLine', function(number, cb)
    cb(lib.callback.await('loe_telephone:setActiveLine', false, number))
end)

---------------------------------------------------------------------------
-- NUI CALLBACK'LERİ — REHBER
---------------------------------------------------------------------------
RegisterNUICallback('getContacts', function(_, cb)
    cb(lib.callback.await('loe_telephone:getContacts', false))
end)

RegisterNUICallback('addContact', function(data, cb)
    cb(lib.callback.await('loe_telephone:addContact', false, data))
end)

RegisterNUICallback('updateContact', function(data, cb)
    cb(lib.callback.await('loe_telephone:updateContact', false, data))
end)

RegisterNUICallback('deleteContact', function(data, cb)
    local id = type(data) == 'table' and data.id or data
    cb(lib.callback.await('loe_telephone:deleteContact', false, id))
end)

---------------------------------------------------------------------------
-- NUI CALLBACK'LERİ — BANKA (App Store'dan indirilen Banka uygulaması)
--   loe_bank'a HİÇBİR değişiklik yapılmaz; sadece onun kendi
--   `lib.callback.register`'lı server API'si çağrılır (ox_lib callback'leri
--   kaynak-bağımsızdır — hangi resource kayıt ettiyse ondan çağrılabilir).
---------------------------------------------------------------------------
local function bankUnavailable(cb)
    if GetResourceState(Config.bank.resource) == 'started' then return false end
    cb({ success = false, reason = 'Banka servisi şu anda kullanılamıyor.' })
    return true
end

RegisterNUICallback('bankGetData', function(_, cb)
    if bankUnavailable(cb) then return end
    cb(lib.callback.await('loe_bank:getData', false) or { success = false, reason = 'Sunucudan yanıt yok.' })
end)

RegisterNUICallback('bankDeposit', function(data, cb)
    if bankUnavailable(cb) then return end
    local amount = type(data) == 'table' and data.amount or nil
    cb(lib.callback.await('loe_bank:deposit', false, amount) or { success = false, reason = 'Sunucudan yanıt yok.' })
end)

RegisterNUICallback('bankWithdraw', function(data, cb)
    if bankUnavailable(cb) then return end
    local amount = type(data) == 'table' and data.amount or nil
    cb(lib.callback.await('loe_bank:withdraw', false, amount) or { success = false, reason = 'Sunucudan yanıt yok.' })
end)

RegisterNUICallback('bankTransfer', function(data, cb)
    if bankUnavailable(cb) then return end
    data = type(data) == 'table' and data or {}
    cb(lib.callback.await('loe_bank:transfer', false, {
        account = data.account, amount = data.amount, note = data.note,
    }) or { success = false, reason = 'Sunucudan yanıt yok.' })
end)

RegisterNUICallback('bankDonate', function(data, cb)
    if bankUnavailable(cb) then return end
    local amount = type(data) == 'table' and data.amount or nil
    cb(lib.callback.await('loe_bank:donate', false, amount) or { success = false, reason = 'Sunucudan yanıt yok.' })
end)

---------------------------------------------------------------------------
-- NUI CALLBACK'LERİ — MESAJLAR
---------------------------------------------------------------------------
RegisterNUICallback('getThreads', function(_, cb)
    cb(lib.callback.await('loe_telephone:getThreads', false))
end)

RegisterNUICallback('getThreadMessages', function(data, cb)
    local number = type(data) == 'table' and data.number or data
    cb(lib.callback.await('loe_telephone:getThreadMessages', false, number))
end)

RegisterNUICallback('sendMessage', function(data, cb)
    cb(lib.callback.await('loe_telephone:sendMessage', false, data))
end)

--- Oyuncunun kendi anlık konumu — mesajlaşmada "Canlı Konum Paylaş" için.
--- Sunucu onayı gerekmez: yalnızca kendi ped'inin koordinatı, bilgi amaçlı.
RegisterNUICallback('getMyLocation', function(_, cb)
    local coords = GetEntityCoords(PlayerPedId())
    cb({ success = true, x = coords.x, y = coords.y })
end)

--- Bir sohbette paylaşılan konumu haritada işaretler (GPS rota/waypoint).
RegisterNUICallback('showLocationOnMap', function(data, cb)
    local x = tonumber(data and data.x)
    local y = tonumber(data and data.y)
    if x and y then
        SetNewWaypoint(x, y)
        lib.notify({ type = 'success', description = 'Konum haritanda işaretlendi.' })
    end
    cb({ success = true })
end)

---------------------------------------------------------------------------
-- NUI CALLBACK'LERİ — ARAMA
---------------------------------------------------------------------------
RegisterNUICallback('getCallHistory', function(_, cb)
    cb(lib.callback.await('loe_telephone:getCallHistory', false))
end)

RegisterNUICallback('startCall', function(data, cb)
    local number = type(data) == 'table' and data.number or data
    local res = lib.callback.await('loe_telephone:startCall', false, number)
    if res and res.success then activeCallId = res.callId end
    cb(res)
end)

RegisterNUICallback('answerCall', function(data, cb)
    local callId = type(data) == 'table' and data.callId or data
    local res = lib.callback.await('loe_telephone:answerCall', false, callId)
    cb(res)
end)

RegisterNUICallback('declineCall', function(data, cb)
    local callId = type(data) == 'table' and data.callId or data
    cb(lib.callback.await('loe_telephone:declineCall', false, callId))
    if activeCallId == callId then activeCallId = nil end
end)

RegisterNUICallback('endCall', function(data, cb)
    local callId = type(data) == 'table' and data.callId or data
    cb(lib.callback.await('loe_telephone:endCall', false, callId))
    if activeCallId == callId then activeCallId = nil end
end)

---------------------------------------------------------------------------
-- NUI CALLBACK'LERİ — TELEGRAM (App Store'dan indirilir)
---------------------------------------------------------------------------
RegisterNUICallback('createGroup', function(data, cb)
    cb(lib.callback.await('loe_telephone:createGroup', false, data))
end)

RegisterNUICallback('getMyGroups', function(_, cb)
    cb(lib.callback.await('loe_telephone:getMyGroups', false))
end)

RegisterNUICallback('searchGroups', function(data, cb)
    local query = type(data) == 'table' and data.query or data
    cb(lib.callback.await('loe_telephone:searchGroups', false, query))
end)

RegisterNUICallback('joinGroupById', function(data, cb)
    local groupId = type(data) == 'table' and data.groupId or data
    cb(lib.callback.await('loe_telephone:joinGroupById', false, groupId))
end)

RegisterNUICallback('joinGroupByInvite', function(data, cb)
    local code = type(data) == 'table' and data.code or data
    cb(lib.callback.await('loe_telephone:joinGroupByInvite', false, code))
end)

RegisterNUICallback('getGroupMessages', function(data, cb)
    local groupId = type(data) == 'table' and data.groupId or data
    cb(lib.callback.await('loe_telephone:getGroupMessages', false, groupId))
end)

RegisterNUICallback('sendGroupMessage', function(data, cb)
    cb(lib.callback.await('loe_telephone:sendGroupMessage', false, data))
end)

---------------------------------------------------------------------------
-- NUI CALLBACK'LERİ — LIFEGRAM (App Store'dan indirilir)
--   loe_lifegram'ın server katmanı çağrılır; sadece onun kendi
--   `lib.callback.register`'lı server API'si çağrılır (ox_lib callback'leri
--   kaynak-bağımsızdır — hangi resource kayıt ettiyse ondan çağrılabilir).
---------------------------------------------------------------------------
local function socialUnavailable(cb)
    if GetResourceState(Config.socialmedia.resource) == 'started' then return false end
    cb({ success = false, reason = 'Lifegram şu anda kullanılamıyor.' })
    return true
end

-- NUI aksiyon adı ('socialGetFeed') -> server callback adı ('getFeed') eşlemesi
local SOCIAL_ACTIONS = {
    socialGetMe            = 'getMe',
    socialRegister          = 'register',
    socialUpdateProfile     = 'updateProfile',
    socialGetProfile        = 'getProfile',
    socialGetPost           = 'getPost',
    socialGetFeed           = 'getFeed',
    socialGetExplore        = 'getExplore',
    socialGetExploreFeed    = 'getExploreFeed',
    socialGetProfilePosts   = 'getProfilePosts',
    socialCreatePost        = 'createPost',
    socialDeletePost        = 'deletePost',
    socialToggleLike        = 'toggleLike',
    socialGetComments       = 'getComments',
    socialAddComment        = 'addComment',
    socialToggleFollow      = 'toggleFollow',
    socialSearchUsers       = 'searchUsers',
    socialGetStoriesStrip   = 'getStoriesStrip',
    socialCreateStory       = 'createStory',
    socialGetStory          = 'getStory',
    socialMarkStorySeen     = 'markStorySeen',
    socialDeleteStory       = 'deleteStory',
    socialLikeStory         = 'likeStory',
    socialGetStoryViewers   = 'getStoryViewers',
    socialGetAlbums         = 'getAlbums',
    socialCreateAlbum       = 'createAlbum',
    socialAddPostToAlbum    = 'addPostToAlbum',
    socialGetThreads        = 'getThreads',
    socialGetThreadMessages = 'getThreadMessages',
    socialSendMessage       = 'sendMessage',
    socialToggleSave        = 'toggleSave',
    socialGetSaved          = 'getSaved',
    socialGetNotifications  = 'getNotifications',
    socialMarkNotificationsSeen = 'markNotificationsSeen',
    -- Parçalı medya aktarımı (parça boyutu ve hız sınırı için aşağıdaki UPLOAD_* ayarlarına bak).
    socialMediaBegin        = 'mediaBegin',
    socialMediaChunk        = 'mediaChunk',
    socialMediaCommit       = 'mediaCommit',
    socialGetMediaInfo      = 'getMediaInfo',
    socialGetMediaChunk     = 'getMediaChunk',
}

-- Medya yükleme hız sınırı.
-- FXServer, istemciden gelen güvenilir (reliable) ağ olaylarının toplam boyutunu bir kova (token bucket) ile
-- sınırlar (FXServer kaynağı, ServerEventPacketHandler.cpp: "netEventSize" = 128 KiB/sn sürekli,
-- 384 KiB patlama; ayar adları rateLimiter_netEventSize_rate / _burst). Kova taşınca oyuncu
-- "Reliable network event size overflow" ile oyundan atılır. Lifegram hikâye yüklemesi (6,6 MB video,
-- 200 KB'lık parçalar) 3. parçada bu sınıra çarpıp oyuncuyu atıyordu (kapak ~31 KB + 2 x 200 KB geçti).
-- mediaBegin/mediaChunk istekleri bu yüzden burada sınırın ALTINDA (~%76) sürekli hızda tutulur;
-- kalan pay oyunun diğer olaylarına (envanter, telefon vb.) bırakılır.
-- Değerleri değiştirirken loe_lifegram/config/config.lua içindeki media.* boyut sınırlarıyla birlikte düşün.
local UPLOAD_RATE  = 100000  -- bayt/sn sürekli yükleme hızı (sunucu sınırı: 131072)
local UPLOAD_BURST = 200000  -- ilk anda beklemeden gönderilebilecek bayt (sunucu sınırı: 393216)
local uploadTokens = UPLOAD_BURST
local uploadStamp  = GetGameTimer()

local function refillUpload()
    local now = GetGameTimer()
    uploadTokens = math.min(UPLOAD_BURST, uploadTokens + (now - uploadStamp) * UPLOAD_RATE / 1000)
    uploadStamp = now
end

--- `bytes` kadar veri göndermeden önce gerekirse bekler (kova eksiye düşmüşse dolana kadar).
local function paceUpload(bytes)
    refillUpload()
    if uploadTokens < 0 then
        Wait(math.ceil(-uploadTokens * 1000 / UPLOAD_RATE))
        refillUpload()
    end
    uploadTokens = uploadTokens - bytes
end

--- Bu isteğin sunucuya götüreceği medya verisi (bayt). Medya dışı istekler sayılmaz.
local function uploadBytes(serverAction, data)
    if type(data) ~= 'table' then return 0 end
    if serverAction == 'mediaChunk' then
        return type(data.data) == 'string' and #data.data or 0
    elseif serverAction == 'mediaBegin' then
        return type(data.thumb) == 'string' and #data.thumb or 0
    end
    return 0
end

for nuiAction, serverAction in pairs(SOCIAL_ACTIONS) do
    RegisterNUICallback(nuiAction, function(data, cb)
        if socialUnavailable(cb) then return end
        local bytes = uploadBytes(serverAction, data)
        if bytes > 0 then paceUpload(bytes) end
        -- pcall: ağ olayı hata fırlatırsa bu coroutine cb() çağırmadan ölür —
        -- NUI tarafı sonsuza dek "gönderiliyor" durumunda kalır. Bunun yerine
        -- temiz bir hata döndürülür.
        local ok, res = pcall(lib.callback.await, 'loe_lifegram:' .. serverAction, false, data)
        if not ok then
            Utils.log(('social %s hata verdi: %s'):format(serverAction, tostring(res)))
            return cb({ success = false, reason = 'Veri çok büyük ya da sunucu hatası.' })
        end
        cb(res or { success = false, reason = 'Sunucudan yanıt yok.' })
    end)
end

---------------------------------------------------------------------------
-- NUI CALLBACK'LERİ — AIRSHARE (Kontrol Merkezi)
---------------------------------------------------------------------------
RegisterNUICallback('getNearbyPlayers', function(_, cb)
    local myPed = PlayerPedId()
    local myCoords = GetEntityCoords(myPed)
    local myServerId = GetPlayerServerId(PlayerId())
    local result = {}

    for _, playerId in ipairs(GetActivePlayers()) do
        local serverId = GetPlayerServerId(playerId)
        if serverId ~= myServerId then
            local ped = GetPlayerPed(playerId)
            if ped and ped ~= 0 then
                local dist = #(myCoords - GetEntityCoords(ped))
                if dist <= Config.airshare.maxDistance then
                    table.insert(result, { serverId = serverId, name = GetPlayerName(playerId), distance = dist })
                end
            end
        end
    end

    table.sort(result, function(a, b) return a.distance < b.distance end)
    cb({ success = true, players = result })
end)

RegisterNUICallback('shareRequest', function(data, cb)
    cb(lib.callback.await('loe_telephone:shareRequest', false, data))
end)

RegisterNUICallback('shareRespond', function(data, cb)
    cb(lib.callback.await('loe_telephone:shareRespond', false, data))
end)

---------------------------------------------------------------------------
-- SUNUCUDAN GELEN OLAYLAR
---------------------------------------------------------------------------

--- AirShare: gelen istek telefon kapalıyken bile açılır (süreli istek, zamanla kaçmasın).
RegisterNetEvent('loe_telephone:client:incomingShare', function(data)
    if cameraOpen then exitCamera() end
    if not phoneOpen then openPhone('home') end
    SendNUIMessage({ action = 'incomingShare', data = data })
end)

RegisterNetEvent('loe_telephone:client:shareResult', function(data)
    SendNUIMessage({ action = 'shareResult', data = data })
end)

RegisterNetEvent('loe_telephone:client:receiveSharedPhoto', function(data)
    SendNUIMessage({ action = 'receiveSharedPhoto', data = data })
end)

--- SIM kullanılınca: 8 haneli numara sor, server'a gönder, sonucu bildir.
RegisterNetEvent('loe_telephone:client:promptNumber', function(slot)
    local len = Config.sim.numberLength

    CreateThread(function()
        local input = lib.inputDialog('Yeni Hat', {
            {
                type = 'input',
                label = 'Telefon Numarası',
                description = ('Tam %d haneli, senin belirleyeceğin rakam.'):format(len),
                required = true,
                icon = 'phone',
            },
        })
        if not input or not input[1] then return end

        local res = lib.callback.await('loe_telephone:registerNumber', false, input[1], slot)
        if res and res.success then
            lib.notify({ type = 'success', description = ('Hattın aktif: %s'):format(Utils.formatNumber(res.number)) })
        else
            lib.notify({ type = 'error', description = (res and res.reason) or 'Numara kaydedilemedi.' })
        end
    end)
end)

RegisterNetEvent('loe_telephone:client:lineChanged', function(state)
    if phoneOpen then
        SendNUIMessage({ action = 'stateUpdate', state = state })
    end
end)

RegisterNetEvent('loe_telephone:client:incomingMessage', function(message)
    if phoneOpen then
        SendNUIMessage({ action = 'incomingMessage', message = message })
    else
        lib.notify({ type = 'inform', description = 'Yeni mesajın var.' })
    end
end)

RegisterNetEvent('loe_telephone:client:incomingGroupMessage', function(message)
    if phoneOpen then
        SendNUIMessage({ action = 'incomingGroupMessage', message = message })
    else
        lib.notify({ type = 'inform', description = 'Bir grupta yeni mesajın var.' })
    end
end)

--- Lifegram: beğeni/yorum/takip bildirimi. loe_lifegram'ın server'ı
--- tetikler, burada yakalanır (FX event'leri kaynak-bağımsızdır).
RegisterNetEvent('loe_lifegram:client:notify', function(data)
    if phoneOpen then
        SendNUIMessage({ action = 'socialNotify', data = data })
    else
        local labels = { like = 'gönderini beğendi', comment = 'gönderine yorum yaptı', follow = 'seni takip etmeye başladı' }
        lib.notify({ type = 'inform', description = ('%s %s'):format(data.fromUsername or 'Biri', labels[data.type] or '') })
    end
end)

--- Lifegram: yeni direkt mesaj (uygulama içi DM, telefonun SMS'inden bağımsız).
RegisterNetEvent('loe_lifegram:client:incomingDirect', function(message)
    if phoneOpen then
        SendNUIMessage({ action = 'socialIncomingDirect', message = message })
    else
        lib.notify({ type = 'inform', description = ('Lifegram: @%s sana mesaj gönderdi.'):format(message.fromUsername or '') })
    end
end)

--- Gelen arama: telefon kapalıysa bile açıp tam ekran çalma ekranını gösterir
--- (arka planda ana ekran açılır, çalma ekranı NUI'de bunun ÜSTÜNE biner).
RegisterNetEvent('loe_telephone:client:incomingCall', function(call)
    activeCallId = call.callId
    if cameraOpen then exitCamera() end
    if not phoneOpen then
        openPhone('home')
    end
    SendNUIMessage({ action = 'incomingCall', call = call })
end)

--- Ses aktarımı (pma-voice) TAMAMEN server'da yapılır (setPlayerCall server
--- export'u ile) — bkz server/main.lua answerCall/teardownCall. Client'ın
--- burada ekstra bir şey yapmasına gerek yok, sadece NUI'yi bilgilendirir.
RegisterNetEvent('loe_telephone:client:callAnswered', function(data)
    callAnimActive = true
    refreshPhoneAnim() -- telefon kulağa gider
    SendNUIMessage({
        action = 'callAnswered',
        callId = data.callId,
        callerNumber = data.callerNumber,
        calleeNumber = data.calleeNumber,
    })
end)

RegisterNetEvent('loe_telephone:client:callEnded', function(data)
    if activeCallId == data.callId then activeCallId = nil end
    callAnimActive = false
    refreshPhoneAnim()
    SendNUIMessage({ action = 'callEnded', callId = data.callId, reason = data.reason })
end)

---------------------------------------------------------------------------
-- KAMERA — GTA Online telefon kamerası gibi TAM EKRAN
--   Telefon kasası gizlenir, script kamera tüm ekranı kaplar; NUI yalnızca
--   şeffaf bir kadraj/oran maskesi çizer (web/index.html #camera-overlay).
--   NUI odağı bırakılır, kontroller oyun tuşlarından okunur:
--     fare: bakış · WASD: yürü · sol tık / Enter: çek / kaydı başlat-durdur
--     sağ tık / Backspace / ESC: çık · tekerlek: yakınlaştır · E: selfie
--     Q: fotoğraf/video · ←/→: ölçek (tam ekran/hikaye/gönderi) · R: gönderi oranı
--   Çekimi ve video kaydını NUI kendisi yapar (web/js/app.js GameView): FiveM'in game-view
--   dokusunu kendi görünür sayfasında okur. screencapture KULLANILMAZ — o,
--   kareyi görünmez kendi çerçevesinde requestAnimationFrame ile bekliyordu;
--   Chromium o çerçevede kareleri durdurduğu için her fotoğraf ancak bir
--   sonraki çekim isteğinde teslim ediliyordu (1. çekim → 2.'de görünür).
---------------------------------------------------------------------------
local CAM_FOV_DEFAULT, CAM_FOV_MIN, CAM_FOV_MAX = 50.0, 20.0, 70.0
local CAM_PITCH_LIMIT, CAM_SELFIE_PITCH_LIMIT = 70.0, 35.0
local CAM_FORWARD_OFFSET, CAM_SELFIE_DISTANCE = 0.30, 0.8
local CAM_HEAD_BONE = 31086 -- SKEL_Head
local CAM_SHOT_COOLDOWN = 700 -- ms

-- Kamera açıkken oyuna gitmemesi gereken tuşlar: bakış, silah/saldırı/nişan,
-- silah çarkı ve tekerlek, koşma/zıplama/eğilme/siper/araca binme, E/Q/R,
-- ESC/P menüleri. WASD (30-35) BİLEREK açık: kamerayla yürünebilir.
local CAM_DISABLED_CONTROLS = {
    1, 2, 14, 15, 16, 17, 21, 22, 23, 24, 25, 36, 37,
    38, 44, 45, 51, 52, 140, 141, 142, 143, 174, 175, 177, 194, 199, 200, 257, 263,
}

local cam = {
    yaw = 0.0, pitch = 0.0,
    fov = CAM_FOV_DEFAULT, targetFov = CAM_FOV_DEFAULT,
    selfie = false, flash = false, recording = false, readyAt = 0, nextShotAt = 0,
    headHeight = 0.7,
}

---------------------------------------------------------------------------
-- TELEFON / ARAMA / SELFİE ANİMASYONLARI
--   Bayrak 49 = AF_LOOPING(1) + AF_UPPERBODY(16) + AF_SECONDARY(32): üst
--   gövdede döner, bacaklar serbest kalır — telefon/kamera açıkken yürünebilir.
---------------------------------------------------------------------------
local ANIM_FLAG = 49
local ANIM_DICT = 'cellphone@'
local ANIM_HOLD = 'cellphone_text_read_base'    -- telefonu elde tutup bakma / fotoğraf çekme
local ANIM_CALL = 'cellphone_call_listen_base'  -- arama: kulağa götürme
local ANIM_SELFIE_DICT = 'anim@mp_player_intselfie'
local ANIM_SELFIE_CLIP = 'idle_a'               -- GTA Online selfie duruşu

local currentAnim = nil -- { dict, clip } | nil

local function ensureAnimDict(dict)
    if HasAnimDictLoaded(dict) then return end
    RequestAnimDict(dict)
    local timeout = GetGameTimer() + 2000
    while not HasAnimDictLoaded(dict) and GetGameTimer() < timeout do Wait(0) end
end

local function playPhoneAnim(dict, clip)
    if currentAnim and currentAnim.dict == dict and currentAnim.clip == clip then return end
    ensureAnimDict(dict)
    TaskPlayAnim(PlayerPedId(), dict, clip, 3.0, 3.0, -1, ANIM_FLAG, 0, false, false, false)
    currentAnim = { dict = dict, clip = clip }
end

local function stopPhoneAnim()
    if not currentAnim then return end
    ClearPedSecondaryTask(PlayerPedId())
    currentAnim = nil
end

--- Öncelik: arama (kulak) > selfie > fotoğraf/kamera > telefonu elde tutma > yok.
--- Telefon/kamera açık-kapalı, selfie aç-kapa ve arama cevaplanma/bitme
--- noktalarından çağrılır; anlık duruma göre doğru animasyonu seçer.
refreshPhoneAnim = function()
    if callAnimActive then
        playPhoneAnim(ANIM_DICT, ANIM_CALL)
    elseif cameraOpen and cam.selfie then
        playPhoneAnim(ANIM_SELFIE_DICT, ANIM_SELFIE_CLIP)
    elseif cameraOpen or phoneOpen then
        playPhoneAnim(ANIM_DICT, ANIM_HOLD)
    else
        stopPhoneAnim()
    end
end

--- -180..180 aralığında açı farkı.
local function angleDiff(a, b)
    return ((a - b + 540.0) % 360.0) - 180.0
end

--- GTA heading'ine (derece, saat yönünün tersi) göre yatay birim yön vektörü.
local function flatDir(yaw)
    local r = math.rad(yaw)
    return vector3(-math.sin(r), math.cos(r), 0.0)
end

--- `from`dan `to`ya ışın atar; arada duvar/araç/nesne varsa kamerayı engelin önüne çeker.
local function clampToObstacles(ped, from, to)
    local ray = StartExpensiveSynchronousShapeTestLosProbe(from.x, from.y, from.z, to.x, to.y, to.z, 1 + 2 + 16, ped, 4)
    local _, hit, hitCoords = GetShapeTestResult(ray)
    if hit and hit ~= 0 then
        return from + (hitCoords - from) * 0.8
    end
    return to
end

local function placeCamera(ped)
    -- Kafa kemiği yerine karakterin kök konumu + sabit kafa yüksekliği: yürürken
    -- kafa sallanması kameraya geçmez (sabitlenmiş, akıcı görüntü).
    local head = GetEntityCoords(ped) + vector3(0.0, 0.0, cam.headHeight)
    local pos
    if cam.selfie then
        -- yüzün önünde, karaktere dönük (kamera yaw yönüne bakar = karaktere)
        pos = clampToObstacles(ped, head, head + flatDir(cam.yaw + 180.0) * CAM_SELFIE_DISTANCE)
    else
        -- göz hizasında, bakış yönünde biraz ileride: karakterin kafası kareye girmez
        pos = head + flatDir(cam.yaw) * CAM_FORWARD_OFFSET
    end
    SetCamCoord(cameraHandle, pos.x, pos.y, pos.z)
    SetCamRot(cameraHandle, cam.pitch, 0.0, cam.yaw, 2)
    SetCamFov(cameraHandle, cam.fov)
end

--- Fare/analog bakış — loe_adminmenu noclip kamerasıyla aynı okuma (profil hassasiyeti + ters çevirme).
local function readLook()
    local sensitivity = GetProfileSetting(14)
    if not sensitivity or sensitivity <= 0 then sensitivity = 5 end
    sensitivity = sensitivity * 2 * (cam.fov / CAM_FOV_DEFAULT) -- yakınlaşınca daha hassas nişan

    local dx = GetDisabledControlNormal(0, 1) * sensitivity
    local dy = GetDisabledControlNormal(0, 2) * sensitivity
    if GetProfileSetting(15) ~= 0 then dy = -dy end

    local limit = cam.selfie and CAM_SELFIE_PITCH_LIMIT or CAM_PITCH_LIMIT
    cam.yaw = (cam.yaw - dx) % 360.0
    cam.pitch = math.max(-limit, math.min(limit, cam.pitch - dy))
end

stopCamera = function()
    if not cameraOpen then return end
    cameraOpen = false
    cam.recording = false
    RenderScriptCams(false, false, 0, true, true)
    if cameraHandle then DestroyCam(cameraHandle, false) end
    cameraHandle = nil
    if phoneOpen then SetNuiFocus(true, true) end
    refreshPhoneAnim()
end

--- Oyuncu kameradan çıktı (tuş / arama / hata): kamerayı kapat ve NUI'yi telefona döndür.
exitCamera = function()
    if not cameraOpen then return end
    stopCamera()
    SendNUIMessage({ action = 'cameraExited' })
end

--- Deklanşör: fotoğrafı/videoyu NUI yakalar (GameView); burada yalnızca tetik + gerçek flaş.
--- Video modunda NUI bu tetiği kaydı başlat/durdur olarak yorumlar.
local function capturePhoto()
    local now = GetGameTimer()
    if now < cam.readyAt or now < cam.nextShotAt then return end
    cam.nextShotAt = now + CAM_SHOT_COOLDOWN

    SendNUIMessage({ action = 'cameraShutter', flash = cam.flash })

    if cam.flash then
        -- NUI flaşlı çekimde birkaç kare bekler; ışık o süre boyunca sahnede yanar.
        CreateThread(function()
            local untilAt = GetGameTimer() + 350
            while GetGameTimer() < untilAt and cameraHandle do
                local c = GetCamCoord(cameraHandle)
                DrawLightWithRange(c.x, c.y, c.z, 255, 255, 255, 12.0, 6.0)
                Wait(0)
            end
        end)
    end
end

--- WASD kameranın baktığı yöne göre yürütür; dururken karakter bakış yönüne döner.
local function updateWalking(ped)
    if IsPedInAnyVehicle(ped, false) or IsPedRagdoll(ped) then return end

    -- Dururken karakterin bakacağı yön: normalde kameranın baktığı yön, selfie'de kameraya.
    local facingYaw = cam.selfie and (cam.yaw + 180.0) % 360.0 or cam.yaw
    local heading = GetEntityHeading(ped)

    -- Hareket girdisi gameplay kamerasına göre yorumlanır. Her iki modda da
    -- kameranın bakış yönüne hizalanır: W ekranın içine, A ekranın soluna.
    -- Selfie'de bu, karaktere göre W/S ve A/D'nin yer değiştirmesi demek.
    SetGameplayCamRelativeHeading(angleDiff(cam.yaw, heading))
    -- Telefonla çekim: koşma yok, sakin yürüyüş (1.0 = yürüme hızı).
    SetPedMaxMoveBlendRatio(ped, 1.0)

    local moving = math.abs(GetControlNormal(0, 30)) > 0.1 or math.abs(GetControlNormal(0, 31)) > 0.1
    if not moving then
        local diff = angleDiff(facingYaw, heading)
        if math.abs(diff) > 0.5 then
            SetEntityHeading(ped, (heading + diff * 0.25) % 360.0)
        end
    end
end

local function cameraTick()
    local ped = PlayerPedId()

    for i = 1, #CAM_DISABLED_CONTROLS do DisableControlAction(0, CAM_DISABLED_CONTROLS[i], true) end
    DisablePlayerFiring(PlayerId(), true)
    HideHudAndRadarThisFrame()

    readLook()

    if IsDisabledControlJustPressed(0, 17) or IsDisabledControlJustPressed(0, 15) then
        cam.targetFov = math.max(CAM_FOV_MIN, cam.targetFov - 5.0)
    elseif IsDisabledControlJustPressed(0, 16) or IsDisabledControlJustPressed(0, 14) then
        cam.targetFov = math.min(CAM_FOV_MAX, cam.targetFov + 5.0)
    end
    cam.fov = cam.fov + (cam.targetFov - cam.fov) * 0.2

    if IsDisabledControlJustPressed(0, 38) or IsDisabledControlJustPressed(0, 51) then
        cam.selfie = not cam.selfie
        cam.yaw = (cam.yaw + 180.0) % 360.0 -- karakter aynı yöne bakmaya devam etsin, kamera öne dolaşsın
        cam.pitch = 0.0
        SendNUIMessage({ action = 'cameraState', selfie = cam.selfie })
        refreshPhoneAnim()
    end
    if IsDisabledControlJustPressed(0, 174) then SendNUIMessage({ action = 'cameraInput', input = 'modePrev' }) end
    if IsDisabledControlJustPressed(0, 175) then SendNUIMessage({ action = 'cameraInput', input = 'modeNext' }) end
    if IsDisabledControlJustPressed(0, 45) then SendNUIMessage({ action = 'cameraInput', input = 'ratio' }) end
    if IsDisabledControlJustPressed(0, 44) or IsDisabledControlJustPressed(0, 52) then
        SendNUIMessage({ action = 'cameraInput', input = 'media' })
    end

    -- Flaş açıkken video kaydı boyunca ışık sürekli yanar (el feneri gibi).
    if cam.recording and cam.flash then
        local c = GetCamCoord(cameraHandle)
        DrawLightWithRange(c.x, c.y, c.z, 255, 255, 255, 12.0, 4.0)
    end

    updateWalking(ped)
    placeCamera(ped)

    if GetGameTimer() < cam.readyAt then return end -- açılıştaki tıklama çekim/çıkış sayılmasın

    if IsDisabledControlJustPressed(0, 24) or IsControlJustPressed(0, 191) then
        capturePhoto()
    elseif IsDisabledControlJustPressed(0, 25) or IsDisabledControlJustPressed(0, 177)
        or IsDisabledControlJustPressed(0, 194) or IsDisabledControlJustPressed(0, 200) then
        exitCamera()
    end
end

local function cameraLoop()
    while cameraOpen do
        local ok, err = pcall(cameraTick)
        if not ok then
            Utils.log(('kamera döngüsü hata verdi: %s'):format(tostring(err)))
            exitCamera()
        end
        Wait(0)
    end
end

RegisterNUICallback('openCamera', function(data, cb)
    if cameraOpen then return cb({ success = true }) end

    local ped = PlayerPedId()
    cam.yaw = GetGameplayCamRot(2).z % 360.0 -- oyuncunun o an baktığı yönden başla
    cam.pitch = 0.0
    cam.fov, cam.targetFov = CAM_FOV_DEFAULT, CAM_FOV_DEFAULT
    cam.selfie, cam.recording = false, false
    cam.flash = type(data) == 'table' and data.flash == true
    cam.readyAt = GetGameTimer() + 300
    cam.nextShotAt = 0
    cam.headHeight = GetPedBoneCoords(ped, CAM_HEAD_BONE, 0.0, 0.0, 0.0).z - GetEntityCoords(ped).z + 0.06

    local ok, err = pcall(function()
        cameraHandle = CreateCam('DEFAULT_SCRIPTED_CAMERA', true)
        SetCamNearClip(cameraHandle, 0.05)
        placeCamera(ped)
        SetCamActive(cameraHandle, true)
        RenderScriptCams(true, false, 0, true, true)
    end)

    if not ok then
        Utils.log(('openCamera hata verdi: %s'):format(tostring(err)))
        if cameraHandle then pcall(DestroyCam, cameraHandle, false) end
        cameraHandle = nil
        return cb({ success = false, reason = 'camera_error' })
    end

    cameraOpen = true
    SetNuiFocus(false, false) -- imleç yok, kontroller oyuna (GTA Online gibi)
    refreshPhoneAnim()
    CreateThread(cameraLoop)

    cb({ success = true })
end)

RegisterNUICallback('closeCamera', function(_, cb)
    stopCamera()
    cb(true)
end)

--- NUI video kaydını başlattı/durdurdu (flaşlı kayıtta sürekli ışık için).
RegisterNUICallback('cameraRecording', function(data, cb)
    cam.recording = cameraOpen and type(data) == 'table' and data.active == true
    cb(true)
end)

---------------------------------------------------------------------------
-- YAŞAM DÖNGÜSÜ
---------------------------------------------------------------------------
AddEventHandler('onResourceStop', function(resource)
    if resource ~= GetCurrentResourceName() then return end
    if phoneOpen then SetNuiFocus(false, false) end
    if cameraOpen then
        RenderScriptCams(false, false, 0, true, true)
        if cameraHandle then DestroyCam(cameraHandle, false) end
    end
    stopPhoneAnim() -- kaynak dururken karakter elde telefonla/kulakta kalmasın
end)

