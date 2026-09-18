--[[
    server/main.lua
    ---------------
    Tek sorumluluk: telefon isteklerini DOĞRULAMAK ve hat/rehber/mesaj/arama
    verisini yönetmek.

    Güvenlik ilkesi: client yalnızca "hangi numara / kime / ne" bilgisi
    gönderir. Hat sahipliği, aktif hat, numara benzersizliği ve tüm
    yönlendirme server'da yapılır. Client'ın gönderdiği hiçbir sahiplik
    bilgisine güvenilmez — her istek, isteği yapan `source`'un GERÇEKTEN o
    numaraya sahip olup olmadığı DB'den doğrulanarak işlenir.

    ARAMA: sinyalizasyon (çalma/kabul/red/süre) BURADA yönetilir; gerçek ses
    aktarımı `setCallVoiceChannel` üzerinden resources/[core]/pma-voice'un
    server export'u `setPlayerCall` ile yapılır (answerCall'da bağlanır,
    teardownCall'da ayrılır). pma-voice kurulu değilse sessizce atlanır —
    sinyalizasyon (arama akışı, geçmiş) yine çalışır, sadece ses gitmez.
]]

local Config = LoeTelephone.Config
local Utils  = LoeTelephone.Utils

local NUMTBL  = Config.db.numbers
local CONTBL  = Config.db.contacts
local MSGTBL  = Config.db.messages
local CALLTBL = Config.db.calls

---------------------------------------------------------------------------
-- TABLOLAR (server ilk başlarken otomatik kurulur — sql/loe_telephone.sql ile eş)
--   Collation qbx `players` tablosuyla AYNI olmalı (utf8mb4_unicode_ci); aksi
--   halde citizenid karşılaştırmaları "Illegal mix of collations" verir.
---------------------------------------------------------------------------
local function alignCollation(tbl)
    local ok, row = pcall(function()
        return MySQL.single.await(
            'SELECT TABLE_COLLATION AS c FROM information_schema.TABLES '
            .. 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', { tbl }
        )
    end)
    if ok and row and row.c and row.c ~= 'utf8mb4_unicode_ci' then
        pcall(function()
            MySQL.query.await(
                ('ALTER TABLE `%s` CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'):format(tbl)
            )
        end)
        Utils.log(('%s collation -> utf8mb4_unicode_ci (%s idi)'):format(tbl, row.c))
    end
end

--- Var olan bir tabloya kolon eksikse ekler (eski kurulumlar için otomatik göç).
local function ensureColumn(tbl, column, definition)
    local ok, row = pcall(function()
        return MySQL.single.await(
            'SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS '
            .. 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
            { tbl, column }
        )
    end)
    if ok and not row then
        pcall(function()
            MySQL.query.await(('ALTER TABLE `%s` ADD COLUMN `%s` %s'):format(tbl, column, definition))
        end)
        Utils.log(('%s.%s kolonu eklendi.'):format(tbl, column))
    end
end

CreateThread(function()
    MySQL.query.await(([[
        CREATE TABLE IF NOT EXISTS `%s` (
            `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `citizenid`  VARCHAR(50)  NOT NULL,
            `number`     VARCHAR(8)   NOT NULL,
            `active`     TINYINT(1)   NOT NULL DEFAULT 0,
            `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_number` (`number`),
            KEY `idx_citizenid` (`citizenid`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    ]]):format(NUMTBL))

    MySQL.query.await(([[
        CREATE TABLE IF NOT EXISTS `%s` (
            `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `citizenid`  VARCHAR(50)  NOT NULL,
            `number`     VARCHAR(8)   NOT NULL,
            `name`       VARCHAR(64)  NOT NULL,
            `created_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            KEY `idx_citizenid` (`citizenid`),
            UNIQUE KEY `uniq_owner_number` (`citizenid`, `number`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    ]]):format(CONTBL))

    MySQL.query.await(([[
        CREATE TABLE IF NOT EXISTS `%s` (
            `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `from_number` VARCHAR(8)   NOT NULL,
            `to_number`   VARCHAR(8)   NOT NULL,
            `body`        VARCHAR(400) NOT NULL,
            `read_at`     TIMESTAMP    NULL DEFAULT NULL,
            `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            KEY `idx_from` (`from_number`),
            KEY `idx_to_read` (`to_number`, `read_at`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    ]]):format(MSGTBL))

    MySQL.query.await(([[
        CREATE TABLE IF NOT EXISTS `%s` (
            `id`          INT UNSIGNED  NOT NULL AUTO_INCREMENT,
            `from_number` VARCHAR(8)    NOT NULL,
            `to_number`   VARCHAR(8)    NOT NULL,
            `status`      VARCHAR(16)   NOT NULL,
            `duration`    INT UNSIGNED  NULL DEFAULT NULL,
            `created_at`  TIMESTAMP     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            KEY `idx_from` (`from_number`),
            KEY `idx_to` (`to_number`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    ]]):format(CALLTBL))

    ensureColumn(MSGTBL, 'photo_data', 'LONGTEXT NULL DEFAULT NULL')
    ensureColumn(MSGTBL, 'location', 'VARCHAR(64) NULL DEFAULT NULL')

    alignCollation(NUMTBL)
    alignCollation(CONTBL)
    alignCollation(MSGTBL)
    alignCollation(CALLTBL)
    Utils.log('tablolar hazır:', NUMTBL, CONTBL, MSGTBL, CALLTBL)
end)

---------------------------------------------------------------------------
-- YARDIMCILAR
---------------------------------------------------------------------------
local function getPlayer(source)
    local ok, player = pcall(function() return exports.qbx_core:GetPlayer(source) end)
    if not ok then return nil end
    return player
end

local function notify(source, ntype, description)
    pcall(function() exports.qbx_core:Notify(source, description, ntype) end)
end

local function playerName(player)
    local ci = player.PlayerData.charinfo
    if ci and ci.firstname then
        return ci.firstname .. (ci.lastname and (' ' .. ci.lastname) or '')
    end
    return GetPlayerName(player.PlayerData.source) or 'Bilinmeyen'
end

---------------------------------------------------------------------------
-- NUMARALAR / HATLAR
---------------------------------------------------------------------------

--- Bir karakterin tüm hatları (numara + aktif bayrağı), eskiden yeniye.
local function numbersOf(citizenid)
    return MySQL.query.await(
        ('SELECT `number`, `active` FROM `%s` WHERE `citizenid` = ? ORDER BY `id` ASC'):format(NUMTBL),
        { citizenid }
    ) or {}
end

--- O an aktif olan numara (yoksa nil).
local function activeNumberOf(citizenid)
    local row = MySQL.single.await(
        ('SELECT `number` FROM `%s` WHERE `citizenid` = ? AND `active` = 1 LIMIT 1'):format(NUMTBL),
        { citizenid }
    )
    return row and row.number or nil
end

--- Bir numaranın sahibi (citizenid) — yoksa nil.
local function citizenidByNumber(number)
    local row = MySQL.single.await(
        ('SELECT `citizenid` FROM `%s` WHERE `number` = ? LIMIT 1'):format(NUMTBL),
        { number }
    )
    return row and row.citizenid or nil
end

--- Bir numara, sahibinin O AN aktif hattı mı? (kapalı/pasif hat -> ulaşılamaz).
local function isNumberActive(number)
    local row = MySQL.single.await(
        ('SELECT 1 AS ok FROM `%s` WHERE `number` = ? AND `active` = 1 LIMIT 1'):format(NUMTBL),
        { number }
    )
    return row ~= nil
end

--- NUI'ye dönecek standart hat durumu. `playerName` NUI'nin ana ekranda
--- oyuncu adını göstermesi için eklendi (salt-okunur, ek alan — mevcut
--- hiçbir alan değişmedi).
local function lineState(citizenid, playerNameHint)
    return {
        success = true,
        numbers = numbersOf(citizenid),
        active  = activeNumberOf(citizenid),
        maxLines = Config.sim.maxLines,
        playerName = playerNameHint,
    }
end

lib.callback.register('loe_telephone:getState', function(source)
    local player = getPlayer(source)
    if not player then return { success = false, reason = 'Oyuncu bulunamadı.' } end
    return lineState(player.PlayerData.citizenid, playerName(player))
end)

--- Aktif hattı değiştir (klasik "hat değiştir" — aynı anda yalnızca 1 aktif).
lib.callback.register('loe_telephone:setActiveLine', function(source, number)
    local player = getPlayer(source)
    if not player then return { success = false, reason = 'Oyuncu bulunamadı.' } end
    local citizenid = player.PlayerData.citizenid

    local target = Utils.validNumber(number)
    if not target then return lineState(citizenid, playerName(player)) end

    local owns = MySQL.single.await(
        ('SELECT 1 AS ok FROM `%s` WHERE `citizenid` = ? AND `number` = ? LIMIT 1'):format(NUMTBL),
        { citizenid, target }
    )
    if not owns then
        local r = lineState(citizenid, playerName(player))
        r.reason = 'Bu numara sana ait değil.'
        return r
    end

    MySQL.update.await(('UPDATE `%s` SET `active` = 0 WHERE `citizenid` = ?'):format(NUMTBL), { citizenid })
    MySQL.update.await(
        ('UPDATE `%s` SET `active` = 1 WHERE `citizenid` = ? AND `number` = ?'):format(NUMTBL),
        { citizenid, target }
    )

    return lineState(citizenid, playerName(player))
end)

---------------------------------------------------------------------------
-- SIM KAYIT AKIŞI
--   1) simcard item kullanılır (qbx CreateUseableItem) -> hat sayısı kontrol
--      edilir -> client'a numara sorulması için event yollanır.
--   2) client lib.inputDialog ile 8 haneli numarayı alır ->
--      `loe_telephone:registerNumber` callback'ine gönderir.
--   3) server tekrar doğrular (format + limit + benzersizlik), kaydeder,
--      SIM'i O ZAMAN tüketir (item.consume ayarlı değil -> ox_inventory
--      otomatik düşmez, silme burada elle yapılır — başarısız girişte SIM
--      HİÇ kaybolmaz).
---------------------------------------------------------------------------
CreateThread(function()
    local ok, err = pcall(function()
        exports.qbx_core:CreateUseableItem(Config.sim.item, function(source, data)
            local player = getPlayer(source)
            if not player then return end
            local citizenid = player.PlayerData.citizenid

            local count = MySQL.scalar.await(
                ('SELECT COUNT(*) FROM `%s` WHERE `citizenid` = ?'):format(NUMTBL), { citizenid }
            ) or 0

            if count >= Config.sim.maxLines then
                return notify(source, 'error', ('En fazla %d hattın olabilir.'):format(Config.sim.maxLines))
            end

            TriggerClientEvent('loe_telephone:client:promptNumber', source, data and data.slot or nil)
        end)
    end)
    if not ok then
        print(('^1[loe_telephone]^7 %s kullanılabilir item olarak kaydedilemedi: %s'):format(Config.sim.item, tostring(err)))
    end
end)

lib.callback.register('loe_telephone:registerNumber', function(source, number, slot)
    local player = getPlayer(source)
    if not player then return { success = false, reason = 'Oyuncu bulunamadı.' } end
    local citizenid = player.PlayerData.citizenid

    local target = Utils.validNumber(number)
    if not target then
        return { success = false, reason = ('Numara tam %d haneli rakam olmalı.'):format(Config.sim.numberLength) }
    end

    local count = MySQL.scalar.await(
        ('SELECT COUNT(*) FROM `%s` WHERE `citizenid` = ?'):format(NUMTBL), { citizenid }
    ) or 0
    if count >= Config.sim.maxLines then
        return { success = false, reason = ('En fazla %d hattın olabilir.'):format(Config.sim.maxLines) }
    end

    local taken = MySQL.single.await(
        ('SELECT 1 AS ok FROM `%s` WHERE `number` = ? LIMIT 1'):format(NUMTBL), { target }
    )
    if taken then
        return { success = false, reason = 'Bu numara zaten alınmış, başka bir tane dene.' }
    end

    local isFirst = count == 0
    local inserted = MySQL.insert.await(
        ('INSERT IGNORE INTO `%s` (`citizenid`, `number`, `active`) VALUES (?, ?, ?)'):format(NUMTBL),
        { citizenid, target, isFirst and 1 or 0 }
    )
    if not inserted or inserted == 0 then
        return { success = false, reason = 'Bu numara zaten alınmış, başka bir tane dene.' }
    end

    local removed = exports.ox_inventory:RemoveItem(source, Config.sim.item, 1)
    if not removed then
        print(('^1[loe_telephone]^7 UYARI: %s için numara kaydedildi ama simcard item düşürülemedi (source=%s)')
            :format(target, source))
    end

    notify(source, 'success', ('Hattın aktif: %s'):format(Utils.formatNumber(target)))
    TriggerClientEvent('loe_telephone:client:lineChanged', source, lineState(citizenid, playerName(player)))

    return { success = true, number = target }
end)

---------------------------------------------------------------------------
-- REHBER (hatlardan bağımsız, karaktere bağlı)
---------------------------------------------------------------------------
lib.callback.register('loe_telephone:getContacts', function(source)
    local player = getPlayer(source)
    if not player then return { success = false, reason = 'Oyuncu bulunamadı.' } end

    local rows = MySQL.query.await(
        ('SELECT `id`, `number`, `name` FROM `%s` WHERE `citizenid` = ? ORDER BY `name` ASC'):format(CONTBL),
        { player.PlayerData.citizenid }
    ) or {}
    return { success = true, contacts = rows }
end)

lib.callback.register('loe_telephone:addContact', function(source, data)
    local player = getPlayer(source)
    if not player then return { success = false, reason = 'Oyuncu bulunamadı.' } end
    local citizenid = player.PlayerData.citizenid

    data = type(data) == 'table' and data or {}
    local number = Utils.validNumber(data.number)
    local name   = Utils.validContactName(data.name)
    if not number then return { success = false, reason = 'Geçerli bir numara gir.' } end
    if not name then return { success = false, reason = 'Bir isim gir.' } end

    local count = MySQL.scalar.await(
        ('SELECT COUNT(*) FROM `%s` WHERE `citizenid` = ?'):format(CONTBL), { citizenid }
    ) or 0
    if count >= Config.contacts.maxContacts then
        return { success = false, reason = 'Rehber dolu.' }
    end

    local id = MySQL.insert.await(
        ('INSERT INTO `%s` (`citizenid`, `number`, `name`) VALUES (?, ?, ?) '
        .. 'ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)'):format(CONTBL),
        { citizenid, number, name }
    )

    local rows = MySQL.query.await(
        ('SELECT `id`, `number`, `name` FROM `%s` WHERE `citizenid` = ? ORDER BY `name` ASC'):format(CONTBL),
        { citizenid }
    ) or {}
    return { success = true, contacts = rows, id = id }
end)

lib.callback.register('loe_telephone:updateContact', function(source, data)
    local player = getPlayer(source)
    if not player then return { success = false, reason = 'Oyuncu bulunamadı.' } end
    local citizenid = player.PlayerData.citizenid

    data = type(data) == 'table' and data or {}
    local id = tonumber(data.id)
    local name = Utils.validContactName(data.name)
    if not id or not name then return { success = false, reason = 'Geçersiz istek.' } end

    MySQL.update.await(
        ('UPDATE `%s` SET `name` = ? WHERE `id` = ? AND `citizenid` = ?'):format(CONTBL),
        { name, id, citizenid }
    )

    local rows = MySQL.query.await(
        ('SELECT `id`, `number`, `name` FROM `%s` WHERE `citizenid` = ? ORDER BY `name` ASC'):format(CONTBL),
        { citizenid }
    ) or {}
    return { success = true, contacts = rows }
end)

lib.callback.register('loe_telephone:deleteContact', function(source, id)
    local player = getPlayer(source)
    if not player then return { success = false, reason = 'Oyuncu bulunamadı.' } end
    local citizenid = player.PlayerData.citizenid

    id = tonumber(id)
    if id then
        MySQL.query.await(('DELETE FROM `%s` WHERE `id` = ? AND `citizenid` = ?'):format(CONTBL), { id, citizenid })
    end

    local rows = MySQL.query.await(
        ('SELECT `id`, `number`, `name` FROM `%s` WHERE `citizenid` = ? ORDER BY `name` ASC'):format(CONTBL),
        { citizenid }
    ) or {}
    return { success = true, contacts = rows }
end)

---------------------------------------------------------------------------
-- MESAJLAR (SMS) — O AN AKTİF hat üzerinden
---------------------------------------------------------------------------

--- source'un o anki aktif numarasını döner; yoksa nil + sebep.
local function requireActiveNumber(source)
    local player = getPlayer(source)
    if not player then return nil, nil, 'Oyuncu bulunamadı.' end
    local citizenid = player.PlayerData.citizenid
    local number = activeNumberOf(citizenid)
    if not number then return nil, citizenid, 'Aktif bir hattın yok.' end
    return number, citizenid, nil
end

--- Aktif hattın konuşma listesi: karşı numara bazında son mesaj + okunmamış sayısı.
lib.callback.register('loe_telephone:getThreads', function(source)
    local myNumber, _, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    local rows = MySQL.query.await(([[
        SELECT
            other,
            (SELECT CASE
                    WHEN m2.`body` != '' THEN m2.`body`
                    WHEN m2.`photo_data` IS NOT NULL THEN '📷 Fotoğraf'
                    WHEN m2.`location` IS NOT NULL THEN '📍 Konum'
                    ELSE m2.`body`
                END
                FROM `%s` m2
                WHERE (m2.`from_number` = t.other AND m2.`to_number` = ?)
                   OR (m2.`from_number` = ? AND m2.`to_number` = t.other)
                ORDER BY m2.`id` DESC LIMIT 1) AS lastBody,
            (SELECT UNIX_TIMESTAMP(m2.`created_at`) FROM `%s` m2
                WHERE (m2.`from_number` = t.other AND m2.`to_number` = ?)
                   OR (m2.`from_number` = ? AND m2.`to_number` = t.other)
                ORDER BY m2.`id` DESC LIMIT 1) AS lastAt,
            (SELECT COUNT(*) FROM `%s` m3
                WHERE m3.`from_number` = t.other AND m3.`to_number` = ? AND m3.`read_at` IS NULL) AS unread
        FROM (
            SELECT `to_number` AS other FROM `%s` WHERE `from_number` = ?
            UNION
            SELECT `from_number` AS other FROM `%s` WHERE `to_number` = ?
        ) t
        ORDER BY lastAt DESC
        LIMIT %d
    ]]):format(MSGTBL, MSGTBL, MSGTBL, MSGTBL, MSGTBL, Config.messages.threadLimit),
        { myNumber, myNumber, myNumber, myNumber, myNumber, myNumber, myNumber }
    ) or {}

    return { success = true, threads = rows, myNumber = myNumber }
end)

lib.callback.register('loe_telephone:getThreadMessages', function(source, otherNumber)
    local myNumber, _, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    local other = Utils.validNumber(otherNumber)
    if not other then return { success = false, reason = 'Geçersiz numara.' } end

    local rows = MySQL.query.await(
        ('SELECT `id`, `from_number`, `to_number`, `body`, `photo_data`, `location`, UNIX_TIMESTAMP(`created_at`) AS ts '
        .. 'FROM `%s` WHERE (`from_number` = ? AND `to_number` = ?) OR (`from_number` = ? AND `to_number` = ?) '
        .. 'ORDER BY `id` DESC LIMIT %d'):format(MSGTBL, Config.messages.historyLimit),
        { myNumber, other, other, myNumber }
    ) or {}

    -- Karşıdan gelenleri okundu işaretle (okunmamış rozetini temizler).
    MySQL.update.await(
        ('UPDATE `%s` SET `read_at` = NOW() WHERE `from_number` = ? AND `to_number` = ? AND `read_at` IS NULL'):format(MSGTBL),
        { other, myNumber }
    )

    return { success = true, messages = rows, myNumber = myNumber, otherNumber = other }
end)

lib.callback.register('loe_telephone:sendMessage', function(source, data)
    local myNumber, _, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    data = type(data) == 'table' and data or {}
    local to = Utils.validNumber(data.to)
    local photo = Utils.validPhotoData(data.photo)
    local location = Utils.validLocation(data.location)
    local body = Utils.validMessageBody(data.body)
    if not to then return { success = false, reason = 'Geçerli bir numara gir.' } end
    if not body and not photo and not location then return { success = false, reason = 'Mesaj boş olamaz.' } end
    if to == myNumber then return { success = false, reason = 'Kendine mesaj atamazsın.' } end
    body = body or ''

    local recipientCid = citizenidByNumber(to)
    if not recipientCid then
        return { success = false, reason = 'Bu numaraya kayıtlı bir hat yok.' }
    end

    local id = MySQL.insert.await(
        ('INSERT INTO `%s` (`from_number`, `to_number`, `body`, `photo_data`, `location`) VALUES (?, ?, ?, ?, ?)'):format(MSGTBL),
        { myNumber, to, body, photo, location }
    )

    local message = {
        id = id, from_number = myNumber, to_number = to, body = body,
        photo_data = photo, location = location, ts = os.time(),
    }

    -- Alıcı ÇEVRİMİÇİ ve bu numara O AN AKTİFSE anlık ilet; değilse hattı
    -- açtığında/geçtiğinde DB'den okur (pasif hatta anlık bildirim gelmez).
    local recipientPlayer = exports.qbx_core:GetPlayerByCitizenId(recipientCid)
    if recipientPlayer and isNumberActive(to) then
        TriggerClientEvent('loe_telephone:client:incomingMessage', recipientPlayer.PlayerData.source, message)
    end

    return { success = true, message = message }
end)

---------------------------------------------------------------------------
-- ARAMA — sinyalizasyon + pma-voice ile gerçek ses kanalı
---------------------------------------------------------------------------
local activeCalls = {}  -- callId -> { callerSrc, callerNumber, calleeSrc, calleeNumber, status, startedAt, ringTimer }
local nextCallSeq = 0

--- @return string callId, number voiceChannel  (voiceChannel: pma-voice call kanalı için tekil int)
local function newCallId()
    nextCallSeq = nextCallSeq + 1
    return ('c%d-%d'):format(os.time(), nextCallSeq), nextCallSeq
end

--- İki oyuncuyu pma-voice'ta ortak bir çağrı kanalına bağlar/ayırır (channel=0 -> ayır).
--- pma-voice kurulu değilse sessizce hiçbir şey yapmaz (sinyalizasyon zaten çalışır).
local function setCallVoiceChannel(callerSrc, calleeSrc, channel)
    if GetResourceState('pma-voice') ~= 'started' then return end
    local ok, err = pcall(function()
        exports['pma-voice']:setPlayerCall(callerSrc, channel)
        exports['pma-voice']:setPlayerCall(calleeSrc, channel)
    end)
    if not ok then
        Utils.log(('pma-voice setPlayerCall hata verdi: %s'):format(tostring(err)))
    end
end

local function logCall(fromNumber, toNumber, status, duration)
    MySQL.insert.await(
        ('INSERT INTO `%s` (`from_number`, `to_number`, `status`, `duration`) VALUES (?, ?, ?, ?)'):format(CALLTBL),
        { fromNumber, toNumber, status, duration }
    )
end

lib.callback.register('loe_telephone:getCallHistory', function(source)
    local myNumber, _, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    local rows = MySQL.query.await(
        ('SELECT `from_number`, `to_number`, `status`, `duration`, UNIX_TIMESTAMP(`created_at`) AS ts '
        .. 'FROM `%s` WHERE `from_number` = ? OR `to_number` = ? ORDER BY `id` DESC LIMIT %d'):format(CALLTBL, Config.calls.historyLimit),
        { myNumber, myNumber }
    ) or {}

    return { success = true, calls = rows, myNumber = myNumber }
end)

--- Aramayı temizler (bellekten siler); reason: 'answered' | 'missed' | 'declined' | 'ended'
local function teardownCall(callId, reason, duration)
    local call = activeCalls[callId]
    if not call then return end
    activeCalls[callId] = nil

    setCallVoiceChannel(call.callerSrc, call.calleeSrc, 0)

    if reason == 'answered-end' then
        logCall(call.callerNumber, call.calleeNumber, 'answered', duration)
    elseif reason == 'missed' then
        logCall(call.callerNumber, call.calleeNumber, 'missed', nil)
    elseif reason == 'declined' then
        logCall(call.callerNumber, call.calleeNumber, 'declined', nil)
    end
end

lib.callback.register('loe_telephone:startCall', function(source, toNumber)
    local myNumber, citizenid, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    local to = Utils.validNumber(toNumber)
    if not to then return { success = false, reason = 'Geçerli bir numara gir.' } end
    if to == myNumber then return { success = false, reason = 'Kendini arayamazsın.' } end

    local recipientCid = citizenidByNumber(to)
    if not recipientCid then return { success = false, reason = 'Bu numaraya kayıtlı bir hat yok.' } end

    local recipientPlayer = exports.qbx_core:GetPlayerByCitizenId(recipientCid)
    if not recipientPlayer or not isNumberActive(to) then
        logCall(myNumber, to, 'missed', nil)
        return { success = false, reason = 'Numaraya şu an ulaşılamıyor.' }
    end

    local calleeSrc = recipientPlayer.PlayerData.source
    local callId, voiceChannel = newCallId()
    local caller = playerName(getPlayer(source))

    activeCalls[callId] = {
        callerSrc = source, callerNumber = myNumber,
        calleeSrc = calleeSrc, calleeNumber = to,
        status = 'ringing', startedAt = nil,
        voiceChannel = voiceChannel,
    }

    TriggerClientEvent('loe_telephone:client:incomingCall', calleeSrc, {
        callId = callId, fromNumber = myNumber, fromName = caller,
    })

    SetTimeout(Config.calls.ringTimeout, function()
        local call = activeCalls[callId]
        if not call or call.status ~= 'ringing' then return end
        TriggerClientEvent('loe_telephone:client:callEnded', call.callerSrc, { callId = callId, reason = 'missed' })
        TriggerClientEvent('loe_telephone:client:callEnded', call.calleeSrc, { callId = callId, reason = 'missed' })
        teardownCall(callId, 'missed')
    end)

    return { success = true, callId = callId, toNumber = to }
end)

lib.callback.register('loe_telephone:answerCall', function(source, callId)
    local call = activeCalls[callId]
    if not call or call.calleeSrc ~= source or call.status ~= 'ringing' then
        return { success = false, reason = 'Bu arama artık geçerli değil.' }
    end

    call.status = 'active'
    call.startedAt = os.time()

    setCallVoiceChannel(call.callerSrc, call.calleeSrc, call.voiceChannel)

    local payload = {
        callId = callId,
        callerNumber = call.callerNumber,
        calleeNumber = call.calleeNumber,
    }
    TriggerClientEvent('loe_telephone:client:callAnswered', call.callerSrc, payload)
    TriggerClientEvent('loe_telephone:client:callAnswered', call.calleeSrc, payload)

    return { success = true }
end)

lib.callback.register('loe_telephone:declineCall', function(source, callId)
    local call = activeCalls[callId]
    if not call or call.calleeSrc ~= source then return { success = false } end

    TriggerClientEvent('loe_telephone:client:callEnded', call.callerSrc, { callId = callId, reason = 'declined' })
    TriggerClientEvent('loe_telephone:client:callEnded', call.calleeSrc, { callId = callId, reason = 'declined' })
    teardownCall(callId, 'declined')

    return { success = true }
end)

lib.callback.register('loe_telephone:endCall', function(source, callId)
    local call = activeCalls[callId]
    if not call or (call.callerSrc ~= source and call.calleeSrc ~= source) then return { success = false } end

    local otherSrc = (call.callerSrc == source) and call.calleeSrc or call.callerSrc
    local wasActive = call.status == 'active'
    local duration = wasActive and (os.time() - call.startedAt) or nil

    TriggerClientEvent('loe_telephone:client:callEnded', source, { callId = callId, reason = 'ended' })
    TriggerClientEvent('loe_telephone:client:callEnded', otherSrc, { callId = callId, reason = 'ended' })
    teardownCall(callId, wasActive and 'answered-end' or 'declined', duration)

    return { success = true }
end)

---------------------------------------------------------------------------
-- TELEGRAM GRUPLARI (App Store'dan indirilen grup mesajlaşma uygulaması)
--   Genel ilke aynı: source'un O AN AKTİF hattı doğrulanır (requireActiveNumber),
--   üyelik her istekte DB'den kontrol edilir. "public" gruplar arama ile
--   herkese görünür ve doğrudan katılınabilir; "private" gruplar yalnızca
--   davet kodu ile (her iki tür grup için de kod üretilir).
---------------------------------------------------------------------------
local GROUPTBL = Config.db.groups
local GMEMTBL  = Config.db.groupMembers
local GMSGTBL  = Config.db.groupMessages

CreateThread(function()
    MySQL.query.await(([[
        CREATE TABLE IF NOT EXISTS `%s` (
            `id`           INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `name`         VARCHAR(32)  NOT NULL,
            `type`         ENUM('public','private') NOT NULL DEFAULT 'public',
            `invite_code`  VARCHAR(10)  NOT NULL,
            `owner_number` VARCHAR(8)   NOT NULL,
            `created_at`   TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_invite_code` (`invite_code`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    ]]):format(GROUPTBL))

    MySQL.query.await(([[
        CREATE TABLE IF NOT EXISTS `%s` (
            `id`        INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `group_id`  INT UNSIGNED NOT NULL,
            `number`    VARCHAR(8)   NOT NULL,
            `joined_at` TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            UNIQUE KEY `uniq_group_number` (`group_id`, `number`),
            KEY `idx_number` (`number`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    ]]):format(GMEMTBL))

    MySQL.query.await(([[
        CREATE TABLE IF NOT EXISTS `%s` (
            `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
            `group_id`    INT UNSIGNED NOT NULL,
            `from_number` VARCHAR(8)   NOT NULL,
            `body`        VARCHAR(400) NOT NULL,
            `created_at`  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (`id`),
            KEY `idx_group` (`group_id`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    ]]):format(GMSGTBL))

    alignCollation(GROUPTBL)
    alignCollation(GMEMTBL)
    alignCollation(GMSGTBL)
    Utils.log('telegram tabloları hazır:', GROUPTBL, GMEMTBL, GMSGTBL)
end)

math.randomseed(os.time())
-- 0/O ve 1/I gibi karışabilecek karakterler bilerek çıkarıldı (elle yazılabilir kod).
local INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

local function generateInviteCode()
    for _ = 1, 20 do
        local chars = {}
        for i = 1, 8 do
            local idx = math.random(1, #INVITE_CHARS)
            chars[i] = INVITE_CHARS:sub(idx, idx)
        end
        local code = table.concat(chars)
        local taken = MySQL.single.await(
            ('SELECT 1 AS ok FROM `%s` WHERE `invite_code` = ? LIMIT 1'):format(GROUPTBL), { code }
        )
        if not taken then return code end
    end
    return nil
end

local function isGroupMember(groupId, number)
    local row = MySQL.single.await(
        ('SELECT 1 AS ok FROM `%s` WHERE `group_id` = ? AND `number` = ? LIMIT 1'):format(GMEMTBL),
        { groupId, number }
    )
    return row ~= nil
end

lib.callback.register('loe_telephone:createGroup', function(source, data)
    local myNumber, _, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    data = type(data) == 'table' and data or {}
    local name = Utils.validGroupName(data.name)
    local gtype = data.type == 'private' and 'private' or 'public'
    if not name then return { success = false, reason = 'Bir grup adı gir.' } end

    local ownedCount = MySQL.scalar.await(
        ('SELECT COUNT(*) FROM `%s` WHERE `owner_number` = ?'):format(GROUPTBL), { myNumber }
    ) or 0
    if ownedCount >= Config.telegram.maxGroupsPerOwner then
        return { success = false, reason = 'En fazla grup kurma sınırına ulaştın.' }
    end

    local code = generateInviteCode()
    if not code then return { success = false, reason = 'Davet kodu üretilemedi, tekrar dene.' } end

    local groupId = MySQL.insert.await(
        ('INSERT INTO `%s` (`name`, `type`, `invite_code`, `owner_number`) VALUES (?, ?, ?, ?)'):format(GROUPTBL),
        { name, gtype, code, myNumber }
    )
    MySQL.insert.await(
        ('INSERT INTO `%s` (`group_id`, `number`) VALUES (?, ?)'):format(GMEMTBL),
        { groupId, myNumber }
    )

    return {
        success = true,
        group = { id = groupId, name = name, type = gtype, inviteCode = code, ownerNumber = myNumber },
    }
end)

lib.callback.register('loe_telephone:getMyGroups', function(source)
    local myNumber, _, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    local rows = MySQL.query.await(([[
        SELECT g.`id`, g.`name`, g.`type`, g.`invite_code` AS inviteCode, g.`owner_number` AS ownerNumber,
            (SELECT `body` FROM `%s` m WHERE m.`group_id` = g.`id` ORDER BY m.`id` DESC LIMIT 1) AS lastBody,
            (SELECT UNIX_TIMESTAMP(m.`created_at`) FROM `%s` m WHERE m.`group_id` = g.`id` ORDER BY m.`id` DESC LIMIT 1) AS lastAt
        FROM `%s` g
        INNER JOIN `%s` gm ON gm.`group_id` = g.`id`
        WHERE gm.`number` = ?
        ORDER BY lastAt DESC
    ]]):format(GMSGTBL, GMSGTBL, GROUPTBL, GMEMTBL), { myNumber }
    ) or {}

    return { success = true, groups = rows, myNumber = myNumber }
end)

lib.callback.register('loe_telephone:searchGroups', function(source, query)
    local myNumber, _, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    local q = type(query) == 'string' and query:gsub('[%c%%_]', ''):gsub('^%s+', ''):gsub('%s+$', '') or ''

    local rows
    if q == '' then
        rows = MySQL.query.await(
            ('SELECT `id`, `name`, `owner_number` AS ownerNumber, '
            .. '(SELECT COUNT(*) FROM `%s` gm WHERE gm.`group_id` = g.`id`) AS memberCount '
            .. 'FROM `%s` g WHERE `type` = \'public\' ORDER BY `id` DESC LIMIT %d')
            :format(GMEMTBL, GROUPTBL, Config.telegram.searchLimit)
        ) or {}
    else
        rows = MySQL.query.await(
            ('SELECT `id`, `name`, `owner_number` AS ownerNumber, '
            .. '(SELECT COUNT(*) FROM `%s` gm WHERE gm.`group_id` = g.`id`) AS memberCount '
            .. 'FROM `%s` g WHERE `type` = \'public\' AND `name` LIKE ? ORDER BY `id` DESC LIMIT %d')
            :format(GMEMTBL, GROUPTBL, Config.telegram.searchLimit),
            { '%' .. q .. '%' }
        ) or {}
    end

    -- hangileri zaten üye olunan gruplar (istemci "Katıl" yerine "Aç" göstersin)
    local myGroupIds = {}
    local memberRows = MySQL.query.await(
        ('SELECT `group_id` FROM `%s` WHERE `number` = ?'):format(GMEMTBL), { myNumber }
    ) or {}
    for _, r in ipairs(memberRows) do myGroupIds[r.group_id] = true end
    for _, r in ipairs(rows) do r.isMember = myGroupIds[r.id] == true end

    return { success = true, groups = rows }
end)

local function joinGroupRow(myNumber, group)
    if not isGroupMember(group.id, myNumber) then
        MySQL.insert.await(
            ('INSERT IGNORE INTO `%s` (`group_id`, `number`) VALUES (?, ?)'):format(GMEMTBL),
            { group.id, myNumber }
        )
    end
    return {
        success = true,
        group = { id = group.id, name = group.name, type = group.type, inviteCode = group.invite_code, ownerNumber = group.owner_number },
    }
end

lib.callback.register('loe_telephone:joinGroupById', function(source, groupId)
    local myNumber, _, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    groupId = tonumber(groupId)
    if not groupId then return { success = false, reason = 'Geçersiz grup.' } end

    local group = MySQL.single.await(
        ('SELECT `id`, `name`, `type`, `invite_code`, `owner_number` FROM `%s` WHERE `id` = ? AND `type` = \'public\' LIMIT 1'):format(GROUPTBL),
        { groupId }
    )
    if not group then return { success = false, reason = 'Grup bulunamadı.' } end

    return joinGroupRow(myNumber, group)
end)

lib.callback.register('loe_telephone:joinGroupByInvite', function(source, code)
    local myNumber, _, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    code = type(code) == 'string' and code:gsub('[%c%s]', ''):upper() or ''
    if code == '' then return { success = false, reason = 'Bir davet kodu gir.' } end

    local group = MySQL.single.await(
        ('SELECT `id`, `name`, `type`, `invite_code`, `owner_number` FROM `%s` WHERE `invite_code` = ? LIMIT 1'):format(GROUPTBL),
        { code }
    )
    if not group then return { success = false, reason = 'Bu davet kodu geçersiz.' } end

    return joinGroupRow(myNumber, group)
end)

lib.callback.register('loe_telephone:getGroupMessages', function(source, groupId)
    local myNumber, _, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    groupId = tonumber(groupId)
    if not groupId or not isGroupMember(groupId, myNumber) then
        return { success = false, reason = 'Bu grubun üyesi değilsin.' }
    end

    local rows = MySQL.query.await(
        ('SELECT `id`, `from_number`, `body`, UNIX_TIMESTAMP(`created_at`) AS ts '
        .. 'FROM `%s` WHERE `group_id` = ? ORDER BY `id` DESC LIMIT %d'):format(GMSGTBL, Config.telegram.groupMessageHistoryLimit),
        { groupId }
    ) or {}

    return { success = true, messages = rows, myNumber = myNumber }
end)

lib.callback.register('loe_telephone:sendGroupMessage', function(source, data)
    local myNumber, _, reason = requireActiveNumber(source)
    if not myNumber then return { success = false, reason = reason } end

    data = type(data) == 'table' and data or {}
    local groupId = tonumber(data.groupId)
    local body = Utils.validGroupMessageBody(data.body)
    if not groupId or not isGroupMember(groupId, myNumber) then
        return { success = false, reason = 'Bu grubun üyesi değilsin.' }
    end
    if not body then return { success = false, reason = 'Mesaj boş olamaz.' } end

    local id = MySQL.insert.await(
        ('INSERT INTO `%s` (`group_id`, `from_number`, `body`) VALUES (?, ?, ?)'):format(GMSGTBL),
        { groupId, myNumber, body }
    )
    local message = { id = id, groupId = groupId, from_number = myNumber, body = body, ts = os.time() }

    -- gruptaki DİĞER üyelerden O AN ÇEVRİMİÇİ ve hattı aktif olanlara anlık ilet
    local members = MySQL.query.await(
        ('SELECT `number` FROM `%s` WHERE `group_id` = ? AND `number` != ?'):format(GMEMTBL),
        { groupId, myNumber }
    ) or {}
    for _, m in ipairs(members) do
        local cid = citizenidByNumber(m.number)
        if cid then
            local p = exports.qbx_core:GetPlayerByCitizenId(cid)
            if p and isNumberActive(m.number) then
                TriggerClientEvent('loe_telephone:client:incomingGroupMessage', p.PlayerData.source, message)
            end
        end
    end

    return { success = true, message = message }
end)

---------------------------------------------------------------------------
-- AIRSHARE (Kontrol Merkezi) — yakındaki oyuncuya numara/fotoğraf paylaşımı
--   Fotoğraf byte'ları (dataUrl) yalnızca gönderenin NUI'sinde (IndexedDB)
--   bulunur; onay gelene kadar sunucu bellekte tutar, onaylanınca hedefe
--   TEK sefer iletir (fazladan bir istemci-sunucu turu gerekmez).
---------------------------------------------------------------------------
local pendingShares = {} -- requestId -> { kind, fromSrc, fromNumber, fromName, targetSrc, dataUrl, timer }
local nextShareSeq = 0

local function newShareId()
    nextShareSeq = nextShareSeq + 1
    return ('s%d-%d'):format(os.time(), nextShareSeq)
end

local function playerDistance(srcA, srcB)
    local pedA, pedB = GetPlayerPed(srcA), GetPlayerPed(srcB)
    if not pedA or pedA == 0 or not pedB or pedB == 0 then return nil end
    local a, b = GetEntityCoords(pedA), GetEntityCoords(pedB)
    local dx, dy, dz = a.x - b.x, a.y - b.y, a.z - b.z
    return math.sqrt(dx * dx + dy * dy + dz * dz)
end

lib.callback.register('loe_telephone:shareRequest', function(source, data)
    local player = getPlayer(source)
    if not player then return { success = false, reason = 'Oyuncu bulunamadı.' } end

    data = type(data) == 'table' and data or {}
    local targetSrc = tonumber(data.targetServerId)
    local kind = data.kind == 'photo' and 'photo' or 'number'
    if not targetSrc or targetSrc == source then return { success = false, reason = 'Geçersiz hedef.' } end
    if GetPlayerName(targetSrc) == nil then return { success = false, reason = 'Oyuncu artık burada değil.' } end

    local dist = playerDistance(source, targetSrc)
    if not dist or dist > Config.airshare.maxDistance then
        return { success = false, reason = 'Bu oyuncu artık yakında değil.' }
    end

    local fromNumber = nil
    if kind == 'number' then
        fromNumber = activeNumberOf(player.PlayerData.citizenid)
        if not fromNumber then return { success = false, reason = 'Aktif bir hattın yok.' } end
    end

    local dataUrl = kind == 'photo' and type(data.dataUrl) == 'string' and data.dataUrl or nil
    if kind == 'photo' and not dataUrl then
        return { success = false, reason = 'Paylaşılacak fotoğraf bulunamadı.' }
    end

    local requestId = newShareId()
    local fromName = playerName(player)

    pendingShares[requestId] = {
        kind = kind, fromSrc = source, fromNumber = fromNumber, fromName = fromName,
        targetSrc = targetSrc, dataUrl = dataUrl,
    }
    pendingShares[requestId].timer = SetTimeout(Config.airshare.requestTimeoutMs, function()
        if pendingShares[requestId] then
            pendingShares[requestId] = nil
            TriggerClientEvent('loe_telephone:client:shareResult', source, { success = false, reason = 'Karşı taraf yanıt vermedi.' })
        end
    end)

    TriggerClientEvent('loe_telephone:client:incomingShare', targetSrc, {
        requestId = requestId, kind = kind, fromName = fromName, fromNumber = fromNumber,
    })

    return { success = true, requestId = requestId }
end)

lib.callback.register('loe_telephone:shareRespond', function(source, data)
    data = type(data) == 'table' and data or {}
    local requestId = data.requestId
    local pending = requestId and pendingShares[requestId]
    if not pending or pending.targetSrc ~= source then
        return { success = false, reason = 'Bu istek artık geçerli değil.' }
    end
    pendingShares[requestId] = nil

    if not data.accept then
        TriggerClientEvent('loe_telephone:client:shareResult', pending.fromSrc, { success = false, reason = 'Karşı taraf reddetti.' })
        return { success = true }
    end

    local targetPlayer = getPlayer(source)
    if not targetPlayer then return { success = false, reason = 'Oyuncu bulunamadı.' } end

    if pending.kind == 'number' then
        MySQL.insert.await(
            ('INSERT INTO `%s` (`citizenid`, `number`, `name`) VALUES (?, ?, ?) '
            .. 'ON DUPLICATE KEY UPDATE `name` = VALUES(`name`)'):format(CONTBL),
            { targetPlayer.PlayerData.citizenid, pending.fromNumber, pending.fromName }
        )
    else
        TriggerClientEvent('loe_telephone:client:receiveSharedPhoto', source, {
            dataUrl = pending.dataUrl, fromName = pending.fromName,
        })
    end

    TriggerClientEvent('loe_telephone:client:shareResult', pending.fromSrc, {
        success = true, kind = pending.kind, targetName = playerName(targetPlayer),
    })

    return { success = true }
end)

--- Oyuncu ayrılırsa üstündeki tüm aramaları temizle, karşı tarafı bilgilendir.
AddEventHandler('playerDropped', function()
    local source = source
    for callId, call in pairs(activeCalls) do
        if call.callerSrc == source or call.calleeSrc == source then
            local otherSrc = (call.callerSrc == source) and call.calleeSrc or call.callerSrc
            TriggerClientEvent('loe_telephone:client:callEnded', otherSrc, { callId = callId, reason = 'ended' })
            local wasActive = call.status == 'active'
            teardownCall(callId, wasActive and 'answered-end' or 'missed', wasActive and (os.time() - call.startedAt) or nil)
        end
    end
end)
